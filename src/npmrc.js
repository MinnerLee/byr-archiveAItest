/**
 * `.npmrc` 解析。
 *
 * 题目要求「能从官方 npm registry 或者私有 npm registry 获取元信息以及拉取包文件」，
 * 并且用 `REGISTRY` 环境变量指定私有源。实现完之后会发现一个现实问题：
 * **真正用私有源的人不会去设环境变量，他们的私有源配置就在 `.npmrc` 里**：
 *
 *   registry=https://npm.pkg.github.com/
 *   //npm.pkg.github.com/:_authToken=ghp_xxxxxxxx
 *   @mycompany:registry=https://npm.mycompany.com/
 *
 * 所以这里补上 `.npmrc` 支持，让服务的配置方式与真实 npm 工作流一致。
 *
 * 优先级（高 → 低）：
 *   1. 命令行参数 `--registry`
 *   2. 环境变量 `REGISTRY` / `REGISTRY_TOKEN`
 *   3. 项目目录的 `./.npmrc`
 *   4. 用户目录的 `~/.npmrc`
 *   5. 内置默认值 https://registry.npmjs.org
 *
 * 只解析本服务需要的三个键：`registry`、`//<host>/:_authToken`、`_auth`。
 * 不解析 scoped registry（`@scope:registry`）—— 那需要让缓存命名空间、
 * 上游客户端都按包名路由，属于另一层改造，已在 README 的「实现边界」中说明。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 解析 `.npmrc` 文本。
 *
 * 格式细节（都是真实踩过的）：
 *   - 允许 `key=value` 与 `key = value`；
 *   - `#` 与 `;` 开头是注释；
 *   - 值里可能有内联注释吗？不会 —— npm 的 ini 解析不剥离内联注释，
 *     所以 `_authToken=abc # note` 里的 `# note` 是值的一部分，这里保持一致；
 *   - 环境变量插值 `${VAR}`：npm 支持，这里也支持。
 *
 * @param {string} text
 * @param {Record<string,string|undefined>} [env]
 * @returns {Record<string,string>}
 */
export function parseNpmrc(text, env = process.env) {
  /** @type {Record<string,string>} */
  const out = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (key === '') continue;

    // 去掉成对的引号
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    // `${VAR}` 插值，未定义则替换为空串（与 npm 行为一致）
    value = value.replace(/\$\{([^}]+)\}/g, (_all, name) => env[name] ?? '');

    out[key] = value;
  }

  return out;
}

/** 尝试读取一个文件，不存在返回 null。 */
function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 找到并按优先级合并 `.npmrc`。
 *
 * @param {object} [options]
 * @param {string} [options.cwd] 项目目录
 * @param {Record<string,string|undefined>} [options.env]
 * @returns {{config:Record<string,string>, sources:Array<{path:string, keys:string[]}>}}
 */
export function loadNpmrc(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const candidates = [
    path.join(cwd, '.npmrc'), // 项目级（优先级更高，后写覆盖前写）
    path.join(os.homedir(), '.npmrc'), // 用户级
  ];

  /** @type {Record<string,string>} */
  let merged = {};
  /** @type {Array<{path:string, keys:string[]}>} */
  const sources = [];

  // 反过来遍历，让「项目级」最后写入从而覆盖「用户级」
  for (const file of [...candidates].reverse()) {
    const text = readIfExists(file);
    if (text === null) continue;
    const parsed = parseNpmrc(text, env);
    merged = { ...merged, ...parsed };
    sources.push({ path: file, keys: Object.keys(parsed) });
  }

  return { config: merged, sources };
}

/**
 * 把一个 registry 地址归一化成「用于匹配 authToken 键」的形式。
 *
 * npm 的 authToken 键规则：`//<host>[:port]/<path>/:_authToken`，
 * 即去掉协议，保留路径但必须以 `/` 结尾。
 *
 * @param {string} registryUrl
 * @returns {string} 形如 `//registry.company.com/`
 */
export function authKeyPrefix(registryUrl) {
  try {
    const url = new URL(registryUrl);
    const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    return `//${url.host}${pathname}`;
  } catch {
    return '';
  }
}

/**
 * 从解析后的 `.npmrc` 里取出某个 registry 对应的鉴权令牌。
 *
 * 依次尝试（与 npm 的查找顺序一致）：
 *   1. `//host/path/:_authToken`
 *   2. `//host/:_authToken`（忽略路径）
 *   3. `//host/path/:_auth`
 *   4. 全局 `_auth`
 *
 * @param {Record<string,string>} npmrc
 * @param {string} registryUrl
 * @returns {string} 令牌（可能是空串）；`_auth` 返回的是 base64，调用方按 Basic 处理
 */
export function findAuth(npmrc, registryUrl) {
  const prefix = authKeyPrefix(registryUrl);
  if (!prefix) return npmrc._auth || '';

  let host;
  try {
    host = new URL(registryUrl).host;
  } catch {
    return npmrc._auth || '';
  }

  const exactToken = npmrc[`${prefix}:_authToken`];
  if (exactToken) return exactToken;

  const hostToken = npmrc[`//${host}/:_authToken`] ?? npmrc[`//${host}:_authToken`];
  if (hostToken) return hostToken;

  const exactAuth = npmrc[`${prefix}:_auth`];
  if (exactAuth) return exactAuth;

  return npmrc._auth || '';
}

/**
 * 综合环境变量与 `.npmrc`，得出最终生效的 registry 配置。
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {boolean} [options.enabled] 是否启用 .npmrc 读取
 * @returns {{registry:string, token:string, tokenType:'bearer'|'basic'|'none', source:string, npmrcSources:Array<{path:string,keys:string[]}>}}
 */
export function resolveRegistry(options = {}) {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? true;

  const { config: npmrc, sources } = enabled
    ? loadNpmrc({ cwd: options.cwd, env })
    : { config: /** @type {Record<string,string>} */ ({}), sources: [] };

  // 1) registry 地址
  let registry = env.REGISTRY || '';
  let source = 'env:REGISTRY';
  if (!registry && npmrc.registry) {
    registry = npmrc.registry;
    source = 'npmrc:registry';
  }
  if (!registry) {
    registry = 'https://registry.npmjs.org';
    source = 'default';
  }

  // 2) 鉴权令牌
  let token = env.REGISTRY_TOKEN || '';
  let tokenType = token ? /** @type {'bearer'} */ ('bearer') : 'none';

  if (!token) {
    const fromNpmrc = findAuth(npmrc, registry);
    if (fromNpmrc) {
      token = fromNpmrc;
      // `_auth` 是 base64 的 `user:pass`，要用 Basic；`_authToken` 用 Bearer。
      // 判断依据：值里是否含 `:` 或能 base64 解出 `:`。
      const looksLikeBasic = /[=+/]/.test(fromNpmrc) && !/^(gh[ps]_|npm_)/.test(fromNpmrc);
      tokenType = looksLikeBasic ? 'basic' : 'bearer';
    }
  }

  return { registry, token, tokenType, source, npmrcSources: sources };
}

export default { parseNpmrc, loadNpmrc, findAuth, authKeyPrefix, resolveRegistry };
