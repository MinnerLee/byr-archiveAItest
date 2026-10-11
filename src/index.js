#!/usr/bin/env node
/**
 * BYR Archive 入口。
 *
 * 职责被刻意压到最小：**判断「是直接运行还是被 import」，然后交给 CLI**。
 * 真正的命令实现在 `cli.js`，服务器实现分散在 `server.js` / `handler.js`。
 *
 * 为什么要有这个守卫？
 * 最初这个文件在顶层直接调用了 `main()`，结果是「任何人 import 它都会顺带起一个服务器」——
 * 测试脚本、CLI 里想复用启动逻辑时都会被这个副作用咬到。
 * 现在只有「作为主脚本被执行」时才真正启动。
 */

import { pathToFileURL } from 'node:url';
import { main } from './cli.js';
import logger from './logger.js';

export { main };

/**
 * 判断当前模块是否是被 `node src/index.js` 直接执行的入口。
 * 用 `realpath` 归一化，避免符号链接/相对路径导致的误判。
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      // serve 命令会一直挂着（await new Promise(() => {})），走到这里说明是短命令
      if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
