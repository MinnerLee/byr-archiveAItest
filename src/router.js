/**
 * URL 路由解析。
 *
 * 支持的 URL 形态（`[]` 表示可选）：
 *
 *   /                                    服务首页
 *   /_health                             健康检查
 *   /_stats                              缓存与运行统计
 *   /npm/<包名>[@版本][/子路径]            jsDelivr 兼容前缀
 *   /<包名>[@版本]                         返回入口文件
 *   /<包名>[@版本]/                        包根目录列表
 *   /<包名>[@版本]/<子目录>/                子目录列表
 *   /<包名>[@版本]/<文件路径>               返回文件内容
 *
 * 版本部分支持：空（=latest）、精确版本、dist-tag、semver 范围（`^`、`~`、`>=` 等）。
 *
 * 包名支持 scoped：`/@vue/shared@3.4.0/dist/shared.cjs.js`
 *
 * 解析只做「切分」，不碰网络 —— 这样路由逻辑可以被单测穷举，
 * 也保证了「非法 URL 不会打上游」。
 */

import config from './config.js';
import { badRequest } from './errors.js';

/** scoped 包：@scope/name，可带 @version 和后缀路径。 */
const SCOPED_RE = /^(@[^/@\s]+\/[^/@\s]+)(?:@([^/]+))?(\/.*)?$/;

/** 普通包：name，可带 @version 和后缀路径。 */
const PLAIN_RE = /^([^/@\s]+)(?:@([^/]+))?(\/.*)?$/;

/**
 * @typedef {object} Route
 * @property {'index'|'health'|'stats'|'metrics'|'api'|'entry'|'listing'|'file'|'not-found'} kind
 * @property {string} [name] 包名
 * @property {string} [versionSpec] URL 中的版本描述，空串表示未指定
 * @property {string} [subPath] 包内相对路径（不含前导斜杠）
 * @property {'info'|'tree'|'dir'|'file'} [api] /_api/ 的子命令
 * @property {boolean} [compat] 是否使用了 /npm/ 兼容前缀
 * @property {object} [query] 查询参数
 */

/** 子命令集合：`/_api/{pkg}@{ver}/{子命令}/...` */
const API_SUBCOMMANDS = new Set(['tree', 'dir', 'file']);

/**
 * 解析 `/_api/...` 系列接口。
 *
 * 形态：
 *   /_api/{包名}[@{版本}]                  概览
 *   /_api/{包名}[@{版本}]/tree             文件树
 *   /_api/{包名}[@{版本}]/dir[/子目录]      目录 JSON
 *   /_api/{包名}[@{版本}]/file/{文件路径}   文件元信息
 *
 * 之所以先解析包名再看第一段是不是子命令，是因为 `tree` / `dir` / `file`
 * 都可能是合法文件名或目录名 —— 靠「保留字」而不是「位置约定」会更容易出错。
 *
 * @param {string} rest 已经去掉 `/_api/` 前缀的部分
 * @param {object} query
 */
function parseApiRoute(rest, query) {
  const trimmed = rest.replace(/^\/+/, '');
  if (trimmed === '') {
    throw badRequest('缺少包名，用法：/_api/{包名}[@{版本}][/tree|/dir|/file/{路径}]');
  }

  const scoped = SCOPED_RE.exec(trimmed);
  const plain = scoped ? null : PLAIN_RE.exec(trimmed);
  const match = scoped || plain;
  if (!match) {
    throw badRequest(`无法从 /_api/ 后解析出包名: ${rest}`);
  }

  const name = match[1];
  const versionSpec = (match[2] ?? '').trim();
  const segments = (match[3] ?? '').split('/').filter((s) => s !== '');

  const first = segments[0] ?? '';

  if (first === '') {
    return { kind: 'api', api: 'info', name, versionSpec, subPath: '', query };
  }

  if (!API_SUBCOMMANDS.has(first)) {
    throw badRequest(
      `/_api/ 下不认识的子命令: ${first}（可用：tree、dir、file）` +
        `；若想取文件内容请用 /_api/{包}@{版本}/file/${segments.join('/')}`,
    );
  }

  return {
    kind: 'api',
    api: first,
    name,
    versionSpec,
    subPath: segments.slice(1).join('/'),
    query,
  };
}

/**
 * 解析请求 URL。
 *
 * @param {string} rawUrl 原始 request.url，例如 `/vue@3.3.4/dist/vue.js?min`
 * @param {URL} base 用于解析的基准地址
 * @returns {Route}
 */
export function parseRoute(rawUrl, base) {
  const url = new URL(rawUrl, base);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw badRequest('URL 中含有非法的百分号编码');
  }

  const query = Object.fromEntries(url.searchParams.entries());

  if (pathname === '/' || pathname === '') {
    return { kind: 'index', query };
  }
  if (pathname === '/_health') {
    return { kind: 'health', query };
  }
  if (pathname === '/_stats') {
    return { kind: 'stats', query };
  }
  if (pathname === '/_metrics') {
    return { kind: 'metrics', query };
  }
  if (pathname === '/_api' || pathname.startsWith('/_api/')) {
    return parseApiRoute(pathname.slice('/_api'.length), query);
  }
  if (pathname === '/favicon.ico') {
    return { kind: 'not-found', query };
  }

  // 去掉前导斜杠
  let rest = pathname.replace(/^\/+/, '');
  let compat = false;

  // jsDelivr 风格的 `/npm/` 前缀。仅当后面确实跟着一个可解析的包名时才剥离，
  // 避免把名字就叫 `npm` 的包误判（`/npm` 只有一段，不会命中这里）。
  if (config.npmPrefix && rest.startsWith('npm/')) {
    const withoutPrefix = rest.slice(4);
    if (SCOPED_RE.test(withoutPrefix) || PLAIN_RE.test(withoutPrefix)) {
      rest = withoutPrefix;
      compat = true;
    }
  }

  const scopedMatch = SCOPED_RE.exec(rest);
  const plainMatch = scopedMatch ? null : PLAIN_RE.exec(rest);
  const match = scopedMatch || plainMatch;

  if (!match) {
    throw badRequest(`无法解析的路径: ${pathname}`);
  }

  const name = match[1];
  const versionSpec = (match[2] ?? '').trim();
  const remainder = match[3] ?? '';

  // remainder 形如 ''、'/'、'/dist/vue.js'、'/dist/'、'//dist//vue.js'
  // 去掉首尾斜杠并收敛中间的空段，避免 `//` 传进下游做路径匹配
  const subPath = remainder
    .split('/')
    .filter((segment) => segment !== '')
    .join('/');

  if (remainder === '' || remainder === '/') {
    // `/pkg` 与 `/pkg@ver` → 入口文件；`/pkg/` 与 `/pkg@ver/` → 目录列表
    return {
      kind: remainder === '/' ? 'listing' : 'entry',
      name,
      versionSpec,
      subPath: '',
      compat,
      query,
    };
  }

  if (remainder.endsWith('/')) {
    return { kind: 'listing', name, versionSpec, subPath, compat, query };
  }

  return { kind: 'file', name, versionSpec, subPath, compat, query };
}

export default { parseRoute };
