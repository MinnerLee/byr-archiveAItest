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
import * as cache from './cache.js';
import * as mime from './mime.js';
import * as compress from './compress.js';
import * as minifyPool from './minify-pool.js';
import * as bundleLib from './bundle.js';
import { parseRoute } from './router.js';
import { renderListing, renderServiceIndex } from './listing.js';
import * as api from './api.js';
import { HttpError, notFound, badRequest } from './errors.js';
import { shortHash, formatBytes } from './util.js';
import * as semver from './semver.js';
import { metrics, renderPrometheus, snapshot as metricsSnapshot } from './metrics.js';
import { createRateLimiter, clientKey } from './ratelimit.js';

/* ------------------------------------------------------------------ */
/* 限流器                                                              */
/* ------------------------------------------------------------------ */

/**
 * 限流器是模块级单例，但可以通过 {@link setRateLimit} 重新配置。
 *
 * 为什么要留一个运行时开关而不是只读环境变量？
 * 因为「默认开启限流」对一个 CDN 来说是不合适的（会误伤正常批量拉取的构建脚本），
 * 但「限流代码只是摆设、永远不会被执行」又等于没实现。
 * 所以：默认关闭，但完整实现、可运行时开启、并有自动化测试覆盖。
 */
let rateLimiter = createRateLimiter({
  perMinute: config.rateLimitPerMinute,
  burst: config.rateLimitBurst || config.rateLimitPerMinute,
  maxKeys: config.rateLimitMaxKeys,
  trustProxy: config.trustProxy,
});

/**
 * 运行时重新配置限流。
 * @param {number} perMinute 每分钟额度，0 表示关闭
 * @param {number} [burst] 突发容量
 */
export function setRateLimit(perMinute, burst) {
  rateLimiter = createRateLimiter({
    perMinute,
    burst: burst || perMinute,
    maxKeys: config.rateLimitMaxKeys,
    trustProxy: config.trustProxy,
  });
  return rateLimiter;
}

/** 取限流器当前状态。 */
export function rateLimitStats() {
  return rateLimiter.stats();
}

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
  if (config.securityHeaders) {
    // 禁止浏览器 MIME 嗅探：否则「包内放一个名字像脚本、内容是 HTML 的文件」
    // 可能被浏览器当成脚本来执行。jsDelivr 也发送这个头。
    headers['x-content-type-options'] = 'nosniff';
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
  /** @type {Record<string,string>} */
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    ...extraHeaders,
  };
  if (config.securityHeaders && !headers['content-security-policy']) {
    // 本服务的 HTML 只有目录列表页和服务首页，都是纯静态内联样式：
    // 放开 style，其余一律禁止。这样即使某个环节的转义出了问题，
    // 注入的脚本也无法执行、无法外联 —— 属于纵深防御的第二层。
    headers['content-security-policy'] =
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
    headers['referrer-policy'] = 'no-referrer';
  }
  res.writeHead(status, baseHeaders(headers));
  res.end(method === 'HEAD' ? undefined : body);
}

/**
 * 把「非 HttpError 但语义明确的错误」翻译成合适的 HTTP 状态码。
 *
 * `E_QUEUE_FULL`（解包队列已满）是**可重试**的暂时性失败，
 * 应该返回 503 + Retry-After，而不是 500 —— 后者会让客户端以为
 * 「这个请求本身是坏的」，从而不去重试。
 */
const RETRYABLE_CODES = {
  E_QUEUE_FULL: { status: 503, message: '服务繁忙：解包队列已满，请稍后重试', retryAfter: 1 },
  E_TOO_LARGE: { status: 413, message: '请求的内容超过体积上限', retryAfter: 0 },
};

/** 发送错误响应。 */
function sendError(res, err, method) {
  const retryable = err && err.code ? RETRYABLE_CODES[err.code] : undefined;

  let status;
  let message;
  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else if (retryable) {
    status = retryable.status;
    message = retryable.message;
  } else {
    status = 500;
    message = '服务器内部错误';
  }

  const payload = {
    error: message,
    status,
    ...(err instanceof HttpError ? err.extra : {}),
    ...(retryable ? { code: err.code, retryable: true } : {}),
  };

  // 4xx 是调用方的问题，不该刷 error 级别日志；5xx 才是服务端需要关注的
  if (status >= 500) logger.error('处理请求失败:', err.stack || err.message);

  const extraHeaders = { 'cache-control': 'no-store' };
  if (retryable && retryable.retryAfter > 0) extraHeaders['retry-after'] = String(retryable.retryAfter);

  sendJson(res, status, payload, extraHeaders);
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
  let minifySkipped = '';
  const isMinifyCandidate = /\.(js|mjs|cjs|css)$/i.test(relPath);

  if (needMinify && isMinifyCandidate && config.minify) {
    if (buffer.length > config.minifyMaxBytes) {
      /**
       * 体积闸门：代码压缩是**同步**的，会独占事件循环。
       * 实测压缩 531KB 的 lodash.js 需要 500ms 以上，这期间该进程
       * 无法处理任何其它请求。对一个要对外服务的 CDN 来说，
       * 「一个匿名请求就能让服务僵住半秒」是不可接受的，所以给它一个上限：
       * 超过就返回原文件并说明原因，让调用方自行决定是否离线压缩。
       */
      minifySkipped = 'too-large';
      logger.debug(
        `跳过即时压缩 ${relPath}（${formatBytes(buffer.length)} > 上限 ${formatBytes(config.minifyMaxBytes)}）`,
      );
    } else {
      const minCacheKey = `min:${config.registry}|${pkg.name}@${pkg.version}/${relPath}`;
      const cachedMin = await cache.getBlob(minCacheKey);

      if (cachedMin) {
        body = cachedMin;
        minified = true;
        metrics.cacheAccess('minify', true);
      } else {
        metrics.cacheAccess('minify', false);
        // 走 worker 线程：压缩是 CPU 密集的，放主线程会独占事件循环
        const result = await minifyPool.minify(relPath, buffer.toString('utf8'));
        body = Buffer.from(result.code, 'utf8');
        minified = true;
        await cache.setBlob(minCacheKey, body);
        if (result.original > 0) {
          logger.debug(
            `压缩 ${relPath}: ${formatBytes(result.original)} -> ${formatBytes(result.minified)}` +
              `（降 ${((1 - result.ratio) * 100).toFixed(1)}%）`,
          );
          metrics.minifySaved(Math.max(0, result.original - result.minified));
        }
      }
    }
  }

  const contentType = mime.lookup(relPath);
  const pinned = isPinnedVersion(route.versionSpec);

  // ETag 由「内容身份 + 是否压缩过」决定
  const etag = `"${shortHash(
    `${config.registry}|${pkg.name}@${pkg.version}/${relPath}|${body.length}|${minified ? 'min' : 'raw'}`,
    20,
  )}"`;

  /**
   * Last-Modified 取「该版本解包落盘的时间」，而不是当前时间。
   *
   * 这里修掉了一个真实缺陷：原实现写的是 `new Date().toUTCString()`，
   * 意味着**同一个文件每次请求返回的 Last-Modified 都不一样** ——
   * 这个头就完全失去了意义，而且会让「按时间做增量同步」的客户端永远认为内容变了。
   *
   * 用解包时间的好处是它对同一个版本稳定（除非缓存被清空后重新解包）；
   * 即使它变化，RFC 7232 也规定 ETag 优先级更高，不会造成错误。
   */
  const lastModifiedDate = new Date(pkg.storedAt || Date.now());
  const lastModified = lastModifiedDate.toUTCString();
  const cacheControl = pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=600';

  // ---- 条件请求：命中就直接 304 ----
  // RFC 7232 §6：If-None-Match 存在时忽略 If-Modified-Since
  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];
  let notModified = false;

  if (ifNoneMatch) {
    notModified = ifNoneMatch.split(',').some((t) => t.trim() === etag || t.trim() === '*');
  } else if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    // HTTP 日期只有秒精度，留 1 秒容差，避免同秒内被判定为「已修改」
    if (Number.isFinite(since) && lastModifiedDate.getTime() <= since + 999) {
      notModified = true;
    }
  }

  if (notModified) {
    metrics.cacheAccess('client-revalidate', true);
    res.writeHead(304, baseHeaders({
      etag,
      'last-modified': lastModified,
      'cache-control': cacheControl,
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
    'last-modified': lastModified,
    'cache-control': cacheControl,
    'x-byr-package': pkg.name,
    'x-byr-version': pkg.version,
    'x-byr-resolution': pkg.how,
    'x-byr-cache': source,
    'x-byr-size': String(body.length),
  };
  if (entrySource) headers['x-byr-entry'] = `${relPath} (${entrySource})`;
  if (minified) headers['x-byr-minified'] = 'true';
  if (minifySkipped) headers['x-byr-minify-skipped'] = minifySkipped;
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
      metrics.compressionSaved(body.length - compressed.length, encoding);
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

    // 深度模式：继续把外部依赖也递归内联进来，即题面说的「把多个依赖合并成一个文件」。
    // 两种写法都支持：`?bundle=deep` 与 `?bundle&deep=1`。
    const deepParam = route.query.deep;
    const deep =
      bundleValue === 'deep' ||
      (deepParam !== undefined && !['0', 'false', 'no'].includes(String(deepParam).toLowerCase()));
    if (bundleValue === 'deep') mode = 'inline';

    await bundleLib.serveBundle(req, res, pkg, target, route, {
      minify: needMinify,
      mode,
      deep,
    });
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

  /**
   * 快照最终写出的响应头。
   *
   * 为什么必须这么做：**响应刷出之后 `res.getHeader()` / `res.getHeaders()` 一律返回空**
   * （Node 把标头交给 socket 时会清掉内部的标头表；实测 Node 22 下
   * 连 `writeHead()` 之后立刻取 `getHeaders()` 也已经是空的）。
   * 最初直接在 `finish` 事件里读 `res.getHeader('content-length')`，
   * 结果是「发送字节数永远是 0」，日志里的 `[版本]` 后缀也从来没出现过 ——
   * 一个静默失效的诊断能力，比直接报错更难发现。
   *
   * 所以这里改成**从 writeHead 的参数里取**，完全不依赖 Node 的内部实现细节：
   * 本服务所有响应路径都是 `res.writeHead(status, {...})` 的调用形态。
   */
  /** @type {Record<string, any>} */
  const finalHeaders = {};
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = (...args) => {
    const result = originalWriteHead(...args);
    const maybeHeaders = args[args.length - 1];
    if (maybeHeaders && typeof maybeHeaders === 'object' && !Array.isArray(maybeHeaders)) {
      Object.assign(finalHeaders, maybeHeaders);
    }
    return result;
  };

  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    metrics.httpRequest({
      method: req.method || 'GET',
      status: res.statusCode,
      durationSeconds: seconds,
      bytes: Number(finalHeaders['content-length'] || 0),
      encoding: String(finalHeaders['content-encoding'] || 'identity'),
    });
    logger.info(
      `${req.method} ${req.url} -> ${res.statusCode} ${(seconds * 1000).toFixed(1)}ms` +
        (finalHeaders['x-byr-version'] ? ` [${finalHeaders['x-byr-version']}]` : ''),
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

  // ---- 限流 ----
  if (rateLimiter.enabled) {
    const key = clientKey(req, config.trustProxy);
    const limited = rateLimiter.check(key);
    if (limited) {
      metrics.rateLimited(limited.limit);
      logger.info(`限流拒绝 ${key} ${req.url}`);
      res.writeHead(429, baseHeaders({
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(limited.retryAfter),
        'x-ratelimit-limit': String(limited.limit),
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.ceil(limited.resetAt / 1000)),
      }));
      res.end(JSON.stringify({ error: '请求过于频繁，请稍后重试', status: 429, retryAfter: limited.retryAfter }));
      return;
    }
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
          renderServiceIndex({
            registry: config.registry,
            registrySource: config.registrySource,
            port: config.port,
          }),
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

      case 'metrics': {
        if (!config.metrics) throw notFound('指标接口已关闭（METRICS=0）');
        const body = renderPrometheus();
        res.writeHead(200, baseHeaders({
          // Prometheus 的文本格式，不用 application/json
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-store',
        }));
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      case 'stats': {
        const disk = await cache.diskStats();
        sendJson(res, 200, {
          upstream: {
            registry: config.registry,
            // 解释「为什么是这个源」：env:REGISTRY / npmrc:registry / default
            source: config.registrySource,
            authenticated: Boolean(config.registryToken),
            tokenType: config.registryTokenType,
            npmrc: config.npmrcSources.map((s) => ({ path: s.path, keys: s.keys })),
          },
          memoryCache: cache.memory.stats(),
          diskCache: disk,
          extraction: store.extractStats(),
          minifyPool: minifyPool.poolStats(),
          rateLimit: rateLimiter.stats(),
          metrics: metricsSnapshot(),
          config: {
            ttl: config.ttl,
            maxTarballBytes: config.maxTarballBytes,
            memoryCacheBytes: config.memoryCacheBytes,
            maxConcurrentExtract: config.maxConcurrentExtract,
            bundleMaxDepth: config.bundleMaxDepth,
            minify: config.minify,
            compress: config.compress,
            securityHeaders: config.securityHeaders,
          },
        }, { 'cache-control': 'no-store' });
        return;
      }

      case 'api': {
        if (!config.api) throw notFound('包信息接口已关闭（API=0）');
        const pkg = await store.loadPackage(route.name, route.versionSpec);
        sendJson(res, 200, api.handle(route, pkg), {
          'cache-control': 'public, max-age=300',
          'x-byr-package': pkg.name,
          'x-byr-version': pkg.version,
          'x-byr-resolution': pkg.how,
        });
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

export default { handleRequest, parseRange, setRateLimit, rateLimitStats };
