/**
 * 计数信号量。
 *
 * 用途：限制「同时进行解包的包数量」。
 *
 * 为什么需要它？解包是**CPU 密集 + 磁盘密集**的操作：
 *   - gunzip 是纯 CPU；
 *   - 解 tar 的每个 512 字节块都要做一次状态判断；
 *   - 落盘时每个文件都要 createWriteStream。
 *
 * 如果没有上限，100 个并发请求同时命中 100 个不同的冷包，就会出现
 * 「100 个 gunzip 同时抢占事件循环 + 100 棵树同时往磁盘写」，
 * 结果是所有请求一起变慢（甚至把磁盘 IO 打满），单个请求的尾延迟会急剧恶化。
 *
 * 加了信号量之后，超出的请求在队列里等待 —— 总吞吐基本不变，
 * 但尾延迟和资源峰值都被压住。这是「限流保护自己」而不是「限流限制用户」。
 *
 * 实现是 FIFO 队列 + 计数，不依赖任何外部库。
 */

/**
 * 创建一个信号量。
 *
 * @param {number} limit 最大并发数，小于 1 时视为 1
 * @param {object} [options]
 * @param {number} [options.maxQueue] 队列长度上限，超过则直接拒绝（防止无限堆积），0 表示不限
 * @returns {{run:<T>(fn:()=>Promise<T>)=>Promise<T>, stats:()=>({active:number,queued:number,limit:number,peakActive:number,completed:number,waitedMs:number})}}
 */
export function createSemaphore(limit, options = {}) {
  const max = Math.max(1, Math.floor(limit) || 1);
  const maxQueue = options.maxQueue ?? 0;

  let active = 0;
  let peakActive = 0;
  let completed = 0;
  let waitedMs = 0;

  /** @type {Array<{resolve:()=>void, reject:(e:Error)=>void, enqueuedAt:number}>} */
  const queue = [];

  /** 队列腾出位置后，唤醒最早等待的那个。 */
  function release() {
    active -= 1;
    completed += 1;

    const next = queue.shift();
    if (!next) return;

    waitedMs += Date.now() - next.enqueuedAt;
    active += 1;
    if (active > peakActive) peakActive = active;
    next.resolve();
  }

  /**
   * 在信号量保护下执行一个任务。
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function run(fn) {
    if (active >= max) {
      if (maxQueue > 0 && queue.length >= maxQueue) {
        const err = new Error(`解包队列已满（${queue.length}/${maxQueue}），请稍后重试`);
        err.code = 'E_QUEUE_FULL';
        throw err;
      }
      await new Promise((resolve, reject) => {
        queue.push({ resolve, reject, enqueuedAt: Date.now() });
      });
    } else {
      active += 1;
      if (active > peakActive) peakActive = active;
    }

    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 运行状态快照，供 /_metrics 与 /_stats 使用。 */
  function stats() {
    return { active, queued: queue.length, limit: max, peakActive, completed, waitedMs };
  }

  return { run, stats };
}

/** 全局解包信号量（其上限由配置项 MAX_CONCURRENT_EXTRACT 决定）。 */
export default { createSemaphore };
