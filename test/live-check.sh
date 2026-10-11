#!/usr/bin/env bash
#
# BYR Archive 真实可用性验收（live check）
#
# 与 test/smoke.mjs、test/acceptance.mjs 的区别：
#   那两个脚本在**同一进程内**起服务、发请求；
#   本脚本用 curl 打**一个已经独立运行的进程**，走真实的 TCP / HTTP 栈，
#   是「服务真的部署起来了吗」这一层的证据。
#
# 用法：
#   bash test/live-check.sh                        # 默认 http://127.0.0.1:8080
#   bash test/live-check.sh http://127.0.0.1:18080 # 指定地址
#
# 注意：本机若有 HTTP 代理，必须加 --noproxy（脚本已内置）。
#
set -u

BASE="${1:-http://127.0.0.1:8080}"
CURL="curl -s --noproxy '*' --max-time 60"
PASS=0
FAIL=0
WARN=0

# 彩色输出（管道重定向时自动失效）
if [ -t 1 ]; then
  G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; B=$'\033[1m'; N=$'\033[0m'
else
  G=''; R=''; Y=''; B=''; N=''
fi

section() { printf '\n%s%s%s\n' "$B" "$1" "$N"; printf '%s\n' "────────────────────────────────────────────────────────────────────────────"; }
note()    { printf '  %s\n' "$1"; }

# 断言：期望的状态码（第 4 个参数是 method，第 5 个及之后原样传给 curl）
expect_status() {
  local label="$1" path="$2" want="$3" method="${4:-GET}"
  shift 4 2>/dev/null || shift $#
  local got
  got=$($CURL "$@" -o /dev/null -w '%{http_code}' -X "$method" "$BASE$path")
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  [%sPASS%s] %-58s %s\n' "$G" "$N" "$label" "$got"
  else
    FAIL=$((FAIL + 1)); printf '  [%sFAIL%s] %-58s 期望 %s 实际 %s\n' "$R" "$N" "$label" "$want" "$got"
  fi
}

# 断言：响应头包含指定值（第 5 个及之后的参数原样传给 curl，例如请求头）
expect_header() {
  local label="$1" path="$2" header="$3" want="$4"
  shift 4
  local got
  got=$($CURL "$@" -D - -o /dev/null "$BASE$path" | tr -d '\r' | awk -F': ' -v h="$header" 'tolower($1)==tolower(h){print $2; exit}')
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  [%sPASS%s] %-58s %s\n' "$G" "$N" "$label" "$got"
  elif [ -n "$got" ]; then
    WARN=$((WARN + 1)); printf '  [%sWARN%s] %-58s 期望 %s 实际 %s\n' "$Y" "$N" "$label" "$want" "$got"
  else
    FAIL=$((FAIL + 1)); printf '  [%sFAIL%s] %-58s 缺少 %s 头\n' "$R" "$N" "$label" "$header"
  fi
}

# 断言：正文匹配正则
expect_body() {
  local label="$1" path="$2" pattern="$3"
  local body
  body=$($CURL "$BASE$path" | head -c 200000)
  if printf '%s' "$body" | grep -Eq -- "$pattern"; then
    PASS=$((PASS + 1)); printf '  [%sPASS%s] %-58s 匹配 /%s/\n' "$G" "$N" "$label" "$pattern"
  else
    FAIL=$((FAIL + 1)); printf '  [%sFAIL%s] %-58s 未匹配 /%s/\n' "$R" "$N" "$label" "$pattern"
  fi
}

# 断言：正文长度大于阈值
expect_size_gt() {
  local label="$1" path="$2" min="$3"
  local size
  size=$($CURL "$BASE$path" | wc -c | tr -d ' ')
  if [ "$size" -gt "$min" ]; then
    PASS=$((PASS + 1)); printf '  [%sPASS%s] %-58s %s 字节\n' "$G" "$N" "$label" "$size"
  else
    FAIL=$((FAIL + 1)); printf '  [%sFAIL%s] %-58s 仅 %s 字节（期望 > %s）\n' "$R" "$N" "$label" "$size" "$min"
  fi
}

printf '%sBYR Archive 真实可用性验收%s\n' "$B" "$N"
printf '目标：%s\n' "$BASE"
printf '时间：%s\n' "$(date '+%Y-%m-%d %H:%M:%S')"

# ====================================================================
section '0. 服务存活与版本'
# ====================================================================
expect_status 'GET /_health' '/_health' 200
expect_body   '/_health 返回 status=ok' '/_health' '"status": "ok"'
note ""
note "服务进程信息："
$CURL "$BASE/_health" | sed 's/^/    /' | head -8

# ====================================================================
section '1. 入口文件解析（题面规则 1~3）'
# ====================================================================
expect_status 'GET /lodash  → 入口文件' '/lodash' 200
expect_header '  命中规则 main'          '/lodash' 'x-byr-entry' 'lodash.js (main)'
expect_header '  Content-Type 正确'      '/lodash' 'content-type' 'application/javascript; charset=utf-8'

expect_status 'GET /react   → 入口文件' '/react' 200
expect_header '  命中规则 exports["."].default' '/react' 'x-byr-entry' 'index.js (exports["."].default)'

expect_status 'GET /vue@3.3.4 → 入口文件' '/vue@3.3.4' 200
expect_header '  命中规则 jsdelivr'       '/vue@3.3.4' 'x-byr-entry' 'dist/vue.global.js (jsdelivr)'

# ====================================================================
section '2. 目录列表（题面要求 nginx 风格）'
# ====================================================================
expect_status 'GET /vue@3.3.4/   → 目录列表' '/vue@3.3.4/' 200
expect_body   '  是 HTML 文档'                 '/vue@3.3.4/' '<!DOCTYPE HTML>'
expect_body   '  列出 package.json'            '/vue@3.3.4/' 'package.json'
expect_body   '  列出 README.md'               '/vue@3.3.4/' 'README.md'
expect_body   '  标注入口文件（入口在 dist/ 下）' '/vue@3.3.4/dist/' '>entry<'
expect_status 'GET /vue@3.3.4/dist/ → 子目录'  '/vue@3.3.4/dist/' 200

# ====================================================================
section '3. 直接访问文件 + Content-Type'
# ====================================================================
expect_status 'GET package.json'          '/vue@3.3.4/package.json' 200
expect_header '  json 必须带 charset'      '/vue@3.3.4/package.json' 'content-type' 'application/json; charset=utf-8'
expect_header '  是精确版本 → immutable'   '/vue@3.3.4/package.json' 'cache-control' 'public, max-age=31536000, immutable'
expect_size_gt 'GET dist/vue.runtime.esm-browser.js' '/vue@3.3.4/dist/vue.runtime.esm-browser.js' 100000
expect_status 'GET README.md'             '/vue@3.3.4/README.md' 200

# ====================================================================
section '4. 版本解析（可选加分项 1）'
# ====================================================================
expect_status 'GET /vue@%5E3.2.0/package.json（semver 范围）' '/vue@%5E3.2.0/package.json' 200
expect_header '  解析方式为 range'     '/vue@%5E3.2.0/package.json' 'x-byr-resolution' 'range'
expect_body   '  解析到 3.x'           '/vue@%5E3.2.0/package.json' '"version": "3\.'
expect_status 'GET /vue@beta/package.json（dist-tag）' '/vue@beta/package.json' 200
expect_header '  解析方式为 dist-tag'  '/vue@beta/package.json' 'x-byr-resolution' 'dist-tag:beta'
expect_status 'GET /vue@3.3.4/package.json（精确版本）' '/vue@3.3.4/package.json' 200
expect_header '  解析方式为 exact'     '/vue@3.3.4/package.json' 'x-byr-resolution' 'exact'

# ====================================================================
section '5. 缓存（可选加分项 2）'
# ====================================================================
note '  连续三次请求同一文件，比较总耗时（%{time_total}）：'
for i in 1 2 3; do
  T=$($CURL -o /dev/null -w '%{time_total}' "$BASE/vue@3.3.4/dist/vue.runtime.esm-browser.js")
  note "    第 ${i} 次 ${T}s"
done
expect_header '  第二次命中内存缓存' '/vue@3.3.4/dist/vue.runtime.esm-browser.js' 'x-byr-cache' 'memory'
note ""
note "  缓存统计（来自 /_stats）："
$CURL "$BASE/_stats" | head -c 4000 | grep -E '"hitRate"|"entries"|"bytes"|"maxBytes"|"peakActive"|"limit"' | sed 's/^/    /' | head -8

# ====================================================================
section '6. 压缩与打包（可选加分项 3）'
# ====================================================================
expect_header '?min → 服务端压缩生效' '/lodash@4.17.21/lodash.js?min' 'x-byr-minified' 'true'
expect_size_gt '?min 产物非空'        '/lodash@4.17.21/lodash.js?min' 50000

S_RAW=$($CURL -H 'accept-encoding: identity' "$BASE/lodash@4.17.21/lodash.js" | wc -c | tr -d ' ')
S_MIN=$($CURL -H 'accept-encoding: identity' "$BASE/lodash@4.17.21/lodash.js?min" | wc -c | tr -d ' ')
S_GZ=$($CURL -H 'accept-encoding: gzip' "$BASE/lodash@4.17.21/lodash.js?min" | wc -c | tr -d ' ')
note ""
note "  lodash.js 体积变化：原始 ${S_RAW} → ?min ${S_MIN} → +gzip ${S_GZ} 字节"

expect_header 'gzip 内容协商' '/vue@3.3.4/package.json' 'content-encoding' 'gzip' -H 'accept-encoding: gzip'
expect_header 'brotli 内容协商（优先级高于 gzip）' '/vue@3.3.4/package.json' 'content-encoding' 'br' -H 'accept-encoding: gzip, br'
expect_header 'brotli 优先于 gzip' '/vue@3.3.4/package.json' 'vary' 'accept-encoding'
expect_status '?bundle （包内内联）' '/mime@3.0.0/index.js?bundle' 200
expect_header '  模式 inline-cjs'     '/mime@3.0.0/index.js?bundle' 'x-byr-bundle' 'inline-cjs'
expect_status '?bundle=deep（跨包内联）' '/express@4.18.2/lib/express.js?bundle=deep' 200
expect_header '  模式 deep-inline-cjs' '/express@4.18.2/lib/express.js?bundle=deep' 'x-byr-bundle' 'deep-inline-cjs'
expect_header '  ?esm 重写模式' '/axios@1.6.0/lib/axios.js?esm' 'x-byr-bundle' 'rewrite'
expect_header '  ?esm 是传递式重写' '/axios@1.6.0/lib/axios.js?esm' 'x-byr-esm-transitive' 'true'
expect_body   '  重写出的 URL 带 ?esm' '/nanoid@5.0.4/index.browser.js?esm' "/npm/nanoid@5\.0\.4/url-alphabet/index\.js\?esm"
expect_body   '  产物横幅写明已知边界' '/axios@1.6.0/lib/axios.js?esm' '已知边界'

# ====================================================================
section '7. jsDelivr 兼容前缀与 scoped 包'
# ====================================================================
expect_status 'GET /npm/vue@3.3.4/package.json' '/npm/vue@3.3.4/package.json' 200
expect_header '  标记为 jsdelivr 风格' '/npm/vue@3.3.4/package.json' 'x-byr-url-style' 'jsdelivr'
expect_status 'GET /@vue/shared@3.4.21/package.json' '/@vue/shared@3.4.21/package.json' 200
expect_body   '  scoped 包内容正确' '/@vue/shared@3.4.21/package.json' '"name": "@vue/shared"'

# ====================================================================
section '8. HTTP 语义'
# ====================================================================
ETAG=$($CURL -D - -o /dev/null "$BASE/vue@3.3.4/package.json" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}')
note "  ETag = $ETAG"
expect_status 'If-None-Match → 304' '/vue@3.3.4/package.json' 304 GET -H "if-none-match: $ETAG"
expect_status 'Range: bytes=0-99 → 206' '/vue@3.3.4/package.json' 206 GET -H 'range: bytes=0-99'
expect_header '  Content-Range 正确' '/vue@3.3.4/package.json' 'content-range' 'bytes 0-99/2592' -H 'range: bytes=0-99'
expect_status 'Range 越界 → 416' '/vue@3.3.4/package.json' 416 GET -H 'range: bytes=999999-'
expect_status 'HEAD 请求' '/vue@3.3.4/package.json' 200 HEAD
expect_header 'CORS 允许任意来源' '/vue@3.3.4/package.json' 'access-control-allow-origin' '*'
expect_header 'nosniff 安全头' '/vue@3.3.4/package.json' 'x-content-type-options' 'nosniff'
expect_header '列表页有 CSP' '/vue@3.3.4/' 'content-security-policy' "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
expect_status 'OPTIONS 预检 → 204' '/vue@3.3.4/package.json' 204 OPTIONS
expect_status 'PUT → 405' '/vue@3.3.4/package.json' 405 PUT

# ====================================================================
section '9. 错误处理'
# ====================================================================
expect_status '不存在的包 → 404' '/this-pkg-does-not-exist-byr/' 404
expect_status '不存在的版本 → 404' '/vue@0.0.1-byr-nope/' 404
expect_status '不存在的文件 → 404' '/vue@3.3.4/nope/none.js' 404
expect_status '目录穿越 → 404' '/vue@3.3.4/../../../etc/passwd' 404
expect_status '非法包名 → 400' '/-/' 400

# ====================================================================
section '10. 运维与程序接口'
# ====================================================================
expect_status 'GET /_stats' '/_stats' 200
expect_status 'GET /_metrics（Prometheus）' '/_metrics' 200
expect_body   '  含 HTTP 请求指标' '/_metrics' 'byr_http_requests_total'
expect_body   '  含事件循环延迟' '/_metrics' 'byr_event_loop_lag_seconds'
expect_status 'GET /_api/vue@3.3.4' '/_api/vue@3.3.4' 200
expect_body   '  含版本解析方式' '/_api/vue@3.3.4' '"how": "exact"'
expect_body   '  含入口命中规则' '/_api/vue@3.3.4' 'jsdelivr'
expect_status 'GET /_api/vue@3.3.4/tree' '/_api/vue@3.3.4/tree' 200
expect_status 'GET /_api/vue@3.3.4/dir/dist' '/_api/vue@3.3.4/dir/dist' 200
expect_status 'GET /_api/vue@3.3.4/file/dist/vue.global.js' '/_api/vue@3.3.4/file/dist/vue.global.js' 200

# ====================================================================
printf '\n%s\n' '════════════════════════════════════════════════════════════════════════════'
printf '%s合计%s  %s%d PASS%s · %s%d FAIL%s · %s%d WARN%s\n' \
  "$B" "$N" "$G" "$PASS" "$N" "$R" "$FAIL" "$N" "$Y" "$WARN" "$N"
printf '%s\n' '════════════════════════════════════════════════════════════════════════════'

[ "$FAIL" -eq 0 ] || exit 1
