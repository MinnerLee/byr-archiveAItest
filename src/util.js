/**
 * 通用小工具。
 */

import crypto from 'node:crypto';

/**
 * 请求合并（single-flight）。
 *
 * 同一个包在同一瞬间被 N 个请求命中时，只应该向 registry 发 1 次请求，
 * 其余请求等这一次的结果。这是「尽量减少上游访问」最有效的一招。
 */
const inFlight = new Map();

/**
 * @template T
 * @param {string} key 去重键
 * @param {() => Promise<T>} factory 真正执行的任务
 * @returns {Promise<T>}
 */
export function singleFlight(key, factory) {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => factory())().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** 当前正在合并中的请求数（用于统计/调试）。 */
export function inFlightCount() {
  return inFlight.size;
}

/** 短哈希，用于给 registry 地址、包名等生成目录名。 */
export function shortHash(input, length = 12) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, length);
}

/**
 * npm registry 的包名编码。
 * scoped 包 `@vue/shared` 需要把中间的 `/` 转义成 `%2f`，
 * 否则部分 registry 会把它当成两个路径段。
 */
export function encodePackageName(name) {
  return name.replace('/', '%2f');
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)}${units[index]}`;
}

/** HTML 转义，目录列表页必须做，否则包内文件名可以注入脚本。 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** URL 路径编码，保留 `/`。 */
export function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

/** 睡眠。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判断对象是否为普通对象。 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从一个 Node 可读流收集全部数据（带体积上限）。
 * @param {AsyncIterable<Buffer>} source
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export async function collect(source, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`响应体超过上限 ${maxBytes} 字节`);
      err.code = 'E_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default {
  singleFlight,
  shortHash,
  encodePackageName,
  formatBytes,
  escapeHtml,
  encodePathSegment,
  sleep,
  isPlainObject,
  collect,
};
