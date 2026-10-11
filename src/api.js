/**
 * 包信息 JSON API（`/_api/...`）。
 *
 * 动机：目录列表页是给**人**看的，但 CDN 的下游常常是**程序**：
 *   - 构建脚本想知道「`^3.2.0` 到底解析到了哪个版本」；
 *   - 前端工具想拿到某个包的完整文件清单去做预加载；
 *   - 监控想检查「这个包的入口文件是不是变了」。
 *
 * 让这些场景去解析 HTML 或抓 tarball 是荒谬的，所以补一组只返回 JSON 的接口。
 * 它们复用与文件服务**完全相同的**解析链路（`store.loadPackage`），
 * 因此返回的版本、入口、文件树和服务实际提供的内容**永远不会不一致** ——
 * 这一点比接口本身更重要。
 *
 * 接口一览：
 *   GET /_api/{包名}[@{版本}]                    包的解析结果与概览
 *   GET /_api/{包名}[@{版本}]/tree               完整文件树
 *   GET /_api/{包名}[@{版本}]/dir[/子目录]        目录的 JSON 列表
 *   GET /_api/{包名}[@{版本}]/file/{文件路径}     单个文件的元信息
 *   GET /_api/_search?q=...                      （预留）搜索，未实现
 */

import config from './config.js';
import * as store from './store.js';
import * as mime from './mime.js';
import { cdnUrl } from './bundle.js';
import { notFound, badRequest } from './errors.js';
import { formatBytes } from './util.js';

/** 去掉可能泄露内部信息的字段，只保留对调用者有用的部分。 */
function summarizeManifest(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type,
    homepage: manifest.homepage,
    repository: manifest.repository?.url || manifest.repository,
    main: manifest.main,
    module: manifest.module,
    browser: manifest.browser,
    unpkg: manifest.unpkg,
    jsdelivr: manifest.jsdelivr,
    types: manifest.types || manifest.typings,
    sideEffects: manifest.sideEffects,
    engines: manifest.engines,
    dependencies: manifest.dependencies,
    peerDependencies: manifest.peerDependencies,
    optionalDependencies: manifest.optionalDependencies,
  };
}

/** 去掉 undefined 字段，让响应更干净。 */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/**
 * `/_api/{pkg}@{ver}` —— 包的解析结果与概览。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {object} route
 */
export function packageInfo(pkg, route) {
  let entry = null;
  let entryError = null;
  try {
    entry = store.resolveEntry(pkg);
  } catch (err) {
    entryError = err.message;
  }

  const dist = pkg.manifest.dist || {};

  return compact({
    requested: {
      package: pkg.name,
      spec: route.versionSpec || 'latest',
      urlStyle: route.compat ? 'jsdelivr' : 'plain',
    },
    resolved: {
      version: pkg.version,
      // 版本是怎么算出来的：exact / latest / range / dist-tag:xxx
      how: pkg.how,
      // 范围解析时上游一共提供了多少个候选版本（用于判断解析是否合理）
      candidates: pkg.candidates,
    },
    entry: entry
      ? {
          path: entry.path,
          // 命中入口解析优先级链的哪一条
          source: entry.source,
          url: cdnUrl(pkg.name, pkg.version, entry.path),
          contentType: mime.lookup(entry.path),
        }
      : undefined,
    entryError: entryError || undefined,
    contents: {
      files: pkg.fileIndex.size,
      directories: pkg.dirIndex.size,
      bytes: pkg.totalBytes,
      bytesHuman: formatBytes(pkg.totalBytes),
    },
    dist: compact({
      tarball: dist.tarball,
      shasum: dist.shasum,
      integrity: dist.integrity,
      unpackedSize: dist.unpackedSize,
      fileCount: dist.fileCount,
    }),
    manifest: summarizeManifest(pkg.manifest),
    upstream: {
      registry: config.registry,
      registrySource: config.registrySource,
    },
    unpackedAt: new Date(pkg.storedAt).toISOString(),
  });
}

/**
 * `/_api/{pkg}@{ver}/tree` —— 完整文件树。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 */
export function fileTree(pkg) {
  const files = [...pkg.fileIndex.entries()]
    .map(([path, size]) => ({
      path,
      size,
      contentType: mime.lookup(path),
      url: cdnUrl(pkg.name, pkg.version, path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));

  return {
    package: pkg.name,
    version: pkg.version,
    count: files.length,
    totalBytes: pkg.totalBytes,
    files,
  };
}

/**
 * `/_api/{pkg}@{ver}/dir/{子目录}` —— 目录的 JSON 列表。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} dirPath 包内相对目录路径（'' 表示包根）
 */
export function directoryListing(pkg, dirPath) {
  if (dirPath !== '' && store.stat(pkg, dirPath) !== 'dir') {
    throw notFound(`包 ${pkg.name}@${pkg.version} 中不存在目录 ${dirPath}`, { path: dirPath });
  }

  const { files, dirs } = store.listDir(pkg, dirPath);

  return {
    package: pkg.name,
    version: pkg.version,
    dir: dirPath,
    dirs: dirs.map((name) => ({
      name,
      path: dirPath === '' ? name : `${dirPath}/${name}`,
      url: cdnUrl(pkg.name, pkg.version, dirPath === '' ? `${name}/` : `${dirPath}/${name}/`),
    })),
    files: files.map((file) => {
      const path = dirPath === '' ? file.name : `${dirPath}/${file.name}`;
      return {
        name: file.name,
        path,
        size: file.size,
        bytesHuman: formatBytes(file.size),
        contentType: mime.lookup(path),
        url: cdnUrl(pkg.name, pkg.version, path),
      };
    }),
  };
}

/**
 * `/_api/{pkg}@{ver}/file/{路径}` —— 单个文件的元信息（不返回内容）。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} filePath 包内相对路径
 */
export function fileInfo(pkg, filePath) {
  if (filePath === '') {
    throw badRequest('请提供文件路径，例如 /_api/vue@3.3.4/file/dist/vue.global.js');
  }

  const state = store.stat(pkg, filePath);
  if (state !== 'file') {
    throw notFound(`包 ${pkg.name}@${pkg.version} 中不存在文件 ${filePath}`, {
      path: filePath,
      state,
    });
  }

  const size = pkg.fileIndex.get(filePath) ?? 0;
  const url = cdnUrl(pkg.name, pkg.version, filePath);

  let entryPath = '';
  try {
    entryPath = store.resolveEntry(pkg).path;
  } catch {
    entryPath = '';
  }

  return compact({
    package: pkg.name,
    version: pkg.version,
    path: filePath,
    size,
    bytesHuman: formatBytes(size),
    contentType: mime.lookup(filePath),
    url,
    isEntry: entryPath === filePath,
    variants: {
      minified: `${url}?min`,
      bundled: /\.(js|mjs|cjs)$/i.test(filePath) ? `${url}?bundle` : undefined,
      esmRewritten: /\.(js|mjs|cjs)$/i.test(filePath) ? `${url}?esm` : undefined,
    },
  });
}

/**
 * 统一入口：按 `route.api` 分派。
 *
 * @param {object} route
 * @param {any} pkg 延迟加载的包对象
 */
export function handle(route, pkg) {
  switch (route.api) {
    case 'tree':
      return fileTree(pkg);
    case 'dir':
      return directoryListing(pkg, route.subPath);
    case 'file':
      return fileInfo(pkg, route.subPath);
    case 'info':
    default:
      return packageInfo(pkg, route);
  }
}

export default { handle, packageInfo, fileTree, directoryListing, fileInfo };
