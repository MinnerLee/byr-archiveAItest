/**
 * 统一的日志工具。
 *
 * 只做三件事：分级、带时间戳、写 stderr（日志不污染 stdout 的响应体）。
 * 刻意不引入日志库 —— 保持零依赖。
 */

import config from './config.js';

const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };

/** 当前生效的日志级别数值。 */
const current = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, stream, args) {
  if (current < LEVELS[level]) return;
  const ts = new Date().toISOString();
  stream.write(`[${ts}] ${level.toUpperCase().padEnd(5)} ${args.map(String).join(' ')}\n`);
}

export const logger = {
  error: (...args) => emit('error', process.stderr, args),
  info: (...args) => emit('info', process.stderr, args),
  debug: (...args) => emit('debug', process.stderr, args),
};

export default logger;
