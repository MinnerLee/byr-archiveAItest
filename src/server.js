/**
 * HTTP 服务器。
 *
 * 用最原始的 `node:http`，不引框架：
 *   - 这个服务的路由规则只有 4 种，Express/Koa 带来的抽象收益为负；
 *   - 少一层中间件就少一次函数调用，静态资源服务的 QPS 是敏感指标；
 *   - 零依赖是这个项目的硬约束。
 *
 * 负责的事情：
 *   - 连接与请求超时（防止慢连接占满 socket）；
 *   - keep-alive 参数；
 *   - 请求体不读（GET/HEAD 服务不该有 body），直接丢弃，避免被大 body 拖住；
 *   - 优雅退出（收到信号后停止接受新连接，等在途请求结束）。
 */

import http from 'node:http';
import config from './config.js';
import logger from './logger.js';
import { handleRequest } from './handler.js';

/**
 * 创建（但不启动）服务器实例。
 * @returns {http.Server}
 */
export function createServer() {
  const server = http.createServer(
    {
      keepAlive: true,
      keepAliveTimeout: 10_000,
      headersTimeout: 20_000,
      requestTimeout: 60_000,
    },
    (req, res) => {
      // 该服务不消费请求体；显式丢弃，避免连接被滞留的 body 卡住
      req.resume();

      res.on('error', (err) => {
        logger.debug(`响应流出错: ${err.message}`);
      });

      handleRequest(req, res).catch((err) => {
        logger.error('未捕获的请求处理异常:', err.stack || err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: '服务器内部错误', status: 500 }));
      });
    },
  );

  // 每个 TCP 连接的超时，防止半开连接长期占用
  server.timeout = 0; // 交给 keepAliveTimeout / headersTimeout 控制
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
    logger.debug(`客户端连接错误: ${err.code || err.message}`);
  });

  return server;
}

/**
 * 启动服务。
 *
 * @param {object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @returns {Promise<http.Server>}
 */
export function start(options = {}) {
  const port = options.port ?? config.port;
  const host = options.host ?? config.host;
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      logger.info(`BYR Archive 已启动: http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`);
      logger.info(`上游 registry: ${config.registry}`);
      logger.info(`磁盘缓存: ${config.diskCache ? config.cacheDir : '已禁用'}`);
      resolve(server);
    });
  });
}

/**
 * 注册优雅退出。
 * @param {http.Server} server
 */
export function installGracefulShutdown(server) {
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，停止接受新连接…`);

    server.close(async () => {
      // 先收掉压缩线程池，避免留下游离的 worker
      try {
        const pool = await import('./minify-pool.js');
        await pool.shutdown();
      } catch {
        /* 忽略：退出路径上不值得因为清理失败而阻塞 */
      }
      logger.info('所有连接已结束，进程退出');
      process.exit(0);
    });

    // 兜底：10 秒内没退干净就强退，避免挂死
    const timer = setTimeout(() => {
      logger.error('优雅退出超时，强制结束');
      process.exit(1);
    }, 10_000);
    timer.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export default { createServer, start, installGracefulShutdown };
