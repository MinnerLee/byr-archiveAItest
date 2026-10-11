/**
 * 打包 / 依赖重写。
 *
 * 对应可选功能 3 的「打包」部分：「把多个依赖合并成一个文件」。
 *
 * 一共三种模式：
 *
 *   1. `?bundle`（默认）—— **Inline 模式**
 *      从入口文件出发，把包内所有**相对依赖**（`require('./x')`）递归内联进一个文件，
 *      配一个微型模块运行时。产出自包含，可直接 `<script>` 引入。
 *
 *   2. `?bundle=deep` —— **Deep Inline 模式**
 *      在 Inline 的基础上，**继续把外部依赖（裸说明符）也拉进来**：
 *      按照 package.json 的 dependencies 范围解析版本 → 下载那个包 → 解包 →
 *      把它的入口也内联进来，并对其内部的依赖递归处理（受深度与模块数上限约束）。
 *      这才是真正意义上的「把多个依赖合并成一个文件」。
 *
 *   3. `?esm` / `?bundle=rewrite` —— **Rewrite 模式**
 *      不合并，把所有 import 说明符（相对路径 + 外部包）重写成**指向本服务的绝对 URL**
 *      并把外部包锁定到精确版本（`import 'lodash'` → `import '/npm/lodash@4.17.21/lodash.js'`）。
 *      这正是 jsDelivr `+esm` 与 esm.sh 的真实做法，也是浏览器里唯一真正可行的
 *      「裸模块说明符」处理方式。
 *
 * 自动选择：入口文件里出现 ESM 语法（`import` / `export`）就走 Rewrite 模式，
 * 因为把 ESM 内联成单文件需要完整的「导入提升 + 活绑定」实现，
 * 那是 rollup / esbuild 量级的编译器工程。与其给出一个在 demo 上能跑、
 * 在真实代码上静默出错的实现，不如把边界画清楚。
 *
 * 模块标识：统一用 `包名@版本/包内路径`。这样跨包内联时，
 * 「哪个模块属于哪个包」是显式的，相对路径与裸说明符的解析规则也一目了然。
 */

import config from './config.js';
import logger from './logger.js';
import * as store from './store.js';
import * as registry from './registry.js';
import * as compress from './compress.js';
import { tokenize } from './minify.js';
import { minify as minifyAsync } from './minify-pool.js';
import { formatBytes, encodePathSegment } from './util.js';
import { tooLarge } from './errors.js';
import { metrics } from './metrics.js';

/** 单次打包允许内联的最大模块数（可通过配置覆盖）。 */
const DEFAULT_MAX_MODULES = 120;

/** 单次打包允许的源码总量上限。 */
const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** 深度打包默认最大深度。 */
const DEFAULT_MAX_DEPTH = 3;

/** Node 内置模块名单（这些不应该被当作 npm 包去解析）。 */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

/** 去掉字符串字面量两侧的引号。 */
function unquote(raw) {
  return raw.slice(1, -1);
}

/**
 * 判断一个说明符是否是 Node 内置模块（`fs`、`node:path` ...）。
 * @param {string} spec
 */
function isNodeBuiltinSpec(spec) {
  if (spec.startsWith('node:')) return true;
  const { name } = splitBareSpec(spec);
  return NODE_BUILTINS.has(name);
}

/** 判断说明符是否为「包内相对路径」。 */
function isRelativeSpec(spec) {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
}

/**
 * 判断说明符是不是一个外部 URL（http/https/data/node 协议），这类不当作 npm 包解析。
 *
 * 这里有个必须注意的坑：**不能用 `startsWith('http')` 来判定 URL** ——
 * `'http-errors'.startsWith('http')` 也是 true，于是 `http-errors`、`http-proxy`
 * 这些包会被静默跳过。这个 bug 是在深度打包 express 时暴露的：
 * 67 个包里唯独缺了 `http-errors`，产物一运行就报 "Cannot find module 'http-errors'"。
 */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|node:|data:)/i;

/**
 * @param {string} spec
 * @returns {boolean}
 */
function isUrlLike(spec) {
  return URL_LIKE.test(spec);
}

/** 模块 id 生成规则：`包名@版本/包内路径`。 */
function moduleId(name, version, filePath) {
  return `${name}@${version}/${filePath}`;
}

/**
 * 拆分裸说明符为「包名 + 子路径」，正确处理 scoped 包。
 *
 * @param {string} spec 例如 `lodash/fp`、`@vue/shared/dist/a.js`
 * @returns {{name:string, subpath:string}}
 */
export function splitBareSpec(spec) {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return { name: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') };
  }
  return { name: parts[0], subpath: parts.slice(1).join('/') };
}

/**
 * 扫描源码中的模块说明符。
 *
 * 用词法分析而不是正则：正则会被字符串和注释里的
 * `require("./fake")` 骗到，词法分析不会。
 *
 * @param {string} source
 * @returns {{specifiers: Array<{kind:string, spec:string, start:number, end:number}>, hasEsm:boolean}}
 */
export function findSpecifiers(source) {
  const tokens = tokenize(source);
  const specifiers = [];
  let hasEsm = false;

  /**
   * 取第 index 个 token 之后的下一个「非空白」token。
   * 词法分析会把空白和换行也切成 token，忽略它们才不会漏判。
   */
  const nextSignificant = (index) => {
    for (let j = index + 1; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (t.type === 'space' || t.type === 'newline' || t.type === 'comment') continue;
      return t;
    }
    return null;
  };

  /** 在一个字符串 token 上记录说明符。 */
  const push = (kind, token) => {
    specifiers.push({
      kind,
      spec: unquote(token.value),
      start: token.start + 1,
      end: token.end - 1,
    });
  };

  /** 从位置 i 向后寻找 `from '<string>'`，限定窗口避免跨语句误匹配。 */
  const findFromString = (i) => {
    let depth = 0;
    let seen = 0;
    for (let j = i; j < tokens.length && seen < 40; j += 1) {
      const t = tokens[j];
      if (t.type === 'space' || t.type === 'newline' || t.type === 'comment') continue;
      seen += 1;

      if (t.type === 'punct') {
        if (t.value === '{') depth += 1;
        else if (t.value === '}') depth -= 1;
        else if (t.value === ';' && depth === 0) return null;
      }
      if (t.type === 'ident' && t.value === 'from' && depth === 0) {
        const next = nextSignificant(j);
        return next && next.type === 'string' ? next : null;
      }
      // 遇到别的字符串字面量，说明这条语句已经不相关了
      if (t.type === 'string' && depth === 0) return null;
    }
    return null;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== 'ident') continue;

    if (token.value === 'require') {
      const open = nextSignificant(i);
      if (!open || open.value !== '(') continue;
      const arg = nextSignificant(tokens.indexOf(open));
      if (arg && arg.type === 'string') push('require', arg);
      continue;
    }

    if (token.value === 'import') {
      const next = nextSignificant(i);

      if (next && next.type === 'string') {
        hasEsm = true;
        push('import', next);
      } else if (next && next.value === '.') {
        hasEsm = true; // import.meta
      } else if (next && next.value === '(') {
        const arg = nextSignificant(tokens.indexOf(next));
        if (arg && arg.type === 'string') push('dynamic-import', arg);
      } else {
        const fromToken = findFromString(i + 1);
        if (fromToken) {
          hasEsm = true;
          push('import', fromToken);
        }
      }
      continue;
    }

    if (token.value === 'export') {
      hasEsm = true;
      const fromToken = findFromString(i + 1);
      if (fromToken) push('export-from', fromToken);
      continue;
    }
  }

  return { specifiers, hasEsm };
}

/**
 * 把相对说明符解析为包内真实文件路径。
 *
 * 依次尝试：原样 → 补扩展名 → 当作目录取 index.*。
 *
 * @param {string} fromPath 引用方在包内的路径
 * @param {string} spec 相对说明符
 * @param {(p:string)=>boolean} exists
 * @returns {string|null}
 */
export function resolveRelativeSpec(fromPath, spec, exists) {
  const baseDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const combined = spec.startsWith('/') ? spec.slice(1) : baseDir ? `${baseDir}/${spec}` : spec;

  // 归一化 `.` 与 `..`
  const segments = [];
  for (const part of combined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  const base = segments.join('/');
  if (base === '') return null;

  return resolveCandidate(base, exists);
}

/** 在一个包内，把「不带扩展名的路径」解析成真实文件。 */
function resolveCandidate(base, exists) {
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}/index.js`,
    `${base}/index.mjs`,
    `${base}/index.cjs`,
    `${base}/index.json`,
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** 生成指向本服务的绝对 URL。 */
export function cdnUrl(name, version, filePath) {
  const pkg = name.split('/').map(encodePathSegment).join('/');
  const file = filePath.split('/').map(encodePathSegment).join('/');
  return `/npm/${pkg}@${version}/${file}`;
}

/**
 * 把一个外部依赖解析成「已解包的包 + 入口文件路径」。
 *
 * 版本范围取自**引用方**的 package.json（`dependencies` / `peerDependencies` /
 * `optionalDependencies`），这保证了「内联进来的版本」与 npm 实际安装的版本一致。
 * 解析出的包会进入缓存，所以同一依赖被多处引用时只下载一次。
 *
 * @param {import('./store.js').MaterializedPackage} ownerPkg 引用方所在的包
 * @param {string} spec 裸说明符
 * @param {Map<string, any>} depCache 本次打包内的依赖缓存
 * @returns {Promise<{pkg:any, path:string}|null>}
 */
async function resolveBareModule(ownerPkg, spec, depCache) {
  if (isUrlLike(spec)) return null;

  const { name, subpath } = splitBareSpec(spec);
  if (!name || NODE_BUILTINS.has(name)) return null;
  if (!registry.isValidName(name)) return null;

  const deps = {
    ...(ownerPkg.manifest.dependencies || {}),
    ...(ownerPkg.manifest.peerDependencies || {}),
    ...(ownerPkg.manifest.optionalDependencies || {}),
  };
  const range = deps[name] || 'latest';
  const cacheKey = `${name}@${range}`;

  let depPkg = depCache.get(cacheKey);
  if (!depPkg) {
    const resolved = await registry.resolveVersion(name, range);
    depPkg = await store.loadPackage(name, resolved.version);
    depCache.set(cacheKey, depPkg);
    logger.debug(`深度打包：锁定依赖 ${name}@${resolved.version}（范围 ${range}）`);
  }

  // 解析依赖包的入口时启用 Node 默认解析：这里模拟的是 Node 的模块解析语义，
  // 而不是本服务 URL 的入口语义。真实世界里确实有包不写 main（如 mime@3.0.0），
  // 靠 Node 的 index.js 默认解析工作。
  const filePath = subpath
    ? resolveCandidate(subpath, (p) => depPkg.fileIndex.has(p))
    : store.resolveEntry(depPkg, { nodeDefault: true }).path;

  if (!filePath || !depPkg.fileIndex.has(filePath)) return null;
  return { pkg: depPkg, path: filePath };
}

/**
 * 收集模块图。
 *
 * @param {import('./store.js').MaterializedPackage} rootPkg
 * @param {string} entryPath
 * @param {object} options
 * @param {boolean} [options.deep] 是否递归内联外部依赖
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxModules]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{modules:Map<string, any>, totalBytes:number, truncated:boolean, externalCount:number, entryId:string}>}
 */
async function collectGraph(rootPkg, entryPath, options = {}) {
  const deep = Boolean(options.deep);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxModules = options.maxModules ?? DEFAULT_MAX_MODULES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;

  /** @type {Map<string, any>} */
  const modules = new Map();
  /** @type {Map<string, any>} */
  const depCache = new Map();

  const entryId = moduleId(rootPkg.name, rootPkg.version, entryPath);
  const queue = [{ pkg: rootPkg, path: entryPath, depth: 0 }];

  let totalBytes = 0;
  let truncated = false;
  let externalCount = 0;
  /** 记录「哪些说明符最终没能内联」，用于诊断与产物注释 */
  /** @type {Map<string,string[]>} spec -> 引用它的模块 id 列表 */
  const unresolved = new Map();

  const markUnresolved = (spec, fromId) => {
    const list = unresolved.get(spec);
    if (list) {
      if (list.length < 5) list.push(fromId);
    } else {
      unresolved.set(spec, [fromId]);
    }
  };

  while (queue.length > 0) {
    const item = queue.shift();
    const id = moduleId(item.pkg.name, item.pkg.version, item.path);
    if (modules.has(id)) continue;

    if (modules.size >= maxModules) {
      truncated = true;
      break;
    }

    const { buffer } = await store.readFile(item.pkg, item.path);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw tooLarge(
        `打包源码总量超过上限 ${formatBytes(maxBytes)}，请改用 ?esm 重写模式或减少 --deep 深度`,
        { bytes: totalBytes },
      );
    }

    const source = buffer.toString('utf8');
    const { specifiers, hasEsm } = findSpecifiers(source);

    /** @type {Record<string,string>} 说明符 → 目标模块 id */
    const resolved = {};

    const mod = {
      id,
      path: item.path,
      pkg: item.pkg,
      source,
      specifiers,
      hasEsm,
      resolved,
      depth: item.depth,
    };
    modules.set(id, mod);

    for (const s of specifiers) {
      if (isRelativeSpec(s.spec)) {
        const target = resolveRelativeSpec(item.path, s.spec, (p) => item.pkg.fileIndex.has(p));
        if (target) {
          resolved[s.spec] = moduleId(item.pkg.name, item.pkg.version, target);
          queue.push({ pkg: item.pkg, path: target, depth: item.depth });
        }
        continue;
      }

      // ---- 外部依赖 ----
      if (!deep || item.depth >= maxDepth) {
        externalCount += 1;
        markUnresolved(s.spec, id);
        continue;
      }

      let found = null;
      try {
        found = await resolveBareModule(item.pkg, s.spec, depCache);
      } catch (err) {
        // 单个依赖解析失败不应该毁掉整个打包：退回「不内联」，
        // 运行时由 __nodeRequire 兜底，并在产物注释里说明。
        logger.debug(`依赖 ${s.spec}（被 ${id} 引用）解析失败: ${err.message}`);
      }

      if (found) {
        resolved[s.spec] = moduleId(found.pkg.name, found.pkg.version, found.path);
        queue.push({ pkg: found.pkg, path: found.path, depth: item.depth + 1 });
      } else {
        externalCount += 1;
        markUnresolved(s.spec, id);
      }
    }
  }

  return { modules, totalBytes, truncated, externalCount, entryId, unresolved };
}

/** 把普通文本安全地嵌进 JS 字符串字面量。 */
function jsString(text) {
  return JSON.stringify(text);
}

/**
 * 把模块源码转换成「可以安全塞进函数体」的形式。
 *
 * 这一步是被真实包教出来的，两个必须处理的坑：
 *
 * 1. **`.json` 文件不是合法的 JS 语句**。
 *    `require('./codes.json')` 里的文件内容是 `{"100":"Continue",...}`。
 *    如果原样塞进 `function(module,exports,require){ ... }` 的函数体，
 *    花括号会被解析成一个**块语句**，于是 `"100": "Continue"` 直接语法报错。
 *    正确做法是把它变成一个表达式：`module.exports = {...};`。
 *    （这个 bug 是在深度打包 express 时，内联 `statuses` 包的 `codes.json` 暴露的。）
 *
 * 2. **shebang 行（`#!...`）在函数体里是语法错误**。
 *    很多包的 CLI 文件以 `#!/usr/bin/env node` 开头，内联时必须去掉。
 *    这里改写成同长度的行注释，保留行号信息便于定位。
 *
 * @param {{path:string, source:string}} mod
 * @returns {string}
 */
function prepareModuleSource(mod) {
  let source = mod.source;

  // 去掉 UTF-8 BOM，它在函数体开头同样是非法字符
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

  if (/\.json$/i.test(mod.path)) {
    try {
      return `module.exports = ${JSON.stringify(JSON.parse(source))};`;
    } catch {
      // 不是合法 JSON（真实 npm 包里偶有带注释的 .json），按普通 JS 继续处理
      logger.debug(`${mod.path} 声明为 .json 但无法解析，按 JS 处理`);
    }
  }

  if (source.startsWith('#!')) {
    const newline = source.indexOf('\n');
    source = newline === -1 ? '' : `//${source.slice(2, newline)}\n${source.slice(newline + 1)}`;
  }

  return source;
}

/**
 * 生成 Inline 单文件 bundle。
 *
 * @param {import('./store.js').MaterializedPackage} rootPkg
 * @param {{modules:Map<string,any>, entryId:string, truncated:boolean, externalCount:number}} graph
 * @param {{deep?:boolean}} [extra]
 */
function emitInlineBundle(rootPkg, graph, extra = {}) {
  const { modules, entryId, truncated, externalCount, unresolved } = graph;
  const safeName = rootPkg.name.replace(/[^A-Za-z0-9_$]/g, '_');

  // 把所有「引用方 + 说明符 → 目标模块 id」的解析结果预先算成一张扁平表，
  // 运行时 require 就是一次对象查表，不做任何路径字符串运算。
  /** @type {Record<string,string>} */
  const table = {};
  for (const mod of modules.values()) {
    for (const [spec, target] of Object.entries(mod.resolved)) {
      table[`${mod.id}\u0000${spec}`] = target;
    }
  }

  const packages = new Set([...modules.values()].map((m) => `${m.pkg.name}@${m.pkg.version}`));

  const parts = [];
  parts.push('/*!');
  parts.push(` * BYR Archive bundle · entry=${entryId}`);
  parts.push(
    ` * mode=${extra.deep ? 'deep-inline' : 'inline'}-cjs · modules=${modules.size} · ` +
      `packages=${packages.size} · built=${new Date().toISOString()}`,
  );
  parts.push(' *');
  parts.push(' * 本文件由 BYR Archive 即时生成：');
  parts.push(' *   - 包内相对依赖已全部内联；');
  if (extra.deep) {
    parts.push(' *   - 外部依赖已按 package.json 的版本范围解析并递归内联（版本已锁定）。');
  } else {
    parts.push(' *   - 外部依赖未内联，保留为 require() 调用；加 ?bundle=deep 可继续内联。');
  }
  if (externalCount > 0) {
    const nonBuiltin = [...unresolved.keys()].filter((k) => !isNodeBuiltinSpec(k));
    parts.push(` *   - 仍有 ${externalCount} 个说明符未被内联。`);
    if (nonBuiltin.length > 0) {
      parts.push(` *     其中非 Node 内置的（需要在目标环境自行提供）：${nonBuiltin.slice(0, 12).join(', ')}${nonBuiltin.length > 12 ? ` 等 ${nonBuiltin.length} 个` : ''}`);
    }
  }
  if (truncated) {
    parts.push(` * 注意：模块数达到上限 ${DEFAULT_MAX_MODULES}，依赖图可能不完整。`);
  }
  parts.push(' */');
  parts.push('(function () {');
  parts.push("'use strict';");
  parts.push(`var __defs = {`);

  for (const mod of modules.values()) {
    parts.push(`${jsString(mod.id)}: function (module, exports, require, __filename) {`);
    parts.push(prepareModuleSource(mod));
    parts.push('},');
  }

  parts.push('};');
  parts.push(`var __table = ${JSON.stringify(table)};`);
  parts.push('var __cache = Object.create(null);');
  parts.push("var __nodeRequire = (typeof require === 'function') ? require : null;");
  parts.push('function __load(id) {');
  parts.push('  if (id in __cache) return __cache[id].exports;');
  parts.push('  if (!Object.prototype.hasOwnProperty.call(__defs, id)) {');
  parts.push('    if (__nodeRequire) {');
  parts.push('      try { return __nodeRequire(id); }');
  parts.push('      catch (err) {');
  parts.push('        var hint = /^[a-z@]/.test(id) ? "该外部依赖未被内联，且本地 node_modules 里也没有。" : "该文件未被内联。";');
  parts.push('        throw new Error("[BYR Archive bundle] 无法解析 " + id + "：" + hint + " 可提高 BUNDLE_MAX_DEPTH / BUNDLE_MAX_MODULES 后重新打包，或改用 ?esm 重写模式。");');
  parts.push('      }');
  parts.push('    }');
  parts.push('    throw new Error("[BYR Archive bundle] 外部依赖未内联: " + id + "（可改用 ?esm 重写模式）");');
  parts.push('  }');
  parts.push('  var module = { exports: {} };');
  parts.push('  __cache[id] = module;');
  parts.push('  var requireForModule = function (spec) {');
  parts.push('    var key = id + "\\u0000" + spec;');
  parts.push('    return __load(Object.prototype.hasOwnProperty.call(__table, key) ? __table[key] : spec);');
  parts.push('  };');
  parts.push('  __defs[id](module, module.exports, requireForModule, "/" + id);');
  parts.push('  return module.exports;');
  parts.push('}');
  parts.push(`var __result = __load(${jsString(entryId)});`);
  parts.push("if (typeof module !== 'undefined' && module.exports) { module.exports = __result; }");
  parts.push(`else if (typeof globalThis !== 'undefined' && globalThis.${safeName} === undefined) { globalThis.${safeName} = __result; }`);
  parts.push('})();');

  return parts.join('\n');
}

/**
 * 解析裸说明符为「本服务上的绝对 URL」，并锁定精确版本。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} spec
 * @returns {Promise<string|null>}
 */
async function resolveBareSpecUrl(pkg, spec) {
  if (isUrlLike(spec)) return null;
  const { name, subpath } = splitBareSpec(spec);
  if (!name || NODE_BUILTINS.has(name)) return null;
  if (!registry.isValidName(name)) return null;

  try {
    const found = await resolveBareModule(pkg, spec, new Map());
    if (!found) return null;
    const url = cdnUrl(found.pkg.name, found.pkg.version, found.path);
    logger.debug(`依赖锁定 ${spec} → ${found.pkg.name}@${found.pkg.version}/${found.path}`);
    return url;
  } catch (err) {
    logger.debug(`无法锁定依赖 ${spec}: ${err.message}`);
    return null;
  }
}

/**
 * 把相对说明符批量重写成绝对 URL。
 * @param {string} source
 * @param {Array<{start:number,end:number,text:string}>} rewrites
 */
function applyRewrites(source, rewrites) {
  const sorted = [...rewrites].sort((a, b) => b.start - a.start);
  let out = source;
  for (const rw of sorted) {
    out = out.slice(0, rw.start) + rw.text + out.slice(rw.end);
  }
  return out;
}

/**
 * 生成 Rewrite 模式输出：只重写说明符，不做合并。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} entryPath
 * @param {string} source
 */
async function emitRewrite(pkg, entryPath, source) {
  const { specifiers } = findSpecifiers(source);
  const rewrites = [];
  let internalCount = 0;
  let externalCount = 0;

  for (const item of specifiers) {
    if (isRelativeSpec(item.spec)) {
      const target = resolveRelativeSpec(entryPath, item.spec, (p) => pkg.fileIndex.has(p));
      if (target) {
        rewrites.push({
          start: item.start,
          end: item.end,
          text: cdnUrl(pkg.name, pkg.version, target),
        });
        internalCount += 1;
      }
      continue;
    }

    const url = await resolveBareSpecUrl(pkg, item.spec);
    if (url) {
      rewrites.push({ start: item.start, end: item.end, text: url });
      externalCount += 1;
    }
  }

  const output = applyRewrites(source, rewrites);
  const banner =
    `/*! BYR Archive · ${pkg.name}@${pkg.version} · entry=${entryPath}\n` +
    ` * mode=rewrite · 已重写 ${internalCount} 个包内相对说明符、${externalCount} 个外部依赖\n` +
    ` * 所有 import 路径已指向本服务并锁定到精确版本，可直接被浏览器作为 ES Module 加载。\n` +
    ` */\n`;

  return { output: banner + output, internalCount, externalCount };
}

/**
 * 生成打包产物（与 HTTP 无关，供 CLI 与 handler 共用）。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} entryPath 包内入口文件路径
 * @param {object} [options]
 * @param {boolean} [options.deep] 是否递归内联外部依赖
 * @param {'auto'|'inline'|'rewrite'} [options.mode]
 * @param {boolean} [options.minify] 是否压缩产物
 * @returns {Promise<{output:string, mode:string, modules:number, packages:number, bytes:number, reason:string, external:number}>}
 */
export async function bundleFile(pkg, entryPath, options = {}) {
  const { buffer } = await store.readFile(pkg, entryPath);
  const source = buffer.toString('utf8');
  const probe = findSpecifiers(source);

  let mode = options.mode ?? 'auto';
  if (mode === 'auto') mode = probe.hasEsm ? 'rewrite' : 'inline';

  let output;
  let modeName;
  let reason = '';
  let modules = 0;
  let packages = 1;
  let external = 0;
  /** @type {string[]} */
  let unresolvedList = [];

  if (mode === 'inline') {
    const graph = await collectGraph(pkg, entryPath, {
      deep: Boolean(options.deep),
      maxDepth: config.bundleMaxDepth,
      maxModules: options.deep ? config.bundleMaxModules : DEFAULT_MAX_MODULES,
      maxBytes: options.deep ? config.bundleMaxBytes : DEFAULT_MAX_SOURCE_BYTES,
    });

    // 图里一旦出现 ESM 模块，内联就不再安全，退回重写模式
    const esmModule = [...graph.modules.values()].find((m) => m.hasEsm);
    if (esmModule) {
      logger.debug(`模块 ${esmModule.id} 使用了 ESM 语法，bundle 退回重写模式`);
      const rewritten = await emitRewrite(pkg, entryPath, source);
      output = rewritten.output;
      modeName = 'rewrite';
      reason = `esm:${esmModule.path}`;
      modules = 1;
      external = rewritten.externalCount;
    } else {
      logger.info(
        `打包 ${pkg.name}@${pkg.version}/${entryPath}: ` +
          `${options.deep ? '深度内联' : '内联'} ${graph.modules.size} 个模块`,
      );
      output = emitInlineBundle(pkg, graph, { deep: Boolean(options.deep) });
      modeName = options.deep ? 'deep-inline-cjs' : 'inline-cjs';
      modules = graph.modules.size;
      packages = new Set([...graph.modules.values()].map((m) => m.pkg.name)).size;
      external = graph.externalCount;
      unresolvedList = [...graph.unresolved.keys()].filter((k) => !isNodeBuiltinSpec(k));
      if (graph.truncated) reason = 'truncated';
    }
  } else {
    const rewritten = await emitRewrite(pkg, entryPath, source);
    output = rewritten.output;
    modeName = 'rewrite';
    modules = 1;
    external = rewritten.externalCount;
  }

  let minified = false;
  if (options.minify && config.minify) {
    // 与 handler 的 `?min` 同一道闸门：代码压缩是同步的，产物越大
    // 阻塞事件循环越久（928KB 的 express 深度产物压缩需要数百毫秒）。
    // 超过上限就不压，宁可返回未压缩的大文件，也不让一个匿名请求僵住整个服务。
    if (Buffer.byteLength(output) > config.minifyMaxBytes) {
      logger.debug(
        `跳过打包产物的代码压缩（${Buffer.byteLength(output)} 字节 > 上限 ${config.minifyMaxBytes}）`,
      );
    } else {
      // 同样走 worker 线程，避免一个打包请求把事件循环堵住
      const result = await minifyAsync('bundle.js', output);
      output = result.code;
      minified = true;
      metrics.minifySaved(Math.max(0, result.original - result.minified));
    }
  }

  return {
    output,
    mode: modeName,
    modules,
    packages,
    bytes: Buffer.byteLength(output),
    minified,
    reason,
    external,
    // 未内联的说明符列表（Node 内置模块会被排除），便于调用方判断产物是否真的自包含
    unresolved: unresolvedList,
  };
}

/**
 * HTTP 入口：响应 `?bundle` / `?esm` 请求。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} entryId
 * @param {object} route
 * @param {{minify:boolean, mode:'auto'|'inline'|'rewrite', deep?:boolean}} options
 */
export async function serveBundle(req, res, pkg, entryId, route, options) {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

  const startedAt = Date.now();
  const result = await bundleFile(pkg, entryId, {
    mode: options.mode,
    deep: Boolean(options.deep),
    minify: options.minify,
  });
  const elapsedMs = Date.now() - startedAt;

  const body = Buffer.from(result.output, 'utf8');

  const headers = {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=600',
    'accept-ranges': 'bytes',
    'x-byr-package': pkg.name,
    'x-byr-version': pkg.version,
    'x-byr-bundle': result.mode,
    'x-byr-bundle-modules': String(result.modules),
    'x-byr-bundle-packages': String(result.packages),
    'x-byr-bundle-external': String(result.external),
    'x-byr-bundle-ms': String(elapsedMs),
    'x-powered-by': 'BYR Archive',
  };
  if (result.reason) headers['x-byr-bundle-reason'] = result.reason;
  if (result.minified) headers['x-byr-minified'] = 'true';
  if (config.cors) headers['access-control-allow-origin'] = '*';
  if (config.securityHeaders) headers['x-content-type-options'] = 'nosniff';

  const encoding = compress.negotiate(req.headers['accept-encoding']);
  if (encoding !== 'identity' && body.length >= 1024) {
    const compressed = await compress.compress(
      `bundle:${config.registry}|${pkg.name}@${pkg.version}/${entryId}|${result.mode}|${result.minified}|${result.modules}`,
      body,
      encoding,
    );
    if (compressed.length < body.length) {
      headers['content-encoding'] = encoding;
      headers.vary = 'accept-encoding';
      headers['content-length'] = String(compressed.length);
      metrics.compressionSaved(body.length - compressed.length, encoding);
      res.writeHead(200, headers);
      res.end(method === 'HEAD' ? undefined : compressed);
      return;
    }
  }

  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

export default {
  serveBundle,
  bundleFile,
  findSpecifiers,
  resolveRelativeSpec,
  splitBareSpec,
  cdnUrl,
};
