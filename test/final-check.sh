#!/usr/bin/env bash
#
# BYR Archive 最终验收（一键跑完需要「真实环境」的两层）
#
#   test/live-check.sh  要求有一个**已经在跑**的服务 → 本脚本负责起这个服务
#   真实浏览器验证      同样要求服务在跑 → 本脚本负责起这个服务
#
# 一条命令完成：
#   1. 启动一个真实的服务进程（独立进程，不是进程内起）
#   2. 等它就绪（带超时，失败会把服务日志打出来）
#   3. 跑 test/live-check.sh（纯 curl 打真实 TCP）
#   4. 跑真实浏览器验证（Chrome 无头，渲染 + 执行 JS）
#   5. 无论成功失败都停掉服务（trap EXIT）
#
# 用法：
#   bash test/final-check.sh
#   PORT=19000 bash test/final-check.sh
#   CHROME_BIN="/path/to/chrome" bash test/final-check.sh
#   NODE_BIN="/path/to/node" bash test/final-check.sh
#
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-18080}"
BASE="http://127.0.0.1:${PORT}"
LOG="${TMPDIR:-/tmp}/byr-final-check-server.log"

# ---- 找 Node ----------------------------------------------------------
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  for candidate in node "$(command -v node 2>/dev/null)"; do
    if [ -n "$candidate" ] && "$candidate" -e "0" >/dev/null 2>&1; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  printf '找不到可用的 Node，请用 NODE_BIN 指定绝对路径\n' >&2
  exit 2
fi

# ---- 找 Chrome --------------------------------------------------------
CHROME_BIN="${CHROME_BIN:-}"
if [ -z "$CHROME_BIN" ]; then
  for candidate in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CHROME_BIN="$candidate"
      break
    fi
  done
fi

# ---- 路径转换 ----------------------------------------------------------
#
# Git Bash 里的 $ROOT 是 msys 风格（/d/BYR Archive），而 Chrome 是原生 Windows 程序，
# 它不认这种路径 —— 直接传进去会静默失败（截图不生成、--dump-dom 输出为空）。
# 所以给 Chrome 用的路径必须转成 Windows 风格（D:/BYR Archive）。
#
# 这个坑很隐蔽：命令返回 0、stderr 被 2>/dev/null 吞掉，只剩下一个 0 字节的输出文件。
ROOT_FOR_CHROME="$(command -v cygpath >/dev/null 2>&1 && cygpath -m "$ROOT" || printf '%s' "$ROOT")"

printf '\033[1mBYR Archive 最终验收\033[0m\n'
printf '项目目录 %s\n' "$ROOT"
printf 'Node     %s\n' "$NODE_BIN"
printf 'Chrome   %s\n' "${CHROME_BIN:-（未找到，将跳过浏览器层）}"
printf '浏览器路径 %s\n' "${CHROME_BIN:-（未找到）}"
printf '地址     %s\n' "$BASE"

SRV_PID=""

cleanup() {
  if [ -n "$SRV_PID" ]; then
    printf '\n\033[1m停止服务进程\033[0m (pid=%s)\n' "$SRV_PID"
    kill "$SRV_PID" 2>/dev/null
    # 等它真的退出，最多 5 秒
    for _ in $(seq 1 10); do
      kill -0 "$SRV_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$SRV_PID" 2>/dev/null
    SRV_PID=""
  fi
}
trap cleanup EXIT INT TERM

# ---- 1. 启动服务 ------------------------------------------------------
printf '\n\033[1m启动服务（独立进程）\033[0m\n'

# 用 `exec` 让子 shell 变成 node 进程本身，这样 $! 拿到的就是 node 的 PID，
# 而不是子 shell 的 PID —— 否则 kill $! 杀不掉真正的服务进程。
( cd "$ROOT" && exec env "PORT=$PORT" "LOG_LEVEL=info" "$NODE_BIN" src/index.js ) > "$LOG" 2>&1 &
SRV_PID=$!

READY=0
for _ in $(seq 1 60); do
  if curl -sf --noproxy '*' -m 2 -o /dev/null "$BASE/_health"; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ "$READY" -ne 1 ]; then
  printf '\033[31m服务在 30 秒内未就绪，日志：\033[0m\n' >&2
  tail -30 "$LOG" >&2
  exit 1
fi
printf '已就绪 pid=%s（日志 %s）\n' "$SRV_PID" "$LOG"

FAILED=0

# ---- 2. 真实客户端验收 ------------------------------------------------
printf '\n\033[1m① 真实客户端验收（curl 打独立进程）\033[0m\n'
if bash "$ROOT/test/live-check.sh" "$BASE" > "$ROOT/docs/live-check-output.txt" 2>&1; then
  grep -E '合计|^\[|PASS ·' "$ROOT/docs/live-check-output.txt" | tail -2
  tail -3 "$ROOT/docs/live-check-output.txt"
else
  printf '\033[31m真实客户端验收未通过\033[0m（详见 docs/live-check-output.txt）\n'
  tail -20 "$ROOT/docs/live-check-output.txt"
  FAILED=1
fi

# ---- 3. 真实浏览器验收 ------------------------------------------------
printf '\n\033[1m② 真实浏览器验收（Chrome 无头）\033[0m\n'
if [ -z "$CHROME_BIN" ]; then
  printf '\033[33m跳过：未找到 Chrome/Edge。可用 CHROME_BIN=... 指定路径\033[0m\n'
else
  if timeout 180 "$CHROME_BIN" \
      --headless=new --disable-gpu --no-sandbox \
      --virtual-time-budget=25000 --window-size=1000,1400 \
      --screenshot="$ROOT_FOR_CHROME/docs/browser-verify.png" \
      --dump-dom "file:///$ROOT_FOR_CHROME/docs/browser-demo.html" \
      > "$ROOT/docs/browser-verify-dom.html" 2>"$LOG.chrome"
  then
    if [ ! -s "$ROOT/docs/browser-verify-dom.html" ]; then
      printf '\033[31mChrome 返回成功但输出为空，stderr：\033[0m\n'
      tail -5 "$LOG.chrome"
    fi
    SUMMARY="$(grep -o '浏览器端验证：[0-9]*/[0-9]* 项通过' "$ROOT/docs/browser-verify-dom.html" | head -1)"
    if [ -n "$SUMMARY" ]; then
      printf '  %s\n' "$SUMMARY"
      # 只要不是 N/N 就算失败
      PASSED="$(printf '%s' "$SUMMARY" | sed -E 's/.*：([0-9]+)\/([0-9]+).*/\1/')"
      TOTAL="$(printf '%s' "$SUMMARY" | sed -E 's/.*：([0-9]+)\/([0-9]+).*/\2/')"
      [ "$PASSED" = "$TOTAL" ] || FAILED=1
    else
      printf '\033[31m未能从渲染结果里读到结论（docs/browser-verify-dom.html 可能为空）\033[0m\n'
      FAILED=1
    fi
    printf '  截图 docs/browser-verify.png\n'
  else
    printf '\033[31mChrome 执行失败\033[0m\n'
    FAILED=1
  fi
fi

# ---- 汇总 -------------------------------------------------------------
printf '\n%s\n' '════════════════════════════════════════════════════════════════════════════'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[1m最终验收：需要真实环境的两层全部通过\033[0m\n'
else
  printf '\033[1m\033[31m最终验收：存在失败项\033[0m\n'
fi
printf '%s\n' '════════════════════════════════════════════════════════════════════════════'

exit "$FAILED"
