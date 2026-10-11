/**
 * 纯 JavaScript 的 tar(gzip) 解包器。
 *
 * 背景：npm registry 不直接提供文件，而是把包打成 tarball（`.tgz`），
 * 所以「取包内某个文件」这件事必须先解包。为了保持零依赖，
 * 这里自己实现 USTAR / PAX 的解析，而不是引入 `tar` 包。
 *
 * 设计要点：
 * - 流式：边 gunzip 边解析边落盘，内存里只保留 512 字节块的滑动窗口，
 *   解一个 100MB 的包也不会把内存打爆；
 * - 支持 PAX 扩展头（typeflag `x`/`g`）与 GNU 长文件名（`L`/`K`），
 *   现代 npm 打出来的包大量使用 PAX，不支持就会漏文件名；
 * - 安全：任何 `..`、绝对路径、逃逸出目标目录的条目都直接拒绝；
 * - 体积上限：单文件和总解压体积都有上限，防御「压缩炸弹」。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/** tar 以 512 字节为一个块。 */
const BLOCK = 512;

/** 一次读取的正文分片大小。 */
const CHUNK = 64 * 1024;

/** 判断一个 512 块是否全为 0（tar 的结束标记）。 */
function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/** 从 buf 的 [start, start+len) 区间读取以 NUL 结尾的字符串。 */
function readString(buf, start, len) {
  const end = start + len;
  let stop = start;
  while (stop < end && buf[stop] !== 0) stop += 1;
  return buf.toString('utf8', start, stop).trim();
}

/**
 * 解析八进制数值字段。
 * 兼容两种编码：
 * 1. 常规八进制 ASCII，以 NUL 或空格结尾；
 * 2. 二进制编码（tar 规范的 base-256），首字节最高位为 1 时启用 ——
 *    大文件（>8GB）和部分工具会用这种写法。
 */
function parseNumeric(buf, start, len) {
  if (len === 0) return 0;
  const first = buf[start];

  // base-256（二进制）编码
  if (first & 0x80) {
    let value = first & 0x7f;
    for (let i = 1; i < len; i += 1) value = value * 256 + buf[start + i];
    return value;
  }

  const raw = readString(buf, start, len);
  if (raw === '') return 0;
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 解析一个 512 字节的 tar 头。
 * @param {Buffer} buf 恰好 512 字节
 */
function parseHeader(buf) {
  const name = readString(buf, 0, 100);
  const size = parseNumeric(buf, 124, 12);
  const mtime = parseNumeric(buf, 136, 12) * 1000;
  const typeflag = buf.toString('ascii', 156, 157);
  const linkname = readString(buf, 157, 100);
  const prefix = readString(buf, 345, 155);
  const mode = parseNumeric(buf, 100, 8);

  // USTAR 约定：prefix + '/' + name 组成完整路径
  const fullName = prefix && name.length + prefix.length + 1 <= 255 ? `${prefix}/${name}` : name;

  return {
    name: fullName,
    size,
    mtime,
    mode,
    /** typeflag `0` 或 NUL 都表示普通文件 */
    type: typeflag === '0' || typeflag === '\0' || typeflag === '' ? 'file' : typeflag,
    linkname,
  };
}

/**
 * 解析 PAX 扩展头正文。
 * 记录格式为 `<十进制长度> <key>=<value>\n`，长度包含自身。
 * @param {Buffer} buf
 * @returns {Record<string,string>}
 */
function parsePax(buf) {
  const records = {};
  let offset = 0;
  const text = buf.toString('utf8');

  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > text.length) break;
    const record = text.slice(space + 1, offset + length - 1); // 去掉结尾的 \n
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }

  return records;
}

/**
 * 把 tar 里的条目名规范化为安全的包内相对路径。
 *
 * @param {string} raw 原始条目名，例如 `package/dist/vue.js`
 * @param {string} [strip] 需要剥掉的前缀（npm 包统一是 `package/`）
 * @returns {string|null} 规范化后的相对路径；非法条目返回 null
 */
function normalizeEntryName(raw, strip) {
  let name = raw.replace(/\\/g, '/');
  if (strip && name.startsWith(strip)) name = name.slice(strip.length);
  name = name.replace(/^\.\//, '').replace(/^\/+/, '');
  if (name === '') return null;
  // 拒绝目录穿越与绝对路径
  const segments = name.split('/');
  if (segments.some((s) => s === '..' || s === '')) return null;
  return segments.join('/');
}

/**
 * 带内部缓冲的字节读取器：把异步流包装成「按需读 N 字节」。
 * 这样上层的 tar 状态机可以写成顺序逻辑，不用手写状态缓存。
 */
class ByteReader {
  /** @param {AsyncIterable<Buffer>} source */
  constructor(source) {
    this.iterator = source[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }

  /**
   * 读取至多 n 字节。
   * @param {number} n
   * @returns {Promise<Buffer|null>} 流已结束且无剩余数据时返回 null
   */
  async read(n) {
    while (this.buffer.length < n && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.ended = true;
        break;
      }
      if (!value || value.length === 0) continue;
      // 尽量避免反复拼接：只有缓冲区里还有残留时才需要 concat
      this.buffer = this.buffer.length === 0 ? Buffer.from(value) : Buffer.concat([this.buffer, value]);
    }

    if (this.buffer.length === 0) return null;
    const take = Math.min(n, this.buffer.length);
    const out = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return out;
  }

  /**
   * 严格读取 n 字节，不足则抛错（说明 tar 被截断）。
   * @param {number} n
   */
  async readExact(n) {
    const parts = [];
    let got = 0;
    while (got < n) {
      const chunk = await this.read(n - got);
      if (chunk === null) throw new Error(`tar 数据被截断：期望 ${n} 字节，实际 ${got} 字节`);
      parts.push(chunk);
      got += chunk.length;
    }
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }

  /** 丢弃 n 字节（跳过对齐填充）。 */
  async skip(n) {
    let left = n;
    while (left > 0) {
      const chunk = await this.read(Math.min(left, CHUNK));
      if (chunk === null) throw new Error('tar 数据被截断（跳过节区时）');
      left -= chunk.length;
    }
  }
}

/** 保证目录存在。 */
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** 等待可写流的 drain（背压）。 */
function writeToStream(stream, buffer) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buffer, (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else stream.once('drain', resolve);
  });
}

/** 关闭可写流并等待真正落盘。 */
function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 解压并解包一个 tar（已 gunzip 的字节流）到目标目录。
 *
 * @param {AsyncIterable<Buffer>|NodeJS.ReadableStream} source tar 字节流
 * @param {string} destRoot 目标根目录
 * @param {object} [options]
 * @param {string} [options.stripPrefix='package/'] 需要剥掉的前缀
 * @param {number} [options.maxTotalBytes] 允许解压出的总字节上限
 * @param {number} [options.maxFileBytes] 单文件字节上限
 * @returns {Promise<{files: Array<{path:string,size:number,mtime:number}>, totalBytes:number, skipped:number}>}
 */
export async function extract(source, destRoot, options = {}) {
  const {
    stripPrefix = 'package/',
    maxTotalBytes = Number.POSITIVE_INFINITY,
    maxFileBytes = Number.POSITIVE_INFINITY,
  } = options;

  const root = path.resolve(destRoot);
  const reader = new ByteReader(source);

  /** @type {Array<{path:string,size:number,mtime:number}>} */
  const files = [];
  let totalBytes = 0;
  let skipped = 0;

  /** 挂起的 PAX 记录（作用于下一个条目） */
  let paxRecords = {};
  /** 挂起的 GNU 长文件名（作用于下一个条目） */
  let overrideName = null;

  /** 目录集合，最后统一建，避免每个条目都 mkdir */
  const dirs = new Set();

  for (;;) {
    const block = await reader.read(BLOCK);
    if (block === null) break; // 正常读完
    if (block.length < BLOCK) throw new Error('tar 头部不足 512 字节，文件被截断');
    if (isZeroBlock(block)) {
      // tar 约定以两个全零块收尾；宽松处理：读到零块即认为结束
      break;
    }

    const header = parseHeader(block);
    const payloadBlocks = Math.ceil(header.size / BLOCK);
    const padding = payloadBlocks * BLOCK - header.size;

    // ---- 元数据类条目：不产生文件，只更新上下文 ----
    if (header.type === 'x' || header.type === 'X') {
      const body = await reader.readExact(header.size);
      if (padding) await reader.skip(padding);
      paxRecords = { ...paxRecords, ...parsePax(body) };
      continue;
    }
    if (header.type === 'g') {
      // 全局 PAX 头，对包内文件无意义，跳过
      if (header.size) await reader.skip(header.size);
      if (padding) await reader.skip(padding);
      continue;
    }
    if (header.type === 'L') {
      // GNU longname：正文就是下一个条目的名字
      const body = await reader.readExact(header.size);
      if (padding) await reader.skip(padding);
      overrideName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (header.type === 'K') {
      if (header.size) await reader.skip(header.size);
      if (padding) await reader.skip(padding);
      continue;
    }

    // ---- 目录条目 ----
    if (header.type === '5') {
      const dirName = normalizeEntryName(paxRecords.path || overrideName || header.name, stripPrefix);
      paxRecords = {};
      overrideName = null;
      if (dirName) dirs.add(dirName);
      continue;
    }

    // ---- 非普通文件（软链 / 硬链 / 设备 / FIFO）：跳过 ----
    if (header.type !== 'file') {
      if (header.size) await reader.skip(header.size);
      if (padding) await reader.skip(padding);
      paxRecords = {};
      overrideName = null;
      skipped += 1;
      continue;
    }

    // ---- 普通文件 ----
    const rawName = paxRecords.path || overrideName || header.name;
    const relPath = normalizeEntryName(rawName, stripPrefix);

    if (relPath === null) {
      // 非法路径：跳过正文，但不终止整个包（一个坏条目不该毁掉整个包）
      if (header.size) await reader.skip(header.size);
      if (padding) await reader.skip(padding);
      paxRecords = {};
      overrideName = null;
      skipped += 1;
      continue;
    }

    const size = Number(paxRecords.size ?? header.size) || 0;
    const absolute = path.resolve(root, relPath);

    // 二次防御：确保最终落盘路径确实在 root 内
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      if (size) await reader.skip(size);
      if (padding) await reader.skip(padding);
      paxRecords = {};
      overrideName = null;
      skipped += 1;
      continue;
    }

    if (size > maxFileBytes) {
      throw new Error(`包内文件 ${relPath} 体积 ${size} 字节，超过单文件上限 ${maxFileBytes} 字节`);
    }
    if (totalBytes + size > maxTotalBytes) {
      throw new Error(`解压后总体积超过上限 ${maxTotalBytes} 字节，疑似异常包`);
    }

    await ensureDir(path.dirname(absolute));
    const ws = fs.createWriteStream(absolute, { mode: (header.mode || 0o644) & 0o777 });
    try {
      let left = size;
      while (left > 0) {
        const chunk = await reader.read(Math.min(left, CHUNK));
        if (chunk === null) throw new Error(`文件 ${relPath} 的数据被截断`);
        await writeToStream(ws, chunk);
        left -= chunk.length;
      }
    } finally {
      await closeStream(ws);
    }

    if (padding) await reader.skip(padding);

    totalBytes += size;
    files.push({
      path: relPath,
      size,
      mtime: Number(paxRecords.mtime ? Date.parse(paxRecords.mtime) : header.mtime) || 0,
    });

    paxRecords = {};
    overrideName = null;
  }

  return { files, totalBytes, skipped, dirs: [...dirs] };
}

/**
 * 判断一段字节流是否为 gzip（magic number 0x1f 0x8b）。
 * @param {Buffer} buf
 */
export function isGzip(buf) {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * 解包一个 `.tgz` 流。
 *
 * @param {AsyncIterable<Buffer>|NodeJS.ReadableStream} source tarball 字节流
 * @param {string} destRoot 目标目录
 * @param {object} [options] 透传给 {@link extract}
 */
export async function extractTgz(source, destRoot, options = {}) {
  const gunzip = zlib.createGunzip();
  // 把源流灌进 gunzip，同时把 gunzip 作为异步可迭代对象交给 extract
  const pump = (async () => {
    for await (const chunk of source) {
      if (!gunzip.write(chunk)) {
        await new Promise((resolve) => gunzip.once('drain', resolve));
      }
    }
    gunzip.end();
  })();

  try {
    const result = await extract(gunzip, destRoot, options);
    await pump;
    return result;
  } catch (err) {
    gunzip.destroy();
    await pump.catch(() => {});
    throw err;
  }
}

export default { extract, extractTgz, isGzip };
