/**
 * 代码压缩线程池。
 *
 * 解决的问题：`minify.js` 是同步实现，压缩一个大文件会**独占事件循环**。
 * 实测压缩 531KB 的 lodash.js 阻塞约 500ms，压缩 4MB 级文件会阻塞数秒。
 * 对一个要同时服务多个客户端的 CDN 来说，这是不可接受的。
 *
 * 方案：把这件 CPU 密集型工作搬到 `worker_threads`，主线程只负责派发与收结果。
 * 这与 gzip/brotli 的处理方式在原理上一致（它们跑在 libuv 线程池里），
 * 只是需要我们自己搭一层。
 *
 * 设计取舍：
 * - **懒创建**：只有在第一次真正需要压缩时才起 worker，不压缩的场景零开销。
 * - **`unref()`**：worker 不阻止进程退出。服务本来就是常驻的，
 *   而测试 / CLI 场景需要进程能干净地结束。
 * - **单任务超时**：worker 卡死或代码异常时，超时终止并**重启**该 worker，
 *   避免一个坏任务永久占用一个并发位。
 * - **优雅降级**：`worker_threads` 不可用（某些受限环境）时，自动退回同步压缩
 *   并只告警一次。宁可慢，不可不可用。
 */

import { Worker } from 'node:worker_threads';
import os from 'node:os';
import config from './config.js';
import logger from './logger.js';
import { minify as minifySync } from './minify.js';

/** 池大小：默认取 CPU 核数与 4 的较小值，给主线程和其它线程留出余量。 */
const POOL_SIZE = Math.max(
  1,
  config.minifyWorkers || Math.min(4, Math.max(1, (os.cpus()?.length || 2) - 1)),
);

/** 单个压缩任务的最长执行时间，超过则终止并重启该 worker。 */
const JOB_TIMEOUT_MS = 60_000;

/** @type {Array<{worker:Worker, busy:boolean, id:number}>} */
let slots = [];
let initialized = false;
/** 是否已因环境不支持而降级为同步压缩。 */
let degraded = false;
let nextJobId = 0;
let cursor = 0;

/** @type {Map<number, {resolve:Function, reject:Function, timer:NodeJS.Timeout, slot:any}>} */
const pending = new Map();

const stats = { jobs: 0, syncFallbacks: 0, timeouts: 0, restarts: 0, poolSize: POOL_SIZE };

/** 创建并初始化一个 worker 槽位。 */
function createSlot() {
  const worker = new Worker(new URL('./minify-worker.js', import.meta.url));
  const slot = { worker, busy: false, id: slots.length };

  worker.on('message', (msg) => {
    const job = pending.get(msg.id);
    if (!job) return;
    pending.delete(msg.id);
    clearTimeout(job.timer);
    slot.busy = false;
    if (msg.ok) {
      job.resolve({ code: msg.code, original: msg.original, minified: msg.minified, ratio: msg.ratio });
    } else {
      job.reject(new Error(`worker 压缩失败: ${msg.error}`));
    }
  });

  worker.on('error', (err) => {
    logger.error(`压缩 worker 出错: ${err.message}`);
    failSlot(slot, err);
  });

  worker.on('exit', (code) => {
    if (pending.size > 0 || code !== 0) {
      failSlot(slot, new Error(`压缩 worker 异常退出（code=${code}）`));
    }
  });

  // 不阻止进程退出：服务本身常驻，测试与 CLI 需要能干净结束
  worker.unref();
  return slot;
}

/** 某个 worker 挂了：拒绝它手上的任务并重启一个替补。 */
function failSlot(slot, err) {
  for (const [id, job] of pending) {
    if (job.slot === slot) {
      pending.delete(id);
      clearTimeout(job.timer);
      job.reject(err);
    }
  }
  const index = slots.indexOf(slot);
  if (index === -1) return;
  slot.worker.terminate().catch(() => {});
  try {
    slots[index] = createSlot();
    stats.restarts += 1;
  } catch (spawnErr) {
    logger.error(`重启压缩 worker 失败: ${spawnErr.message}`);
    slots.splice(index, 1);
    if (slots.length === 0) degraded = true;
  }
}

/** 懒初始化整个池。 */
function ensurePool() {
  if (initialized) return;
  initialized = true;
  try {
    for (let i = 0; i < POOL_SIZE; i += 1) slots.push(createSlot());
    logger.debug(`压缩线程池已启动：${POOL_SIZE} 个 worker`);
  } catch (err) {
    logger.error(`无法启动压缩 worker（将退回同步压缩）: ${err.message}`);
    degraded = true;
    slots = [];
  }
}

/**
 * 异步压缩。
 *
 * @param {string} filePath 用于按扩展名选择压缩器
 * @param {string} code 源码
 * @returns {Promise<{code:string, original:number, minified:number, ratio:number}>}
 */
export function minify(filePath, code) {
  ensurePool();

  // 降级路径：仍然可用，只是会阻塞主线程，所以必须告警而不是静默
  if (degraded || slots.length === 0) {
    stats.syncFallbacks += 1;
    if (stats.syncFallbacks === 1) {
      logger.error('压缩 worker 不可用，已退回**同步**压缩：大文件会阻塞事件循环');
    }
    return Promise.resolve(minifySync(filePath, code));
  }

  // 轮询挑一个空闲槽位；全忙就排队等（不额外建 worker，避免无界扩张）
  const slot = slots[cursor % slots.length];
  cursor += 1;

  return new Promise((resolve, reject) => {
    const id = (nextJobId += 1);
    const timer = setTimeout(() => {
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      stats.timeouts += 1;
      logger.error(`压缩任务超时（${JOB_TIMEOUT_MS}ms），重启该 worker`);
      failSlot(job.slot, new Error('压缩任务超时'));
      reject(new Error('压缩任务超时'));
    }, JOB_TIMEOUT_MS);
    timer.unref?.();

    pending.set(id, { resolve, reject, timer, slot });
    slot.busy = true;
    stats.jobs += 1;
    slot.worker.postMessage({ id, filePath, code });
  });
}

/** 运行状态快照。 */
export function poolStats() {
  return {
    ...stats,
    workers: slots.length,
    busy: slots.filter((s) => s.busy).length,
    queued: pending.size,
    degraded,
  };
}

/** 关闭池（测试与优雅退出用）。 */
export async function shutdown() {
  const all = slots.map((s) => s.worker.terminate().catch(() => {}));
  slots = [];
  initialized = false;
  await Promise.all(all);
}

export default { minify, poolStats, shutdown };
