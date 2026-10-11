/**
 * 端到端冒烟测试。
 *
 * 直接在本进程内起一个服务实例，然后用真实 HTTP 请求打它 ——
 * 既验证了路由/解析/缓存的纯逻辑，也验证了「真的能从 npm registry 拉到包并吐出来」。
 *
 * 运行：npm test
 * 若网络不可达，联网用例会自动跳过并给出提示（单元用例仍然全部执行）。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import * as semver from '../src/semver.js';
import { parseRoute } from '../src/router.js';
import * as mime from '../src/mime.js';
import { minifyJavaScript } from '../src/minify.js';
import { resolveEntry, normalizeEntryPath } from '../src/entry.js';
import { parseRange } from '../src/handler.js';
import { findSpecifiers, resolveRelativeSpec, splitBareSpec } from '../src/bundle.js';
import { start } from '../src/server.js';

/* ------------------------------------------------------------------ */
/* 迷你测试框架                                                         */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m\n`);
}

function check(label, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
  } catch (err) {
    failed += 1;
    failures.push(`${currentSection} → ${label}: ${err.message}`);
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n      ${err.message}\n`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
  } catch (err) {
    failed += 1;
    failures.push(`${currentSection} → ${label}: ${err.message}`);
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n      ${err.message}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. semver                                                           */
/* ------------------------------------------------------------------ */

function testSemver() {
  section('1. semver 版本解析');

  check('精确版本比较', () => {
    assert.equal(semver.compare('1.2.3', '1.2.4'), -1);
    assert.equal(semver.compare('1.10.0', '1.9.0'), 1);
    assert.equal(semver.compare('2.0.0', '2.0.0'), 0);
  });

  check('预发布版本优先级低于正式版', () => {
    assert.equal(semver.compare('1.0.0-beta.1', '1.0.0'), -1);
    assert.equal(semver.compare('1.0.0-alpha', '1.0.0-beta'), -1);
    assert.equal(semver.compare('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  });

  check('插入号 ^1.2.3 → >=1.2.3 <2.0.0', () => {
    assert.equal(semver.satisfies('1.2.3', '^1.2.3'), true);
    assert.equal(semver.satisfies('1.9.9', '^1.2.3'), true);
    assert.equal(semver.satisfies('2.0.0', '^1.2.3'), false);
    assert.equal(semver.satisfies('1.2.2', '^1.2.3'), false);
  });

  check('插入号对 0.x 的特殊规则', () => {
    assert.equal(semver.satisfies('0.2.9', '^0.2.3'), true);
    assert.equal(semver.satisfies('0.3.0', '^0.2.3'), false);
    assert.equal(semver.satisfies('0.0.3', '^0.0.3'), true);
    assert.equal(semver.satisfies('0.0.4', '^0.0.3'), false);
  });

  check('波浪号 ~1.2.3 → >=1.2.3 <1.3.0', () => {
    assert.equal(semver.satisfies('1.2.9', '~1.2.3'), true);
    assert.equal(semver.satisfies('1.3.0', '~1.2.3'), false);
    assert.equal(semver.satisfies('1.9.0', '~1'), true);
    assert.equal(semver.satisfies('2.0.0', '~1'), false);
  });

  check('比较符与并集', () => {
    assert.equal(semver.satisfies('1.5.0', '>=1.2.0 <2.0.0'), true);
    assert.equal(semver.satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
    assert.equal(semver.satisfies('3.1.0', '^1.0.0 || ^3.0.0'), true);
    assert.equal(semver.satisfies('2.5.0', '^1.0.0 || ^3.0.0'), false);
  });

  check('通配与连字符区间', () => {
    assert.equal(semver.satisfies('1.9.9', '1.x'), true);
    assert.equal(semver.satisfies('2.0.0', '1.x'), false);
    assert.equal(semver.satisfies('1.2.7', '1.2.x'), true);
    assert.equal(semver.satisfies('1.5.0', '1.2.3 - 1.8.0'), true);
    assert.equal(semver.satisfies('1.9.0', '1.2.3 - 1.8.0'), false);
    assert.equal(semver.satisfies('99.0.0', '*'), true);
  });

  check('预发布版本默认不参与匹配', () => {
    assert.equal(semver.satisfies('2.0.0-beta.1', '^1.0.0'), false);
    assert.equal(semver.satisfies('1.2.3-beta.1', '>=1.2.3-beta.0'), true);
  });

  check('maxSatisfying 取最高版本', () => {
    const list = ['1.0.0', '1.2.0', '1.10.0', '2.0.0', '1.9.0'];
    assert.equal(semver.maxSatisfying(list, '^1.0.0'), '1.10.0');
    assert.equal(semver.maxSatisfying(list, '~1.2.0'), '1.2.0');
    assert.equal(semver.maxSatisfying(list, '^3.0.0'), null);
  });

  check('非法输入不抛异常', () => {
    assert.equal(semver.parse('not-a-version'), null);
    assert.equal(semver.satisfies('not-a-version', '^1.0.0'), false);
    assert.equal(semver.isExact('1.2.3'), true);
    assert.equal(semver.isExact('^1.2.3'), false);
  });
}

/* ------------------------------------------------------------------ */
/* 2. 路由                                                             */
/* ------------------------------------------------------------------ */

function testRouter() {
  section('2. URL 路由解析');
  const base = 'http://localhost:8080';

  const r = (p) => parseRoute(p, base);

  check('根路径 → 首页', () => {
    assert.equal(r('/').kind, 'index');
  });

  check('/包名 → 入口文件', () => {
    const route = r('/vue');
    assert.deepEqual([route.kind, route.name, route.versionSpec], ['entry', 'vue', '']);
  });

  check('/包名@版本 → 入口文件', () => {
    const route = r('/vue@3.3.4');
    assert.deepEqual([route.kind, route.name, route.versionSpec], ['entry', 'vue', '3.3.4']);
  });

  check('/包名@版本/ → 目录列表', () => {
    const route = r('/vue@3.3.4/');
    assert.deepEqual([route.kind, route.name, route.versionSpec, route.subPath], [
      'listing', 'vue', '3.3.4', '',
    ]);
  });

  check('/包名@版本/子目录/ → 目录列表', () => {
    const route = r('/vue@3.3.4/dist/');
    assert.deepEqual([route.kind, route.subPath], ['listing', 'dist']);
  });

  check('/包名@版本/文件 → 文件', () => {
    const route = r('/vue@3.3.4/dist/vue.runtime.esm-browser.js');
    assert.deepEqual([route.kind, route.subPath], ['file', 'dist/vue.runtime.esm-browser.js']);
  });

  check('scoped 包', () => {
    const route = r('/@vue/shared@3.4.21/dist/shared.cjs.js');
    assert.deepEqual([route.kind, route.name, route.versionSpec, route.subPath], [
      'file', '@vue/shared', '3.4.21', 'dist/shared.cjs.js',
    ]);
  });

  check('scoped 包不带版本', () => {
    const route = r('/@vue/shared/');
    assert.deepEqual([route.kind, route.name, route.versionSpec], ['listing', '@vue/shared', '']);
  });

  check('/npm/ 兼容前缀', () => {
    const route = r('/npm/vue@3.3.4/dist/vue.js');
    assert.deepEqual([route.kind, route.compat, route.name, route.subPath], [
      'file', true, 'vue', 'dist/vue.js',
    ]);
  });

  check('semver 范围被当作版本描述（URL 解码后）', () => {
    const route = r('/vue@%5E3.2.0/');
    assert.equal(route.versionSpec, '^3.2.0');
    assert.equal(route.kind, 'listing');
  });

  check('dist-tag 被当作版本描述', () => {
    const route = r('/vue@beta/package.json');
    assert.deepEqual([route.versionSpec, route.subPath], ['beta', 'package.json']);
  });

  check('查询参数被解析', () => {
    const route = r('/lodash@4.17.21/lodash.js?min');
    assert.equal(route.query.min, '');
  });

  check('相邻斜杠被收敛', () => {
    const route = r('/vue@3.3.4//dist//vue.js');
    assert.equal(route.subPath, 'dist/vue.js');
  });
}

/* ------------------------------------------------------------------ */
/* 3. Content-Type                                                     */
/* ------------------------------------------------------------------ */

function testMime() {
  section('3. Content-Type 映射');

  check('题目明确要求 json 带 charset', () => {
    assert.equal(mime.lookup('package.json'), 'application/json; charset=utf-8');
  });

  check('js / css / html / md', () => {
    assert.equal(mime.lookup('dist/vue.js'), 'application/javascript; charset=utf-8');
    assert.equal(mime.lookup('style.css'), 'text/css; charset=utf-8');
    assert.equal(mime.lookup('index.html'), 'text/html; charset=utf-8');
    assert.equal(mime.lookup('README.md'), 'text/markdown; charset=utf-8');
  });

  check('二进制类型不带 charset', () => {
    assert.equal(mime.lookup('logo.png'), 'image/png');
    assert.equal(mime.lookup('font.woff2'), 'font/woff2');
    assert.equal(mime.lookup('mod.wasm'), 'application/wasm');
    assert.equal(mime.lookup('icon.svg'), 'image/svg+xml; charset=utf-8');
  });

  check('无扩展名文件按名字猜', () => {
    assert.equal(mime.lookup('LICENSE'), 'text/plain; charset=utf-8');
    assert.equal(mime.lookup('README'), 'text/markdown; charset=utf-8');
    assert.equal(mime.lookup('.gitignore'), 'text/plain; charset=utf-8');
  });

  check('未知扩展名回退 octet-stream', () => {
    assert.equal(mime.lookup('weird.zzz'), 'application/octet-stream');
  });
}

/* ------------------------------------------------------------------ */
/* 4. 入口解析                                                         */
/* ------------------------------------------------------------------ */

function testEntry() {
  section('4. 入口文件解析优先级');

  const exists = (set) => (p) => set.includes(p);

  check('规则 1：jsdelivr 字段优先', () => {
    const result = resolveEntry(
      { jsdelivr: 'dist/vue.global.js', exports: { '.': { default: './index.js' } }, main: 'index.js' },
      exists(['dist/vue.global.js', 'index.js']),
    );
    assert.deepEqual(result, { path: 'dist/vue.global.js', source: 'jsdelivr' });
  });

  check('规则 2：exports["."].default', () => {
    const result = resolveEntry(
      { exports: { '.': { default: './index.js' } }, main: 'legacy.js' },
      exists(['index.js', 'legacy.js']),
    );
    assert.deepEqual(result, { path: 'index.js', source: 'exports["."].default' });
  });

  check('规则 2：exports["."] 是字符串', () => {
    const result = resolveEntry({ exports: { '.': './lib/main.js' } }, exists(['lib/main.js']));
    assert.deepEqual(result, { path: 'lib/main.js', source: 'exports["."]' });
  });

  check('规则 3：exports["."] 无 default 时回退 main', () => {
    const result = resolveEntry(
      { exports: { '.': { import: './esm/index.mjs', require: './cjs/index.cjs' } }, main: 'lib/index.js' },
      exists(['lib/index.js']),
    );
    assert.deepEqual(result, { path: 'lib/index.js', source: 'main' });
  });

  check('规则 4：全不满足返回 null', () => {
    assert.equal(resolveEntry({ name: 'x' }, exists([])), null);
    assert.equal(resolveEntry({ main: 'missing.js' }, exists([])), null);
  });

  check('main 指向目录时按 index.js 兜底', () => {
    const result = resolveEntry({ main: 'lib' }, exists(['lib/index.js']));
    assert.deepEqual(result, { path: 'lib/index.js', source: 'main' });
  });

  check('路径归一化', () => {
    assert.equal(normalizeEntryPath('./dist/./vue.js'), 'dist/vue.js');
    assert.equal(normalizeEntryPath('/index.js'), 'index.js');
    assert.equal(normalizeEntryPath('../escape.js'), null);
  });
}

/* ------------------------------------------------------------------ */
/* 5. 压缩 / 打包的纯逻辑                                               */
/* ------------------------------------------------------------------ */

function testMinify() {
  section('5. JS 压缩器');
  const src = `// 顶部注释
/* 会被删掉的块注释 */
/*! 版权声明 @license MIT */
function add ( a, b ) {
  // 行内注释
  return a + b;   // 尾注释
}

const s = "字符串里的 // 不能被当成注释";
const re = /a\\/b/g;
const t = \`模板 \${ add(1, 2) } 结束\`;
`;

  const out = minifyJavaScript(src);

  check('删除普通注释', () => {
    assert.ok(!out.code.includes('会被删掉的块注释'));
    assert.ok(!out.code.includes('// 顶部注释'));
    assert.ok(!out.code.includes('行内注释'));
  });

  check('保留 @license 版权注释', () => {
    assert.ok(out.code.includes('@license MIT'));
  });

  check('字符串与正则内容不被破坏', () => {
    assert.ok(out.code.includes('"字符串里的 // 不能被当成注释"'));
    assert.ok(out.code.includes('re=/a\\/b/g'));
  });

  check('模板字符串按原样保留（内部不做压缩，保证语义安全）', () => {
    assert.ok(out.code.includes('`模板 ${ add(1, 2) } 结束`'), out.code);
  });

  check('体积确实变小', () => {
    assert.ok(out.minified < out.original, `${out.minified} 应小于 ${out.original}`);
    assert.ok(out.minified > 0);
  });

  check('压缩结果可被解析（语法仍然合法）', () => {
    // eslint-disable-next-line no-new-func
    new Function(out.code);
    assert.ok(true);
  });

  check('ASI 安全：不把换行吃掉导致语义变化', () => {
    const risky = 'let a = 1\n[b] = a\nfunction f(){ return\n{x:1} }\n';
    const min = minifyJavaScript(risky).code;
    // `let a = 1` 与 `[b] = a` 之间的换行必须保留，否则变成 `let a = 1[b] = a`
    assert.ok(min.includes('let a=1\n') || min.includes('let a = 1\n'), min);
    // `return` 后必须换行，否则返回值变化
    assert.ok(/return\s*\n/.test(min), min);
  });
}

function testBundleHelpers() {
  section('6. 打包器说明符扫描');

  check('识别 require / import / export-from', () => {
    const src = `
      const a = require('./a.js');
      import b from "./b.js";
      import { c } from './c.js';
      import * as d from 'dep';
      export { e } from './e.js';
      const f = require('fs');
    `;
    const { specifiers, hasEsm } = findSpecifiers(src);
    const specs = specifiers.map((s) => s.spec).sort();
    assert.deepEqual(specs, ['./a.js', './b.js', './c.js', './e.js', 'dep', 'fs']);
    assert.equal(hasEsm, true);
  });

  check('字符串/注释里的 require 不会被误判', () => {
    const src = `
      // require('./fake.js')
      const s = "require('./also-fake.js')";
      const real = require('./real.js');
    `;
    const { specifiers } = findSpecifiers(src);
    assert.deepEqual(specifiers.map((s) => s.spec), ['./real.js']);
  });

  check('scoped 包的裸说明符拆分', () => {
    assert.deepEqual(splitBareSpec('@vue/shared'), { name: '@vue/shared', subpath: '' });
    assert.deepEqual(splitBareSpec('@vue/shared/dist/a.js'), { name: '@vue/shared', subpath: 'dist/a.js' });
    assert.deepEqual(splitBareSpec('lodash/fp'), { name: 'lodash', subpath: 'fp' });
  });

  check('相对路径解析支持补扩展名与 index 兜底', () => {
    const files = new Set(['lib/a.js', 'lib/util/index.js', 'main.json']);
    const exists = (p) => files.has(p);
    assert.equal(resolveRelativeSpec('lib/a.js', './a.js', exists), 'lib/a.js');
    assert.equal(resolveRelativeSpec('lib/a.js', './util', exists), 'lib/util/index.js');
    assert.equal(resolveRelativeSpec('lib/a.js', '../main.json', exists), 'main.json');
    assert.equal(resolveRelativeSpec('lib/a.js', './missing', exists), null);
  });
}

function testRange() {
  section('7. HTTP Range 解析');

  check('bytes=0-99', () => {
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  });

  check('bytes=500- （到末尾）', () => {
    assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  });

  check('bytes=-100 （最后 100 字节）', () => {
    assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  });

  check('超范围返回 unsatisfiable', () => {
    assert.equal(parseRange('bytes=2000-3000', 1000), 'unsatisfiable');
  });

  check('非 Range 头返回 null', () => {
    assert.equal(parseRange('items=0-10', 1000), null);
  });
}

/* ------------------------------------------------------------------ */
/* 8. 端到端（需要网络）                                                */
/* ------------------------------------------------------------------ */

/** 发一个请求，返回 { status, headers, body:Buffer }。 */
function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 先探测网络是否可用。 */
async function hasNetwork() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://registry.npmjs.org/-/ping', { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function testEndToEnd(port) {
  section('8. 端到端（真实 npm registry）');

  await checkAsync('GET /_health', async () => {
    const res = await request(port, '/_health');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body.toString());
    assert.equal(payload.status, 'ok');
  });

  await checkAsync('GET / 返回服务首页', async () => {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.ok(res.body.includes('BYR Archive'));
  });

  await checkAsync('GET /lodash → 入口文件，Content-Type 正确', async () => {
    const res = await request(port, '/lodash');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/javascript/);
    assert.ok(res.body.length > 1000, `body 只有 ${res.body.length} 字节`);
    assert.ok(res.headers['x-byr-version'], '应带 x-byr-version');
  });

  await checkAsync('GET /vue@3.3.4/ → 目录列表 HTML', async () => {
    const res = await request(port, '/vue@3.3.4/');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /text\/html/);
    const html = res.body.toString();
    assert.ok(html.includes('<!DOCTYPE HTML>'));
    assert.ok(html.includes('package.json'));
    assert.ok(html.includes('README.md'));
  });

  await checkAsync('GET /vue@3.3.4/dist/vue.runtime.esm-browser.js → 文件内容', async () => {
    const res = await request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /javascript/);
    assert.ok(res.body.includes('Vue'));
  });

  await checkAsync('GET /vue@3.3.4/package.json → json Content-Type', async () => {
    const res = await request(port, '/vue@3.3.4/package.json');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    const pkg = JSON.parse(res.body.toString());
    assert.equal(pkg.name, 'vue');
  });

  await checkAsync('GET /vue@3.3.4/ → 入口字段为 jsdelivr（vue 有该字段）', async () => {
    const res = await request(port, '/vue@3.3.4');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['x-byr-entry']), /jsdelivr/);
  });

  await checkAsync('GET /react → 走 exports["."].default', async () => {
    const res = await request(port, '/react');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['x-byr-entry']), /exports/);
    assert.ok(String(res.headers['x-byr-entry']).endsWith('index.js (exports["."].default)'));
  });

  await checkAsync('semver 范围 /vue@^3.2.0/ 解析到 3.x 最高版本', async () => {
    const res = await request(port, '/vue@%5E3.2.0/');
    assert.equal(res.status, 200);
    const version = String(res.headers['x-byr-version']);
    assert.ok(version.startsWith('3.'), `解析到 ${version}`);
    assert.equal(res.headers['x-byr-resolution'], 'range');
  });

  await checkAsync('dist-tag /vue@beta/package.json', async () => {
    const res = await request(port, '/vue@beta/package.json');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['x-byr-resolution']), /dist-tag/);
    const pkg = JSON.parse(res.body.toString());
    assert.match(pkg.version, /^\d+\.\d+\.\d+-/);
  });

  await checkAsync('范围解析结果与 exact 请求落到同一版本', async () => {
    const ranged = await request(port, '/vue@%5E3.2.0/');
    const version = String(ranged.headers['x-byr-version']);
    const exact = await request(port, `/vue@${version}/package.json`);
    assert.equal(exact.status, 200);
    assert.equal(exact.headers['x-byr-version'], version);
    assert.equal(exact.headers['x-byr-resolution'], 'exact');
  });

  await checkAsync('404：不存在的包', async () => {
    const res = await request(port, '/this-package-definitely-does-not-exist-byr/');
    assert.equal(res.status, 404);
  });

  await checkAsync('404：不存在的版本', async () => {
    const res = await request(port, '/vue@0.0.1-byr-not-exist/');
    assert.equal(res.status, 404);
  });

  await checkAsync('404：不存在的包内文件', async () => {
    const res = await request(port, '/vue@3.3.4/nope/nothing.js');
    assert.equal(res.status, 404);
  });

  await checkAsync('目录穿越被拒绝', async () => {
    const res = await request(port, '/vue@3.3.4/..%2f..%2fetc%2fpasswd');
    assert.ok(res.status === 404 || res.status === 400 || res.status === 403, `实际 ${res.status}`);
  });

  await checkAsync('压缩：gzip 后体积更小且 Content-Encoding 正确', async () => {
    const plain = await request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { headers: { 'accept-encoding': 'identity' } });
    const gz = await request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(plain.status, 200);
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(gz.body.length < plain.body.length, `${gz.body.length} 应小于 ${plain.body.length}`);
  });

  await checkAsync('brotli 优先级高于 gzip', async () => {
    const res = await request(port, '/vue@3.3.4/dist/vue.runtime.esm-browser.js', {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    assert.equal(res.headers['content-encoding'], 'br');
  });

  await checkAsync('ETag + If-None-Match → 304', async () => {
    const first = await request(port, '/vue@3.3.4/package.json');
    const etag = first.headers.etag;
    assert.ok(etag, '应返回 ETag');
    const second = await request(port, '/vue@3.3.4/package.json', {
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal(second.body.length, 0);
  });

  await checkAsync('Range 请求返回 206 与正确的 Content-Range', async () => {
    const full = await request(port, '/vue@3.3.4/package.json');
    const partial = await request(port, '/vue@3.3.4/package.json', {
      headers: { range: 'bytes=0-9' },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.body.length, 10);
    assert.equal(partial.headers['content-range'], `bytes 0-9/${full.body.length}`);
    assert.deepEqual(partial.body, full.body.subarray(0, 10));
  });

  await checkAsync('CORS 头存在', async () => {
    const res = await request(port, '/vue@3.3.4/package.json');
    assert.equal(res.headers['access-control-allow-origin'], '*');
  });

  await checkAsync('HEAD 请求只有头没有体', async () => {
    const res = await request(port, '/vue@3.3.4/package.json', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 0);
    assert.ok(Number(res.headers['content-length']) > 0);
  });

  await checkAsync('二次请求命中缓存（x-byr-cache: memory）', async () => {
    await request(port, '/lodash@4.17.21/lodash.js');
    const res = await request(port, '/lodash@4.17.21/lodash.js');
    assert.equal(res.headers['x-byr-cache'], 'memory');
  });

  await checkAsync('?min 即时压缩：体积变小、语法仍合法', async () => {
    const raw = await request(port, '/lodash@4.17.21/lodash.js', {
      headers: { 'accept-encoding': 'identity' },
    });
    const min = await request(port, '/lodash@4.17.21/lodash.js?min', {
      headers: { 'accept-encoding': 'identity' },
    });
    assert.equal(min.headers['x-byr-minified'], 'true');
    assert.ok(min.body.length < raw.body.length, `${min.body.length} 应小于 ${raw.body.length}`);
    // 语法必须仍然可解析
    new Function(min.body.toString());
  });

  await checkAsync('.min.js 缺失时回退到未压缩文件并即时压缩', async () => {
    // vue@3.3.4 的 dist 里有 vue.global.js 但没有 vue.global.min.js
    const res = await request(port, '/vue@3.3.4/dist/vue.global.min.js', {
      headers: { 'accept-encoding': 'identity' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-byr-minified'], 'true');
  });

  await checkAsync('?bundle 内联多个模块为单文件', async () => {
    const res = await request(port, '/axios@1.6.0/lib/axios.js?bundle');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /javascript/);
    const mode = String(res.headers['x-byr-bundle']);
    const modules = Number(res.headers['x-byr-bundle-modules'] ?? 0);
    assert.ok(['inline-cjs', 'rewrite'].includes(mode), `mode=${mode}`);
    if (mode === 'inline-cjs') {
      assert.ok(modules > 3, `内联模块数应大于 3，实际 ${modules}`);
      assert.ok(res.body.toString().includes('__defs'), '应包含模块表');
    }
  });

  await checkAsync('?esm 重写说明符为服务自身绝对 URL', async () => {
    const res = await request(port, '/axios@1.6.0/index.js?esm');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-byr-bundle'], 'rewrite');
    assert.ok(res.body.toString().includes('mode=rewrite'));
  });

  await checkAsync('jsDelivr 兼容前缀 /npm/ 生效', async () => {
    const res = await request(port, '/npm/vue@3.3.4/package.json');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-byr-url-style'], 'jsdelivr');
  });

  await checkAsync('scoped 包端到端', async () => {
    const res = await request(port, '/@vue/shared@3.4.21/package.json');
    assert.equal(res.status, 200);
    const pkg = JSON.parse(res.body.toString());
    assert.equal(pkg.name, '@vue/shared');
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  process.stdout.write('\x1b[1mBYR Archive 测试套件\x1b[0m\n');

  testSemver();
  testRouter();
  testMime();
  testEntry();
  testMinify();
  testBundleHelpers();
  testRange();

  const online = await hasNetwork();
  if (!online) {
    process.stdout.write('\n\x1b[33m⚠ 检测不到外网，跳过端到端用例（单元用例已全部执行）\x1b[0m\n');
  } else {
    const server = await start({ port: 0, host: '127.0.0.1' });
    const { port } = server.address();
    process.stdout.write(`\n(测试服务监听 127.0.0.1:${port})\n`);
    try {
      await testEndToEnd(port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  process.stdout.write(
    `\n\x1b[1m结果:\x1b[0m \x1b[32m${passed} 通过\x1b[0m` +
      (failed ? `, \x1b[31m${failed} 失败\x1b[0m` : '') +
      '\n',
  );

  if (failed > 0) {
    process.stdout.write('\n失败详情:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`测试运行失败: ${err.stack}\n`);
  process.exitCode = 1;
});
