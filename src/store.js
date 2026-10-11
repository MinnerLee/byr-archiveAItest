/**
 * 包仓库层：把「包名 + 版本」变成「可读的文件树」。
 *
 * 这是整条链路的粘合层：
 *   registry.resolveVersion  →  拿到 tarball 地址
 *   registry.openTarball     →  拿到字节流
 *   tar.extractTgz           →  解包到磁盘
 *   cache.extractInto        →  原子落盘 + 请求合并
 *
 * 对外只暴露「像文件系统一样」的接口：exists / stat / read / list，
 * 上层 handler 不需要知道 tarball、缓存、内存 LRU 这些细节。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import config from './config.js';
import logger from './logger.js';
import * as cache from './cache.js';
import * as registry from './registry.js';
import * as tar from './tar.js';
import entryResolver from './entry.js';
import { upstreamError, notFound, tooLarge, badRequest } from './errors.js';
import { shortHash } from './util.js';
import { createSemaphore } from './semaphore.js';
import { metrics } from './metrics.js';
import { createIntegrityChecker, describe as describeIntegrity } from './integrity.js';
import { singleFlight } from './util.js';
import { Transform } from 'node:stream';

/**
 * 全局解包信号量。
 *
 * 这是 config 里 `MAX_CONCURRENT_EXTRACT` 真正生效的地方 ——
 * 之前这个配置项只是被声明、从未被使用（一个「空承诺」），现在补上。
 * 它把「同时进行的下载 + 解包」限制在一个固定并发度内：
 * 超出的请求排队等待，而不是一起抢事件循环和磁盘。
 */
const extractSemaphore = createSemaphore(config.maxConcurrentExtract, {
  maxQueue: config.maxExtractQueue,
});

/**
 * @typedef {object} MaterializedPackage
 * @property {string} name
 * @property {string} version
 * @property {any} manifest 完整 manifest（含入口字段）
 * @property {string} dir 解包后磁盘目录
 * @property {Map<string, number>} fileIndex 包内相对路径 → 大小
 * @property {Set<string>} dirIndex 包内目录集合（不含空目录）
 * @property {number} totalBytes
 * @property {number} storedAt 解包落盘时间戳（用于 Last-Modified）
 * @property {string} how 版本解析方式
 */

/**
 * 若解包结果被一层「包装目录」包住（某些私有 registry 的 tarball
 * 条目名是 `foo-1.0.0/...` 而不是 npm 官方的 `package/...`），
 * 就把这层目录拍平，保证后续所有逻辑都假设「根目录 = 包根」。
 *
 * @param {string} dir
 */
async function flattenWrapperDir(dir) {
  const rootEntries = await fsp.readdir(dir, { withFileTypes: true });
  if (rootEntries.some((e) => e.name === 'package.json')) return; // 已经是包根

  const dirs = rootEntries.filter((e) => e.isDirectory());
  if (rootEntries.length !== 1 || dirs.length !== 1) return; // 结构不明确，不做处理

  const wrapper = dirs[0].name;
  const wrapperPath = path.join(dir, wrapper);
  const inner = await fsp.readdir(wrapperPath, { withFileTypes: true });
  if (!inner.some((e) => e.name === 'package.json')) return;

  logger.debug(`检测到包装目录 ${wrapper}/，拍平到包根`);

  // 移动到上层：先把 wrapper 里每一项 rename 到父目录
  for (const item of inner) {
    await fsp.rename(path.join(wrapperPath, item.name), path.join(dir, item.name));
  }
  await fsp.rm(wrapperPath, { recursive: true, force: true });
}

/**
 * 下载并解包一个包版本，返回文件树索引。
 *
 * @param {string} name
 * @param {string} version
 * @param {string} tarballUrl
 * @returns {Promise<{dir:string, files:Array<{path:string,size:number}>, totalBytes:number}>}
 */
async function materialize(name, version, tarballUrl, dist) {
  const cached = await cache.getExtracted(name, version);
  if (cached) {
    logger.debug(`解包结果命中磁盘缓存: ${name}@${version}`);
    metrics.cacheAccess('extracted', true);
    return {
      dir: cached.dir,
      files: cached.files,
      totalBytes: cached.totalBytes,
      // 解包时间：作为该版本文件的 Last-Modified 依据（见 handler 的说明）
      storedAt: cached.storedAt,
    };
  }
  metrics.cacheAccess('extracted', false);

  /**
   * 关键顺序：**先去重，再抢信号量名额**。
   *
   * 这里修掉了一个真实的并发缺陷：原来的写法是
   *     await extractSemaphore.run(() => cache.extractInto(...))
   * 而「同一包只解一次」的去重逻辑在 `cache.extractInto` **内部**。
   * 后果是 N 个并发请求会先各自占掉一个信号量名额（或排进队列），
   * 等轮到它们时才发现在去重表里被合并了 —— 队列额度被同一份工作白白吃光。
   *
   * 实测：100 个并发请求同一个冷包时，4 个执行 + 64 个排队 = 68 个占满队列，
   * 剩下 32 个请求直接拿到 `E_QUEUE_FULL`。
   *
   * 把 singleFlight 提到信号量**外面**之后，N 个并发请求只剩 1 个进入信号量。
   */
  const dedupeKey = `materialize:${config.registry}|${name}@${version}`;

  return singleFlight(dedupeKey, async () => {
    // 合并等待期间可能已经被别的请求解好了，二次确认避免重复劳动
    const done = await cache.getExtracted(name, version);
    if (done) {
      return {
        dir: done.dir,
        files: done.files,
        totalBytes: done.totalBytes,
        storedAt: done.storedAt,
      };
    }

    logger.info(`下载并解包 ${name}@${version} <- ${tarballUrl}`);
    const startedAt = Date.now();

    // 整段「下载 + 解包」都在信号量保护下，避免并发冷包把 CPU 与磁盘打满
    try {
      const result = await extractSemaphore.run(() =>
        cache.extractInto(name, version, async (dir) => {
          const { stream, contentLength } = await registry.openTarball(tarballUrl, config.maxTarballBytes);
          if (contentLength) logger.debug(`tarball 体积 ${contentLength} 字节`);

          /**
           * 完整性校验：边流边算哈希，不额外缓冲。
           *
           * 校验在**写入缓存之前**完成 —— 解包结果只有在完整、可信时才会
           * 被 rename 到正式缓存目录；校验失败会抛错，由 extractInto 清理 staging。
           */
          const checker = config.verifyIntegrity ? createIntegrityChecker(dist) : null;
          let source = stream;
          if (checker) {
            source = stream.pipe(
              new Transform({
                transform(chunk, _enc, cb) {
                  checker.update(chunk);
                  cb(null, chunk);
                },
              }),
            );
          }

          const unpacked = await tar.extractTgz(source, dir, {
            // npm 官方 registry 的条目统一以 `package/` 开头
            stripPrefix: 'package/',
            maxTotalBytes: config.maxTarballBytes * 8,
            maxFileBytes: config.maxFileBytes,
          });

          if (checker) {
            const verdict = checker.verify();
            if (!verdict.ok) {
              const failed = verdict.checks.filter((c) => !c.ok);
              throw upstreamError(
                `tarball 完整性校验失败（${name}@${version}）：` +
                  failed.map((c) => `${c.algo} 期望 ${c.expected}，实际 ${c.actual}`).join('；') +
                  '。已丢弃本次解包结果，不会写入缓存。',
                { name, version, tarball: tarballUrl, checks: verdict.checks },
              );
            }
            logger.debug(`完整性校验通过 ${name}@${version}: ${describeIntegrity(verdict)}`);
          }

          await flattenWrapperDir(dir);

          // 拍平后文件清单可能变了，重新扫描一次磁盘，保证索引与磁盘一致
          const files = await scanFiles(dir);
          const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

          logger.info(
            `解包完成 ${name}@${version}: ${files.length} 个文件，共 ${totalBytes} 字节` +
              (unpacked.skipped ? `（跳过 ${unpacked.skipped} 个非普通文件条目）` : '') +
              (checker ? '（完整性已校验）' : ''),
          );

          return { files, totalBytes };
        }),
      );

      metrics.extraction({
        ms: Date.now() - startedAt,
        bytes: result.totalBytes,
        files: result.files.length,
        ok: true,
      });
      return result;
    } catch (err) {
      metrics.extraction({ ms: Date.now() - startedAt, bytes: 0, files: 0, ok: false });
      throw err;
    }
  });
}

/** 递归扫描目录，产出「相对路径 + 大小」清单。 */
async function scanFiles(root) {
  /** @type {Array<{path:string,size:number,mtime:number}>} */
  const out = [];

  async function walk(dir, prefix) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of entries) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full, rel);
      } else if (item.isFile()) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) out.push({ path: rel, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
      }
    }
  }

  await walk(root, '');
  return out;
}

/** 由文件清单推导出目录集合（包含所有中间层级）。 */
function buildDirIndex(files) {
  const dirs = new Set();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      dirs.add(segments.slice(0, i).join('/'));
    }
  }
  return dirs;
}

/**
 * 把一个请求解析成「已就绪的包」。
 *
 * @param {string} name 包名
 * @param {string} versionSpec 版本描述（可为空）
 * @returns {Promise<MaterializedPackage>}
 */
export async function loadPackage(name, versionSpec) {
  if (!registry.isValidName(name)) {
    throw badRequest(`非法的包名: ${name}`);
  }

  const { version, manifest, how, candidates } = await registry.resolveVersion(name, versionSpec);

  const tarballUrl = manifest?.dist?.tarball;
  if (!tarballUrl) {
    throw upstreamError(`版本 ${name}@${version} 的元信息里没有 dist.tarball，无法获取文件`, {
      name,
      version,
    });
  }

  const materialized = await materialize(name, version, tarballUrl, manifest.dist);

  return {
    name,
    version,
    manifest,
    how,
    candidates,
    dir: materialized.dir,
    totalBytes: materialized.totalBytes,
    storedAt: materialized.storedAt || Date.now(),
    fileIndex: new Map(materialized.files.map((f) => [f.path, f.size])),
    dirIndex: buildDirIndex(materialized.files),
    files: materialized.files,
  };
}

/**
 * 读取包内文件。
 *
 * 命中路径：内存 LRU → 磁盘。文件内容在「同一个版本」下不可变，
 * 因此可以用很长的 TTL（默认 7 天），实际靠 LRU 的字节上限来控内存。
 *
 * @param {MaterializedPackage} pkg
 * @param {string} relPath
 * @returns {Promise<{buffer:Buffer, source:'memory'|'disk'}>}
 */
export async function readFile(pkg, relPath) {
  const key = `file:${config.registry}|${pkg.name}@${pkg.version}/${relPath}`;

  const cached = cache.memory.get(key);
  if (cached) {
    logger.debug(`文件命中内存缓存: ${key}`);
    return { buffer: cached, source: 'memory' };
  }

  const size = pkg.fileIndex.get(relPath) ?? 0;
  if (size > config.maxFileBytes) {
    throw tooLarge(`文件 ${relPath} 体积 ${size} 字节，超过单文件上限`, { path: relPath, size });
  }

  let buffer;
  try {
    buffer = await cache.readExtractedFile(pkg.dir, relPath);
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(`包内不存在文件: ${relPath}`, { path: relPath });
    throw err;
  }

  cache.memory.set(key, buffer, config.ttl.file, buffer.length);
  return { buffer, source: 'disk' };
}

/**
 * 判断包内某路径是文件、目录还是不存在。
 * @param {MaterializedPackage} pkg
 * @param {string} relPath
 * @returns {'file'|'dir'|'missing'}
 */
export function stat(pkg, relPath) {
  if (relPath === '') return 'dir';
  if (pkg.fileIndex.has(relPath)) return 'file';
  if (pkg.dirIndex.has(relPath)) return 'dir';
  return 'missing';
}

/**
 * 列出某个目录的直接子项。
 *
 * @param {MaterializedPackage} pkg
 * @param {string} relPath 目录的包内相对路径（'' 表示包根）
 * @returns {{files:Array<{name:string,size:number}>, dirs:string[]}}
 */
export function listDir(pkg, relPath) {
  const prefix = relPath === '' ? '' : `${relPath}/`;
  const files = [];
  const dirs = new Set();

  for (const [filePath, size] of pkg.fileIndex) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push({ name: rest, size });
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const dirList = [...dirs].sort((a, b) => a.localeCompare(b, 'en'));

  return { files, dirs: dirList };
}

/**
 * 解析入口文件（题目要求的优先级链）。
 *
 * @param {MaterializedPackage} pkg
 * @param {object} [options]
 * @param {boolean} [options.nodeDefault] 4 条规则全落空时是否回退到 Node 默认解析（包根 index.js）。
 *        HTTP 路径默认不启用（题面规则 4 要求 404）；打包器解析依赖包时会启用。
 * @returns {{path:string, source:string}}
 */
export function resolveEntry(pkg, options = {}) {
  const nodeDefault = options.nodeDefault ?? config.entryNodeDefault;

  const entry = entryResolver.resolveEntry(
    pkg.manifest,
    (relPath) => pkg.fileIndex.has(relPath),
    { ...options, nodeDefault },
  );

  if (!entry) {
    // 如果包里其实存在 index.js，说明这个包依赖 Node 的默认解析。
    // 直接给 404 会让人一头雾水，所以把原因和解决办法一并写进响应体。
    const nodeCandidate = ['index.js', 'index.mjs', 'index.cjs', 'index.json'].find((f) =>
      pkg.fileIndex.has(f),
    );

    throw notFound(
      `包 ${pkg.name}@${pkg.version} 没有可用的入口文件（jsdelivr / exports["."] / main 均未命中）`,
      {
        package: pkg.name,
        version: pkg.version,
        ...(nodeCandidate
          ? {
              hint:
                `该包的 package.json 未声明 main / exports，但包含 ${nodeCandidate}。` +
                'Node 会默认解析到它；本服务默认严格遵循题面规则返回 404。' +
                '设置 ENTRY_NODE_DEFAULT=1 可启用 Node 默认解析回退。',
              nodeDefaultCandidate: nodeCandidate,
              enableWith: `直接访问文件 /${pkg.name}@${pkg.version}/${nodeCandidate}`,
            }
          : {}),
      },
    );
  }

  return entry;
}

/**
 * 解包信号量的运行状态（供 /_metrics 与 /_stats 使用）。
 * @returns {{active:number,queued:number,limit:number,peakActive:number,completed:number,waitedMs:number}}
 */
export function extractStats() {
  return extractSemaphore.stats();
}

/** 缓存键工具，供上层构造稳定的 ETag。 */
export function contentEtag(pkg, relPath, buffer) {
  return `"${shortHash(`${pkg.name}@${pkg.version}/${relPath}:${buffer.length}`, 20)}"`;
}

export default {
  loadPackage,
  readFile,
  stat,
  listDir,
  resolveEntry,
  contentEtag,
  extractStats,
};
