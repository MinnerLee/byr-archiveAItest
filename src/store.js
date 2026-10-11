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

/**
 * @typedef {object} MaterializedPackage
 * @property {string} name
 * @property {string} version
 * @property {any} manifest 完整 manifest（含入口字段）
 * @property {string} dir 解包后磁盘目录
 * @property {Map<string, number>} fileIndex 包内相对路径 → 大小
 * @property {Set<string>} dirIndex 包内目录集合（不含空目录）
 * @property {number} totalBytes
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
async function materialize(name, version, tarballUrl) {
  const cached = await cache.getExtracted(name, version);
  if (cached) {
    logger.debug(`解包结果命中磁盘缓存: ${name}@${version}`);
    return { dir: cached.dir, files: cached.files, totalBytes: cached.totalBytes };
  }

  logger.info(`下载并解包 ${name}@${version} ← ${tarballUrl}`);

  return cache.extractInto(name, version, async (dir) => {
    const { stream, contentLength } = await registry.openTarball(tarballUrl, config.maxTarballBytes);
    if (contentLength) logger.debug(`tarball 体积 ${contentLength} 字节`);

    const result = await tar.extractTgz(stream, dir, {
      // npm 官方 registry 的条目统一以 `package/` 开头
      stripPrefix: 'package/',
      maxTotalBytes: config.maxTarballBytes * 8,
      maxFileBytes: config.maxFileBytes,
    });

    await flattenWrapperDir(dir);

    // 拍平后文件清单可能变了，重新扫描一次磁盘，保证索引与磁盘一致
    const files = await scanFiles(dir);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

    logger.info(
      `解包完成 ${name}@${version}: ${files.length} 个文件，共 ${totalBytes} 字节` +
        (result.skipped ? `（跳过 ${result.skipped} 个非普通文件条目）` : ''),
    );

    return { files, totalBytes };
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

  const materialized = await materialize(name, version, tarballUrl);

  return {
    name,
    version,
    manifest,
    how,
    candidates,
    dir: materialized.dir,
    totalBytes: materialized.totalBytes,
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
 * @returns {{path:string, source:string}}
 */
export function resolveEntry(pkg) {
  const entry = entryResolver.resolveEntry(pkg.manifest, (relPath) => pkg.fileIndex.has(relPath));

  if (!entry) {
    throw notFound(
      `包 ${pkg.name}@${pkg.version} 没有可用的入口文件（jsdelivr / exports["."] / main 均未命中）`,
      { package: pkg.name, version: pkg.version },
    );
  }

  return entry;
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
};
