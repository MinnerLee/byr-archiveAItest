/**
 * 两级缓存。
 *
 * 题目可选功能 2 要求「尽量减少 npm registry 的访问次数」，并明确：
 *   - 缓存方式自选；
 *   - 若用内存缓存，要避免无限增长，需要上限或过期；
 *   - 不同内容类型要有不同的过期时间。
 *
 * 对应设计：
 *
 *   ┌──────────────┐  未命中   ┌──────────────┐  未命中   ┌──────────────┐
 *   │  内存 LRU    │ ───────▶ │  磁盘缓存    │ ───────▶ │ npm registry │
 *   │ 按字节上限淘汰 │          │ 按 TTL 判定   │          │   上游       │
 *   └──────────────┘          └──────────────┘          └──────────────┘
 *
 * - 内存层：Map 记录访问顺序实现 LRU，按「字节」而非「条数」限额，
 *   这样缓一个 5MB 的 vue.js 和缓一个 1KB 的 package.json 代价是等价的，
 *   避免「缓存 1 万个小文件把内存吃掉」和「一个大文件挤爆内存」两种翻车方式。
 * - 磁盘层：元信息存 JSON、解包结果直接以目录树落盘（文件系统自己会做 page cache，
 *   相当于「第三级缓存」）。
 * - 分类型 TTL：版本元信息 1h、packument 5min、解包文件 7d、404 负缓存 30s。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';
import logger from './logger.js';
import { shortHash, singleFlight } from './util.js';

/**
 * 按字节计量的 LRU 缓存。
 */
class MemoryCache {
  /** @param {number} maxBytes 字节上限 */
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    /** @type {Map<string, {value:any, size:number, expiresAt:number}>} */
    this.store = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * 读取。命中的条目会被移到 Map 末尾（表示最近使用）。
   * @param {string} key
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.bytes -= entry.size;
      this.misses += 1;
      return undefined;
    }
    // 重新插入到末尾，维持 LRU 顺序
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /**
   * 写入。
   * @param {string} key
   * @param {any} value
   * @param {number} ttl 毫秒，0 表示永不过期（仅靠 LRU 淘汰）
   * @param {number} [size] 显式指定占用字节数
   */
  set(key, value, ttl, size) {
    const bytes = size ?? estimateSize(value);
    if (bytes > this.maxBytes) return; // 单个条目就超过总额度，不缓存

    const existing = this.store.get(key);
    if (existing) {
      this.bytes -= existing.size;
      this.store.delete(key);
    }

    this.store.set(key, {
      value,
      size: bytes,
      expiresAt: ttl > 0 ? Date.now() + ttl : 0,
    });
    this.bytes += bytes;

    // 超出额度就从头（最久未使用）淘汰
    while (this.bytes > this.maxBytes && this.store.size > 0) {
      const oldest = this.store.keys().next().value;
      const entry = this.store.get(oldest);
      this.store.delete(oldest);
      this.bytes -= entry.size;
      this.evictions += 1;
    }
  }

  /** 清空。 */
  clear() {
    this.store.clear();
    this.bytes = 0;
  }

  /** 统计信息，供 /_stats 使用。 */
  stats() {
    return {
      entries: this.store.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: this.hits + this.misses === 0 ? 0 : this.hits / (this.hits + this.misses),
    };
  }
}

/** 估算任意值占用的字节数。 */
function estimateSize(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value);
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/** 内存缓存实例。 */
export const memory = new MemoryCache(config.noCache ? 0 : config.memoryCacheBytes);

/** 当前 registry 对应的磁盘缓存命名空间（不同 registry 互不干扰）。 */
const registryId = shortHash(config.registry, 12);

const metaDir = path.join(config.cacheDir, registryId, 'meta');
const pkgDir = path.join(config.cacheDir, registryId, 'pkg');
const tmpDir = path.join(config.cacheDir, registryId, 'tmp');

/** 初始化缓存目录。 */
export async function init() {
  if (!config.diskCache || config.noCache) return;
  await Promise.all([
    fsp.mkdir(metaDir, { recursive: true }),
    fsp.mkdir(pkgDir, { recursive: true }),
    fsp.mkdir(tmpDir, { recursive: true }),
  ]);
  logger.debug(`缓存目录已就绪: ${config.cacheDir}`);
}

/** 某个元信息条目的磁盘路径。 */
function metaPath(key) {
  return path.join(metaDir, `${shortHash(key, 32)}.json`);
}

/**
 * 读取元信息缓存。
 *
 * @param {string} key 逻辑键，例如 `packument:vue`
 * @returns {Promise<{value:any, fresh:boolean, ageMs:number}|null>}
 *          `fresh=false` 表示已过期但仍可用于「上游故障时兜底」
 */
export async function getMeta(key) {
  const memKey = `meta:${key}`;
  const cached = memory.get(memKey);
  if (cached) return { value: cached.value, fresh: cached.fresh, ageMs: cached.ageMs };

  if (config.noCache || !config.diskCache) return null;

  const file = metaPath(key);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const record = JSON.parse(raw);
    const ageMs = Date.now() - record.storedAt;
    const fresh = ageMs < record.ttl;
    // 过期后还在内存里留短时间，供上游故障时兜底
    memory.set(memKey, { value: record.value, fresh, ageMs }, fresh ? record.ttl : 60_000);
    return { value: record.value, fresh, ageMs };
  } catch (err) {
    if (err.code !== 'ENOENT') logger.debug(`读取元信息缓存失败 ${file}: ${err.message}`);
    return null;
  }
}

/**
 * 写入元信息缓存（内存 + 磁盘）。
 * @param {string} key
 * @param {any} value
 * @param {number} ttl 毫秒
 */
export async function setMeta(key, value, ttl) {
  memory.set(`meta:${key}`, { value, fresh: true, ageMs: 0 }, ttl);

  if (config.noCache || !config.diskCache) return;
  const file = metaPath(key);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ storedAt: Date.now(), ttl, value }));
    await fsp.rename(tmp, file);
  } catch (err) {
    logger.debug(`写入元信息缓存失败 ${file}: ${err.message}`);
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

/** 解包结果所在目录。 */
export function packagePath(name, version) {
  return path.join(pkgDir, encodeDirName(name), version);
}

/** 把包名安全地映射成目录名（scoped 包的 `@` `\/` 不能直接做目录名）。 */
function encodeDirName(name) {
  return name.replace(/\//g, '__').replace(/^@/, '_at_');
}

/** 解包完成标记文件名。 */
const DONE_MARKER = '.byr-archive.json';

/**
 * 取一个已解包的包目录。
 *
 * 命中条件：目录存在、有完成标记、且未超出 TTL。
 * 如果包已解包但索引丢失，会返回 null 让对方重新解（保证一致性优先）。
 *
 * @param {string} name 包名
 * @param {string} version 版本
 * @returns {Promise<{dir:string, files:Array<{path:string,size:number,mtime:number}>, totalBytes:number, storedAt:number}|null>}
 */
export async function getExtracted(name, version) {
  if (config.noCache || !config.diskCache) return null;

  const dir = packagePath(name, version);
  const marker = path.join(dir, DONE_MARKER);
  try {
    const raw = await fsp.readFile(marker, 'utf8');
    const record = JSON.parse(raw);
    if (Date.now() - record.storedAt > config.ttl.file) return null;
    return { ...record, dir };
  } catch {
    return null;
  }
}

/**
 * 在一个临时目录里解包，成功后原子地改名到正式目录。
 *
 * 之所以要「临时目录 + rename」：解包过程中若服务被中断，
 * 正式目录里就会留下半成品，后续请求会读到残缺的文件树。
 * rename 在同一文件系统内是原子操作，能保证「要么完整、要么不存在」。
 *
 * @param {string} name
 * @param {string} version
 * @param {(dir:string) => Promise<{files:Array<{path:string,size:number,mtime:number}>, totalBytes:number}>} producer
 *        负责把文件真正写到传入的临时目录里
 * @returns {Promise<{dir:string, files:any[], totalBytes:number, storedAt:number}>}
 */
export async function extractInto(name, version, producer) {
  if (config.noCache || !config.diskCache) {
    // 不落盘时用一次性临时目录，调用方用完自行清理
    const dir = await fsp.mkdtemp(path.join(await fsp.mkdtemp(path.join(process.env.TEMP || '/tmp', 'byr-')), 'pkg-'));
    const result = await producer(dir);
    return { ...result, dir, storedAt: Date.now(), ephemeral: true };
  }

  await init();
  const target = packagePath(name, version);
  const staging = path.join(tmpDir, `${encodeDirName(name)}-${version}-${process.pid}-${Date.now()}`);

  const dedupeKey = `extract:${config.registry}|${name}@${version}`;
  return singleFlight(dedupeKey, async () => {
    // 合并请求后可能已经被别的请求解好了
    const done = await getExtracted(name, version);
    if (done) return done;

    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });

    try {
      const result = await producer(staging);
      const record = {
        storedAt: Date.now(),
        files: result.files,
        totalBytes: result.totalBytes,
      };
      await fsp.writeFile(path.join(staging, DONE_MARKER), JSON.stringify(record));

      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(staging, target);

      return { ...record, dir: target };
    } catch (err) {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  });
}

/** 统计磁盘缓存用量与条目数。 */
export async function diskStats() {
  /** @type {{packages:number, files:number, bytes:number}} */
  const out = { packages: 0, files: 0, bytes: 0, dir: config.cacheDir };

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth <= 2) await walk(full, depth + 1);
      } else {
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat) continue;
        if (entry.name === DONE_MARKER) out.packages += 1;
        else {
          out.files += 1;
          out.bytes += stat.size;
        }
      }
    }
  }

  await walk(config.cacheDir, 0);
  return out;
}

/** 读取磁盘上已解包的文件。 */
export async function readExtractedFile(dir, relPath) {
  return fsp.readFile(path.join(dir, relPath));
}

/** 同步判断路径是否存在（用于极热的目录检查）。 */
export function existsSync(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

export default {
  memory,
  init,
  getMeta,
  setMeta,
  packagePath,
  getExtracted,
  extractInto,
  diskStats,
  readExtractedFile,
};
