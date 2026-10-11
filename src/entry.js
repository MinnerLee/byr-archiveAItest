/**
 * 入口文件解析。
 *
 * 题目原文要求：
 *   当用户访问 `/包名` 或 `/包名@版本` 时，服务应解析出该包的入口文件并直接返回其内容。
 *   入口文件解析规则遵循 Node.js 和 npm 生态的惯例：
 *     1. 如果 package.json 中定义了 `jsdelivr` 字段，则使用该字段指定的路径。
 *     2. 否则，检查 `exports["."]`：
 *        a. 若是对象且存在 `exports["."]["default"]`，以该 default 作为路径；
 *        b. 若是字符串，直接使用该路径。
 *     3. 如果没有符合条件的 `exports["."]`，则使用 `main` 字段。
 *     4. 以上都不满足则返回 404。
 *
 * 本模块严格实现上述优先级链，另外补了两处「不改变优先级、只提升健壮性」的处理：
 *   - 路径归一化：去掉 `./` 前缀与多余斜杠；
 *   - 目录兜底：若候选路径实际是个目录，按 npm 惯例再试 `index.js` / `index.json`
 *     / `index.mjs`（老包里 `main: "lib"` 是常见写法，直接 404 体验太差）。
 *
 * 「按 `exports` 的完整条件解析（import/require/browser 等）」被放在
 * `ENTRY_CONDITIONS=1` 开关后面，默认关闭 —— 因为题目明确要求「不满足就用 main」，
 * 默认开启会偏离题面给定行为。
 */

import config from './config.js';

/** 目录兜底时依次尝试的文件名。 */
const INDEX_CANDIDATES = ['index.js', 'index.mjs', 'index.cjs', 'index.json', 'index.node'];

/** 把入口声明归一化成包内相对路径。 */
export function normalizeEntryPath(input) {
  if (typeof input !== 'string') return null;
  let p = input.trim();
  if (p === '') return null;
  p = p.replace(/^\.\//, '').replace(/^\/+/, '');
  // 收敛 `a/./b` 与 `a//b`
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null;
  if (segments.length === 0) return null;
  return segments.join('/');
}

/**
 * 按题目给定优先级链，算出「入口文件在包内的相对路径」。
 *
 * @param {object} manifest package.json 的内容（或 registry 返回的单版本 manifest）
 * @param {(relPath:string) => boolean} exists 判断包内某路径是否为存在的文件
 * @param {object} [options]
 * @param {boolean} [options.nodeDefault=false] 4 条规则全部落空时，
 *        是否再尝试 Node 的默认解析（包根 `index.js` 等）。
 *
 *        默认 **关闭**，因为题面规则 4 明确写着「以上均不满足则返回 404」。
 *        但真实世界里有包确实不写 `main`（例如 `mime@3.0.0`），
 *        靠 Node 的 `index.js` 默认解析工作 —— 所以打包器在解析**依赖包**的入口时
 *        会显式打开这个开关（它模拟的是 Node 的解析语义，不是本服务的 URL 语义）。
 *
 * @returns {{path:string, source:string}|null} 解析结果；无法解析返回 null
 */
export function resolveEntry(manifest, exists, options = {}) {
  if (!manifest || typeof manifest !== 'object') return null;

  /** 用目录兜底把候选路径变成「确实存在的文件路径」。 */
  const settle = (candidate) => {
    if (!candidate) return null;
    if (exists(candidate)) return candidate;
    // 候选是个目录（或指向目录）→ 试 index.*
    for (const index of INDEX_CANDIDATES) {
      const p = `${candidate.replace(/\/+$/, '')}/${index}`;
      if (exists(p)) return p;
    }
    return null;
  };

  // ---- 规则 1：jsdelivr 字段 ----
  const jsdelivr = normalizeEntryPath(manifest.jsdelivr);
  if (jsdelivr) {
    const settled = settle(jsdelivr);
    if (settled) return { path: settled, source: 'jsdelivr' };
  }

  // ---- 规则 2：exports["."] ----
  const dotExport = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports['.'] : undefined;
  if (typeof dotExport === 'string') {
    const normalized = normalizeEntryPath(dotExport);
    const settled = settle(normalized);
    if (settled) return { path: settled, source: 'exports["."]' };
  } else if (dotExport && typeof dotExport === 'object') {
    // 2.a 只认 default 字段
    const def = dotExport.default;
    if (typeof def === 'string') {
      const settled = settle(normalizeEntryPath(def));
      if (settled) return { path: settled, source: 'exports["."].default' };
    }
  }

  // ---- 规则 3：main ----
  const main = normalizeEntryPath(manifest.main);
  if (main) {
    const settled = settle(main);
    if (settled) return { path: settled, source: 'main' };
  }

  // ---- 可选增强：完整 exports 条件解析 / browser 字段 ----
  if (config.enableEntryConditions) {
    const conditional = resolveConditionalExports(manifest, exists);
    if (conditional) return conditional;

    const browser = manifest.browser;
    if (typeof browser === 'string') {
      const settled = settle(normalizeEntryPath(browser));
      if (settled) return { path: settled, source: 'browser' };
    }
  }

  // ---- 可选增强：Node 默认解析（仅打包器解析依赖时启用） ----
  if (options.nodeDefault) {
    for (const index of INDEX_CANDIDATES) {
      if (exists(index)) return { path: index, source: 'node-default' };
    }
  }

  // ---- 规则 4：兜底失败 ----
  return null;
}

/** 按常见条件顺序在 exports 里深度优先找第一个可用的路径。 */
function resolveConditionalExports(manifest, exists) {
  const dot = manifest.exports && typeof manifest.exports === 'object' ? manifest.exports['.'] : undefined;
  if (!dot || typeof dot !== 'object') return null;

  const conditions = ['default', 'browser', 'import', 'require', 'node', 'module', 'development', 'production'];
  const walk = (node) => {
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return null;
    for (const key of conditions) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const found = walk(node[key]);
        if (found) return found;
      }
    }
    // 没有任何已知条件，退而取第一个字符串值
    for (const value of Object.values(node)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };

  const candidate = normalizeEntryPath(walk(dot));
  if (candidate && exists(candidate)) {
    return { path: candidate, source: 'exports["."] (conditions)' };
  }
  return null;
}

export default { resolveEntry, normalizeEntryPath };
