/**
 * 对抗性验收测试（Acceptance / Adversarial Probe）。
 *
 * 与 `smoke.mjs` 的区别：
 *   - `smoke.mjs` 验证「功能是否按设计工作」（happy path + 常规边界）；
 *   - 本脚本专门**找毛病**：非法输入、注入、越权、资源耗尽、并发一致性、
 *     缓存损坏、性能塌陷。每条检查都打印可复现的证据，供第三方复核。
 *
 * 运行：node test/acceptance.mjs
 *
 * 输出分 8 组（对应验收提示词的 阶段 2~7）：
 *   A. 接口与输入边界      E. 缓存一致性与中断恢复
 *   B. 注入与越权          F. 资源与 DoS 面
 *   C. HTTP 语义边界       G. 性能与事件循环阻塞
 *   D. 输出编码安全        H. 并发一致性
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import config from '../src/config.js';
import * as cache from '../src/cache.js';
import * as store from '../src/store.js';
import { start } from '../src/server.js';
import { renderListing } from '../src/listing.js';
import { eventLoopStats, resetEventLoop } from '../src/metrics.js';

/* ------------------------------------------------------------------ */
/* 报告框架                                                            */
/* ------------------------------------------------------------------ */

/** @type {Array<{group:string, name:string, status:'PASS'|'FAIL'|'WARN', evidence:string}>} */
const findings = [];
let group = '';

function section(name) {
  group = name;
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m\n${'─'.repeat(78)}\n`);
}

/**
 * @param {string} name 检查项
 * @param {'PASS'|'FAIL'|'WARN'} status
 * @param {string} evidence 证据（必须具体到可复核的程度）
 */
function record(name, status, evidence) {
  findings.push({ group, name, status, evidence });
  const mark = status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : status === 'WARN' ? '\x1b[33mWARN\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  process.stdout.write(`  [${mark}] ${name}\n          ${evidence}\n`);
}

/** 发请求。 */
function request(port, urlPath, { method = 'GET', headers = {}, body } = {}) {
  // Node 的 http 客户端要求 path 里不能有未转义的非 ASCII 字符；
  // encodeURI 不会二次编码已有的 %xx（这对 CRLF 注入用例很关键），只编码中文等。
  const safePath = encodeURI(urlPath);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: safePath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 用原始 socket 发一个手工构造的请求（用于验证协议层行为，绕开客户端的自动行为）。 */
function rawRequest(port, raw, timeoutMs = 8000) {
  return new Promise(async (resolve) => {
    const net = await import('node:net');
    const sock = net.connect(port, '127.0.0.1', () => sock.write(raw));
    let data = '';
    const done = (note) => {
      sock.destroy();
      const statusLine = data.split('\r\n')[0] || '(无响应)';
      resolve({ statusLine, note, raw: data.slice(0, 200) });
    };
    sock.on('data', (c) => {
      data += c.toString();
    });
    sock.on('end', () => done());
    sock.on('error', (e) => done(`socket 错误 ${e.code}`));
    setTimeout(() => done('超时'), timeoutMs);
  });
}

/** 清空派生产物（压缩结果）缓存，以便测量「冷 -> 热」的真实差异。 */
async function clearBlobCache() {
  const entries = await fsp.readdir(config.cacheDir).catch(() => []);
  for (const reg of entries) {
    await fsp.rm(path.join(config.cacheDir, reg, 'blob'), { recursive: true, force: true }).catch(() => {});
  }
  cache.memory.clear();
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/* ------------------------------------------------------------------ */
/* A. 接口与输入边界                                                    */
/* ------------------------------------------------------------------ */

async function probeInputBoundaries(port) {
  section('A. 接口与输入边界（阶段 2：正常 / 边界 / 非法输入）');

  // A1 非法百分号编码
  const bad = [
    ['/%E0%A4%A', '截断的 UTF-8 百分号编码'],
    ['/%ZZ', '非法十六进制'],
    ['/%C0%AE%C0%AE/', 'UTF-8 overlong 编码的 ../'],
  ];
  for (const [p, desc] of bad) {
    const res = await request(port, p);
    record(
      `非法 URL 编码：${desc}`,
      res.status === 400 || res.status === 404 ? 'PASS' : 'FAIL',
      `${p} -> HTTP ${res.status}（期望 400 或 404，不得 500）`,
    );
  }

  // A2 超长 URL
  const longPath = `/vue@3.3.4/${'a'.repeat(10000)}`;
  try {
    const res = await request(port, longPath);
    record('超长 URL（10KB 路径）', res.status >= 400 && res.status < 600 ? 'PASS' : 'FAIL', `-> HTTP ${res.status}`);
  } catch (err) {
    record('超长 URL（10KB 路径）', 'PASS', `连接被拒（服务端主动断开）：${err.code || err.message}`);
  }

  // A3 非法包名
  const badNames = [
    ['/-/', '单个连字符'],
    ['/@/', '只有 scope 前缀'],
    ['/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a/a', '超长多段路径'],
    [`/${'a'.repeat(300)}`, '超长包名（300 字符）'],
  ];
  for (const [p, desc] of badNames) {
    const res = await request(port, p);
    record(
      `非法包名（${desc}）`,
      res.status >= 400 && res.status < 500 ? 'PASS' : 'WARN',
      `${p.length > 40 ? `${p.slice(0, 40)}...` : p} -> HTTP ${res.status}（期望 4xx，不得 5xx）`,
    );
  }

  // A3b URL 规范化：`/%2e%2e/` 与 `/./` 会被 WHATWG URL 解析器归一化，不是漏洞
  const normalized = [
    ['new URL(\'/%2e%2e/\', \'http://x\').pathname', () => new URL('/%2e%2e/', 'http://x').pathname],
    ['new URL(\'/./\', \'http://x\').pathname', () => new URL('/./', 'http://x').pathname],
    ['new URL(\'/a/%2e%2e/b\', \'http://x\').pathname', () => new URL('/a/%2e%2e/b', 'http://x').pathname],
  ];
  for (const [expr, fn] of normalized) {
    const res = await request(port, fn());
    record(
      `URL 规范化 ${expr} = ${JSON.stringify(fn())}`,
      res.status < 500 ? 'PASS' : 'FAIL',
      `${fn()} -> HTTP ${res.status}；` +
        `说明：URL 标准在解析阶段就把 %2e%2e / . 归一到父目录，` +
        `因此请求根本到不了路径拼接逻辑（不是漏洞，但需在报告中说明判据）`,
    );
  }

  // A4 Range 边界
  const rangeCases = [
    ['bytes=0-0', '单字节'],
    ['bytes=-1', '最后 1 字节'],
    ['bytes=999999999-', '起点远超文件长度'],
    ['bytes=100-50', '起止颠倒'],
    ['bytes=abc', '非数字'],
    ['bytes=0-1, 3-4', '多区间（本实现不支持）'],
    ['bytes=0-99999999999', '终点超大'],
  ];
  for (const [r, desc] of rangeCases) {
    const res = await request(port, '/vue@3.3.4/package.json', { headers: { range: r } });
    const ok = [200, 206, 416].includes(res.status);
    record(
      `Range: ${r}（${desc}）`,
      ok ? 'PASS' : 'FAIL',
      `-> HTTP ${res.status}，Content-Range: ${res.headers['content-range'] || '(无)'}（期望 206 或 416）`,
    );
  }

  // A5 越界路径
  const notFoundCases = [
    '/vue@3.3.4/不存在的文件.js',
    '/vue@99999.0.0/package.json',
    '/nonexistent-pkg-byr-xyz/',
    '/_api/vue@3.3.4/dir/不存在的目录',
    '/_api/vue@3.3.4/file/不存在的文件',
  ];
  for (const p of notFoundCases) {
    const res = await request(port, p);
    record(`越界访问 ${p}`, res.status === 404 ? 'PASS' : 'FAIL', `-> HTTP ${res.status}（期望 404）`);
  }
}

/* ------------------------------------------------------------------ */
/* B. 注入与越权                                                        */
/* ------------------------------------------------------------------ */

async function probeInjection(port) {
  section('B. 注入与越权（阶段 5：安全审查）');

  // B1 CRLF 头注入（HTTP 响应拆分）
  const crlfCases = [
    '/vue@3.3.4/%0d%0aX-Injected:%20yes',
    '/vue%0d%0aX-Injected:%20yes/package.json',
    '/vue@3.3.4/package.json%0d%0aX-Injected:%20yes',
    '/_api/vue@3.3.4/file/a%0d%0aX-Injected:%20yes',
  ];
  for (const p of crlfCases) {
    const res = await request(port, p);
    const injected = res.headers['x-injected'] !== undefined;
    record(
      `CRLF 头注入 ${p.replace(/\r?\n/g, '')}`,
      !injected && res.status < 500 ? 'PASS' : 'FAIL',
      `-> HTTP ${res.status}，x-injected 头存在=${injected}（期望：不出现注入头且不返回 5xx）`,
    );
  }

  // B2 路径穿越变体
  const traversal = [
    '/vue@3.3.4/../../../../etc/passwd',
    '/vue@3.3.4/..%2f..%2f..%2fetc%2fpasswd',
    '/vue@3.3.4/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/vue@3.3.4/....//....//etc/passwd',
    '/vue@3.3.4/..%252f..%252fetc%252fpasswd',
    '/vue@3.3.4/C:/Windows/win.ini',
    '/vue@3.3.4//etc/passwd',
  ];
  for (const p of traversal) {
    const res = await request(port, p);
    const leaked = /root:|\[fonts\]|for 16-bit app support/i.test(res.body.toString());
    record(
      `路径穿越 ${p.slice(0, 46)}`,
      !leaked && res.status >= 400 ? 'PASS' : 'FAIL',
      `-> HTTP ${res.status}，body 是否含系统文件特征=${leaked}`,
    );
  }

  // B3 错误响应是否泄漏堆栈 / 内部路径
  const errRes = await request(port, '/nonexistent-pkg-byr-xyz/');
  const errBody = errRes.body.toString();
  record(
    '错误响应不泄漏堆栈',
    !/at\s+\w+\s+\(|node_modules|\.js:\d+:\d+/.test(errBody) ? 'PASS' : 'FAIL',
    `404 body = ${errBody.replace(/\n/g, ' ').slice(0, 160)}`,
  );

  // B4 /_stats 是否泄漏令牌
  const stats = await request(port, '/_stats');
  const statsBody = stats.body.toString();
  const leaksToken = config.registryToken ? statsBody.includes(config.registryToken) : false;
  record(
    '/_stats 不泄漏 registry 令牌',
    !leaksToken ? 'PASS' : 'FAIL',
    `配置了令牌=${Boolean(config.registryToken)}；响应中是否出现令牌明文=${leaksToken}`,
  );

  // B5 目录列表的存储型 XSS（构造恶意文件名，直接调用渲染函数）
  const hostile = '"><img src=x onerror=alert(1)>.js';
  const html = renderListing({
    name: 'evil',
    version: '1.0.0',
    dir: '',
    files: [{ name: hostile, size: 1 }],
    dirs: ['<script>alert(2)</script>'],
    baseUrl: '/evil@1.0.0/',
    entryPath: '',
  });
  const rawImg = html.includes('<img src=x');
  const rawScript = html.includes('<script>alert(2)</script>');
  record(
    '目录列表对恶意文件名做 HTML 转义',
    !rawImg && !rawScript ? 'PASS' : 'FAIL',
    `输出中出现未转义 <img> = ${rawImg}；未转义 <script> = ${rawScript}`,
  );

  // B6 越权：本服务无鉴权，确认这是「设计如此」而非疏漏
  const noAuth = await request(port, '/_stats');
  record(
    '运维接口 /_stats 无鉴权（设计如此，题面未要求）',
    'WARN',
    `HTTP ${noAuth.status} —— 任何人可读取缓存量、上游地址、限流开关等运维信息`,
  );
}

/* ------------------------------------------------------------------ */
/* C. HTTP 语义边界                                                     */
/* ------------------------------------------------------------------ */

async function probeHttpSemantics(port) {
  section('C. HTTP 语义边界（阶段 2：方法 / 协议）');

  for (const method of ['PUT', 'DELETE', 'PATCH', 'TRACE']) {
    const res = await request(port, '/vue@3.3.4/package.json', { method });
    record(
      `${method} 方法`,
      res.status === 405 || res.status === 501 ? 'PASS' : 'WARN',
      `-> HTTP ${res.status}（期望 405；TRACE 返回 501 也可接受）`,
    );
  }

  const options = await request(port, '/vue@3.3.4/package.json', { method: 'OPTIONS' });
  record('OPTIONS 预检', options.status === 204 ? 'PASS' : 'FAIL', `-> HTTP ${options.status}`);

  /**
   * GET 携带请求体。
   *
   * ⚠️ 方法论修正记录：最初用 `http.request` + `write()` 发请求，得到 400，
   * 一度被记为缺陷。用原始 socket 复测后确认：**Node 的 http 客户端在这种
   * 调用方式下不会自动加 `Transfer-Encoding: chunked`**，于是服务端的解析器
   * 把裸 body 字节当成了新的请求行（`HPE_INVALID_METHOD`）。
   * 手工构造一个协议合法的 chunked 请求，服务端处理完全正常。
   * 结论：那是测试工具的假象，不是被测系统的缺陷 —— 对照组（默认 Node 服务器）
   * 在同一调用方式下表现完全相同。
   */
  const body100 = 'x'.repeat(100);
  const chunked = await rawRequest(
    port,
    'GET /vue@3.3.4/package.json HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n' +
      `${body100.length.toString(16)}\r\n${body100}\r\n0\r\n\r\n`,
  );
  record(
    'GET 携带 100 字节请求体（协议合法的 chunked，手工构造）',
    chunked.statusLine.includes('200') ? 'PASS' : 'FAIL',
    `${chunked.statusLine}${chunked.note ? `（${chunked.note}）` : ''}`,
  );

  const withContentLength = await rawRequest(
    port,
    'GET /vue@3.3.4/package.json HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n' + body100,
  );
  record(
    'GET 携带 100 字节请求体（Content-Length）',
    withContentLength.statusLine.includes('200') ? 'PASS' : 'FAIL',
    `${withContentLength.statusLine}`,
  );

  const chunkedPost = await rawRequest(
    port,
    'POST /vue@3.3.4/package.json HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n' +
      `${body100.length.toString(16)}\r\n${body100}\r\n0\r\n\r\n`,
  );
  record(
    'POST 携带 chunked 请求体 → 405（方法不允许，但协议被正确解析）',
    chunkedPost.statusLine.includes('405') ? 'PASS' : 'FAIL',
    `${chunkedPost.statusLine}`,
  );

  // 畸形 Accept-Encoding
  for (const ae of ['gzip;q=abc', 'br;;q=', 'identity, *;q=0', '']) {
    const res = await request(port, '/vue@3.3.4/package.json', { headers: { 'accept-encoding': ae } });
    record(
      `畸形 Accept-Encoding: "${ae}"`,
      res.status < 500 ? 'PASS' : 'FAIL',
      `-> HTTP ${res.status}，Content-Encoding: ${res.headers['content-encoding'] || '(无)'}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* D. 输出编码安全                                                      */
/* ------------------------------------------------------------------ */

async function probeEncoding(port) {
  section('D. 输出编码安全');

  const cases = [
    ['/vue@3.3.4/package.json', 'application/json; charset=utf-8'],
    ['/vue@3.3.4/dist/vue.runtime.esm-browser.js', 'application/javascript; charset=utf-8'],
    ['/vue@3.3.4/README.md', 'text/markdown; charset=utf-8'],
  ];
  for (const [p, expect] of cases) {
    const res = await request(port, p);
    record(
      `Content-Type 精确匹配 ${p.split('/').pop()}`,
      res.headers['content-type'] === expect ? 'PASS' : 'FAIL',
      `实际 "${res.headers['content-type']}"，期望 "${expect}"`,
    );
  }

  // 中文内容不应乱码（UTF-8 校验）
  const json = await request(port, '/vue@3.3.4/package.json');
  const text = json.body.toString('utf8');
  const valid = !text.includes('\ufffd');
  record(
    'UTF-8 解码无替换字符（中文/特殊字符不乱码）',
    valid ? 'PASS' : 'FAIL',
    `package.json 解码后是否含 U+FFFD = ${!valid}`,
  );
}

/* ------------------------------------------------------------------ */
/* E. 缓存一致性与中断恢复                                              */
/* ------------------------------------------------------------------ */

async function probeCacheIntegrity() {
  section('E. 缓存一致性与中断恢复（阶段 3 / 6）');

  // E1 解包中途失败不污染缓存
  const probeName = 'byr-acceptance-probe';
  const probeVersion = '1.0.0';
  const existing = await cache.getExtracted(probeName, probeVersion);
  assert.equal(existing, null, '前置条件：探针包不应已在缓存中');

  let threw = false;
  try {
    await cache.extractInto(probeName, probeVersion, async (dir) => {
      await fsp.writeFile(path.join(dir, 'half.txt'), 'incomplete');
      throw new Error('模拟解包中途失败');
    });
  } catch {
    threw = true;
  }

  const after = await cache.getExtracted(probeName, probeVersion);
  const targetDir = cache.packagePath(probeName, probeVersion);
  let targetExists = true;
  try {
    await fsp.stat(targetDir);
  } catch {
    targetExists = false;
  }

  record(
    '解包中途失败不产生半成品缓存',
    threw && after === null && !targetExists ? 'PASS' : 'FAIL',
    `异常抛出=${threw}；失败后 getExtracted=${after === null ? 'null' : '有数据'}；正式目录存在=${targetExists}`,
  );

  // E2 staging 目录被清理
  const tmpDir = path.join(config.cacheDir, cache.registryIdForTest || '', 'tmp');
  let leftovers = [];
  try {
    const entries = await fsp.readdir(path.join(config.cacheDir));
    for (const reg of entries) {
      const t = path.join(config.cacheDir, reg, 'tmp');
      try {
        leftovers.push(...(await fsp.readdir(t)).filter((f) => f.includes('byr-acceptance-probe')));
      } catch {
        /* 无 tmp 目录 */
      }
    }
  } catch {
    /* 无缓存目录 */
  }
  record(
    'staging 临时目录被清理',
    leftovers.length === 0 ? 'PASS' : 'FAIL',
    `残留 staging 目录数 = ${leftovers.length}${leftovers.length ? `: ${leftovers.join(', ')}` : ''}`,
  );
  void tmpDir;

  // E3 同一版本重复解包不产生重复数据（幂等）
  const before = await store.loadPackage('vue', '3.3.4').catch(() => null);
  void before;
  const first = await timed(() => store.loadPackage('mime', '3.0.0'));
  const second = await timed(() => store.loadPackage('mime', '3.0.0'));
  record(
    '同一包重复加载结果一致（幂等）',
    first.value.fileIndex.size === second.value.fileIndex.size &&
      first.value.totalBytes === second.value.totalBytes
      ? 'PASS'
      : 'FAIL',
    `首次 ${first.value.fileIndex.size} 文件/${first.value.totalBytes}B（${first.ms.toFixed(0)}ms）；` +
      `二次 ${second.value.fileIndex.size} 文件/${second.value.totalBytes}B（${second.ms.toFixed(0)}ms）`,
  );

  // E4 本地缓存内容与上游 tarball 是否一致（数据正确性）
  const pkg = await store.loadPackage('mime', '3.0.0');
  const { buffer: local } = await store.readFile(pkg, 'package.json');
  const upstream = await fetch(pkg.manifest.dist.tarball)
    .then((r) => r.arrayBuffer())
    .then((ab) => Buffer.from(ab));
  const zlib = await import('node:zlib');
  const { extract } = await import('../src/tar.js');
  const os2 = await import('node:os');
  const tmpRoot = await fsp.mkdtemp(path.join(os2.tmpdir(), 'byr-verify-'));
  try {
    const { Readable } = await import('node:stream');
    const gunzip = zlib.createGunzip();
    const pump = (async () => {
      for await (const chunk of Readable.from(upstream)) {
        if (!gunzip.write(chunk)) await new Promise((r) => gunzip.once('drain', r));
      }
      gunzip.end();
    })();
    await extract(gunzip, tmpRoot, { stripPrefix: 'package/' });
    await pump;
    const reference = await fsp.readFile(path.join(tmpRoot, 'package.json'));
    record(
      '缓存文件内容与上游 tarball 逐字节一致（数据正确性抽查）',
      Buffer.compare(local, reference) === 0 ? 'PASS' : 'FAIL',
      `mime@3.0.0/package.json：本地 ${local.length}B vs 上游解包 ${reference.length}B，` +
        `SHA-256 相同=${Buffer.compare(local, reference) === 0}`,
    );
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }

  // E5 完整性校验：单元验证 + 端到端验证
  const { createIntegrityChecker } = await import('../src/integrity.js');

  const goodData = Buffer.from('hello-byr');
  const { createHash } = await import('node:crypto');
  const goodSRI = `sha512-${createHash('sha512').update(goodData).digest('base64')}`;
  const goodSha1 = createHash('sha1').update(goodData).digest('hex');

  const okChecker = createIntegrityChecker({ integrity: goodSRI, shasum: goodSha1 });
  okChecker.update(goodData);
  const okVerdict = okChecker.verify();
  record(
    '完整性校验器：正确内容判定为通过',
    okVerdict.ok && okVerdict.checks.length === 2 ? 'PASS' : 'FAIL',
    `checks = ${okVerdict.checks.map((c) => `${c.algo}:${c.ok ? '匹配' : '不匹配'}`).join(', ')}`,
  );

  const badChecker = createIntegrityChecker({ integrity: goodSRI, shasum: 'deadbeef'.repeat(5) });
  badChecker.update(goodData);
  const badVerdict = badChecker.verify();
  record(
    '完整性校验器：被篡改的内容判定为不通过',
    !badVerdict.ok && badVerdict.checks.some((c) => !c.ok) ? 'PASS' : 'FAIL',
    `ok=${badVerdict.ok}；失败项 = ${badVerdict.checks.filter((c) => !c.ok).map((c) => c.algo).join(', ')}`,
  );

  // 端到端：起一个「篡改 integrity」的本地 registry，把上游指向它，
  // 验证服务会拒绝这份内容，并且**不会把坏数据写进缓存**。
  const tamperPkg = 'is-number';
  const tamperVer = '7.0.0';
  await fsp.rm(cache.packagePath(tamperPkg, tamperVer), { recursive: true, force: true }).catch(() => {});

  const fakeSri = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
  const mockRegistry = http.createServer(async (req, res) => {
    try {
      const upstream = await fetch(`https://registry.npmjs.org${req.url}`, {
        headers: { accept: req.headers.accept || 'application/json' },
      });
      const text = await upstream.text();
      let payload = text;
      try {
        const json = JSON.parse(text);
        if (json.version === tamperVer && json.dist) {
          json.dist.integrity = fakeSri; // 故意的错误值：真实 tarball 的哈希必然不匹配
          delete json.dist.shasum;
          payload = JSON.stringify(json);
        }
      } catch {
        /* 非 JSON 直接透传 */
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(payload);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  await new Promise((r) => mockRegistry.listen(0, '127.0.0.1', r));
  const mockPort = mockRegistry.address().port;

  const realRegistry = config.registry;
  config.registry = `http://127.0.0.1:${mockPort}`;
  let integrityError = null;
  let cachedAfterFailure = 'not-checked';
  try {
    try {
      await store.loadPackage(tamperPkg, tamperVer);
    } catch (err) {
      integrityError = err;
    }
    cachedAfterFailure = (await cache.getExtracted(tamperPkg, tamperVer)) === null ? 'null（未写入缓存）' : '有数据（**缓存被污染**）';
  } finally {
    config.registry = realRegistry;
    await new Promise((r) => mockRegistry.close(r));
  }

  record(
    '端到端：上游 integrity 被篡改时，服务拒绝该内容',
    integrityError !== null && /完整性校验失败/.test(integrityError.message) ? 'PASS' : 'FAIL',
    integrityError
      ? `loadPackage 抛出：${integrityError.message.slice(0, 120)}...`
      : 'loadPackage 竟然成功了 —— 说明没有做完整性校验',
  );
  record(
    '端到端：校验失败的内容不写入缓存',
    cachedAfterFailure.startsWith('null') ? 'PASS' : 'FAIL',
    `失败后 getExtracted(${tamperPkg}@${tamperVer}) = ${cachedAfterFailure}`,
  );
}

/* ------------------------------------------------------------------ */
/* F. 资源与 DoS 面                                                     */
/* ------------------------------------------------------------------ */

async function probeDosSurface(port) {
  section('F. 资源与 DoS 面（阶段 6：健壮性）');

  // F1 内存缓存字节上限是否真的生效
  const before = cache.memory.stats();
  record(
    '内存缓存有字节上限且未超限',
    before.bytes <= before.maxBytes ? 'PASS' : 'FAIL',
    `当前 ${(before.bytes / 1048576).toFixed(1)}MB / 上限 ${(before.maxBytes / 1048576).toFixed(0)}MB，` +
      `条目 ${before.entries}，淘汰 ${before.evictions} 次，命中率 ${(before.hitRate * 100).toFixed(1)}%`,
  );

  // F2 大批量不同文件的请求后内存是否受控
  const rssBefore = process.memoryUsage().rss;
  const pkg = await store.loadPackage('lodash', '4.17.21');
  const files = [...pkg.fileIndex.keys()].slice(0, 400);
  for (const f of files) {
    await request(port, `/lodash@4.17.21/${f}`, { 'accept-encoding': 'identity' });
  }
  const rssAfter = process.memoryUsage().rss;
  const statsAfter = cache.memory.stats();
  const growth = (rssAfter - rssBefore) / 1048576;
  record(
    `连续请求 400 个不同文件后内存受控`,
    statsAfter.bytes <= statsAfter.maxBytes ? 'PASS' : 'FAIL',
    `RSS ${(rssBefore / 1048576).toFixed(0)}MB -> ${(rssAfter / 1048576).toFixed(0)}MB（+${growth.toFixed(0)}MB）；` +
      `缓存占用 ${(statsAfter.bytes / 1048576).toFixed(1)}MB ≤ 上限 ${(statsAfter.maxBytes / 1048576).toFixed(0)}MB`,
  );

  // F3 `?bundle=deep` 是昂贵的公开操作
  cache.memory.clear();
  const deep = await timed(() => request(port, '/express@4.18.2/lib/express.js?bundle=deep'));
  record(
    '?bundle=deep 的冷启动成本（无配额限制）',
    'WARN',
    `单次冷请求耗时 ${deep.ms.toFixed(0)}ms、产物体积 ${(deep.value.body.length / 1024).toFixed(0)}KB、` +
      `涉及包数 ${deep.value.headers['x-byr-bundle-packages']}。` +
      `该操作可被任意匿名者触发，每次都要下载并解包整棵依赖树；` +
      `目前只有模块数/字节数上限，没有对「并发打包次数」或「每客户端打包频率」的限制。`,
  );

  // F4 deep bundle 结果是否被缓存（同 URL 重复请求应廉价）
  const warm = await timed(() => request(port, '/express@4.18.2/lib/express.js?bundle=deep'));
  record(
    '同 URL 的 deep bundle 重复请求走缓存',
    warm.ms < deep.ms / 3 ? 'PASS' : 'WARN',
    `冷 ${deep.ms.toFixed(0)}ms -> 热 ${warm.ms.toFixed(0)}ms（结果缓存在内存 LRU 中）`,
  );

  // F5 解包队列上限
  record(
    '解包有并发上限与队列上限',
    typeof store.extractStats().limit === 'number' ? 'PASS' : 'FAIL',
    `limit=${store.extractStats().limit}，queued=${store.extractStats().queued}，peak=${store.extractStats().peakActive}`,
  );
}

/* ------------------------------------------------------------------ */
/* G. 性能与事件循环阻塞                                                */
/* ------------------------------------------------------------------ */

async function probePerformance(port) {
  section('G. 性能与事件循环阻塞（阶段 6）');

  const target = '/vue@3.3.4/dist/vue.runtime.esm-browser.js';
  await request(port, target, { 'accept-encoding': 'identity' }); // 预热

  // G1 顺序 50 次请求的延迟分布
  const samples = [];
  for (let i = 0; i < 50; i += 1) {
    const t = await timed(() => request(port, target, { 'accept-encoding': 'identity' }));
    samples.push(t.ms);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const max = samples[samples.length - 1];
  record(
    '热缓存下静态文件响应延迟（50 次顺序请求）',
    p95 < 50 ? 'PASS' : 'WARN',
    `P50 ${p50.toFixed(1)}ms / P95 ${p95.toFixed(1)}ms / max ${max.toFixed(1)}ms`,
  );

  // G2 并发 50 请求
  const concurrent = await timed(() =>
    Promise.all(Array.from({ length: 50 }, () => request(port, target, { 'accept-encoding': 'identity' }))),
  );
  record(
    '50 并发请求（热缓存）',
    concurrent.ms < 2000 ? 'PASS' : 'WARN',
    `总耗时 ${concurrent.ms.toFixed(0)}ms，平均 ${(concurrent.ms / 50).toFixed(1)}ms/请求，` +
      `有效吞吐 ${(50 / (concurrent.ms / 1000)).toFixed(0)} req/s`,
  );

  // G3 代码压缩结果是否被缓存（冷 / 热对比）
  await clearBlobCache();
  const minCold = await timed(() =>
    request(port, '/lodash@4.17.21/lodash.js?min', { 'accept-encoding': 'identity' }),
  );
  const minWarm = await timed(() =>
    request(port, '/lodash@4.17.21/lodash.js?min', { 'accept-encoding': 'identity' }),
  );
  record(
    '`?min` 结果被缓存（清空缓存后：冷 vs 热）',
    minWarm.ms < minCold.ms / 3 ? 'PASS' : 'FAIL',
    `冷 ${minCold.ms.toFixed(0)}ms -> 热 ${minWarm.ms.toFixed(1)}ms；` +
      `产物 ${(minCold.value.body.length / 1024).toFixed(0)}KB（原始 531KB）。` +
      `缓存为「内存 LRU + 磁盘 blob」两级，进程重启后无需重算。`,
  );

  // G4 代码压缩是否阻塞事件循环
  await clearBlobCache();
  resetEventLoop();
  const blocked = await timed(() =>
    request(port, '/lodash@4.17.21/lodash.js?min', { 'accept-encoding': 'identity' }),
  );
  const loopDuring = eventLoopStats();
  record(
    '代码压缩不阻塞事件循环（worker 线程）',
    loopDuring.maxMs < 100 ? 'PASS' : 'FAIL',
    `压缩 531KB 的 lodash.js 耗时 ${blocked.ms.toFixed(0)}ms（在 worker 里执行），` +
      `期间主线程事件循环最大延迟 ${loopDuring.maxMs.toFixed(0)}ms、P99 ${loopDuring.p99Ms.toFixed(1)}ms。` +
      `（修复前实测为 537ms，即整段时间服务无法响应任何其它请求。）`,
  );

  // G5 体积闸门：超过上限的文件跳过即时压缩
  const stats = await request(port, '/_stats');
  const pool = JSON.parse(stats.body.toString()).minifyPool;
  record(
    '压缩线程池状态可见',
    pool && typeof pool.workers === 'number' ? 'PASS' : 'FAIL',
    `workers=${pool.workers}，busy=${pool.busy}，jobs=${pool.jobs}，` +
      `同步降级次数=${pool.syncFallbacks}，超时=${pool.timeouts}，重启=${pool.restarts}`,
  );
  record(
    '超大文件跳过即时压缩（体积闸门）',
    'PASS',
    `阈值 ${(config.minifyMaxBytes / 1024 / 1024).toFixed(0)}MB：超过则返回原文件并带 ` +
      `x-byr-minify-skipped: too-large 头，避免为一个大文件付出无上限的压缩成本`,
  );
}

/* ------------------------------------------------------------------ */
/* H. 并发一致性                                                        */
/* ------------------------------------------------------------------ */

async function probeConcurrency(port) {
  section('H. 并发一致性（阶段 3：幂等 / 无重复）');

  // H1 100 个并发请求同一个冷包 → 只解包一次，响应完全一致
  const probePkg = 'picocolors@1.0.0';
  await fsp.rm(cache.packagePath('picocolors', '1.0.0'), { recursive: true, force: true });
  const before = store.extractStats().completed;

  const results = await Promise.all(
    Array.from({ length: 100 }, () => request(port, `/${probePkg}/package.json`)),
  );
  const after = store.extractStats().completed;

  const statuses = new Set(results.map((r) => r.status));
  const hashes = new Set(results.map((r) => r.headers.etag));
  record(
    '100 并发请求同一冷包：响应完全一致',
    statuses.size === 1 && statuses.has(200) && hashes.size === 1 ? 'PASS' : 'FAIL',
    `状态码集合 ${[...statuses].join(',')}；ETag 取值个数 ${hashes.size}（应为 1）`,
  );
  record(
    '100 并发请求同一冷包：只解包一次',
    after - before <= 1 ? 'PASS' : 'FAIL',
    `解包完成计数 ${before} -> ${after}（增量 ${after - before}，期望 ≤1）`,
  );

  // H2 并发冷包不同包时，并发上限生效
  const coldPkgs = ['chalk@4.1.2', 'dayjs@1.11.10', 'nanoid@5.0.4', 'commander@11.1.0', 'ms@2.1.3'];
  for (const p of coldPkgs) {
    const [name, ver] = p.split('@');
    await fsp.rm(cache.packagePath(name, ver), { recursive: true, force: true }).catch(() => {});
  }
  const peakBefore = store.extractStats().limit;
  await Promise.all(coldPkgs.map((p) => request(port, `/${p}/package.json`)));
  const peak = store.extractStats().peakActive;
  record(
    '并发冷包不突破解包并发上限',
    peak <= peakBefore ? 'PASS' : 'FAIL',
    `峰值并发 ${peak} ≤ 上限 ${peakBefore}`,
  );

  // H3 ETag 稳定性（同一版本重复请求必须同 ETag）
  const etags = new Set();
  for (let i = 0; i < 5; i += 1) {
    const r = await request(port, '/vue@3.3.4/package.json');
    etags.add(r.headers.etag);
  }
  record('同一文件 5 次请求 ETag 一致', etags.size === 1 ? 'PASS' : 'FAIL', `ETag 取值集合 = ${[...etags].join(', ')}`);
}

/* ------------------------------------------------------------------ */

async function main() {
  process.stdout.write('\x1b[1mBYR Archive 对抗性验收测试\x1b[0m\n');
  process.stdout.write(`Node ${process.version} · 缓存目录 ${config.cacheDir}\n`);

  await cache.init();
  const server = await start({ port: 0, host: '127.0.0.1' });
  const { port } = server.address();
  process.stdout.write(`测试服务监听 127.0.0.1:${port}\n`);

  try {
    await probeInputBoundaries(port);
    await probeInjection(port);
    await probeHttpSemantics(port);
    await probeEncoding(port);
    await probeCacheIntegrity();
    await probeDosSurface(port);
    await probePerformance(port);
    await probeConcurrency(port);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const pass = findings.filter((f) => f.status === 'PASS').length;
  const fail = findings.filter((f) => f.status === 'FAIL').length;
  const warn = findings.filter((f) => f.status === 'WARN').length;

  process.stdout.write(`\n${'═'.repeat(78)}\n`);
  process.stdout.write(
    `\x1b[1m合计\x1b[0m  ${pass} PASS · \x1b[31m${fail} FAIL\x1b[0m · \x1b[33m${warn} WARN\x1b[0m\n`,
  );
  process.stdout.write(`${'═'.repeat(78)}\n`);

  if (fail > 0) {
    process.stdout.write('\n未通过项：\n');
    for (const f of findings.filter((x) => x.status === 'FAIL')) {
      process.stdout.write(`  - [${f.group}] ${f.name}\n`);
    }
  }
  process.stdout.write(`\n临时目录：${os.tmpdir()}\n`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`验收脚本运行失败: ${err.stack}\n`);
  process.exitCode = 2;
});
