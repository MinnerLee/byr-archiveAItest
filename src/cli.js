/**
 * 命令行工具。
 *
 * 动机：这个服务的核心逻辑（版本解析、入口解析、解包、压缩、打包）本身
 * 与 HTTP 无关。把它们关在服务器进程里，只有「发一个 HTTP 请求」一条路能用，
 * 既不方便调试，也无法在构建脚本里复用。
 *
 * 所以补一层 CLI：**复用完全相同的核心模块**，把同样的能力搬到终端里。
 *
 *   byr-archive serve                    启动服务
 *   byr-archive info  <包[@版本]>         解析结果概览（版本怎么算出来的、入口是哪条规则）
 *   byr-archive tree  <包[@版本]>         完整文件树
 *   byr-archive ls    <包[@版本]> [目录]   目录列表（终端友好的表格）
 *   byr-archive cat   <包[@版本]> <文件>   输出文件内容
 *   byr-archive min   <包[@版本]> <文件>   输出压缩后内容（-s 只打印统计）
 *   byr-archive bundle <包[@版本]> <文件>  打包（--deep 递归内联外部依赖，-o 写文件）
 *   byr-archive verify <包[@版本]>        自检：把每个环节跑一遍并给出结论
 *
 * 约定：所有命令的 stdout 只输出结果本身，日志统一走 stderr，
 * 因此 `byr-archive cat lodash > lodash.js` 这种管道用法是干净的。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import logger from './logger.js';
import * as cache from './cache.js';
import * as store from './store.js';
import * as mime from './mime.js';
import * as semver from './semver.js';
import { minifyJavaScript } from './minify.js';
import { findSpecifiers } from './bundle.js';
import { start, installGracefulShutdown } from './server.js';
import { formatBytes } from './util.js';
import { HttpError } from './errors.js';

/** 输出到 stdout（结果本身）。 */
function out(text = '') {
  process.stdout.write(`${text}\n`);
}

/** 输出到 stderr（提示信息，不污染管道）。 */
function note(text = '') {
  process.stderr.write(`${text}\n`);
}

/**
 * 计算字符串在终端里的显示宽度。
 *
 * 中文字符占 2 列，`String#length` 数的是码元个数，直接用会把对齐弄歪 ——
 * 这是中文 CLI 里最常见的观感问题，顺手修掉。
 *
 * @param {string} text
 * @returns {number}
 */
function displayWidth(text) {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 按显示宽度右侧补空格。
 * @param {string} text
 * @param {number} width
 */
function padEndWidth(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 极简参数解析：把 `--flag value` 与 `--flag` 收进对象，其余作为位置参数。
 *
 * @param {string[]} argv
 * @returns {{positional:string[], flags:Record<string, string|boolean>}}
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const ALIAS = { '-o': '--out', '-s': '--stats', '-j': '--json', '-h': '--help' };

  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    if (ALIAS[token]) token = ALIAS[token];

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(0, eq)] = token.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[token] = next;
        i += 1;
      } else {
        flags[token] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return { positional, flags };
}

/**
 * 解析 `包名@版本描述`，正确处理 scoped 包。
 *
 * @param {string} spec 例如 `vue`、`vue@3.3.4`、`@vue/shared@^3.2.0`
 * @returns {{name:string, version:string}}
 */
export function parsePackageSpec(spec) {
  if (!spec) throw new Error('缺少包名');
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash === -1) throw new Error(`scoped 包名不完整: ${spec}（应为 @scope/name）`);
    const rest = spec.slice(slash + 1);
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      return { name: spec.slice(0, slash + 1) + rest.slice(0, at), version: rest.slice(at + 1) };
    }
    return { name: spec, version: '' };
  }
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  return { name: spec, version: '' };
}

/* ------------------------------------------------------------------ */
/* 子命令                                                              */
/* ------------------------------------------------------------------ */

const HELP = `BYR Archive —— 最简版 jsDelivr

用法: byr-archive <命令> [参数]

命令:
  serve  [--port n] [--host addr]        启动 HTTP 服务（默认命令，默认端口 8080）
  info   <包[@版本]> [-j]                解析结果概览（版本来源、入口命中规则、体积）
  tree   <包[@版本]> [-j]                完整文件树
  ls     <包[@版本]> [目录] [-j]          目录列表
  cat    <包[@版本]> <文件>               输出文件内容（可重定向）
  min    <包[@版本]> <文件> [-s]          输出压缩后内容；-s 只打印压缩统计
  bundle <包[@版本]> <文件> [--deep] [-o 文件]
                                         打包；--deep 会递归内联外部依赖
  verify <包[@版本]>                     自检：逐环节跑一遍并给出结论

全局参数:
  --registry <url>   上游 registry（优先级高于环境变量与 .npmrc）
  -j, --json         以 JSON 输出（便于脚本消费）
  -h, --help         显示帮助

环境变量: REGISTRY / REGISTRY_TOKEN / CACHE_DIR / LOG_LEVEL / PORT / HOST
另外会自动读取 ./.npmrc 与 ~/.npmrc 中的 registry 与 _authToken。
`;

/**
 * 加载一个包（共用入口）。
 * @param {string} spec
 * @returns {Promise<import('./store.js').MaterializedPackage>}
 */
async function load(spec) {
  const { name, version } = parsePackageSpec(spec);
  await cache.init();
  return store.loadPackage(name, version);
}

/** serve：启动服务。 */
async function commandServe(flags) {
  const port = Number.parseInt(String(flags['--port'] ?? ''), 10);
  const host = typeof flags['--host'] === 'string' ? flags['--host'] : undefined;

  await cache.init();
  const server = start({
    port: Number.isFinite(port) ? port : config.port,
    host: host ?? config.host,
  });
  installGracefulShutdown(await server);

  // 保持进程存活，直到收到信号
  await new Promise(() => {});
}

/** info：解析结果概览。 */
async function commandInfo(positional, flags) {
  const spec = positional[0];
  if (!spec) throw new Error('用法: byr-archive info <包[@版本]>');

  const pkg = await load(spec);

  let entry = null;
  let entryError = null;
  try {
    entry = store.resolveEntry(pkg);
  } catch (err) {
    entryError = err.message;
  }

  if (flags['--json']) {
    out(JSON.stringify({
      package: pkg.name,
      version: pkg.version,
      how: pkg.how,
      candidates: pkg.candidates,
      entry,
      entryError,
      files: pkg.fileIndex.size,
      directories: pkg.dirIndex.size,
      bytes: pkg.totalBytes,
      registry: config.registry,
      registrySource: config.registrySource,
      unpackedAt: new Date(pkg.storedAt).toISOString(),
      tarball: pkg.manifest.dist?.tarball,
      license: typeof pkg.manifest.license === 'string' ? pkg.manifest.license : pkg.manifest.license?.type,
    }, null, 2));
    return;
  }

  const rows = [
    ['包', pkg.name],
    ['请求的版本描述', parsePackageSpec(spec).version || 'latest'],
    ['解析到的版本', pkg.version],
    ['解析方式', pkg.how + (pkg.candidates ? `（上游共 ${pkg.candidates} 个版本）` : '')],
    ['入口文件', entry ? `${entry.path}  ← ${entry.source}` : `（无法解析：${entryError}）`],
    ['入口 Content-Type', entry ? mime.lookup(entry.path) : '-'],
    ['文件数', String(pkg.fileIndex.size)],
    ['目录数', String(pkg.dirIndex.size)],
    ['解压后体积', `${formatBytes(pkg.totalBytes)}（${pkg.totalBytes} 字节）`],
    ['tarball', pkg.manifest.dist?.tarball || '-'],
    ['License', (typeof pkg.manifest.license === 'string' ? pkg.manifest.license : pkg.manifest.license?.type) || '-'],
    ['上游 registry', `${config.registry}  (${config.registrySource})`],
    ['解包时间', new Date(pkg.storedAt).toISOString()],
  ];
  const width = Math.max(...rows.map((r) => displayWidth(r[0])));
  for (const [key, value] of rows) {
    out(`${padEndWidth(key, width + 2)}${value}`);
  }
}

/** tree：完整文件树。 */
async function commandTree(positional, flags) {
  const spec = positional[0];
  if (!spec) throw new Error('用法: byr-archive tree <包[@版本]>');
  const pkg = await load(spec);

  if (flags['--json']) {
    out(JSON.stringify(
      [...pkg.fileIndex.entries()].map(([p, size]) => ({ path: p, size })).sort((a, b) => a.path.localeCompare(b.path, 'en')),
      null, 2,
    ));
    return;
  }

  const prefix = positional[1] ?? '';
  const entries = [...pkg.fileIndex.keys()]
    .filter((p) => (prefix === '' ? true : p.startsWith(prefix)))
    .sort((a, b) => a.localeCompare(b, 'en'));

  for (const p of entries) {
    const size = pkg.fileIndex.get(p) ?? 0;
    out(`${String(size).padStart(10, ' ')}  ${p}`);
  }
  note(`${entries.length} 个文件，共 ${formatBytes(entries.reduce((s, p) => s + (pkg.fileIndex.get(p) ?? 0), 0))}`);
}

/** ls：目录列表。 */
async function commandLs(positional, flags) {
  const spec = positional[0];
  if (!spec) throw new Error('用法: byr-archive ls <包[@版本]> [目录]');
  const pkg = await load(spec);

  const dir = (positional[1] ?? '').replace(/^\/+|\/+$/g, '');
  const state = store.stat(pkg, dir);
  if (state !== 'dir') throw new Error(`目录不存在: ${dir || '/'}`);

  const { files, dirs } = store.listDir(pkg, dir);

  if (flags['--json']) {
    out(JSON.stringify({ package: pkg.name, version: pkg.version, dir, dirs, files }, null, 2));
    return;
  }

  out(`\x1b[1m${pkg.name}@${pkg.version}/${dir}\x1b[0m`);
  for (const d of dirs) out(`  \x1b[34m${d}/\x1b[0m`);
  for (const f of files) {
    const tag = f.name === (() => { try { return store.resolveEntry(pkg).path.split('/').pop(); } catch { return ''; } })();
    out(`  ${f.name}${tag ? '  \x1b[32m[入口]\x1b[0m' : ''}  \x1b[90m${formatBytes(f.size)}\x1b[0m`);
  }
}

/** cat：输出文件内容。 */
async function commandCat(positional) {
  const [, file] = positional;
  if (!positional[0] || !file) throw new Error('用法: byr-archive cat <包[@版本]> <文件路径>');
  const pkg = await load(positional[0]);

  if (store.stat(pkg, file) !== 'file') throw new Error(`文件不存在: ${file}`);
  const { buffer } = await store.readFile(pkg, file);
  process.stdout.write(buffer);
}

/** min：压缩。 */
async function commandMin(positional, flags) {
  const [, file] = positional;
  if (!positional[0] || !file) throw new Error('用法: byr-archive min <包[@版本]> <文件> [-s]');
  const pkg = await load(positional[0]);

  if (store.stat(pkg, file) !== 'file') throw new Error(`文件不存在: ${file}`);
  const { buffer } = await store.readFile(pkg, file);
  const source = buffer.toString('utf8');

  const started = Date.now();
  const result = minifyJavaScript(source);
  const ms = Date.now() - started;

  note(`${file}: ${formatBytes(result.original)} -> ${formatBytes(result.minified)} ` +
    `（降 ${((1 - result.ratio) * 100).toFixed(1)}%，耗时 ${ms}ms）`);

  if (flags['--stats']) {
    out(JSON.stringify({
      file,
      original: result.original,
      minified: result.minified,
      savedPercent: Number(((1 - result.ratio) * 100).toFixed(2)),
      ms,
    }, null, 2));
    return;
  }
  process.stdout.write(`${result.code}\n`);
}

/** bundle：打包。 */
async function commandBundle(positional, flags) {
  const [, file] = positional;
  if (!positional[0] || !file) {
    throw new Error('用法: byr-archive bundle <包[@版本]> <文件> [--deep] [-o 输出文件]');
  }
  const { bundleFile } = await import('./bundle.js');
  const pkg = await load(positional[0]);
  const deep = Boolean(flags['--deep']);
  const result = await bundleFile(pkg, file, { deep });

  note(`模式 ${result.mode} · 模块 ${result.modules} · ${formatBytes(result.bytes)}` +
    (result.mode === 'rewrite' ? `（原因：${result.reason}）` : ''));

  const target = typeof flags['--out'] === 'string' ? flags['--out'] : '';
  if (target) {
    fs.writeFileSync(target, result.output);
    note(`已写入 ${path.resolve(target)}`);
  } else {
    process.stdout.write(result.output);
  }
}

/**
 * 语法校验：**只解析不执行**。
 *
 * 这一点很重要 —— 被校验的是刚从 npm 下载来的第三方代码，
 * 不能因为「验证」就去执行它。
 *
 * 三级策略：
 *   1. CJS 用 `vm.Script` 编译（不运行），完全不需要子进程，最快也最稳。
 *   2. ESM 优先用 `vm.SourceTextModule`（需要 `--experimental-vm-modules`）。
 *   3. 都不行时退回 `node --check <临时文件>`。
 *
 * 为什么默认不用 `spawnSync`？因为在 Windows 上「进程启动自己这个可执行文件」
 * 会偶发 `EBUSY`（文件正被占用），表现是随机失败、报错信息为空 —— 极难排查。
 * 能用进程内手段解决的就不要开子进程。
 *
 * @param {string} code
 * @param {boolean} isEsm
 */
function syntaxCheck(code, isEsm) {
  if (!isEsm) {
    try {
      // eslint-disable-next-line no-new
      new vm.Script(code, { filename: 'byr-verify.cjs' });
      return;
    } catch (err) {
      throw new Error(`语法校验未通过：${err.message}`);
    }
  }

  if (typeof vm.SourceTextModule === 'function') {
    try {
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(code, { identifier: 'byr-verify.mjs' });
      return;
    } catch (err) {
      throw new Error(`语法校验未通过：${err.message}`);
    }
  }

  // 兜底：起子进程用 Node 自己的解析器校验
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byr-verify-'));
  const file = path.join(dir, 'probe.mjs');
  try {
    fs.writeFileSync(file, code);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.error) {
      throw new Error(`无法启动语法校验子进程：${result.error.code || result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !l.startsWith('(node:'))
        .pop();
      throw new Error(`语法校验未通过：${detail || `退出码 ${result.status}`}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** verify：逐环节自检。 */
async function commandVerify(positional, flags) {
  const spec = positional[0];
  if (!spec) throw new Error('用法: byr-archive verify <包[@版本]>');

  const pkg = await load(spec);
  /** @type {Array<{ok:boolean,label:string,detail:string}>} */
  const results = [];

  /**
   * 跑一项检查。
   *
   * 刻意写成「一律 await 的顺序执行」而不是 Promise.all：
   * 检查项之间存在数据依赖（比如入口路径要先解析出来，后面才能验证它是否存在），
   * 而且报告的顺序必须与代码顺序一致，否则这个命令的可读性就没有意义了。
   */
  const check = async (label, fn) => {
    try {
      const detail = await fn();
      results.push({ ok: true, label, detail: detail === undefined ? '' : String(detail) });
    } catch (err) {
      results.push({ ok: false, label, detail: err.message });
    }
  };

  let entryPath = '';

  await check('包元信息可获取', () => `${pkg.name}@${pkg.version}（版本解析方式：${pkg.how}）`);
  await check('tarball 已下载并解包', () => `${pkg.fileIndex.size} 个文件，共 ${formatBytes(pkg.totalBytes)}`);
  await check('入口文件可解析（jsdelivr / exports["."] / main 优先级链）', () => {
    const entry = store.resolveEntry(pkg);
    entryPath = entry.path;
    return `${entry.path}  ←  命中 ${entry.source}`;
  });
  await check('入口文件在包内真实存在', () => {
    if (!entryPath) throw new Error('入口未解析成功');
    if (store.stat(pkg, entryPath) !== 'file') throw new Error(`${entryPath} 不是普通文件`);
    return '是';
  });
  await check('入口文件 Content-Type 已确定', () => {
    if (!entryPath) throw new Error('入口未解析成功');
    return mime.lookup(entryPath);
  });
  await check('包内所有文件的 Content-Type 无遗漏', () => {
    let unknown = 0;
    for (const f of pkg.fileIndex.keys()) {
      if (mime.lookup(f) === 'application/octet-stream') unknown += 1;
    }
    return `${pkg.fileIndex.size} 个文件中 ${unknown} 个回退为 octet-stream`;
  });
  await check('包内无路径穿越条目', () => {
    const bad = [...pkg.fileIndex.keys()].filter((f) => f.split('/').includes('..') || f.startsWith('/'));
    if (bad.length > 0) throw new Error(`发现可疑路径: ${bad.slice(0, 3).join(', ')}`);
    return '通过';
  });
  await check('包根目录索引可用', () => {
    const { files, dirs } = store.listDir(pkg, '');
    if (files.length + dirs.length === 0) throw new Error('包根目录为空');
    return `${files.length} 个文件、${dirs.length} 个子目录`;
  });
  await check('入口文件可读取', async () => {
    if (!entryPath) throw new Error('入口未解析成功');
    const { buffer, source } = await store.readFile(pkg, entryPath);
    return `${formatBytes(buffer.length)}（缓存来源 ${source}）`;
  });

  if (entryPath && /\.(js|mjs|cjs)$/i.test(entryPath)) {
    await check('入口文件经压缩后语法仍合法', async () => {
      const { buffer } = await store.readFile(pkg, entryPath);
      const source = buffer.toString('utf8');
      const result = minifyJavaScript(source);
      syntaxCheck(result.code, findSpecifiers(source).hasEsm);
      return `${formatBytes(result.original)} -> ${formatBytes(result.minified)}（降 ${((1 - result.ratio) * 100).toFixed(1)}%），语法校验通过`;
    });

    await check('入口文件可打包', async () => {
      const { bundleFile } = await import('./bundle.js');
      const result = await bundleFile(pkg, entryPath, {});
      return `模式 ${result.mode} · 模块 ${result.modules} · 产物 ${formatBytes(result.bytes)}`;
    });
  }

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    out(`${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.label}${r.detail ? `  \x1b[90m${r.detail}\x1b[0m` : ''}`);
  }
  out('');

  if (flags['--json']) {
    out(JSON.stringify({ package: pkg.name, version: pkg.version, passed, total: results.length, results }, null, 2));
  } else {
    out(`${pkg.name}@${pkg.version}: \x1b[1m${passed}/${results.length}\x1b[0m 项通过`);
  }

  return passed === results.length;
}

/* ------------------------------------------------------------------ */
/* 调度                                                                */
/* ------------------------------------------------------------------ */

/**
 * CLI 主入口。
 *
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @returns {Promise<number>} 退出码
 */
export async function main(argv) {
  // `--registry` 优先级最高：必须在 import config 之前生效，
  // 但 config 已经在模块加载时读过了环境变量，所以这里直接改写进程环境并重载配置对象。
  const prefetch = parseArgs(argv);
  if (typeof prefetch.flags['--registry'] === 'string') {
    process.env.REGISTRY = prefetch.flags['--registry'];
    const fresh = await import(`./config.js?cli=${encodeURIComponent(prefetch.flags['--registry'])}`);
    Object.assign(config, fresh.config);
  }

  const command = prefetch.positional[0] && !prefetch.positional[0].startsWith('-')
    ? prefetch.positional.shift()
    : 'serve';

  if (prefetch.flags['--help'] || command === 'help') {
    out(HELP.trimEnd());
    return 0;
  }

  if (prefetch.flags['--version']) {
    out(config.userAgent);
    return 0;
  }

  switch (command) {
    case 'serve':
      await commandServe(prefetch.flags);
      return 0;
    case 'info':
      await commandInfo(prefetch.positional, prefetch.flags);
      return 0;
    case 'tree':
      await commandTree(prefetch.positional, prefetch.flags);
      return 0;
    case 'ls':
      await commandLs(prefetch.positional, prefetch.flags);
      return 0;
    case 'cat':
      await commandCat(prefetch.positional, prefetch.flags);
      return 0;
    case 'min':
      await commandMin(prefetch.positional, prefetch.flags);
      return 0;
    case 'bundle':
      await commandBundle(prefetch.positional, prefetch.flags);
      return 0;
    case 'verify': {
      const ok = await commandVerify(prefetch.positional, prefetch.flags);
      return ok ? 0 : 1;
    }
    default:
      note(`未知命令: ${command}\n`);
      out(HELP.trimEnd());
      return 1;
  }
}

/** 让 `node src/cli.js ...` 也能直接工作。 */
export const cliScriptPath = fileURLToPath(import.meta.url);

export default { main, parseArgs, parsePackageSpec };
