/**
 * 请求处理器：把路由结果变成 HTTP 响应。
 *
 * 这一层负责所有「HTTP 语义」：
 *   - Content-Type（按扩展名，题目必选）
 *   - Content-Length / Content-Range / Accept-Ranges（支持断点续传）
 *   - ETag + If-None-Match → 304（省流量）
 *   - Cache-Control（版本化 URL 才敢用 immutable）
 *   - Accept-Encoding → gzip / brotli
 *   - CORS（jsDelivr 的核心使用场景就是跨域 <script>/<link> 引入）
 *   - HEAD 请求、错误响应
 *
 * 另外会带一组 `x-byr-*` 诊断响应头（解析到的版本、入口文件来源、缓存命中层级、
 * 压缩前后体积），既方便排障，也让「各环节到底做了什么」在 curl -I 下一目了然。
 */

import config from './config.js';
import logger from './logger.js';
import * as store from './store.js';
import * as mime from './mime.js';
import * as compress from './compress.js';
import * as minifyLib from './minify.js';
import * as bundleLib from './bundle.js';
import { parseRoute } from './router.js';
import { renderListing, renderServiceIndex } from './listing.js';
import { HttpError, notFound, badRequest, tooLarge } from './errors.js';
import { shortHash, formatBytes } from './util.js';
import * as semver from './semver.js';

/** 压缩可省略的 MIME 前缀。 */

/**
 * 公共响应头。
 *
 * 顺带做一次 ASCII 清洗：HTTP 头只允许 ASCII 可见字符，
 * 一旦某个诊断头里混进中文或箭头符号（U+2192 之类），
 * Node 会直接抛 ERR_INVALID_CHAR 把整个响应打成 500。
 * 与其在每处拼字符串时提心吊胆，不如在出口统一兜住。
 *
 * @param {Record<string,string>} [extra]
 */
function baseHeaders(extra = {}) {
  /** @type {Record<string,string>} */
  const headers = {
    'x-powered-by': 'BYR Archive',
    ...extra,
  };
  if (config.cors) {
    headers['access-control-allow-origin'] = '*';
    headers['access-control-expose-headers'] = '*';
  }
  for (const [key, value] of Object.entries(headers)) {
    // eslint-disable-next-line no-control-regex
    if (/[^\x20-\x7e]/.test(value)) {
      headers[key] = value.replace(/[^\x20-\x7e]/g, '?');
    }
  }
  return headers;
}

/** 发送 JSON 响应。 */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  res.writeHead(
    status,
    baseHeaders({
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      ...extraHeaders,
    }),
  );
  res.end(body);
}

/** 发送 HTML 响应。 */
function sendHtml(res, status, html, extraHeaders = {}, method = 'GET') {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(
    status,
    baseHeaders({
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      ...extraHeaders,
    }),
  );
  res.end(method === 'HEAD' ? undefined : body);
}

/** 发送错误响应。 */
function sendError(res, err, method) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : '服务器内部错误';
  const payload = {
    error: message,
    status,
    ...(err instanceof HttpError ? err.extra : {}),
  };
  if (status >= 500) logger.error('处理请求失败:', err.stack || err.message);
  sendJson(res, status, payload, { 'cache-control': 'no-store' });
  if (method === 'HEAD') res.end();
}

/**
 * 解析 `Range: bytes=start-end` 请求头。
 *
 * @param {string} header
 * @param {number} size
 * @returns {{start:number, end:number}|'unsatisfiable'|null} null 表示不是 Range 请求
 */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;

  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // 后缀区间：bytes=-500 表示最后 500 字节
    const suffix = Number.parseInt(rawEnd, 10);
    if (suffix === 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd, 10), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/** 判断请求的版本描述是否「精确锁定」，用于决定 Cache-Control 的强度。 */
function isPinnedVersion(versionSpec) {
  return versionSpec !== '' && versionSpec !== 'latest' && semver.isExact(versionSpec);
}

/**
 * 提供一个文件（含入口文件）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} relPath 包内路径
 * @param {object} route
 * @param {{ entrySource?: string, needMinify?: boolean }} [options]
 */
async function serveFile(req, res, pkg, relPath, route, options = {}) {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const { entrySource, needMinify = false } = options;

  const { buffer, source } = await store.readFile(pkg, relPath);

  let body = buffer;
  let minified = false;
  const isMinifyCandidate = /\.(js|mjs|cjs|css)$/i.test(relPath);

  if (needMinify && isMinifyCandidate && config.minify) {
    const result = minifyLib.minify(relPath, buffer.toString('utf8'));
    body = Buffer.from(result.code, 'utf8');
    minified = true;
    if (result.original > 0) {
      logger.debug(
        `压缩 ${relPath}: ${formatBytes(result.original)} → ${formatBytes(result.minified)}` +
          `（${(result.ratio * 100).toFixed(1)}%）`,
      );
    }
  }

  const contentType = mime.lookup(relPath);
  const pinned = isPinnedVersion(route.versionSpec);

  // ETag 由「内容身份 + 是否压缩过」决定
  const etag = `"${shortHash(
    `${config.registry}|${pkg.name}@${pkg.version}/${relPath}|${body.length}|${minified ? 'min' : 'raw'}`,
    20,
  )}"`;

  // ---- 条件请求：命中就直接 304 ----
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
    res.writeHead(304, baseHeaders({
      etag,
      'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=600',
      'x-byr-package': pkg.name,
      'x-byr-version': pkg.version,
    }));
    res.end();
    return;
  }

  const headers = {
    'content-type': contentType,
    etag,
    'accept-ranges': 'bytes',
    'last-modified': new Date().toUTCString(),
    'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=600',
    'x-byr-package': pkg.name,
    'x-byr-version': pkg.version,
    'x-byr-resolution': pkg.how,
    'x-byr-cache': source,
    'x-byr-size': String(body.length),
  };
  if (entrySource) headers['x-byr-entry'] = `${relPath} (${entrySource})`;
  if (minified) headers['x-byr-minified'] = 'true';
  if (route.compat) headers['x-byr-url-style'] = 'jsdelivr';

  // ---- Range 请求：不压缩，返回 206 ----
  const rangeHeader = req.headers.range;
  if (rangeHeader && method === 'GET') {
    const range = parseRange(rangeHeader, body.length);
    if (range === 'unsatisfiable') {
      res.writeHead(416, baseHeaders({
        'content-range': `bytes */${body.length}`,
        'content-type': contentType,
      }));
      res.end();
      return;
    }
    if (range) {
      const slice = body.subarray(range.start, range.end + 1);
      res.writeHead(206, baseHeaders({
        ...headers,
        'content-length': String(slice.length),
        'content-range': `bytes ${range.start}-${range.end}/${body.length}`,
      }));
      res.end(method === 'HEAD' ? undefined : slice);
      return;
    }
  }

  // ---- 传输压缩 ----
  const encoding = compress.negotiate(req.headers['accept-encoding']);
  if (encoding !== 'identity' && compress.shouldCompress(contentType, body.length)) {
    const compressed = await compress.compress(
      `${config.registry}|${pkg.name}@${pkg.version}/${relPath}|${minified ? 'min' : 'raw'}`,
      body,
      encoding,
    );
    // 压缩后不一定更小（极小文件），不划算就退回原样
    if (compressed.length < body.length) {
      headers['content-encoding'] = encoding;
      headers.vary = 'accept-encoding';
      headers['content-length'] = String(compressed.length);
      headers['x-byr-compressed'] = `${body.length}->${compressed.length}`;
      res.writeHead(200, baseHeaders(headers));
      res.end(method === 'HEAD' ? undefined : compressed);
      return;
    }
  }

  headers['content-length'] = String(body.length);
  headers.vary = 'accept-encoding';
  res.writeHead(200, baseHeaders(headers));
  res.end(method === 'HEAD' ? undefined : body);
}

/** 提供一个目录列表页。 */
function serveListing(req, res, pkg, route, entryPath) {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const { files, dirs } = store.listDir(pkg, route.subPath);

  const versionPart = route.versionSpec === '' ? '' : `@${route.versionSpec}`;
  const compatPart = route.compat ? '/npm' : '';
  const dirPart = route.subPath === '' ? '' : `${route.subPath}/`;
  const baseUrl = `${compatPart}/${encodeURIComponent(pkg.name)}${versionPart}/${dirPart}`;

  const html = renderListing({
    name: pkg.name,
    version: pkg.version,
    dir: route.subPath,
    files,
    dirs,
    baseUrl,
    entryPath: entryPath ?? '',
  });

  sendHtml(
    res,
    200,
    html,
    {
      'cache-control': 'public, max-age=300',
      'x-byr-package': pkg.name,
      'x-byr-version': pkg.version,
      'x-byr-resolution': pkg.how,
    },
    method,
  );
}

/** 提供一个入口文件。 */
async function serveEntry(req, res, pkg, route) {
  const entry = store.resolveEntry(pkg);
  // 入口路径必须是合法文件，否则视为包结构异常
  if (store.stat(pkg, entry.path) !== 'file') {
    throw notFound(`入口文件 ${entry.path} 不存在于包 ${pkg.name}@${pkg.version} 中`, {
      entry: entry.path,
    });
  }
  const needMinify = isMinifyRequested(route.query);
  await serveFile(req, res, pkg, entry.path, route, {
    entrySource: entry.source,
    needMinify,
  });
}

/** 解析「是否要求压缩」：`?min` / `?min=1` / `?minify`。 */
function isMinifyRequested(query) {
  if (!query) return false;
  for (const key of ['min', 'minify', 'minified']) {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      const value = String(query[key]).toLowerCase();
      return value !== '0' && value !== 'false' && value !== 'no';
    }
  }
  return false;
}

/**
 * 处理一个普通文件的请求，包含 `.min.js` 回退逻辑。
 */
async function handleFileRoute(req, res, pkg, route) {
  let target = route.subPath;
  let needMinify = isMinifyRequested(route.query);
  const query = { ...route.query };
  delete query.min;
  delete query.minify;
  delete query.minified;

  // 打包模式：?bundle / ?esm
  const wantBundle =
    Object.prototype.hasOwnProperty.call(route.query, 'bundle') ||
    Object.prototype.hasOwnProperty.call(route.query, 'esm');

  let state = store.stat(pkg, target);

  // jsDelivr 的经典行为：请求 `xxx.min.js` 而包里没有时，
  // 自动取 `xxx.js` 并在服务端压缩后返回，而不是 404。
  if (state !== 'file') {
    const fallback = target.replace(/\.min\.(js|mjs|cjs|css)$/i, '.$1');
    if (fallback !== target && store.stat(pkg, fallback) === 'file') {
      logger.debug(`${target} 不存在，回退到 ${fallback} 并即时压缩`);
      target = fallback;
      needMinify = true;
      state = 'file';
    }
  }

  if (state !== 'file') {
    throw notFound(`包 ${pkg.name}@${pkg.version} 中不存在 ${route.subPath}`, {
      path: route.subPath,
    });
  }

  if (wantBundle && /\.(js|mjs|cjs)$/i.test(target)) {
    let mode = 'auto';
    if (Object.prototype.hasOwnProperty.call(route.query, 'esm')) mode = 'rewrite';
    const bundleValue = String(route.query.bundle ?? '').toLowerCase();
    if (['inline', 'cjs', '1', 'true'].includes(bundleValue)) mode = 'inline';
    if (['rewrite', 'esm', 'flatten'].includes(bundleValue)) mode = 'rewrite';

    await bundleLib.serveBundle(req, res, pkg, target, route, { minify: needMinify, mode });
    return;
  }

  await serveFile(req, res, pkg, target, route, { needMinify });
}

/**
 * 顶层入口。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleRequest(req, res) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      `${req.method} ${req.url} → ${res.statusCode} ${ms.toFixed(1)}ms` +
        (res.getHeader('x-byr-version') ? ` [${res.getHeader('x-byr-version')}]` : ''),
    );
  });

  // 只接受 GET / HEAD / OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, baseHeaders({
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    }));
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: '仅支持 GET / HEAD / OPTIONS', status: 405 }, {
      allow: 'GET, HEAD, OPTIONS',
    });
    return;
  }

  let route;
  try {
    route = parseRoute(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    sendError(res, err, req.method);
    return;
  }

  try {
    switch (route.kind) {
      case 'index':
        sendHtml(
          res,
          200,
          renderServiceIndex({ registry: config.registry, port: config.port }),
          { 'cache-control': 'public, max-age=60' },
          req.method,
        );
        return;

      case 'health':
        sendJson(res, 200, {
          status: 'ok',
          registry: config.registry,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        }, { 'cache-control': 'no-store' });
        return;

      case 'stats': {
        const disk = await cache.diskStats();
        sendJson(res, 200, {
          upstream: config.registry,
          memoryCache: cache.memory.stats(),
          diskCache: disk,
          config: {
            ttl: config.ttl,
            maxTarballBytes: config.maxTarballBytes,
            memoryCacheBytes: config.memoryCacheBytes,
            minify: config.minify,
            compress: config.compress,
          },
        }, { 'cache-control': 'no-store' });
        return;
      }

      case 'not-found':
        throw notFound(`资源不存在: ${req.url}`);

      case 'entry': {
        const pkg = await store.loadPackage(route.name, route.versionSpec);
        await serveEntry(req, res, pkg, route);
        return;
      }

      case 'listing': {
        const pkg = await store.loadPackage(route.name, route.versionSpec);
        if (route.subPath !== '' && store.stat(pkg, route.subPath) !== 'dir') {
          throw notFound(`包 ${pkg.name}@${pkg.version} 中不存在目录 ${route.subPath}`, {
            path: route.subPath,
          });
        }
        let entryPath = '';
        try {
          entryPath = store.resolveEntry(pkg).path;
        } catch {
          entryPath = '';
        }
        serveListing(req, res, pkg, route, entryPath);
        return;
      }

      case 'file': {
        const pkg = await store.loadPackage(route.name, route.versionSpec);
        await handleFileRoute(req, res, pkg, route);
        return;
      }

      default:
        throw badRequest(`未知的路由类型: ${route.kind}`);
    }
  } catch (err) {
    sendError(res, err, req.method);
  }
}

export default { handleRequest, parseRange };
