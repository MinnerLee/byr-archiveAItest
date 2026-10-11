/**
 * 传输压缩（gzip / brotli）。
 *
 * 对应可选功能 3 里「压缩」的另一半：package 内的文件按原样提供已经能满足需求，
 * 但一个未压缩的 `vue.global.js` 有 500KB+，gzip 后约 130KB，brotli 后约 110KB。
 * 对这个 CDN 的核心场景（浏览器直接 `<script src>` 引入）收益非常直接。
 *
 * 三个实现要点：
 *  1. **只压缩文本类内容**。图片、字体、wasm 已经是压缩格式，再压一遍纯属浪费 CPU。
 *  2. **压缩结果进缓存**。同一个文件被反复请求时不应该反复压缩 —— 压缩是纯 CPU 开销，
 *     而且压缩后的字节是确定性的，天然适合缓存。
 *  3. **对 Range 请求不压缩**。字节区间是相对于「选定的表示」的，混着压缩会让
 *     Range/Content-Range 语义变得难以对齐，所以带 Range 头时一律返回 identity。
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';
import config from './config.js';
import * as cache from './cache.js';
import { isTextMime } from './mime.js';

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

/** 小于这个体积不值得压缩（HTTP 头 + 压缩开销可能反而更大）。 */
const MIN_SIZE = 1024;

/** gzip 压缩级别：6 是体积/速度的常见折中。 */
const GZIP_OPTIONS = { level: 6 };

/** brotli 参数：质量 5 在动态压缩场景下速度可接受，体积接近 q9。 */
const BROTLI_OPTIONS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 0,
  },
};

/**
 * 解析 Accept-Encoding，挑选最合适的编码。
 *
 * @param {string|undefined} header
 * @returns {'br'|'gzip'|'identity'}
 */
export function negotiate(header) {
  if (!config.compress || !header) return 'identity';

  /** @type {Map<string, number>} */
  const accepted = new Map();
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const m = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(param);
      if (m) q = Number.parseFloat(m[1]);
    }
    accepted.set(name, q);
  }

  const qOf = (name) => accepted.get(name) ?? 0;
  const wildcard = qOf('*');

  const br = accepted.has('br') ? qOf('br') : wildcard;
  const gzip = accepted.has('gzip') ? qOf('gzip') : wildcard;

  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return 'identity';
}

/**
 * 判断该内容是否值得压缩。
 *
 * 注意：传入的 MIME 常常带参数（`application/javascript; charset=utf-8`），
 * 判断前必须先把 `;` 后面的部分去掉，否则永远匹配不上白名单。
 *
 * @param {string} mime
 * @param {number} size
 */
export function shouldCompress(mime, size) {
  if (!config.compress) return false;
  if (size < MIN_SIZE) return false;
  const base = String(mime).split(';')[0].trim().toLowerCase();
  return isTextMime(base);
}

/**
 * 压缩并缓存结果。
 *
 * @param {string} cacheKey 用于缓存的键（应包含包名、版本、路径）
 * @param {Buffer} input 原始内容
 * @param {'br'|'gzip'} encoding
 * @returns {Promise<Buffer>}
 */
export async function compress(cacheKey, input, encoding) {
  const key = `${encoding}:${cacheKey}`;

  const cached = cache.memory.get(key);
  if (cached) return cached;

  const output = encoding === 'br'
    ? await brotliAsync(input, BROTLI_OPTIONS)
    : await gzipAsync(input, GZIP_OPTIONS);

  // 压缩结果与内容一一对应且不可变，缓存时长跟文件本身一致
  cache.memory.set(key, output, config.ttl.file, output.length);
  return output;
}

export default { negotiate, shouldCompress, compress };
