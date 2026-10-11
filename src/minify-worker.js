/**
 * 代码压缩的 Worker 线程入口。
 *
 * 为什么需要单独的 worker：
 *   `minify.js` 里的压缩器是纯同步的（词法分析 + 字符串拼接）。
 *   实测压缩 531KB 的 lodash.js 需要 500ms 以上，这段时间**整个事件循环被独占**，
 *   服务无法响应任何其它请求 —— 一个匿名请求就能让服务僵住半秒。
 *
 *   gzip / brotli 不受此影响，因为 Node 的 zlib 异步接口跑在 libuv 线程池里；
 *   而我们自己写的压缩器只能在 JS 主线程上跑，所以必须显式搬出去。
 *
 * 这个文件只做一件事：接收任务、调用压缩器、把结果发回去。
 * 所有调度逻辑在 `minify-pool.js`。
 */

import { parentPort } from 'node:worker_threads';
import { minify } from './minify.js';

if (!parentPort) {
  // 被当成普通模块 import 了（不是 worker 上下文），什么都不做
} else {
  parentPort.on('message', (job) => {
    try {
      const result = minify(job.filePath, job.code);
      parentPort.postMessage({
        id: job.id,
        ok: true,
        code: result.code,
        original: result.original,
        minified: result.minified,
        ratio: result.ratio,
      });
    } catch (err) {
      parentPort.postMessage({ id: job.id, ok: false, error: err.message });
    }
  });
}
