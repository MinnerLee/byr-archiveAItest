/**
 * 全局配置。
 *
 * 所有可调参数集中在这里，方便通过环境变量覆盖。
 * 设计原则：默认值必须让服务「开箱即用」，不设置任何环境变量也能正常工作。
 */

import path from 'node:path';
import os from 'node:os';

/** 读取整型环境变量，非法值回退到默认值。 */
function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 读取字符串环境变量。 */
function readStr(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** 读取布尔环境变量（1/true/yes/on 视为真）。 */
function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * 规范化 registry 地址：
 * - 补齐协议（默认 https）
 * - 去掉结尾斜杠，避免拼接出 `//` 双斜杠路径
 */
export function normalizeRegistry(input) {
  let url = String(input).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

const registry = normalizeRegistry(readStr('REGISTRY', 'https://registry.npmjs.org'));

export const config = {
  /** 监听端口 */
  port: readInt('PORT', 8080),
  /** 监听地址 */
  host: readStr('HOST', '0.0.0.0'),

  /** 上游 npm registry 地址（题目要求：由 REGISTRY 环境变量指定） */
  registry,

  /** 私有 registry 的鉴权令牌，存在时以 Bearer 方式发送 */
  registryToken: readStr('REGISTRY_TOKEN', ''),

  /** 磁盘缓存根目录 */
  cacheDir: path.resolve(readStr('CACHE_DIR', path.join(process.cwd(), '.byr-cache'))),
  /** 是否启用磁盘缓存 */
  diskCache: readBool('DISK_CACHE', true),
  /** 内存缓存字节上限（超过后按 LRU 淘汰） */
  memoryCacheBytes: readInt('MEMORY_CACHE_BYTES', 64 * 1024 * 1024),
  /** 关闭全部缓存（调试用） */
  noCache: readBool('NO_CACHE', false),

  /** 不同类别内容的缓存存活时间（毫秒） */
  ttl: {
    /** 单个版本元信息：相对稳定，1 小时 */
    manifest: readInt('TTL_MANIFEST', 60 * 60 * 1000),
    /** 完整 packument（含所有版本与 dist-tags）：变化较频繁，5 分钟 */
    packument: readInt('TTL_PACKUMENT', 5 * 60 * 1000),
    /** 已解包的文件内容：npm 版本发布后不可变，缓存 7 天 */
    file: readInt('TTL_FILE', 7 * 24 * 60 * 60 * 1000),
    /** 未命中的查询（404 负缓存）：短暂保留，防止打爆上游，30 秒 */
    negative: readInt('TTL_NEGATIVE', 30 * 1000),
  },

  /** 上游请求超时（毫秒） */
  upstreamTimeout: readInt('UPSTREAM_TIMEOUT', 30 * 1000),
  /** 单个 tarball 允许的最大体积，防止拉爆磁盘/内存，默认 128MB */
  maxTarballBytes: readInt('MAX_TARBALL_BYTES', 128 * 1024 * 1024),
  /** 单个文件允许的最大响应体积，默认 64MB */
  maxFileBytes: readInt('MAX_FILE_BYTES', 64 * 1024 * 1024),
  /** 并发解包上限，避免同时解多个大包把机器拖死 */
  maxConcurrentExtract: readInt('MAX_CONCURRENT_EXTRACT', 4),

  /** 是否开启 JS 压缩（.min.js 回退 + ?min 参数） */
  minify: readBool('MINIFY', true),
  /** 是否开启 gzip / brotli 传输压缩 */
  compress: readBool('COMPRESS', true),
  /** 是否开启 CORS（jsDelivr 默认允许跨域，这里默认开启） */
  cors: readBool('CORS', true),
  /** 是否允许 jsDelivr 风格的 /npm/ 前缀 */
  npmPrefix: readBool('NPM_PREFIX', true),
  /**
   * 是否启用「exports 完整条件解析 / browser 字段」作为入口解析兜底。
   * 默认关闭：题目明确要求「exports["."] 不满足就用 main」，开启会偏离题面行为。
   */
  enableEntryConditions: readBool('ENTRY_CONDITIONS', false),

  /** 日志级别：silent | error | info | debug */
  logLevel: readStr('LOG_LEVEL', 'info'),

  /** 服务标识 */
  userAgent: `byr-archive/1.0.0 (node ${process.version.split('.')[0]}; ${os.platform()})`,
};

export default config;
