/**
 * npm registry 上游客户端。
 *
 * 职责：把「包名 + 版本描述」翻译成「一个可用的版本 + 完整 manifest + tarball 流」。
 *
 * 三个关键优化（都是为了「减少上游访问 + 降低单次代价」）：
 *
 * 1. 精确版本走「单版本接口」。
 *    `GET /vue/latest` 只有 3KB，而 `GET /vue`（完整 packument）接近 900KB。
 *    请求 `/vue@3.5.43/index.js` 时没必要下载全部版本历史。
 *
 * 2. 需要版本区间时才取 packument，并且优先请求「简版 packument」
 *    （`Accept: application/vnd.npm.install-v1+json`），npm 官方 registry
 *    会剔除 README、历史版本里的冗余字段，体积能小一大截。
 *
 * 3. 简版 packument 里**没有** `main` / `exports` / `jsdelivr` 这些入口字段，
 *    也可能缺 `dist.tarball` 之外的信息，所以最终仍会补一次单版本 manifest 请求。
 *    这一步同样进缓存（TTL 1 小时）。
 */

import { Readable } from 'node:stream';
import config from './config.js';
import logger from './logger.js';
import * as cache from './cache.js';
import * as semver from './semver.js';
import { singleFlight, encodePackageName } from './util.js';
import { notFound, upstreamError, gatewayTimeout, HttpError } from './errors.js';

/** 简版 packument 的 Accept 值。 */
const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';

/** 构造 registry 请求的公共 headers。 */
function headers(accept) {
  /** @type {Record<string,string>} */
  const out = {
    accept,
    'user-agent': config.userAgent,
    'accept-encoding': 'gzip',
  };
  if (config.registryToken) out.authorization = `Bearer ${config.registryToken}`;
  return out;
}

/** 手写的超时 + 中止控制。 */
function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeout);
  timer.unref?.();
  return { controller, clear: () => clearTimeout(timer) };
}

/**
 * 发起上游 GET 请求。
 * @param {string} url
 * @param {{accept?:string}} [options]
 * @returns {Promise<Response>}
 */
async function upstreamGet(url, options = {}) {
  const { controller, clear } = withTimeout();
  try {
    const res = await fetch(url, {
      headers: headers(options.accept || 'application/json'),
      signal: controller.signal,
      redirect: 'follow',
    });
    return res;
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw gatewayTimeout(`请求上游 registry 超时（${config.upstreamTimeout}ms）: ${url}`);
    }
    throw upstreamError(`无法连接上游 registry: ${err.message}`, { url });
  } finally {
    clear();
  }
}

/**
 * 读取一个 JSON 接口，带「单飞 + 两级缓存 + 负缓存 + stale-if-error」。
 *
 * @param {object} options
 * @param {string} options.key 缓存逻辑键
 * @param {string} options.url 请求地址
 * @param {number} options.ttl 缓存时长
 * @param {string} [options.accept]
 * @param {string} options.notFoundMessage 上游 404 时对外暴露的文案
 * @returns {Promise<any>}
 */
async function getJson({ key, url, ttl, accept, notFoundMessage }) {
  const dedupeKey = `json:${config.registry}|${key}`;

  return singleFlight(dedupeKey, async () => {
    const cached = await cache.getMeta(key);
    if (cached && cached.fresh) {
      logger.debug(`meta 命中缓存: ${key}`);
      return cached.value;
    }

    let response;
    try {
      response = await upstreamGet(url, { accept });
    } catch (err) {
      // 上游故障时，宁可用过期数据也不要 5xx —— 可用性优先
      if (cached) {
        logger.info(`上游失败，回退到过期缓存 ${key}: ${err.message}`);
        return cached.value;
      }
      throw err;
    }

    if (response.status === 404) {
      await cache.setMeta(`404:${key}`, { at: Date.now() }, config.ttl.negative).catch(() => {});
      throw notFound(notFoundMessage, { url });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (cached) {
        logger.info(`上游返回 ${response.status}，回退到过期缓存 ${key}`);
        return cached.value;
      }
      throw upstreamError(`上游 registry 返回 ${response.status}`, {
        url,
        body: body.slice(0, 300),
      });
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw upstreamError(`上游返回的内容不是合法 JSON: ${err.message}`, { url });
    }

    await cache.setMeta(key, parsed, ttl).catch(() => {});
    return parsed;
  });
}

/** 检查负缓存中是否记录了「这个 key 最近 404 过」。 */
async function recentMiss(key) {
  const hit = await cache.getMeta(`404:${key}`);
  return Boolean(hit);
}

/**
 * 拉取 packument（包的完整元信息）。
 *
 * 先尝试简版（体积小），失败再退回完整版。
 *
 * @param {string} name 包名
 * @returns {Promise<any>}
 */
export async function fetchPackument(name) {
  const key = `packument:${ABBREVIATED_ACCEPT}:${name}`;
  if (await recentMiss(key)) {
    throw notFound(`未找到包 ${name}`, { package: name });
  }

  const url = `${config.registry}/${encodePackageName(name)}`;

  // 部分私有 registry 不支持 abbreviated 头，会返回 406/400，这里做一次降级
  try {
    return await getJson({
      key,
      url,
      ttl: config.ttl.packument,
      accept: ABBREVIATED_ACCEPT,
      notFoundMessage: `未找到包 ${name}`,
    });
  } catch (err) {
    if (err instanceof HttpError && [400, 406, 415].includes(err.status)) {
      logger.debug(`registry 不支持简版 packument，降级为完整版: ${name}`);
      return getJson({
        key: `packument:full:${name}`,
        url,
        ttl: config.ttl.packument,
        accept: 'application/json',
        notFoundMessage: `未找到包 ${name}`,
      });
    }
    throw err;
  }
}

/**
 * 拉取单个版本的完整 manifest。
 *
 * 注意：只有这个接口会返回 `main` / `exports` / `jsdelivr` 等入口字段，
 * 入口文件解析必须依赖它。
 *
 * @param {string} name
 * @param {string} version 精确版本号
 * @returns {Promise<any>}
 */
export async function fetchManifest(name, version) {
  const key = `manifest:${name}@${version}`;
  if (await recentMiss(key)) {
    throw notFound(`未找到包 ${name} 的版本 ${version}`, { package: name, version });
  }

  const url = `${config.registry}/${encodePackageName(name)}/${encodeURIComponent(version)}`;
  return getJson({
    key,
    url,
    ttl: config.ttl.manifest,
    accept: 'application/json',
    notFoundMessage: `未找到包 ${name} 的版本 ${version}`,
  });
}

/** 包名合法性校验（防止把奇怪的字符串拼进上游 URL）。 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * 校验包名。
 * @param {string} name
 */
export function isValidName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 214) return false;
  if (!PACKAGE_NAME_RE.test(name)) return false;
  // 防御：编码后仍不应出现路径穿越
  if (name.includes('..') || name.includes('%')) return false;
  return true;
}

/**
 * 把一个版本描述解析成具体版本号。
 *
 * 解析顺序（与 npm 的行为一致）：
 *   1. 空 / `latest` → dist-tags.latest
 *   2. dist-tags 里存在同名 tag（如 `beta`、`next`）→ 直接取
 *   3. 精确版本且能直接取到 → 直接取（最省流量的快路径）
 *   4. 否则当作 semver 范围，取满足范围的最高版本
 *
 * @param {string} name 包名
 * @param {string} spec 版本描述，可为空
 * @returns {Promise<{version:string, manifest:any, how:string, candidates:number}>}
 */
export async function resolveVersion(name, spec) {
  const wanted = (spec ?? '').trim();

  return singleFlight(`resolve:${config.registry}|${name}@${wanted}`, async () => {
    // ---- 快路径：精确版本直接取单版本 manifest（约 3KB） ----
    if (wanted !== '' && wanted !== 'latest' && semver.isExact(wanted)) {
      const exact = semver.parse(wanted).raw;
      const manifest = await fetchManifest(name, exact).catch((err) => {
        if (err.status === 404) return null;
        throw err;
      });
      if (manifest) {
        return { version: manifest.version || exact, manifest, how: 'exact', candidates: 1 };
      }
    }

    // ---- 常规路径：拿 packument 做 tag / 范围解析 ----
    const packument = await fetchPackument(name);
    const versions = Object.keys(packument.versions || {});
    const tags = packument['dist-tags'] || {};

    if (versions.length === 0) {
      throw notFound(`包 ${name} 没有任何可用版本`, { package: name });
    }

    let version = null;
    let how = '';

    if (wanted === '' || wanted === 'latest') {
      version = tags.latest || semver.maxSatisfying(versions, '*');
      how = 'latest';
    } else if (Object.prototype.hasOwnProperty.call(tags, wanted)) {
      version = tags[wanted];
      how = `dist-tag:${wanted}`;
    } else {
      try {
        version = semver.maxSatisfying(versions, wanted);
      } catch {
        version = null;
      }
      how = 'range';
    }

    if (!version) {
      throw notFound(
        `包 ${name} 没有匹配 ${wanted || 'latest'} 的版本`,
        { package: name, spec: wanted, available: Object.keys(tags) },
      );
    }

    // 简版 packument 不含入口字段，必须补一次完整 manifest
    const manifest = await fetchManifest(name, version);
    return { version, manifest, how, candidates: versions.length };
  });
}

/**
 * 打开 tarball 的字节流。
 *
 * @param {string} url
 * @param {number} [maxBytes] 体积上限
 * @returns {Promise<{stream:Readable, contentLength:number}>}
 */
export async function openTarball(url, maxBytes = config.maxTarballBytes) {
  const { controller, clear } = withTimeout();
  let response;
  try {
    response = await fetch(url, {
      headers: headers('application/octet-stream'),
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clear();
    if (err.name === 'AbortError') throw gatewayTimeout(`下载 tarball 超时: ${url}`);
    throw upstreamError(`下载 tarball 失败: ${err.message}`, { url });
  }

  if (!response.ok) {
    clear();
    throw upstreamError(`下载 tarball 失败，上游返回 ${response.status}`, { url });
  }

  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxBytes) {
    clear();
    controller.abort();
    throw upstreamError(`tarball 体积 ${length} 字节，超过上限 ${maxBytes}`, { url });
  }

  const stream = Readable.fromWeb(response.body);
  // 整个下载过程都受超时保护，读完再解绑
  stream.once('end', clear);
  stream.once('close', clear);
  stream.once('error', clear);

  return { stream, contentLength: length };
}

export default {
  fetchPackument,
  fetchManifest,
  resolveVersion,
  openTarball,
  isValidName,
};
