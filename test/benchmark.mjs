/**
 * 基准测量脚本。
 *
 * 跑一遍所有关键环节，把「实测数字」打印出来 ——
 * 文档里的每一个性能/体积数据都来自这个脚本，而不是估算。
 *
 * 运行：node test/benchmark.mjs
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import config from '../src/config.js';
import * as registry from '../src/registry.js';
import * as store from '../src/store.js';
import * as cache from '../src/cache.js';
import { minifyJavaScript } from '../src/minify.js';
import { findSpecifiers } from '../src/bundle.js';
import { start } from '../src/server.js';
import { formatBytes } from '../src/util.js';
import { writeFile } from 'node:fs/promises';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/** 计时辅助。 */
async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { value, ms };
}

function header(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n${'─'.repeat(72)}\n`);
}

function row(label, value) {
  process.stdout.write(`  ${label.padEnd(46, ' ')} ${value}\n`);
}

/** 发一个 HTTP 请求。 */
function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 用 `node --check` 校验一段代码的语法。
 * 这是最可靠的方式：Node 自己的解析器说了算，而且不会执行代码。
 */
async function syntaxCheck(code, isEsm = false) {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, writeFile: wf, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'byr-check-'));
  const target = path.join(dir, `probe.${isEsm ? 'mjs' : 'cjs'}`);
  await wf(target, code);
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    row('  压缩后语法校验', `通过（node --check，按 ${isEsm ? 'ESM' : 'CJS'} 解析）`);
  } catch (err) {
    row('  ⚠ 压缩结果语法错误', String(err.stderr || err.message).slice(0, 200));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */

async function measureUpstreamStrategy() {
  header('1. 上游请求策略：精确版本 vs packument');

  const pkgName = 'vue';
  const version = '3.3.4';

  const exact = await timed(() =>
    fetch(`https://registry.npmjs.org/${pkgName}/${version}`).then((r) => r.text()),
  );
  row(`GET /vue/3.3.4（单版本 manifest）`, `${formatBytes(exact.value.length)} · ${exact.ms.toFixed(0)}ms`);

  const abbr = await timed(() =>
    fetch(`https://registry.npmjs.org/${pkgName}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    }).then((r) => r.text()),
  );
  row(`GET /vue（简版 packument）`, `${formatBytes(abbr.value.length)} · ${abbr.ms.toFixed(0)}ms`);

  const full = await timed(() =>
    fetch(`https://registry.npmjs.org/${pkgName}`).then((r) => r.text()),
  );
  row(`GET /vue（完整 packument）`, `${formatBytes(full.value.length)} · ${full.ms.toFixed(0)}ms`);

  const saving = (1 - exact.value.length / full.value.length) * 100;
  row(
    `→ 精确版本路径相比完整 packument 节省`,
    `${saving.toFixed(1)}%（${formatBytes(full.value.length - exact.value.length)}）`,
  );

  const abbrSaving = (1 - abbr.value.length / full.value.length) * 100;
  row(`→ 简版 packument 相比完整 packument 节省`, `${abbrSaving.toFixed(1)}%`);
}

async function measureExtraction() {
  header('2. 下载 + 解包（冷路径）');

  const targets = [
    ['lodash', '4.17.21'],
    ['vue', '3.3.4'],
    ['axios', '1.6.0'],
  ];

  for (const [name, version] of targets) {
    const { value: pkg, ms } = await timed(() => store.loadPackage(name, version));
    row(
      `${name}@${version}`,
      `${pkg.files.length} 个文件 · ${formatBytes(pkg.totalBytes)} · ${ms.toFixed(0)}ms`,
    );
  }

  header('3. 缓存效果（热路径，同一进程）');
  const { ms: warmMs } = await timed(() => store.loadPackage('vue', '3.3.4'));
  row('vue@3.3.4 二次加载（命中磁盘缓存）', `${warmMs.toFixed(1)}ms`);

  const vuePkg = await store.loadPackage('vue', '3.3.4');
  const fileWarm1 = await timed(() => store.readFile(vuePkg, 'dist/vue.runtime.esm-browser.js'));
  const fileWarm2 = await timed(() => store.readFile(vuePkg, 'dist/vue.runtime.esm-browser.js'));
  row('首次读取文件（磁盘）', `${fileWarm1.ms.toFixed(2)}ms`);
  row('再次读取文件（内存 LRU）', `${fileWarm2.ms.toFixed(2)}ms`);

  header('4. registry 元信息请求合并（single-flight）');
  // 直接统计「真正打到上游的 HTTP 请求次数」，比看缓存命中计数更准确
  const realFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (...args) => {
    upstreamCalls += 1;
    return realFetch(...args);
  };
  try {
    await Promise.all(Array.from({ length: 20 }, () => registry.fetchManifest('react', '18.2.0')));
  } finally {
    globalThis.fetch = realFetch;
  }
  row('20 个并发 fetchManifest("react","18.2.0")（未预热）', `实际发往 registry 的请求：${upstreamCalls} 次`);

  let coldUpstream = 0;
  globalThis.fetch = (...args) => {
    coldUpstream += 1;
    return realFetch(...args);
  };
  try {
    await Promise.all([
      store.loadPackage('express', '4.18.2'),
      store.loadPackage('express', '4.18.2'),
      store.loadPackage('express', '4.18.2'),
      store.loadPackage('express', '4.18.2'),
      store.loadPackage('express', '4.18.2'),
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
  row('5 个并发的「冷包」loadPackage', `实际发往 registry 的请求：${coldUpstream} 次（元信息 + tarball）`);
}

async function measureTransfer() {
  header('5. 传输压缩（gzip / brotli）');

  const cases = [
    ['vue', '3.3.4', 'dist/vue.runtime.esm-browser.js'],
    ['lodash', '4.17.21', 'lodash.js'],
    ['axios', '1.6.0', 'dist/axios.js'],
  ];

  for (const [name, version, path] of cases) {
    const pkg = await store.loadPackage(name, version);
    if (!pkg.fileIndex.has(path)) {
      row(`${name}@${version}/${path}`, '（包内不存在，跳过）');
      continue;
    }
    const { buffer } = await store.readFile(pkg, path);
    const gz = await gzip(buffer, { level: 6 });
    const br = await brotli(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    row(
      `${name}@${version}/${path.split('/').pop()}`,
      `${formatBytes(buffer.length)} → gzip ${formatBytes(gz.length)} (${((gz.length / buffer.length) * 100).toFixed(0)}%)` +
        ` · br ${formatBytes(br.length)} (${((br.length / buffer.length) * 100).toFixed(0)}%)`,
    );
  }
}

async function measureMinify() {
  header('6. JS 压缩（词法级安全压缩）');

  const cases = [
    ['lodash', '4.17.21', 'lodash.js'],
    ['vue', '3.3.4', 'dist/vue.global.js'],
    ['axios', '1.6.0', 'lib/axios.js'],
  ];

  for (const [name, version, path] of cases) {
    const pkg = await store.loadPackage(name, version);
    if (!pkg.fileIndex.has(path)) {
      row(`${name}@${version}/${path}`, '（包内不存在，跳过）');
      continue;
    }
    const { buffer } = await store.readFile(pkg, path);
    const source = buffer.toString('utf8');
    const { ms } = await timed(() => minifyJavaScript(source));
    const result = minifyJavaScript(source);
    row(
      `${name}@${version}/${path.split('/').pop()}`,
      `${formatBytes(result.original)} → ${formatBytes(result.minified)} ` +
        `（${((1 - result.ratio) * 100).toFixed(1)}%↓，${ms.toFixed(0)}ms）`,
    );
    // 语法合法性校验：交给 Node 自己的解析器（node --check），
    // CJS 与 ESM 都能可靠验证，且不会真的执行代码。
    // 用词法分析判定这是不是 ESM —— 不能看压缩后的代码，
    // 因为压缩会把整份文件合成一行，行首 import 的写法就失效了。
    await syntaxCheck(result.code, findSpecifiers(source).hasEsm);
  }

  header('7. 压缩 + 传输压缩 叠加');
  const pkg = await store.loadPackage('vue', '3.3.4');
  const { buffer } = await store.readFile(pkg, 'dist/vue.global.js');
  const min = minifyJavaScript(buffer.toString('utf8'));
  const minBuf = Buffer.from(min.code, 'utf8');
  const gz = await gzip(minBuf, { level: 6 });
  const br = await brotli(minBuf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  row('vue@3.3.4/dist/vue.global.js', `${formatBytes(buffer.length)}（原始）`);
  row('  → 仅服务端压缩后', `${formatBytes(minBuf.length)}（${((1 - minBuf.length / buffer.length) * 100).toFixed(1)}%↓）`);
  row('  → 压缩 + gzip', `${formatBytes(gz.length)}（${((1 - gz.length / buffer.length) * 100).toFixed(1)}%↓）`);
  row('  → 压缩 + brotli', `${formatBytes(br.length)}（${((1 - br.length / buffer.length) * 100).toFixed(1)}%↓）`);
}

async function measureHttp(port) {
  header('8. HTTP 层（真实请求）');

  const pkg = await store.loadPackage('vue', '3.3.4');
  const file = 'dist/vue.runtime.esm-browser.js';
  const { buffer } = await store.readFile(pkg, file);

  const cold = await timed(() =>
    request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { 'accept-encoding': 'identity' }),
  );
  row('GET（原始，无压缩）', `${cold.ms.toFixed(1)}ms · ${formatBytes(cold.value.body.length)}`);

  const hot = await timed(() =>
    request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { 'accept-encoding': 'identity' }),
  );
  row('GET（内存缓存命中）', `${hot.ms.toFixed(1)}ms`);

  const gz = await timed(() =>
    request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { 'accept-encoding': 'gzip' }),
  );
  row('GET（gzip，含首次压缩）', `${gz.ms.toFixed(1)}ms · ${formatBytes(gz.value.body.length)}`);

  const gz2 = await timed(() =>
    request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { 'accept-encoding': 'gzip' }),
  );
  row('GET（gzip，压缩结果命中缓存）', `${gz2.ms.toFixed(1)}ms`);

  const etag = cold.value.headers.etag;
  const cond = await timed(() =>
    request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { 'if-none-match': etag }),
  );
  row('GET（If-None-Match → 304）', `${cond.ms.toFixed(1)}ms · 状态 ${cond.value.status}`);

  const range = await timed(() =>
    request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { range: 'bytes=0-1023' }),
  );
  row('GET（Range: bytes=0-1023）', `${range.ms.toFixed(1)}ms · 状态 ${range.value.status} · ${range.value.body.length} 字节`);

  row('原始文件大小', formatBytes(buffer.length));
}

async function measureBundle(port) {
  header('9. 打包（?bundle）');

  // 入口文件本身的体积 & 依赖数，作为「打包前」的基线
  const expressPkg = await store.loadPackage('express', '4.18.2');
  const expressEntry = await store.readFile(expressPkg, 'lib/express.js');

  const res = await request(port, '/express@4.18.2/lib/express.js?bundle');
  const mode = res.headers['x-byr-bundle'];
  const modules = res.headers['x-byr-bundle-modules'];
  row('模式一：Inline（CJS 多文件内联）', '');
  row('  express@4.18.2/lib/express.js?bundle', `状态 ${res.status} · 模式 ${mode} · 模块数 ${modules}`);
  row('  入口文件本身体积', formatBytes(expressEntry.buffer.length));
  row('  打包产物体积（含运行时与横幅注释）', formatBytes(res.body.length));

  // 交叉验证：产物里确实出现了这么多个模块定义
  const inlined = (res.body.toString().match(/^"[^"]+": function \(module, exports, require/gm) || []).length;
  row('  产物中实际统计到的模块定义', `${inlined} 个`);
  row('  产物是否自包含（包含微型 require 运行时）', res.body.toString().includes('__load') ? '是' : '否');

  row('  说明', 'express 的外部依赖（body-parser 等）不在包内，');
  row('', '会被保留为 require() 调用 —— 这是 Inline 模式的既定边界。');

  row('', '');
  // 真正「自包含」的可执行验证：mime@3.0.0 零依赖、4 个文件的 CJS 图
  const mimePkg = await store.loadPackage('mime', '3.0.0');
  const mimeRes = await request(port, '/mime@3.0.0/index.js?bundle');
  row('  mime@3.0.0/index.js?bundle（零依赖，可自包含执行）',
    `模式 ${mimeRes.headers['x-byr-bundle']} · 模块数 ${mimeRes.headers['x-byr-bundle-modules']}`);
  row('    入口文件体积', formatBytes((await store.readFile(mimePkg, 'index.js')).buffer.length));
  row('    打包产物体积', formatBytes(mimeRes.body.length));

  const bundlePath = 'D:/BYR Archive/.byr-cache/bench-bundle.cjs';
  await writeFile(bundlePath, mimeRes.body);
  const { execFileSync } = await import('node:child_process');
  try {
    const output = execFileSync(
      process.execPath,
      ['-e',
        `const m = require(${JSON.stringify(bundlePath)});` +
        `console.log('getType(.js)=' + m.getType('a.js'), '| getExtension(application/json)=' + m.getExtension('application/json'), '| 已注册类型数=' + Object.keys(m._types).length);`,
      ],
      { encoding: 'utf8', timeout: 30000 },
    ).trim();
    row('    在 Node 中 require 产物并实际调用', output);
  } catch (err) {
    row('    ⚠ 产物执行失败', String(err.stderr || err.message).slice(0, 300));
  }

  const minified = await request(port, '/express@4.18.2/lib/express.js?bundle&min');
  row('  ?bundle&min 产物体积', `${formatBytes(minified.body.length)}（x-byr-minified: ${minified.headers['x-byr-minified']}）`);

  const gzipped = await request(port, '/express@4.18.2/lib/express.js?bundle&min', {
    'accept-encoding': 'gzip',
  });
  row('  ?bundle&min + gzip 传输', formatBytes(gzipped.body.length));

  row('', '');
  row('模式二：Rewrite（ESM 说明符重写为绝对 URL）', '');
  const esm = await request(port, '/axios@1.6.0/lib/axios.js?esm');
  row('  axios@1.6.0/lib/axios.js?esm', `模式 ${esm.headers['x-byr-bundle']} · ${formatBytes(esm.body.length)}`);
  const sample = esm.body.toString().split('\n').filter((l) => l.includes('from ')).slice(0, 3);
  for (const line of sample) row('    ' + line.trim().slice(0, 62), '');
}

/* ------------------------------------------------------------------ */

async function main() {
  process.stdout.write('\x1b[1mBYR Archive 基准测量\x1b[0m\n');
  process.stdout.write(`Node ${process.version} · 上游 ${config.registry}\n`);

  await cache.init();
  await measureUpstreamStrategy();
  await measureExtraction();
  await measureTransfer();
  await measureMinify();

  const server = await start({ port: 0, host: '127.0.0.1' });
  const { port } = server.address();
  try {
    await measureHttp(port);
    await measureBundle(port);
  } finally {
    await new Promise((r) => server.close(r));
  }

  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`测量失败: ${err.stack}\n`);
  process.exitCode = 1;
});
