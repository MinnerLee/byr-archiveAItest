/**
 * 优雅退出探针（被 `test/verify-live.mjs` 作为独立子进程拉起）。
 *
 * 为什么要单独一个文件，而不是直接给服务进程发 SIGTERM：
 *
 *   Windows 没有 POSIX 信号。从另一个进程调用 `child.kill('SIGTERM')` 的实测结果是
 *   `exit code=null, signal=SIGTERM` —— 进程被 TerminateProcess **强制终止**，
 *   `process.on('SIGTERM')` 里的处理器**一行都不会执行**。
 *
 *   也就是说：优雅退出的代码路径在 Windows 上无法用「跨进程真实信号」触发。
 *   如果沿用那种方式测试，只能得到「日志里没有关闭信息」的假失败。
 *
 * 这个探针仍然是：**真实的独立进程 + 真实启动的 server 实例 + 真实的关闭逻辑**，
 * 只是把信号的投递方式换成进程内 `process.emit('SIGTERM')`（平台适配），
 * 从而验证关闭逻辑本身是否正确。
 *
 * 退出码：优雅退出成功为 0；若 5 秒内没退出，外层测试会判定超时失败。
 */

import { start, installGracefulShutdown } from '../../src/server.js';
import logger from '../../src/logger.js';

const server = await start({ port: 0, host: '127.0.0.1' });
installGracefulShutdown(server);

// 服务就绪后自我触发关闭，模拟收到 SIGTERM
setTimeout(() => {
  logger.info('[探针] 在进程内触发 SIGTERM（Windows 无法跨进程投递）');
  process.emit('SIGTERM');
}, 400);
