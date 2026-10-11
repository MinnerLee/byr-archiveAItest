/**
 * 最终可用性验证（Live Verification）。
 *
 * 与另外两个测试脚本的区别 —— 这是「真的能跑吗」这一层证据：
 *
 *   smoke.mjs       在**当前进程内**起服务，验证逻辑正确性
 *   acceptance.mjs  在当前进程内做对抗性测试
 *   verify-live.mjs 本脚本：**spawn 一个真实的独立进程** `node src/index.js`，
 *                   通过真实 TCP 打它，并额外验证 CLI 子进程。
 *
 * 为什么值得单独做一遍：进程内测试可以掩盖大量真实问题 ——
 * 端口绑定、配置读取、启动顺序、优雅退出、CLI 入口守卫、
 * 「是不是只在本机某个未提交的文件存在时才能跑」等等。
 *
 * 运行：node test/verify-live.mjs
 * 退出码：0 = 全部通过
 */

import { spawn } from 'node:child_process';
import nodeHttp from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* 报告框架                                                            */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function group(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n${'─'.repeat(76)}\n`);
}

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} evidence
 */
function check(name, ok, evidence) {
  if (ok) {
    pass += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name}\n      ${evidence}\n`);
  } else {
    fail += 1;
    failures.push(`${name}: ${evidence}`);
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name}\n      ${evidence}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* 真实 HTTP 客户端                                                    */
/* ------------------------------------------------------------------ */

/**
 * 发一个真实 HTTP 请求（走 TCP，不是进程内调用）。
 *
 * ⚠️ 这里刻意用底层的 `node:http`，而不是全局 `fetch`。
 *
 * 原因是 `fetch`（undici 实现）会**自己协商并透明解压**：
 * 它会覆盖调用方传入的 `Accept-Encoding`，解压后还会把 `Content-Encoding`
 * 从响应头里摘掉。结果是「传输压缩」这类行为在 fetch 下**根本观察不到** ——
 * 实测最初用 fetch 跑本脚本时，gzip / brotli 三项全部读不到 Content-Encoding，
 * 一度被误报为失败。
 *
 * 用 `node:http` 就没有这层魔法：请求头原样发出，响应体原样返回，
 * 验证工具才能观察到被测系统的真实行为。
 *
 * （这与验收报告里记录的 chunked 请求那次是同一类问题：
 *   客户端的自动行为掩盖了被测对象的真实表现。）
 *
 * @param {string} url
 * @param {object} [options]
 */
function http(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const started = Date.now();
    const req = nodeHttp.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          // 把 node:http 的响应头包成 Headers，保持与 fetch 一致的 .get() 用法
          const flat = {};
          for (const [k, v] of Object.entries(res.headers)) {
            flat[k] = Array.isArray(v) ? v.join(', ') : v;
          }
          resolve({
            status: res.statusCode,
            headers: new Headers(flat),
            body,
            text: body.toString('utf8'),
            ms: Date.now() - started,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 起一个真实的独立服务进程。 *//** 起一个真实的独立服务进程。 */
async function startRealServer(port) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (c) => {
    log += c.toString();
  });
  child.stderr.on('data', (c) => {
    log += c.toString();
  });

  const exited = new Promise((resolve) => child.once('exit', resolve));

  // 轮询直到就绪（最多 20 秒）
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`服务在 20 秒内未就绪。进程输出：\n${log}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/_health`);
      if (res.ok) break;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return { child, exited, getLog: () => log };
}

/** 跑一个 CLI 子进程并返回输出。 */
async function runCli(args, timeoutMs = 120_000) {
  const child = spawn(process.execPath, ['src/index.js', ...args], {
    cwd: ROOT,
    env: { ...process.env, LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => {
    out += c.toString();
  });
  child.stderr.on('data', (c) => {
    err += c.toString();
  });

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, out, err };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const port = 18080 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;

  process.stdout.write('\x1b[1mBYR Archive 最终可用性验证（真实独立进程）\x1b[0m\n');
  process.stdout.write(`Node ${process.version}\n`);
  process.stdout.write(`工作目录 ${ROOT}\n`);
  process.stdout.write(`目标地址 ${base}\n`);

  group('A. 进程启动');

  const server = await startRealServer(port);
  const bootLog = server.getLog();
  check('独立进程能正常启动并监听端口', bootLog.includes('BYR Archive 已启动'), bootLog.trim().split('\n')[0] || '(无输出)');
  check(
    '启动日志报告了正确的上游与缓存目录',
    /上游 registry: https?:\/\//.test(bootLog) && /磁盘缓存:/.test(bootLog),
    bootLog
      .trim()
      .split('\n')
      .slice(1, 3)
      .map((l) => l.replace(/^\[[^\]]+\]\s*INFO\s*/, ''))
      .join(' | '),
  );

  try {
    /* ---------------- B. 必选功能 ---------------- */
    group('B. 必选功能（真实 HTTP）');

    const health = await http(`${base}/_health`);
    check(
      'GET /_health',
      health.status === 200 && JSON.parse(health.text).status === 'ok',
      `HTTP ${health.status} · ${health.ms}ms · ${health.text.replace(/\s+/g, ' ').slice(0, 90)}…`,
    );

    const index = await http(`${base}/`);
    check(
      'GET / 服务首页',
      index.status === 200 && index.text.includes('BYR Archive') && index.text.includes('试试这些地址'),
      `HTTP ${index.status} · ${index.body.length}B · Content-Type: ${index.headers.get('content-type')}`,
    );

    const entryJsdelivr = await http(`${base}/vue@3.3.4`);
    check(
      'REQ-005 入口解析规则 1（jsdelivr 字段）',
      entryJsdelivr.status === 200 && entryJsdelivr.headers.get('x-byr-entry')?.includes('jsdelivr'),
      `GET /vue@3.3.4 → HTTP ${entryJsdelivr.status} · x-byr-entry: ${entryJsdelivr.headers.get('x-byr-entry')}`,
    );

    const entryExports = await http(`${base}/react`);
    check(
      'REQ-006 入口解析规则 2a（exports["."].default）',
      entryExports.status === 200 && entryExports.headers.get('x-byr-entry')?.includes('exports'),
      `GET /react → HTTP ${entryExports.status} · x-byr-entry: ${entryExports.headers.get('x-byr-entry')}`,
    );

    const entryMain = await http(`${base}/lodash`);
    check(
      'REQ-008 入口解析规则 3（main）',
      entryMain.status === 200 && entryMain.headers.get('x-byr-entry')?.endsWith('(main)'),
      `GET /lodash → HTTP ${entryMain.status} · x-byr-entry: ${entryMain.headers.get('x-byr-entry')}`,
    );

    const noEntry = await http(`${base}/express@4.18.2`);
    const noEntryBody = JSON.parse(noEntry.text);
    check(
      'REQ-009 入口解析规则 4（均不满足 → 404，且带解释）',
      noEntry.status === 404 && /ENTRY_NODE_DEFAULT/.test(noEntryBody.hint || ''),
      `GET /express@4.18.2 → HTTP ${noEntry.status} · hint 含解决办法(${Boolean(noEntryBody.hint)}) · nodeDefaultCandidate=${noEntryBody.nodeDefaultCandidate}`,
    );

    const listing = await http(`${base}/vue@3.3.4/`);
    check(
      'REQ-010 目录列表页',
      listing.status === 200 && listing.text.includes('<!DOCTYPE HTML>') && listing.text.includes('package.json'),
      `HTTP ${listing.status} · ${listing.body.length}B · ${listing.headers.get('content-type')}`,
    );

    const file = await http(`${base}/vue@3.3.4/dist/vue.runtime.esm-browser.js`);
    check(
      'REQ-011 直接访问文件 + REQ-003 Content-Type',
      file.status === 200 && file.headers.get('content-type') === 'application/javascript; charset=utf-8',
      `HTTP ${file.status} · ${(file.body.length / 1024).toFixed(0)}KB · ${file.headers.get('content-type')}`,
    );

    const json = await http(`${base}/vue@3.3.4/package.json`);
    check(
      'REQ-003 题面明确要求：json 带 charset',
      json.headers.get('content-type') === 'application/json; charset=utf-8',
      `Content-Type: ${json.headers.get('content-type')}`,
    );

    /* ---------------- C. 可选加分项 ---------------- */
    group('C. 可选加分项（真实 HTTP）');

    const ranged = await http(`${base}/vue@%5E3.2.0/package.json`);
    check(
      'REQ-101a semver 范围解析（^3.2.0）',
      ranged.status === 200 && ranged.headers.get('x-byr-resolution') === 'range' && /^3\./.test(ranged.headers.get('x-byr-version')),
      `HTTP ${ranged.status} · 解析到 ${ranged.headers.get('x-byr-version')} · 方式 ${ranged.headers.get('x-byr-resolution')}`,
    );

    const tagged = await http(`${base}/vue@beta/package.json`);
    check(
      'REQ-101b dist-tag 解析（@beta）',
      tagged.status === 200 && /dist-tag/.test(tagged.headers.get('x-byr-resolution') || ''),
      `HTTP ${tagged.status} · ${tagged.headers.get('x-byr-resolution')} → ${tagged.headers.get('x-byr-version')}`,
    );

    const scoped = await http(`${base}/@vue/shared@3.4.21/package.json`);
    check(
      'scoped 包（@vue/shared）',
      scoped.status === 200 && JSON.parse(scoped.text).name === '@vue/shared',
      `HTTP ${scoped.status} · name=${JSON.parse(scoped.text).name}`,
    );

    const compat = await http(`${base}/npm/vue@3.3.4/package.json`);
    check(
      'jsDelivr 兼容前缀 /npm/',
      compat.status === 200 && compat.headers.get('x-byr-url-style') === 'jsdelivr',
      `HTTP ${compat.status} · x-byr-url-style: ${compat.headers.get('x-byr-url-style')}`,
    );

    const gz = await http(`${base}/vue@3.3.4/dist/vue.runtime.esm-browser.js`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const br = await http(`${base}/vue@3.3.4/dist/vue.runtime.esm-browser.js`, {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    check(
      'REQ-103b 传输压缩（gzip / brotli 内容协商）',
      gz.headers.get('content-encoding') === 'gzip' && br.headers.get('content-encoding') === 'br' && br.body.length < gz.body.length,
      `原始 297KB → gzip ${(gz.body.length / 1024).toFixed(0)}KB → br ${(br.body.length / 1024).toFixed(0)}KB`,
    );

    const min = await http(`${base}/lodash@4.17.21/lodash.js?min`, { headers: { 'accept-encoding': 'identity' } });
    const minAgain = await http(`${base}/lodash@4.17.21/lodash.js?min`, { headers: { 'accept-encoding': 'identity' } });
    check(
      'REQ-103a 代码压缩（?min）且结果被缓存',
      min.status === 200 && min.headers.get('x-byr-minified') === 'true' && min.body.length < 200 * 1024 && minAgain.ms < 50,
      `${(min.body.length / 1024).toFixed(0)}KB（原始 531KB）· 首次 ${min.ms}ms → 二次 ${minAgain.ms}ms（命中缓存）`,
    );

    const bundled = await http(`${base}/mime@3.0.0/index.js?bundle`);
    check(
      'REQ-103c 打包（?bundle 内联包内相对依赖）',
      bundled.status === 200 && String(bundled.headers.get('x-byr-bundle')).includes('inline') && Number(bundled.headers.get('x-byr-bundle-modules')) >= 4,
      `模式 ${bundled.headers.get('x-byr-bundle')} · 模块 ${bundled.headers.get('x-byr-bundle-modules')} · ${(bundled.body.length / 1024).toFixed(0)}KB`,
    );

    const deep = await http(`${base}/cookie-parser@1.4.6/index.js?bundle=deep`);
    check(
      'REQ-103c 深度打包（?bundle=deep 递归内联外部依赖）',
      deep.status === 200 && deep.headers.get('x-byr-bundle') === 'deep-inline-cjs' && Number(deep.headers.get('x-byr-bundle-packages')) >= 2,
      `模式 ${deep.headers.get('x-byr-bundle')} · 模块 ${deep.headers.get('x-byr-bundle-modules')} · 涉及包 ${deep.headers.get('x-byr-bundle-packages')} · ${(deep.body.length / 1024).toFixed(1)}KB`,
    );

    const esm = await http(`${base}/axios@1.6.0/lib/axios.js?esm`);
    check(
      'ESM 说明符重写（?esm）',
      esm.status === 200 && esm.headers.get('x-byr-bundle') === 'rewrite' && esm.text.includes("from '/npm/"),
      `模式 ${esm.headers.get('x-byr-bundle')} · 产物含指向本服务的绝对 URL(${esm.text.includes("from '/npm/")})`,
    );

    const minJsFallback = await http(`${base}/vue@3.3.4/dist/vue.global.min.js`, {
      headers: { 'accept-encoding': 'identity' },
    });
    check(
      '.min.js 缺失时回退到即时压缩（jsDelivr 行为）',
      minJsFallback.status === 200 && minJsFallback.headers.get('x-byr-minified') === 'true',
      `GET /vue@3.3.4/dist/vue.global.min.js（包里没有这个文件）→ HTTP ${minJsFallback.status} · x-byr-minified: ${minJsFallback.headers.get('x-byr-minified')}`,
    );

    /* ---------------- D. HTTP 语义 ---------------- */
    group('D. HTTP 语义');

    const etag = json.headers.get('etag');
    const notModified = await http(`${base}/vue@3.3.4/package.json`, { headers: { 'if-none-match': etag } });
    check(
      'ETag + If-None-Match → 304',
      notModified.status === 304 && notModified.body.length === 0,
      `ETag ${etag} → HTTP ${notModified.status} · body ${notModified.body.length}B`,
    );

    const ims = await http(`${base}/vue@3.3.4/package.json`, {
      headers: { 'if-modified-since': json.headers.get('last-modified') },
    });
    check(
      'If-Modified-Since → 304',
      ims.status === 304,
      `Last-Modified ${json.headers.get('last-modified')} → HTTP ${ims.status}`,
    );

    const range = await http(`${base}/vue@3.3.4/package.json`, { headers: { range: 'bytes=0-99' } });
    check(
      'Range → 206 + Content-Range',
      range.status === 206 && range.body.length === 100 && range.headers.get('content-range') === `bytes 0-99/${json.body.length}`,
      `HTTP ${range.status} · ${range.headers.get('content-range')} · 实际 ${range.body.length}B`,
    );

    const head = await http(`${base}/vue@3.3.4/package.json`, { method: 'HEAD' });
    check(
      'HEAD 只有头没有体',
      head.status === 200 && head.body.length === 0 && Number(head.headers.get('content-length')) > 0,
      `HTTP ${head.status} · body ${head.body.length}B · Content-Length ${head.headers.get('content-length')}`,
    );

    const options = await http(`${base}/vue@3.3.4/package.json`, { method: 'OPTIONS' });
    check(
      'OPTIONS → 204 + CORS 预检头',
      options.status === 204 && options.headers.get('access-control-allow-methods')?.includes('GET'),
      `HTTP ${options.status} · allow-methods: ${options.headers.get('access-control-allow-methods')}`,
    );

    check(
      'CORS 与安全响应头',
      json.headers.get('access-control-allow-origin') === '*' && json.headers.get('x-content-type-options') === 'nosniff',
      `access-control-allow-origin: ${json.headers.get('access-control-allow-origin')} · x-content-type-options: ${json.headers.get('x-content-type-options')}`,
    );

    check(
      '目录列表页 CSP / Referrer-Policy',
      /default-src 'none'/.test(listing.headers.get('content-security-policy') || '') && listing.headers.get('referrer-policy') === 'no-referrer',
      `CSP: ${String(listing.headers.get('content-security-policy')).slice(0, 60)}… · referrer-policy: ${listing.headers.get('referrer-policy')}`,
    );

    /* ---------------- E. 运维接口 ---------------- */
    group('E. 运维与 API');

    const apiInfo = await http(`${base}/_api/vue@3.3.4`);
    const apiInfoBody = JSON.parse(apiInfo.text);
    check(
      '/_api/ 包信息（版本 / 入口 / 体积）',
      apiInfo.status === 200 && apiInfoBody.entry.source === 'jsdelivr' && apiInfoBody.resolved.version === '3.3.4',
      `HTTP ${apiInfo.status} · 版本 ${apiInfoBody.resolved.version}（${apiInfoBody.resolved.how}）· 入口 ${apiInfoBody.entry.path} ← ${apiInfoBody.entry.source}`,
    );

    const apiTree = await http(`${base}/_api/vue@3.3.4/tree`);
    check(
      '/_api/ 文件树',
      apiTree.status === 200 && JSON.parse(apiTree.text).count > 10,
      `HTTP ${apiTree.status} · ${JSON.parse(apiTree.text).count} 个文件 · ${(apiTree.body.length / 1024).toFixed(1)}KB`,
    );

    const metrics = await http(`${base}/_metrics`);
    check(
      '/_metrics（Prometheus 文本格式）',
      metrics.status === 200 && metrics.text.includes('byr_http_requests_total') && metrics.text.includes('byr_event_loop_lag_seconds'),
      `HTTP ${metrics.status} · ${metrics.text.split('\n').filter((l) => l && !l.startsWith('#')).length} 个样本 · ${metrics.headers.get('content-type')}`,
    );

    const stats = await http(`${base}/_stats`);
    const statsBody = JSON.parse(stats.text);
    check(
      '/_stats（解包信号量 / 压缩线程池 / 限流 / 缓存）',
      stats.status === 200 && statsBody.extraction && statsBody.minifyPool && statsBody.rateLimit,
      `信号量上限 ${statsBody.extraction.limit} · 压缩 worker ${statsBody.minifyPool.workers} 个（降级 ${statsBody.minifyPool.syncFallbacks} 次）· 限流 ${statsBody.rateLimit.enabled ? '开' : '关'} · 内存缓存 ${(statsBody.memoryCache.bytes / 1048576).toFixed(1)}MB`,
    );

    /* ---------------- F. 错误处理与安全 ---------------- */
    group('F. 错误处理与安全');

    const cases = [
      ['/nonexistent-pkg-byr-xyz/', 404, '不存在的包'],
      ['/vue@99999.0.0/package.json', 404, '不存在的版本'],
      ['/vue@3.3.4/nope/nothing.js', 404, '不存在的文件'],
      ['/vue@3.3.4/../../../../etc/passwd', 404, '路径穿越'],
      ['/vue@3.3.4/%2e%2e%2f%2e%2e%2fetc%2fpasswd', 404, '编码后的路径穿越'],
      ['/-/', 400, '非法包名'],
      ['/_api/vue@3.3.4/bogus', 400, '未知 API 子命令'],
    ];
    for (const [urlPath, expect, desc] of cases) {
      const res = await http(`${base}${urlPath}`);
      check(
        `${desc} → ${expect}`,
        res.status === expect,
        `GET ${urlPath.slice(0, 50)} → HTTP ${res.status}`,
      );
    }

    const put = await http(`${base}/vue@3.3.4/package.json`, { method: 'PUT' });
    check('PUT → 405', put.status === 405, `HTTP ${put.status} · Allow: ${put.headers.get('allow')}`);

    const stackLeak = /at\s+\w+\s+\(|\/src\/|\.js:\d+:\d+/.test((await http(`${base}/nonexistent-pkg-byr-xyz/`)).text);
    check('错误响应不泄漏堆栈', !stackLeak, `404 响应体中未出现堆栈特征(${!stackLeak})`);

    /* ---------------- G. 真实并发 ---------------- */
    group('G. 真实并发（同一冷包 60 并发）');

    const concurrent = await Promise.all(
      Array.from({ length: 60 }, () => http(`${base}/nanoid@5.0.4/package.json`)),
    );
    const statuses = new Set(concurrent.map((r) => r.status));
    const etags = new Set(concurrent.map((r) => r.headers.get('etag')));
    check(
      '60 并发请求同一冷包：状态码与 ETag 完全一致',
      statuses.size === 1 && statuses.has(200) && etags.size === 1,
      `状态码集合 {${[...statuses].join(',')}} · ETag 取值 ${etags.size} 个 · 耗时 ${Math.max(...concurrent.map((r) => r.ms))}ms`,
    );

    /* ---------------- H. 优雅退出 ---------------- */
    group('H. 优雅退出');

    server.child.kill('SIGTERM');
    // 注意：`server.exited` resolve 的是退出码（数字），不是数组，
    // 所以两支都要先包装成数组再解构，否则超时分支和正常分支形状不一致。
    const [exitCode] = await Promise.race([
      server.exited.then((code) => [code]),
      new Promise((r) => setTimeout(() => r([null]), 12_000)),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    const shutdownLog = server.getLog();
    check(
      'SIGTERM 后进程能干净退出（含线程池回收）',
      exitCode === 0 && /停止接受新连接/.test(shutdownLog),
      `退出码 ${exitCode} · 日志含「停止接受新连接」(${/停止接受新连接/.test(shutdownLog)}) · 含「进程退出」(${/进程退出/.test(shutdownLog)})`,
    );

    /* ---------------- I. CLI 子进程 ---------------- */
    group('I. CLI（真实子进程）');

    const cliHelp = await runCli(['--help'], 30_000);
    check(
      'CLI --help',
      cliHelp.code === 0 && cliHelp.out.includes('byr-archive'),
      `退出码 ${cliHelp.code} · 输出 ${cliHelp.out.split('\n').length} 行`,
    );

    const cliInfo = await runCli(['info', 'vue@3.3.4'], 180_000);
    check(
      'CLI info vue@3.3.4',
      cliInfo.code === 0 && /jsdelivr/.test(cliInfo.out),
      cliInfo.out
        .split('\n')
        .filter((l) => /入口文件|解析到的版本|解析方式|文件数/.test(l))
        .map((l) => l.trim())
        .join(' | '),
    );

    const cliVerify = await runCli(['verify', 'mime@3.0.0'], 240_000);
    const verifySummary = (cliVerify.out.match(/(\d+)\/(\d+) 项通过/) || [])[0] || '(未找到结论行)';
    check(
      'CLI verify mime@3.0.0（逐环节自检）',
      cliVerify.code === 0 && /(\d+)\/\1 项通过/.test(cliVerify.out),
      verifySummary,
    );
  } finally {
    if (!server.child.killed) server.child.kill('SIGKILL');
  }

  /* ---------------- 汇总 ---------------- */
  process.stdout.write(`\n${'═'.repeat(76)}\n`);
  process.stdout.write(
    `\x1b[1m最终可用性验证\x1b[0m  \x1b[32m${pass} 通过\x1b[0m` +
      (fail ? ` · \x1b[31m${fail} 失败\x1b[0m` : ' · 无失败') +
      '\n',
  );
  process.stdout.write(`${'═'.repeat(76)}\n`);

  if (fail > 0) {
    process.stdout.write('\n失败项：\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`验证脚本异常: ${err.stack}\n`);
  process.exitCode = 2;
});
