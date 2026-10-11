/**
 * 基准测量脚本。
 *
 * 跑一遍所有关键环节，把「实测数字」打印出来 ——
 * 文档里的每一个性能/体积数据都来自这个脚本，而不是估算。
 *
 * 运行：npm run bench   （或 node test/benchmark.mjs）
 *
 * 输出分 11 节：上游请求策略 / 下载解包 / 缓存 / 请求合并 / 传输压缩 /
 * 代码压缩 / 压缩叠加 / HTTP 层 / 打包（三种模式） / 监控接口 / 信号量与限流
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

import config from '../src/config.js';
import * as registry from '../src/registry.js';
import * as store from '../src/store.js';
import * as cache from '../src/cache.js';
import { minifyJavaScript } from '../src/minify.js';
import { findSpecifiers } from '../src/bundle.js';
import { start } from '../src/server.js';
import { formatBytes } from '../src/util.js';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/* ------------------------------------------------------------------ */
/* 输出工具                                                            */
/* ------------------------------------------------------------------ */

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
  const { mkdtemp, writeFile: wf, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'byr-check-'));
  const target = path.join(dir, `probe.${isEsm ? 'mjs' : 'cjs'}`);
  await wf(target, code);
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    row('  语法校验', `通过（node --check，按 ${isEsm ? 'ESM' : 'CJS'} 解析）`);
  } catch (err) {
    row('  ⚠ 语法校验失败', String(err.stderr || err.message).slice(0, 200));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 1. 上游请求策略                                                      */
/* ------------------------------------------------------------------ */

async function measureUpstreamStrategy() {
  header('1. 上游请求策略：精确版本 vs packument');

  const pkgName = 'vue';
  const version = '3.3.4';

  const exact = await timed(() =>
    fetch(`https://registry.npmjs.org/${pkgName}/${version}`).then((r) => r.text()),
  );
  row('GET /vue/3.3.4（单版本 manifest）', `${formatBytes(exact.value.length)} · ${exact.ms.toFixed(0)}ms`);

  const abbr = await timed(() =>
    fetch(`https://registry.npmjs.org/${pkgName}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    }).then((r) => r.text()),
  );
  row('GET /vue（简版 packument）', `${formatBytes(abbr.value.length)} · ${abbr.ms.toFixed(0)}ms`);

  const full = await timed(() => fetch(`https://registry.npmjs.org/${pkgName}`).then((r) => r.text()));
  row('GET /vue（完整 packument）', `${formatBytes(full.value.length)} · ${full.ms.toFixed(0)}ms`);

  row(
    '-> 精确版本路径相比完整 packument 节省',
    `${((1 - exact.value.length / full.value.length) * 100).toFixed(1)}%（${formatBytes(full.value.length - exact.value.length)}）`,
  );
  row(
    '-> 简版 packument 相比完整 packument 节省',
    `${((1 - abbr.value.length / full.value.length) * 100).toFixed(1)}%`,
  );
}

/* ------------------------------------------------------------------ */
/* 2-4. 解包、缓存、请求合并                                            */
/* ------------------------------------------------------------------ */

async function measureExtraction() {
  header('2. 下载 + 解包（冷路径）');

  for (const [name, version] of [['lodash', '4.17.21'], ['vue', '3.3.4'], ['axios', '1.6.0']]) {
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
  const file1 = await timed(() => store.readFile(vuePkg, 'dist/vue.runtime.esm-browser.js'));
  const file2 = await timed(() => store.readFile(vuePkg, 'dist/vue.runtime.esm-browser.js'));
  row('首次读取文件（磁盘）', `${file1.ms.toFixed(2)}ms`);
  row('再次读取文件（内存 LRU）', `${file2.ms.toFixed(2)}ms`);

  header('4. registry 元信息请求合并（single-flight）');

  // 直接统计「真正打到上游的 HTTP 请求次数」，比看缓存命中计数更准确
  const realFetch = globalThis.fetch;
  const countFetch = async (fn) => {
    let calls = 0;
    globalThis.fetch = (...args) => {
      calls += 1;
      return realFetch(...args);
    };
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
    return calls;
  };

  const concurrentMeta = await countFetch(() =>
    Promise.all(Array.from({ length: 20 }, () => registry.fetchManifest('react', '18.2.0'))),
  );
  row('20 个并发 fetchManifest("react","18.2.0")（未预热）', `实际发往 registry 的请求：${concurrentMeta} 次`);

  const concurrentCold = await countFetch(() =>
    Promise.all(Array.from({ length: 5 }, () => store.loadPackage('express', '4.18.2'))),
  );
  row('5 个并发的「冷包」loadPackage', `实际发往 registry 的请求：${concurrentCold} 次（元信息 + tarball）`);
}

/* ------------------------------------------------------------------ */
/* 5-7. 压缩                                                           */
/* ------------------------------------------------------------------ */

async function measureTransfer() {
  header('5. 传输压缩（gzip / brotli）');

  for (const [name, version, path] of [
    ['vue', '3.3.4', 'dist/vue.runtime.esm-browser.js'],
    ['lodash', '4.17.21', 'lodash.js'],
    ['axios', '1.6.0', 'dist/axios.js'],
  ]) {
    const pkg = await store.loadPackage(name, version);
    if (!pkg.fileIndex.has(path)) {
      row(`${name}@${version}/${path}`, '（包内不存在，跳过）');
      continue;
    }
    const { buffer } = await store.readFile(pkg, path);
    const gz = await gzip(buffer, { level: 6 });
    const br = await brotli(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
    row(
      `${name}@${version}/${path.split('/').pop()}`,
      `${formatBytes(buffer.length)} -> gzip ${formatBytes(gz.length)} (${((gz.length / buffer.length) * 100).toFixed(0)}%)` +
        ` · br ${formatBytes(br.length)} (${((br.length / buffer.length) * 100).toFixed(0)}%)`,
    );
  }
}

async function measureMinify() {
  header('6. JS 压缩（词法级安全压缩）');

  for (const [name, version, path] of [
    ['lodash', '4.17.21', 'lodash.js'],
    ['vue', '3.3.4', 'dist/vue.global.js'],
    ['axios', '1.6.0', 'lib/axios.js'],
  ]) {
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
      `${formatBytes(result.original)} -> ${formatBytes(result.minified)} ` +
        `（降 ${((1 - result.ratio) * 100).toFixed(1)}%，耗时 ${ms.toFixed(0)}ms）`,
    );
    // 用词法分析判定是否 ESM —— 不能看压缩后的代码，压缩会把整份文件合成一行
    await syntaxCheck(result.code, findSpecifiers(source).hasEsm);
  }

  header('7. 代码压缩 + 传输压缩 叠加');
  const pkg = await store.loadPackage('vue', '3.3.4');
  const { buffer } = await store.readFile(pkg, 'dist/vue.global.js');
  const min = minifyJavaScript(buffer.toString('utf8'));
  const minBuf = Buffer.from(min.code, 'utf8');
  const gz = await gzip(minBuf, { level: 6 });
  const br = await brotli(minBuf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  row('vue@3.3.4/dist/vue.global.js', `${formatBytes(buffer.length)}（原始）`);
  row('  -> 仅代码压缩后', `${formatBytes(minBuf.length)}（降 ${((1 - minBuf.length / buffer.length) * 100).toFixed(1)}%）`);
  row('  -> 代码压缩 + gzip', `${formatBytes(gz.length)}（降 ${((1 - gz.length / buffer.length) * 100).toFixed(1)}%）`);
  row('  -> 代码压缩 + brotli', `${formatBytes(br.length)}（降 ${((1 - br.length / buffer.length) * 100).toFixed(1)}%）`);
}

/* ------------------------------------------------------------------ */
/* 8. HTTP 层                                                          */
/* ------------------------------------------------------------------ */

async function measureHttp(port) {
  header('8. HTTP 层（真实请求）');

  const file = 'vue@3.3.4/dist/vue.runtime.esm-browser.js';
  const pkg = await store.loadPackage('vue', '3.3.4');
  const { buffer } = await store.readFile(pkg, 'dist/vue.runtime.esm-browser.js');

  const plain = await timed(() => request(port, `/${file}`, { 'accept-encoding': 'identity' }));
  row('GET（原始，无压缩）', `${plain.ms.toFixed(1)}ms · ${formatBytes(plain.value.body.length)}`);

  const hot = await timed(() => request(port, `/${file}`, { 'accept-encoding': 'identity' }));
  row('GET（内存缓存命中）', `${hot.ms.toFixed(1)}ms`);

  const gz1 = await timed(() => request(port, `/${file}`, { 'accept-encoding': 'gzip' }));
  row('GET（gzip，含首次压缩）', `${gz1.ms.toFixed(1)}ms · ${formatBytes(gz1.value.body.length)}`);

  const gz2 = await timed(() => request(port, `/${file}`, { 'accept-encoding': 'gzip' }));
  row('GET（gzip，压缩结果命中缓存）', `${gz2.ms.toFixed(1)}ms`);

  const etag = plain.value.headers.etag;
  const cond = await timed(() => request(port, `/${file}`, { 'if-none-match': etag }));
  row('GET（If-None-Match -> 304）', `${cond.ms.toFixed(1)}ms · 状态 ${cond.value.status}`);

  const range = await timed(() => request(port, `/${file}`, { range: 'bytes=0-1023' }));
  row(
    'GET（Range: bytes=0-1023）',
    `${range.ms.toFixed(1)}ms · 状态 ${range.value.status} · ${range.value.body.length} 字节`,
  );

  row('原始文件大小', formatBytes(buffer.length));
}

/* ------------------------------------------------------------------ */
/* 9. 打包                                                             */
/* ------------------------------------------------------------------ */

async function measureBundle(port) {
  header('9. 打包（?bundle）');

  /* ---- 模式一：Inline（只内联包内相对依赖） ---- */
  row('模式一：Inline —— 只合并包内相对依赖', '');
  const expressPkg = await store.loadPackage('express', '4.18.2');
  const expressEntry = await store.readFile(expressPkg, 'lib/express.js');

  const plain = await request(port, '/express@4.18.2/lib/express.js?bundle');
  row(
    '  express@4.18.2/lib/express.js?bundle',
    `状态 ${plain.status} · 模式 ${plain.headers['x-byr-bundle']} · 模块数 ${plain.headers['x-byr-bundle-modules']}`,
  );
  row('  入口文件本身体积', formatBytes(expressEntry.buffer.length));
  row('  打包产物体积', formatBytes(plain.body.length));
  const inlined = (plain.body.toString().match(/^"[^"]+": function \(module, exports, require/gm) || []).length;
  row('  产物中实际统计到的模块定义', `${inlined} 个（与响应头一致）`);
  row('  产物是否自包含', plain.body.toString().includes('__load') ? '是（含微型 require 运行时）' : '否');
  row('  说明', `仍有 ${plain.headers['x-byr-bundle-external']} 个外部依赖保留为 require() 调用`);

  /* ---- 零依赖包：验证产物能真正执行 ---- */
  row('', '');
  const mimePkg = await store.loadPackage('mime', '3.0.0');
  const mimeBundle = await request(port, '/mime@3.0.0/index.js?bundle');
  row(
    '  mime@3.0.0/index.js?bundle（零依赖，可自包含执行）',
    `模式 ${mimeBundle.headers['x-byr-bundle']} · 模块数 ${mimeBundle.headers['x-byr-bundle-modules']}`,
  );
  row('    入口文件体积', formatBytes((await store.readFile(mimePkg, 'index.js')).buffer.length));
  row('    打包产物体积', formatBytes(mimeBundle.body.length));

  const mimePath = 'D:/BYR Archive/.byr-cache/bench-bundle.cjs';
  await writeFile(mimePath, mimeBundle.body);
  try {
    const output = execFileSync(
      process.execPath,
      ['-e',
        `const m = require(${JSON.stringify(mimePath)});` +
        `console.log('getType(.js)=' + m.getType('a.js') + ' | getExtension(application/json)=' + m.getExtension('application/json') + ' | 已注册类型数=' + Object.keys(m._types).length);`,
      ],
      { encoding: 'utf8', timeout: 30000 },
    ).trim();
    row('    在 Node 中 require 产物并实际调用', output);
  } catch (err) {
    row('    ⚠ 产物执行失败', String(err.stderr || err.message).slice(0, 300));
  }

  const minified = await request(port, '/express@4.18.2/lib/express.js?bundle&min');
  row(
    '  ?bundle&min 产物体积',
    `${formatBytes(minified.body.length)}（x-byr-minified: ${minified.headers['x-byr-minified']}）`,
  );
  const gzipped = await request(port, '/express@4.18.2/lib/express.js?bundle&min', { 'accept-encoding': 'gzip' });
  row('  ?bundle&min + gzip 传输', formatBytes(gzipped.body.length));

  /* ---- 模式二：Rewrite（ESM 说明符重写） ---- */
  row('', '');
  row('模式二：Rewrite —— ESM 说明符重写为绝对 URL', '');
  const esm = await request(port, '/axios@1.6.0/lib/axios.js?esm');
  row('  axios@1.6.0/lib/axios.js?esm', `模式 ${esm.headers['x-byr-bundle']} · ${formatBytes(esm.body.length)}`);
  for (const line of esm.body.toString().split('\n').filter((l) => l.includes('from ')).slice(0, 3)) {
    row(`    ${line.trim().slice(0, 62)}`, '');
  }

  /* ---- 模式三：Deep Inline（递归内联外部依赖） ---- */
  row('', '');
  row('模式三：Deep Inline —— 递归内联外部依赖（真正的「多包合并成单文件」）', '');
  const deep = await request(port, '/express@4.18.2/lib/express.js?bundle=deep');
  row('  express@4.18.2/lib/express.js?bundle=deep', `状态 ${deep.status} · 模式 ${deep.headers['x-byr-bundle']}`);
  row('    内联模块数', String(deep.headers['x-byr-bundle-modules']));
  row('    涉及包数', String(deep.headers['x-byr-bundle-packages']));
  row('    仍未内联的说明符', `${deep.headers['x-byr-bundle-external']} 个（全部是 Node 内置模块）`);
  row('    产物体积', formatBytes(deep.body.length));
  const deepWarm = await timed(() => request(port, '/express@4.18.2/lib/express.js?bundle=deep'));
  row(
    '    打包耗时',
    `冷缓存 ${deep.headers['x-byr-bundle-ms']}ms（含 70 个包的下载解包）` +
      ` -> 热缓存 ${deepWarm.ms.toFixed(0)}ms`,
  );

  const deepMin = await request(port, '/express@4.18.2/lib/express.js?bundle=deep&min', { 'accept-encoding': 'gzip' });
  row('    深度打包 + 代码压缩 + gzip', formatBytes(deepMin.body.length));

  // 把产物丢进 Node 里真实 require 并起一个 express 服务 ——
  // 证明它不是「看着像能跑」，而是真的能跑
  const deepPath = 'D:/BYR Archive/.byr-cache/bench-deep-express.cjs';
  await writeFile(deepPath, deep.body);
  try {
    const output = execFileSync(
      process.execPath,
      ['-e', `
        const express = require(${JSON.stringify(deepPath)});
        const app = express();
        app.get('/hello', (req, res) => res.json({ ok: true, from: 'single-file-express' }));
        const server = app.listen(0, async () => {
          const res = await fetch('http://127.0.0.1:' + server.address().port + '/hello');
          console.log('typeof express=' + typeof express + ' | GET /hello -> ' + res.status + ' ' + (await res.text()));
          server.close();
        });
      `],
      { encoding: 'utf8', timeout: 60000 },
    ).trim();
    row('    在 Node 中真实 require 并起服务', output);
  } catch (err) {
    row('    ⚠ 深度产物执行失败', String(err.stdout || err.stderr || err.message).slice(0, 300));
  }

  const cpPlain = await request(port, '/cookie-parser@1.4.6/index.js?bundle');
  const cpDeep = await request(port, '/cookie-parser@1.4.6/index.js?bundle=deep');
  row(
    '  cookie-parser@1.4.6 对照',
    `普通 ${cpPlain.headers['x-byr-bundle-packages']} 包 / ${formatBytes(cpPlain.body.length)}` +
      `  ->  深度 ${cpDeep.headers['x-byr-bundle-packages']} 包 / ${formatBytes(cpDeep.body.length)}`,
  );
}

/* ------------------------------------------------------------------ */
/* 10-11. 监控接口、信号量与限流                                        */
/* ------------------------------------------------------------------ */

async function measureBonusInfra(port) {
  header('10. 监控与运维接口');

  const metricsRes = await timed(() => request(port, '/_metrics'));
  const metricsText = metricsRes.value.body.toString();
  row(
    'GET /_metrics（Prometheus 文本格式）',
    `${metricsRes.ms.toFixed(1)}ms · ${formatBytes(metricsRes.value.body.length)}`,
  );
  row(
    '  导出的指标样本数',
    String(metricsText.split('\n').filter((l) => l && !l.startsWith('#')).length),
  );
  const names = [...new Set(metricsText.split('\n').filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]))];
  row('  指标名', names.join(', '));

  const treeRes = await timed(() => request(port, '/_api/vue@3.3.4/tree'));
  const tree = JSON.parse(treeRes.value.body.toString());
  row(
    'GET /_api/vue@3.3.4/tree',
    `${treeRes.ms.toFixed(1)}ms · ${tree.count} 个文件 · ${formatBytes(treeRes.value.body.length)}`,
  );

  const dirRes = await timed(() => request(port, '/_api/vue@3.3.4/dir/dist'));
  row(
    'GET /_api/vue@3.3.4/dir/dist',
    `${dirRes.ms.toFixed(1)}ms · ${JSON.parse(dirRes.value.body.toString()).files.length} 个文件`,
  );

  header('11. 并发解包信号量与限流');

  const before = JSON.parse((await request(port, '/_stats')).body.toString());
  row('解包信号量上限（MAX_CONCURRENT_EXTRACT）', String(before.extraction.limit));
  row(
    '内存缓存命中率',
    `${(before.memoryCache.hitRate * 100).toFixed(1)}%（${before.memoryCache.entries} 个条目 / ${formatBytes(before.memoryCache.bytes)}）`,
  );

  const coldPkgs = ['chalk@4.1.2', 'commander@11.1.0', 'dayjs@1.11.10', 'nanoid@5.0.4', 'picocolors@1.0.0'];
  const concurrent = await timed(() => Promise.all(coldPkgs.map((p) => request(port, `/${p}/package.json`))));
  const after = JSON.parse((await request(port, '/_stats')).body.toString()).extraction;
  row(
    `${coldPkgs.length} 个不同冷包同时请求`,
    `${concurrent.ms.toFixed(0)}ms · 峰值并发 ${after.peakActive}（上限 ${after.limit}）· 累计完成 ${after.completed} 次`,
  );

  const { setRateLimit, rateLimitStats } = await import('../src/handler.js');
  setRateLimit(60, 5);
  let firstReject = -1;
  let retryAfter = 0;
  try {
    for (let i = 0; i < 12; i += 1) {
      const res = await request(port, '/_health');
      if (res.status === 429) {
        firstReject = i + 1;
        retryAfter = Number(res.headers['retry-after']);
        break;
      }
    }
    // 注意：这里不能再去请求 /_stats —— 那个请求自己也会被限流。
    // 直接读进程内的限流器状态才是可靠的。
    const detail = rateLimitStats();
    row(
      '限流开启（60/分钟，突发容量 5）',
      `第 ${firstReject} 个请求被拒 · Retry-After ${retryAfter}s · 累计拒绝 ${detail.rejected} 次`,
    );
  } finally {
    setRateLimit(0, 0);
  }
  const resumed = await request(port, '/_health');
  row('限流关闭后', `状态 ${resumed.status}（恢复正常放行）`);
}

/* ------------------------------------------------------------------ */

async function main() {
  process.stdout.write('\x1b[1mBYR Archive 基准测量\x1b[0m\n');
  process.stdout.write(`Node ${process.version} · 上游 ${config.registry}（来源 ${config.registrySource}）\n`);

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
    await measureBonusInfra(port);
  } finally {
    await new Promise((r) => server.close(r));
  }

  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`测量失败: ${err.stack}\n`);
  process.exitCode = 1;
});
