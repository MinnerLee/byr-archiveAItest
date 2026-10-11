#!/usr/bin/env node
/**
 * BYR Archive 入口。
 *
 * 用法：
 *   node src/index.js
 *   REGISTRY=https://registry.npmjs.org PORT=8080 node src/index.js
 *
 * 也可以用 npm 脚本：
 *   npm start
 *   npm run dev     （--watch 自动重启）
 */

import config from './config.js';
import logger from './logger.js';
import * as cache from './cache.js';
import { start, installGracefulShutdown } from './server.js';

async function main() {
  // 命令行参数覆盖（--port / --host / --registry）
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const index = argv.indexOf(flag);
    return index !== -1 && argv[index + 1] ? argv[index + 1] : undefined;
  };

  const port = Number.parseInt(argOf('--port') ?? '', 10);
  const host = argOf('--host');
  const registryArg = argOf('--registry');

  // 命令行优先级最高：先把 --registry 塞回环境变量，再让 config 读到的值生效
  if (registryArg) {
    process.env.REGISTRY = registryArg;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'BYR Archive —— 最简版 jsDelivr',
        '',
        '用法: node src/index.js [选项]',
        '',
        '选项:',
        '  --port <n>            监听端口（默认 8080）',
        '  --host <addr>         监听地址（默认 0.0.0.0）',
        '  --registry <url>      上游 npm registry（默认 https://registry.npmjs.org）',
        '  -h, --help            显示帮助',
        '',
        '环境变量: PORT / HOST / REGISTRY / CACHE_DIR / MEMORY_CACHE_BYTES /',
        '          TTL_MANIFEST / TTL_PACKUMENT / TTL_FILE / LOG_LEVEL / NO_CACHE',
        '',
      ].join('\n'),
    );
    return;
  }

  if (registryArg) {
    // 重新加载配置，让 --registry 生效
    const fresh = await import(`./config.js?registry=${encodeURIComponent(registryArg)}`);
    Object.assign(config, fresh.config);
  }

  await cache.init();

  const server = start({
    port: Number.isFinite(port) ? port : config.port,
    host: host ?? config.host,
  });

  installGracefulShutdown(await server);
}

main().catch((err) => {
  logger.error('启动失败:', err.stack || err.message);
  process.exit(1);
});
