#!/bin/bash
# 開發者工具（macOS）：commit / merge 後自動推送 main 到 GitHub。說明：docs/git-autopush.md
#
# 推送前逐個 commit 檢查（中間加了又刪掉的也算）：
#   1. 不能有資料、資料庫、金鑰、本機部署設定的檔案
#   2. 新增內容不能有 .git/autopush-private-values 裡的真實值，也不能有像金鑰的字串
# 有問題、推送失敗、歷史被改寫都不推，寫 log 並發桌面通知（同一則 6 小時內只發一次）；恢復時再通知一次。

LOG="${AUTOPUSH_LOG:-$HOME/Library/Logs/agent-board/git-autopush.log}"   # 測試時可用 AUTOPUSH_LOG 改位置
ROOT=$(git rev-parse --show-toplevel) || exit 0
HELPER="$ROOT/deploy/git-hooks/autopush_check.py"
PY=/Library/Frameworks/Python.framework/Versions/Current/bin/python3
[ -x "$PY" ] || PY=python3
LOCK="$(git rev-parse --git-common-dir)/autopush.lock"
PUSH_TIMEOUT=60

mkdir -p "$(dirname "$LOG")"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
alert() { log "$2"; "$PY" "$HELPER" notify "$1" "⚠️ GitHub 自動推送：$2" >> "$LOG" 2>&1; }
resolved() { "$PY" "$HELPER" resolved "✅ GitHub 自動推送已恢復：$1" >> "$LOG" 2>&1; }

[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || exit 0   # 只推 main；agent 的 phase 分支不推

run() {
  base=$(git rev-parse -q --verify origin/main) || { alert no-origin "找不到 origin/main，沒有推送。請手動執行一次 git push -u origin main"; return; }
  head=$(git rev-parse HEAD)
  [ "$base" = "$head" ] && return
  if ! git merge-base --is-ancestor "$base" HEAD; then
    alert rewritten "本機歷史和 GitHub 不一致（可能 amend 或 rebase 了已推送的 commit），沒有推送。請人工處理，不要 force push"
    return
  fi

  # 1. 檔案：逐個 commit 列出碰過的檔案（包含之後又刪掉的）
  bad=$(git log --format= --name-only "$base"..HEAD | sort -u |
        grep -E '(^|/)(data|backups)/|^deploy/local/|\.(db|db-wal|db-shm|sqlite[0-9]*|pem|key|jsonl)$|(^|/)\.env(\.|$)|(^|/)vapid[^/]*\.json$' |
        grep -vE '(^|/)\.env\.example$')
  if [ -n "$bad" ]; then
    alert bad-files "沒有推送，commit 裡有不該上傳的檔案：$(echo $bad | head -c 300)"
    return
  fi

  # 2. 內容：逐個 commit 的新增行
  if ! reason=$(git log --format= -p --no-color --no-ext-diff "$base"..HEAD | "$PY" "$HELPER" scan 2>>"$LOG"); then
    alert secret "沒有推送：${reason:-檢查程式執行失敗}。請人工檢查"
    return
  fi

  # 3. 推送：不跳出帳密視窗、最多等 $PUSH_TIMEOUT 秒
  if out=$(GIT_TERMINAL_PROMPT=0 /usr/bin/perl -e 'alarm shift; exec @ARGV' "$PUSH_TIMEOUT" git push -q origin main 2>&1); then
    log "已推送 $(git rev-parse --short HEAD)"
    resolved "已推送 $(git rev-parse --short HEAD)"
  else
    alert push-failed "推送失敗（下次提交會一起推）：$(echo ${out:-超過 ${PUSH_TIMEOUT} 秒沒有回應} | head -c 300)"
  fi
}

if [ "$1" = "--locked" ]; then
  run
  exit 0
fi
# 同時只跑一個（連續快速 commit 時排隊，最多等 120 秒）；排到時會把當下所有還沒推的一起推
( /usr/bin/lockf -k -t 120 "$LOCK" "$0" --locked || log "等不到上一次推送結束，略過（下次提交會一起推）" ) > /dev/null 2>&1 &
exit 0
