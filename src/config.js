/**
 * 全局配置。
 *
 * 所有可调参数集中在这里，方便通过环境变量覆盖。
 * 设计原则：默认值必须让服务「开箱即用」，不设置任何环境变量也能正常工作。
 *
 * registry 地址与鉴权令牌的解析优先级（详见 `npmrc.js`）：
 *   命令行 --registry > 环境变量 REGISTRY/REGISTRY_TOKEN > ./.npmrc > ~/.npmrc > 默认官方源
 */

import path from 'node:path';
import os from 'node:os';
import { resolveRegistry } from './npmrc.js';

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

/** 上游源配置（地址 + 令牌 + 来源，便于在 /_stats 里解释「为什么是这个源」）。 */
const upstream = resolveRegistry({
  enabled: !['0', 'false', 'no'].includes(String(process.env.NPMRC ?? 'true').toLowerCase()),
});

const registry = normalizeRegistry(upstream.registry);

export const config = {
  /** 监听端口 */
  port: readInt('PORT', 8080),
  /** 监听地址 */
  host: readStr('HOST', '0.0.0.0'),

  /** 上游 npm registry 地址（题目要求：由 REGISTRY 环境变量指定；也支持 .npmrc） */
  registry,
  /** 该地址是从哪来的：env:REGISTRY / npmrc:registry / default */
  registrySource: upstream.source,
  /** 私有 registry 的鉴权令牌 */
  registryToken: upstream.token,
  /** 令牌类型：bearer / basic（`_auth` 是 base64 的 user:pass，需要 Basic） */
  registryTokenType: upstream.tokenType,
  /** 读取到的 .npmrc 文件列表（只记录路径与键名，不记录值，避免泄露令牌） */
  npmrcSources: upstream.npmrcSources,
  /** 是否启用 .npmrc 读取 */
  npmrc: upstream.npmrcSources.length > 0,

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
    /** 压缩产物缓存 */
    compressed: readInt('TTL_COMPRESSED', 7 * 24 * 60 * 60 * 1000),
  },

  /** 上游请求超时（毫秒） */
  upstreamTimeout: readInt('UPSTREAM_TIMEOUT', 30 * 1000),
  /** 单个 tarball 允许的最大体积，防止拉爆磁盘/内存，默认 128MB */
  maxTarballBytes: readInt('MAX_TARBALL_BYTES', 128 * 1024 * 1024),
  /** 单个文件允许的最大响应体积，默认 64MB */
  maxFileBytes: readInt('MAX_FILE_BYTES', 64 * 1024 * 1024),
  /** 并发解包上限，避免同时解多个大包把机器拖死 */
  maxConcurrentExtract: readInt('MAX_CONCURRENT_EXTRACT', 4),
  /** 解包等待队列长度上限，0 表示不限 */
  maxExtractQueue: readInt('MAX_EXTRACT_QUEUE', 64),

  /** 每客户端每分钟请求上限；0 表示关闭限流（默认关闭，避免影响正常批量使用） */
  rateLimitPerMinute: readInt('RATE_LIMIT_PER_MINUTE', 0),
  /** 限流的突发容量，默认等于每分钟额度 */
  rateLimitBurst: readInt('RATE_LIMIT_BURST', 0),
  /** 限流最多跟踪多少个客户端 */
  rateLimitMaxKeys: readInt('RATE_LIMIT_MAX_KEYS', 10_000),
  /** 是否信任 X-Forwarded-For（部署在反向代理之后才应开启，否则可被伪造绕过限流） */
  trustProxy: readBool('TRUST_PROXY', false),

  /** 是否开启 JS 压缩（.min.js 回退 + ?min 参数） */
  minify: readBool('MINIFY', true),
  /** 是否开启 gzip / brotli 传输压缩 */
  compress: readBool('COMPRESS', true),
  /** 是否开启 CORS（jsDelivr 默认允许跨域，这里默认开启） */
  cors: readBool('CORS', true),
  /** 是否发送安全响应头（nosniff 等） */
  securityHeaders: readBool('SECURITY_HEADERS', true),
  /** 是否允许 jsDelivr 风格的 /npm/ 前缀 */
  npmPrefix: readBool('NPM_PREFIX', true),
  /** 是否暴露 /_metrics（Prometheus 格式） */
  metrics: readBool('METRICS', true),
  /** 是否暴露 /_api/ 包信息接口 */
  api: readBool('API', true),
  /**
   * 是否启用「exports 完整条件解析 / browser 字段」作为入口解析兜底。
   * 默认关闭：题目明确要求「exports["."] 不满足就用 main」，开启会偏离题面行为。
   */
  enableEntryConditions: readBool('ENTRY_CONDITIONS', false),
  /**
   * 入口解析兜底：4 条规则全落空时，是否回退到 Node 的默认解析（包根 index.js）。
   *
   * 默认关闭 —— 题面规则 4 明确要求「以上均不满足则返回 404」。
   * 但真实世界里有不少包确实不写 `main`（实测：express@4.18.2、mime@3.0.0
   * 的已发布 package.json 里都没有 main/exports，靠 Node 的 index.js 默认解析工作）。
   * 打开此项即可获得与 Node 一致的解析行为。
   */
  entryNodeDefault: readBool('ENTRY_NODE_DEFAULT', false),

  /**
   * 深度打包（?bundle=deep）的最大依赖深度。
   *
   * 默认给 8 而不是 3：真实依赖树可以很深 —— express 就是
   * express → body-parser → qs → side-channel → object-inspect 共 5 层。
   * 深度其实是个很差的"保险丝"（层数少不代表体积小），
   * 真正有效的护栏是下面的模块数上限与源码总量上限，深度只作为兜底。
   */
  bundleMaxDepth: readInt('BUNDLE_MAX_DEPTH', 8),
  /** 深度打包允许的最大模块数 */
  bundleMaxModules: readInt('BUNDLE_MAX_MODULES', 300),
  /** 深度打包允许的最大源码字节数 */
  bundleMaxBytes: readInt('BUNDLE_MAX_BYTES', 16 * 1024 * 1024),

  /** 日志级别：silent | error | info | debug */
  logLevel: readStr('LOG_LEVEL', 'info'),

  /** 服务标识 */
  userAgent: `byr-archive/1.1.0 (node ${process.version.split('.')[0]}; ${os.platform()})`,
};

export default config;
