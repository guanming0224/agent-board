#!/bin/sh
# dev 實例（docs/release-update-spec.md §8、CONTRACTS §21.6）：從工作目錄（不是發布檔）跑一套獨立的
# hub＋session host＋daemon，和正式版完全分開：
#   - hub 只綁 127.0.0.1:8024（AGENT_BOARD_DEV_PORT 可改）；要從別台看就自己 `tailscale serve` 另一個埠（不自動做）
#   - 資料夾 ~/.agent-board-dev（AGENT_BOARD_DEV_DIR 可改），機器名稱加 -dev
#   - 不建 launchd／工作排程器、不推播、不查新版、不自動更新（daemon 沒有 AGENT_BOARD_INSTALL_ROOT）
#
#   sh scripts/dev-instance.sh start          啟動（已在跑的不重複啟動）
#   sh scripts/dev-instance.sh pair <配對碼>  第一次：瀏覽器開 http://127.0.0.1:8024 建帳號、產生配對碼，再執行這個
#   sh scripts/dev-instance.sh stop           停止（session host 也停，dev 的 agent 會結束）
#   sh scripts/dev-instance.sh status         各程序在不在、hub 版本
#
# 正式版只從 tag 的 Release 更新；不要從畫布裡的 session 部署自己（派工單 §14.6）。
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
dir="${AGENT_BOARD_DEV_DIR:-$HOME/.agent-board-dev}"
port="${AGENT_BOARD_DEV_PORT:-8024}"
host=127.0.0.1
tsx="$repo/node_modules/.bin/tsx"
logs="$dir/logs"
name="${AGENT_BOARD_DEV_NAME:-$(hostname -s 2>/dev/null || hostname)-dev}"

die() {
  printf 'dev-instance: %s\n' "$1" >&2
  exit 1
}

[ -x "$tsx" ] || die "找不到 $tsx，先在 repo 根目錄執行 corepack pnpm install"
case "$dir" in
  "$HOME/.agent-board" | "$HOME/.agent-board/"*) die "資料夾不能是正式版的 ~/.agent-board" ;;
esac
[ "$port" != 8787 ] || die "埠不能是正式版的 8787"

pid_alive() {
  [ -f "$dir/$1.pid" ] && kill -0 "$(cat "$dir/$1.pid")" 2>/dev/null
}

# 只帶 dev 需要的環境：正式版服務的設定（AGENT_BOARD_*）一律不繼承。
dev_env() {
  env -u AGENT_BOARD_HUB_URL -u AGENT_BOARD_MACHINE_TOKEN -u AGENT_BOARD_INSTALL_ROOT \
    -u AGENT_BOARD_SESSION_HOST_SERVICE -u AGENT_BOARD_HOOK_BIN -u AGENT_BOARD_MCP_SERVER \
    AGENT_BOARD_DATA_DIR="$dir" "$@"
}

start_one() {
  role=$1
  shift
  if pid_alive "$role"; then
    printf '%s 已在跑（pid %s）\n' "$role" "$(cat "$dir/$role.pid")"
    return 0
  fi
  # 新的 process group（setsid 不一定有，用 node 的 detached），關掉這個終端機也不會被帶走。
  dev_env node -e "
    const { spawn } = require('node:child_process');
    const { openSync } = require('node:fs');
    const out = openSync(process.argv[1], 'a', 0o600);
    const child = spawn(process.argv[2], process.argv.slice(3), { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    console.log(child.pid);
  " "$logs/$role.log" "$@" >"$dir/$role.pid"
  printf '%s 已啟動（pid %s，紀錄 %s）\n' "$role" "$(cat "$dir/$role.pid")" "$logs/$role.log"
}

stop_one() {
  role=$1
  if pid_alive "$role"; then
    kill "$(cat "$dir/$role.pid")" 2>/dev/null || true
    i=0
    while pid_alive "$role" && [ "$i" -lt 50 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    pid_alive "$role" && kill -9 "$(cat "$dir/$role.pid")" 2>/dev/null || true
    printf '%s 已停止\n' "$role"
  fi
  rm -f "$dir/$role.pid"
}

wait_hub() {
  i=0
  while [ "$i" -lt 100 ]; do
    curl -fsS "http://$host:$port/api/health" >/dev/null 2>&1 && return 0
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

command=${1:-status}
mkdir -p "$logs"
chmod 700 "$dir"

case "$command" in
  start)
    AGENT_BOARD_PORT=$port AGENT_BOARD_HOST=$host AGENT_BOARD_DISABLE_PUSH=1 \
      AGENT_BOARD_DISABLE_RELEASE_CHECK=1 start_one hub "$tsx" "$repo/packages/hub/src/main.ts"
    wait_hub || die "hub 沒有在 20 秒內回應，看 $logs/hub.log"
    start_one session-host "$tsx" "$repo/packages/session-host/src/main.ts"
    if [ -f "$dir/machine.json" ]; then
      AGENT_BOARD_MACHINE_NAME=$name start_one daemon "$tsx" "$repo/packages/daemon/src/index.ts"
    else
      printf '還沒配對：瀏覽器開 http://%s:%s 建帳號、到設定產生配對碼，再執行：\n  sh %s pair <配對碼>\n' \
        "$host" "$port" "$0"
    fi
    ;;
  pair)
    [ $# -ge 2 ] || die "用法：dev-instance.sh pair <配對碼>"
    AGENT_BOARD_MACHINE_NAME=$name dev_env "$tsx" "$repo/packages/daemon/src/index.ts" pair \
      --hub "http://$host:$port" --code "$2"
    AGENT_BOARD_MACHINE_NAME=$name start_one daemon "$tsx" "$repo/packages/daemon/src/index.ts"
    ;;
  stop)
    stop_one daemon
    stop_one session-host
    stop_one hub
    ;;
  status)
    for role in hub session-host daemon; do
      if pid_alive "$role"; then
        printf '%-13s 在跑（pid %s）\n' "$role" "$(cat "$dir/$role.pid")"
      else
        printf '%-13s 沒有在跑\n' "$role"
      fi
    done
    health=$(curl -fsS "http://$host:$port/api/health" 2>/dev/null || true)
    [ -n "$health" ] && printf 'hub http://%s:%s %s\n' "$host" "$port" "$health"
    printf '資料夾 %s，機器名稱 %s\n' "$dir" "$name"
    ;;
  *)
    die "用法：dev-instance.sh start|pair <配對碼>|stop|status"
    ;;
esac
