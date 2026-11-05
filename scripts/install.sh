#!/bin/sh
# Agent Board 安裝腳本（macOS、Linux）。不需要 root，只寫使用者目錄，不送出任何資料。
#
#   sh install.sh hub [--port 8787] [--host IP]
#   sh install.sh daemon --hub 'https://hub.example' --code ABCD-1234 [--name 機器名稱]
#   sh install.sh --uninstall [--purge]
#
# 其他選項：--from <發布檔.tar.gz 或資料夾>、--claude-bin <路徑>、--repair、--no-service、--no-start
# 可重複執行：內容沒變就不重裝、不重啟服務。
set -eu

MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18
RELEASE_URL="${AGENT_BOARD_RELEASE_URL:-https://github.com/OWNER/agent-board/releases/latest/download/agent-board.tar.gz}"

case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  zh*) lang=zh ;;
  *) lang=en ;;
esac

# t '中文' 'English'：不是中文語系就用英文。
t() {
  if [ "$lang" = zh ]; then printf '%s' "$1"; else printf '%s' "$2"; fi
}

die() {
  printf '%s: %s\n' "$(t 安裝失敗 'Install failed')" "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 ||
  die "$(t "找不到 node。請先安裝 Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} 以上（https://nodejs.org）。" "Cannot find node. Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer (https://nodejs.org).")"

node -e "
  const [major, minor] = process.versions.node.split('.').map(Number);
  process.exit(major > $MIN_NODE_MAJOR || (major === $MIN_NODE_MAJOR && minor >= $MIN_NODE_MINOR) ? 0 : 1);
" || die "$(t "Node.js 版本太舊（目前 $(node -v)），需要 ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} 以上。" "Node.js is too old ($(node -v)). ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer is required.")"

command -v npm >/dev/null 2>&1 || die "$(t "找不到 npm。它通常隨 Node.js 一起安裝。" "Cannot find npm. It normally comes with Node.js.")"

data_root="$HOME/.local/share/agent-board"

# 在 Agent Board 開的 session 裡執行時（例如請畫布上的 Claude 上架），安裝程式重啟 daemon 會把
# 這個 session 連同安裝程式一起殺掉，daemon 就起不來。這時改成脫離目前 session 在背景跑（新的
# process session、沒有終端機），輸出寫到紀錄檔。設 AGENT_BOARD_INSTALL_DETACHED=1 可強制在前景跑。
if [ -n "${AGENT_BOARD_SESSION_ID:-}" ] && [ -z "${AGENT_BOARD_INSTALL_DETACHED:-}" ]; then
  log_dir="${AGENT_BOARD_DATA_DIR:-$HOME/.agent-board}/logs"
  mkdir -p "$log_dir" || die "$(t "無法建立紀錄資料夾：$log_dir" "Cannot create the log folder: $log_dir")"
  log_file="$log_dir/install-$(date +%Y%m%d-%H%M%S).log"
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  AGENT_BOARD_INSTALL_DETACHED=1 node -e "
    const { spawn } = require('node:child_process');
    const { openSync } = require('node:fs');
    const out = openSync(process.argv[1], 'a');
    const child = spawn('sh', process.argv.slice(2), { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    console.log(child.pid);
  " "$log_file" "$self" "$@" >"$log_dir/.install-pid" ||
    die "$(t "無法在背景啟動安裝程式。" "Could not start the installer in the background.")"
  printf '%s\n' "$(t "偵測到在 Agent Board session 裡執行：安裝程式會重啟 daemon，這個 session 可能跟著中斷，所以改在背景執行（PID $(cat "$log_dir/.install-pid")）。" "Running inside an Agent Board session: the installer restarts the daemon, which can end this session, so it now runs in the background (PID $(cat "$log_dir/.install-pid")).")"
  printf '%s\n' "$(t "進度：tail -f '$log_file'（最後一行是「安裝結束，結束碼 0」就是成功）" "Progress: tail -f '$log_file' (a last line of \"Installer finished, exit code 0\" means success)")"
  rm -f "$log_dir/.install-pid"
  exit 0
fi
tmp=""
note_exit=""
# 背景執行的那一份：結束時在紀錄檔最後寫結果，方便確認。
[ -n "${AGENT_BOARD_INSTALL_DETACHED:-}" ] && [ -n "${AGENT_BOARD_SESSION_ID:-}" ] && note_exit=1
on_exit() {
  code=$?
  [ -z "$tmp" ] || rm -rf "$tmp"
  [ -z "$note_exit" ] || printf '\n[%s] %s %s\n' "$(date)" "$(t "安裝結束，結束碼" "Installer finished, exit code")" "$code"
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

from=""
uninstall=""
for arg in "$@"; do
  [ "$arg" = "--uninstall" ] && uninstall=1
done

if [ -n "$uninstall" ]; then
  [ -f "$data_root/app/scripts/installer.mjs" ] || die "$(t "這台機器沒有安裝 Agent Board。" "Agent Board is not installed on this machine.")"
  for arg in "$@"; do
    shift
    [ "$arg" = "--uninstall" ] || set -- "$@" "$arg"
  done
  node "$data_root/app/scripts/installer.mjs" uninstall "$@"
  exit $?
fi

# 把 --from 從參數裡拿掉，其餘原樣交給 installer.mjs（路徑含空格也不會斷開）。
count=$#
take_from=""
while [ "$count" -gt 0 ]; do
  arg=$1
  shift
  count=$((count - 1))
  if [ -n "$take_from" ]; then
    from=$arg
    take_from=""
  elif [ "$arg" = "--from" ]; then
    take_from=1
  else
    set -- "$@" "$arg"
  fi
done
[ -z "$take_from" ] || die "$(t "--from 後面要接檔案或資料夾。" "--from needs a file or folder.")"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/agent-board-install.XXXXXX")

verify_sha256() {
  node -e "
    const { createHash } = require('node:crypto');
    const { readFileSync } = require('node:fs');
    const expected = readFileSync(process.argv[2], 'utf8').trim().split(/\s+/)[0];
    const actual = createHash('sha256').update(readFileSync(process.argv[1])).digest('hex');
    process.exit(expected === actual ? 0 : 1);
  " "$1" "$2"
}

script_dir=$(dirname "$0")
if [ -z "$from" ] && [ -f "$script_dir/../BUILD_ID" ]; then
  # 從已解開的發布檔裡執行。
  from="$script_dir/.."
fi

if [ -z "$from" ]; then
  case "$RELEASE_URL" in
    */OWNER/*) die "$(t "這份腳本沒有設定下載位址。請從原始碼建置後用 --from 指定發布檔（見 README）。" "This script has no download address set. Build from source and pass the release file with --from (see the README).")" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "$(t "找不到 curl。可以手動下載發布檔後用 --from 指定。" "Cannot find curl. Download the release file yourself and pass it with --from.")"
  printf '%s %s\n' "$(t 下載 Downloading)" "$RELEASE_URL"
  curl -fsSL "$RELEASE_URL" -o "$tmp/agent-board.tar.gz" ||
    die "$(t "下載失敗。可以手動下載發布檔後用 --from 指定。" "Download failed. Download the release file yourself and pass it with --from.")"
  curl -fsSL "$RELEASE_URL.sha256" -o "$tmp/agent-board.tar.gz.sha256" ||
    die "$(t "下載校驗檔失敗。" "Could not download the checksum file.")"
  verify_sha256 "$tmp/agent-board.tar.gz" "$tmp/agent-board.tar.gz.sha256" ||
    die "$(t "檔案校驗不符，下載內容可能損壞。" "Checksum mismatch. The download may be corrupt.")"
  from="$tmp/agent-board.tar.gz"
fi

if [ -d "$from" ]; then
  source_dir=$(cd "$from" && pwd)
else
  [ -f "$from" ] || die "$(t "找不到 --from 指定的檔案：$from" "Cannot find the --from file: $from")"
  tar -xzf "$from" -C "$tmp" || die "$(t "解壓縮失敗：$from" "Could not extract: $from")"
  source_dir="$tmp/agent-board"
fi
[ -f "$source_dir/BUILD_ID" ] || die "$(t "$source_dir 不是 Agent Board 發布檔。" "$source_dir is not an Agent Board release.")"

node "$source_dir/scripts/installer.mjs" install --source "$source_dir" "$@"
exit $?
