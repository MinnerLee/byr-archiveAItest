/**
 * 令牌桶限流。
 *
 * 为什么一个 CDN 需要限流？不是因为要限制用户，而是因为**上游是共享资源**：
 *   - npm registry 有速率限制与封禁策略，本服务如果无限转发，IP 被拉黑后所有人都用不了；
 *   - 单个客户端刷不存在的包名，会把「负缓存」之前的每一次请求都变成一次上游往返；
 *   - 一个失控的脚本可以在几分钟内把磁盘缓存刷到几百 GB。
 *
 * 用令牌桶而不是固定窗口计数器，是因为固定窗口有两个经典缺陷：
 *   1. 窗口边界突发（在 59.9s 和 60.1s 各打满一次额度）；
 *   2. 无法表达「允许短时突发」这个真实需求。
 * 令牌桶天然支持突发容量 + 平滑速率。
 *
 * 结构：每个 key（默认按客户端 IP）一个桶，用 Map 维护访问顺序实现 LRU，
 * 桶数量有上限，防止「伪造海量 IP」把内存撑爆（本质是限流器自身也要限流）。
 */

/**
 * 解析客户端标识。默认取 socket 地址。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy 是否信任 X-Forwarded-For（部署在反向代理后面时才该开启，
 *                             否则客户端可以伪造这个头绕过限流）
 * @returns {string}
 */
export function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      // 取最左边一个，即最初发起请求的客户端
      return forwarded.split(',')[0].trim();
    }
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.length > 0) return realIp.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * 创建限流器。
 *
 * @param {object} options
 * @param {number} options.perMinute 每分钟允许的请求数；0 表示不限流
 * @param {number} [options.burst] 允许的突发容量，默认等于 perMinute
 * @param {number} [options.maxKeys] 最多跟踪多少个客户端，默认 10000
 * @param {boolean} [options.trustProxy] 是否信任 X-Forwarded-For
 * @returns {{
 *   enabled:boolean,
 *   check:(key:string)=>null|{limit:number,remaining:number,retryAfter:number,resetAt:number},
 *   stats:()=>({enabled:boolean,perMinute:number,burst:number,tracked:number,rejected:number,hits:number})
 * }}
 */
export function createRateLimiter(options = {}) {
  const perMinute = Math.max(0, Math.floor(options.perMinute ?? 0));
  const enabled = perMinute > 0;
  const burst = Math.max(1, Math.floor(options.burst ?? perMinute) || 1);
  const maxKeys = Math.max(1, options.maxKeys ?? 10_000);
  /** 每毫秒补充的令牌数。 */
  const refillPerMs = perMinute / 60_000;

  /** @type {Map<string, {tokens:number, updatedAt:number}>} */
  const buckets = new Map();
  let rejected = 0;
  let hits = 0;

  /** 清掉最久未访问的桶，保证内存上限。 */
  function evictIfNeeded() {
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      buckets.delete(oldest);
    }
  }

  /**
   * 消耗一个令牌。
   *
   * @param {string} key 客户端标识
   * @returns {null | {limit:number, remaining:number, retryAfter:number, resetAt:number}}
   *          返回 null 表示放行；返回对象表示被拒绝（用于构造 429 响应头）
   */
  function check(key) {
    if (!enabled) return null;
    hits += 1;

    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket) {
      bucket = { tokens: burst, updatedAt: now };
    } else {
      // 按经过的时间补充令牌，上限为桶容量
      const elapsed = now - bucket.updatedAt;
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
      // 命中已存在的桶时移到末尾（LRU）
      buckets.delete(key);
    }

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      evictIfNeeded();
      rejected += 1;
      const deficit = 1 - bucket.tokens;
      const retryAfterMs = Math.ceil(deficit / refillPerMs);
      return {
        limit: perMinute,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        resetAt: now + retryAfterMs,
      };
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    evictIfNeeded();
    return null;
  }

  /** 运行状态快照。 */
  function stats() {
    return {
      enabled,
      perMinute,
      burst,
      tracked: buckets.size,
      rejected,
      hits,
    };
  }

  return { enabled, check, stats };
}

export default { createRateLimiter, clientKey };
