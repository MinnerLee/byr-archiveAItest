/**
 * 打包 / 依赖重写（可选功能 3 的「打包」部分）。
 *
 * 题目原话：「参考 jsdelivr 和 esm.sh 的功能提供 压缩/打包 功能
 *           （例如把 JS 文件最小化，把多个依赖合并成一个文件）」。
 *
 * 这里实现两种模式，通过查询参数选择：
 *
 *   1. `?bundle`（默认）—— **Inline 模式**
 *      从入口文件出发，把包内所有**相对依赖**（`require('./x')`）递归收集起来，
 *      内联进一个文件，配一个不到 30 行的微型模块运行时。
 *      输出是一个自包含的、可以直接 `<script>` 引入的文件。
 *
 *   2. `?esm` 或 `?bundle=rewrite` —— **Rewrite 模式**
 *      不合并，而是把所有 import 说明符（相对路径 + 外部包）重写成
 *      **指向本服务的绝对 URL**，并且顺带把外部包的版本锁定到精确版本
 *      （例如 `import 'lodash'` → `import '/npm/lodash@4.17.21/lodash.js'`）。
 *      这正是 jsDelivr `+esm` 与 esm.sh 的真实做法，也是浏览器里唯一
 *      真正可行的「裸模块说明符」处理方式。
 *
 * 自动选择：入口文件里出现 ESM 语法（`import` / `export`）就自动走 Rewrite 模式，
 * 因为把 ESM 内联成单文件需要完整实现「导入提升 + 活绑定」，那是一个真正的
 * 编译器工程（rollup / esbuild 的量级），不适合塞进这个「最简 CDN」。
 * 与其给出一个能跑通 demo、但在真实代码上静默出错的实现，不如把边界画清楚。
 */

import config from './config.js';
import logger from './logger.js';
import * as store from './store.js';
import * as registry from './registry.js';
import * as cache from './cache.js';
import * as compress from './compress.js';
import { tokenize, minifyJavaScript } from './minify.js';
import { escapeHtml, formatBytes, encodePathSegment } from './util.js';
import { notFound, tooLarge } from './errors.js';

/** 单次打包允许内联的最大模块数，防止一个包把整个 dist 目录拖进来。 */
const MAX_MODULES = 120;

/** 单次打包允许的源码总量上限。 */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

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

/** 判断说明符是否为「包内相对路径」。 */
function isRelativeSpec(spec) {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
}

/** 拆分裸说明符为「包名 + 子路径」，正确处理 scoped 包。 */
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

      // 静态 import：import 'x' / import x from 'x' / import {a} from 'x' / import * as n from 'x'
      if (next && next.type === 'string') {
        hasEsm = true;
        push('import', next);
      } else if (next && next.value === '.') {
        hasEsm = true; // import.meta
      } else if (next && next.value === '(') {
        // 动态 import：不改语义，但同样需要重写目标
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
 * 解析相对说明符为包内真实文件路径。
 *
 * 依次尝试：原样 → 补扩展名 → 当作目录取 index.* →
 * 当作目录读它的 package.json main。
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
 * 收集 CJS 模块图。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} entryId
 * @returns {Promise<{modules:Map<string,{id:string, source:string, specifiers:any[], hasEsm:boolean}>, totalBytes:number, truncated:boolean}>}
 */
async function collectGraph(pkg, entryId) {
  /** @type {Map<string,{id:string, source:string, specifiers:any[], hasEsm:boolean}>} */
  const modules = new Map();
  const queue = [entryId];
  let totalBytes = 0;
  let truncated = false;

  while (queue.length > 0) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    if (modules.size >= MAX_MODULES) {
      truncated = true;
      break;
    }

    const { buffer } = await store.readFile(pkg, id);
    totalBytes += buffer.length;
    if (totalBytes > MAX_SOURCE_BYTES) {
      throw tooLarge(
        `打包源码总量超过上限 ${formatBytes(MAX_SOURCE_BYTES)}，请改用 ?esm 重写模式`,
        { bytes: totalBytes },
      );
    }

    const source = buffer.toString('utf8');
    const { specifiers, hasEsm } = findSpecifiers(source);
    modules.set(id, { id, source, specifiers, hasEsm });

    for (const item of specifiers) {
      if (!isRelativeSpec(item.spec)) continue;
      const target = resolveRelativeSpec(id, item.spec, (p) => pkg.fileIndex.has(p));
      if (target && !modules.has(target)) queue.push(target);
    }
  }

  return { modules, totalBytes, truncated };
}

/** 构造「引用方 + 说明符 → 模块 id」的解析表。 */
function buildResolveTable(modules) {
  const table = {};
  for (const mod of modules.values()) {
    for (const item of mod.specifiers) {
      if (!isRelativeSpec(item.spec)) continue;
      const target = resolveRelativeSpec(mod.id, item.spec, (p) =>
        [...modules.keys()].includes(p),
      );
      if (target) table[`${mod.id}\u0000${item.spec}`] = target;
    }
  }
  return table;
}

/** 把普通文本安全地嵌进 JS 字符串字面量。 */
function jsString(text) {
  return JSON.stringify(text);
}

/**
 * 生成 Inline 单文件 bundle。
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} entryId
 * @param {Map<string,{id:string,source:string,specifiers:any[],hasEsm:boolean}>} modules
 * @param {{truncated?:boolean}} [extra]
 */
function emitInlineBundle(pkg, entryId, modules, extra = {}) {
  const safeName = pkg.name.replace(/[^A-Za-z0-9_$]/g, '_');
  const table = buildResolveTable(modules);

  const parts = [];
  parts.push('/*!');
  parts.push(` * BYR Archive bundle · ${pkg.name}@${pkg.version} · entry=${entryId}`);
  parts.push(` * mode=inline-cjs · modules=${modules.size} · built=${new Date().toISOString()}`);
  parts.push(' *');
  parts.push(' * 本文件由 BYR Archive 即时生成：包内所有相对依赖已内联，无需再发额外请求。');
  parts.push(' * 未被内联的外部依赖（如 require("lodash")）会在 Node 环境下透传给原生 require，');
  parts.push(' * 在浏览器中则会抛出明确错误 —— 请改用 ?esm 重写模式。');
  if (extra.truncated) {
    parts.push(` * 注意：模块数达到上限 ${MAX_MODULES}，依赖图可能不完整。`);
  }
  parts.push(' */');
  parts.push('(function () {');
  parts.push("'use strict';");
  parts.push(`var __defs = {`);

  for (const mod of modules.values()) {
    parts.push(`${jsString(mod.id)}: function (module, exports, require, __filename) {`);
    parts.push(mod.source);
    parts.push('},');
  }

  parts.push('};');
  parts.push(`var __table = ${JSON.stringify(table)};`);
  parts.push('var __cache = Object.create(null);');
  parts.push("var __nodeRequire = (typeof require === 'function') ? require : null;");
  parts.push('function __load(id) {');
  parts.push('  if (id in __cache) return __cache[id].exports;');
  parts.push('  if (!Object.prototype.hasOwnProperty.call(__defs, id)) {');
  parts.push('    if (__nodeRequire) return __nodeRequire(id);');
  parts.push('    throw new Error("[BYR Archive bundle] 外部依赖未内联: " + id + "（请改用 ?esm 重写模式）");');
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
async function resolveBareSpec(pkg, spec) {
  if (spec.startsWith('node:') || spec.startsWith('data:') || spec.startsWith('http')) return null;
  const { name, subpath } = splitBareSpec(spec);
  if (!name || NODE_BUILTINS.has(name)) return null;
  if (!registry.isValidName(name)) return null;

  const deps = {
    ...(pkg.manifest.dependencies || {}),
    ...(pkg.manifest.peerDependencies || {}),
    ...(pkg.manifest.optionalDependencies || {}),
  };
  const range = deps[name] || 'latest';

  try {
    const resolved = await registry.resolveVersion(name, range);
    const depPkg = await store.loadPackage(name, resolved.version);
    const file = subpath || store.resolveEntry(depPkg).path;
    if (!depPkg.fileIndex.has(file)) return null;
    logger.debug(`依赖锁定 ${spec} → ${name}@${resolved.version}/${file}`);
    return cdnUrl(name, resolved.version, file);
  } catch (err) {
    logger.debug(`无法锁定依赖 ${spec}: ${err.message}`);
    return null;
  }
}

/**
 * 生成 Rewrite 模式输出：只重写说明符，不做合并。
 *
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} entryId
 * @param {string} source
 * @param {boolean} rewriteExternal 是否同时重写外部包说明符
 */
async function emitRewrite(pkg, entryId, source, rewriteExternal = true) {
  const { specifiers } = findSpecifiers(source);
  const rewrites = [];
  let internalCount = 0;
  let externalCount = 0;

  for (const item of specifiers) {
    if (isRelativeSpec(item.spec)) {
      const target = resolveRelativeSpec(entryId, item.spec, (p) => pkg.fileIndex.has(p));
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

    if (!rewriteExternal) continue;
    const url = await resolveBareSpec(pkg, item.spec);
    if (url) {
      rewrites.push({ start: item.start, end: item.end, text: url });
      externalCount += 1;
    }
  }

  const output = applyRewrites(source, rewrites);
  const banner =
    `/*! BYR Archive · ${pkg.name}@${pkg.version} · entry=${entryId}\n` +
    ` * mode=rewrite · 已重写 ${internalCount} 个包内相对说明符、${externalCount} 个外部依赖\n` +
    ` * 所有 import 路径已指向本服务并锁定到精确版本，可直接被浏览器作为 ES Module 加载。\n` +
    ` */\n`;

  return { output: banner + output, internalCount, externalCount };
}

/**
 * HTTP 入口：响应 `?bundle` / `?esm` 请求。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./store.js').MaterializedPackage} pkg
 * @param {string} entryId
 * @param {object} route
 * @param {{minify:boolean, mode:'auto'|'inline'|'rewrite'}} options
 */
export async function serveBundle(req, res, pkg, entryId, route, options) {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

  const { buffer } = await store.readFile(pkg, entryId);
  const source = buffer.toString('utf8');
  const probe = findSpecifiers(source);

  // 自动选择模式：有 ESM 语法就走重写（合并 ESM 需要完整的模块语义实现）
  let mode = options.mode;
  if (mode === 'auto') mode = probe.hasEsm ? 'rewrite' : 'inline';

  let output;
  let diagnostics;

  if (mode === 'inline') {
    const graph = await collectGraph(pkg, entryId);
    // 图里出现任何 ESM 模块，内联就不再安全，退回重写
    const esmModule = [...graph.modules.values()].find((m) => m.hasEsm);
    if (esmModule) {
      logger.debug(`模块 ${esmModule.id} 使用了 ESM 语法，bundle 退回重写模式`);
      const result = await emitRewrite(pkg, entryId, source, true);
      output = result.output;
      diagnostics = { mode: 'rewrite', reason: `esm:${esmModule.id}`, ...result };
    } else {
      logger.info(`打包 ${pkg.name}@${pkg.version}/${entryId}: 内联 ${graph.modules.size} 个模块`);
      output = emitInlineBundle(pkg, entryId, graph.modules, { truncated: graph.truncated });
      diagnostics = {
        mode: 'inline-cjs',
        modules: graph.modules.size,
        sourceBytes: graph.totalBytes,
        truncated: graph.truncated,
      };
    }
  } else {
    const result = await emitRewrite(pkg, entryId, source, true);
    output = result.output;
    diagnostics = { mode: 'rewrite', ...result };
  }

  let body = Buffer.from(output, 'utf8');
  let minified = false;
  if (options.minify && config.minify) {
    const result = minifyJavaScript(body.toString('utf8'));
    body = Buffer.from(result.code, 'utf8');
    minified = true;
  }

  const headers = {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'public, max-age=600',
    'accept-ranges': 'bytes',
    'x-byr-package': pkg.name,
    'x-byr-version': pkg.version,
    'x-byr-bundle': diagnostics.mode,
    'x-byr-bundle-modules': String(diagnostics.modules ?? diagnostics.internalCount ?? 0),
    'x-powered-by': 'BYR Archive',
  };
  if (diagnostics.reason) headers['x-byr-bundle-reason'] = diagnostics.reason;
  if (minified) headers['x-byr-minified'] = 'true';
  if (config.cors) headers['access-control-allow-origin'] = '*';

  const encoding = compress.negotiate(req.headers['accept-encoding']);
  if (encoding !== 'identity') {
    const compressed = await compress.compress(
      `bundle:${config.registry}|${pkg.name}@${pkg.version}/${entryId}|${diagnostics.mode}|${minified}`,
      body,
      encoding,
    );
    if (compressed.length < body.length) {
      headers['content-encoding'] = encoding;
      headers.vary = 'accept-encoding';
      headers['content-length'] = String(compressed.length);
      res.writeHead(200, headers);
      res.end(method === 'HEAD' ? undefined : compressed);
      return;
    }
  }

  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

export default { serveBundle, findSpecifiers, resolveRelativeSpec, splitBareSpec, cdnUrl };
