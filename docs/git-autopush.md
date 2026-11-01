# Git 自動推送（開發者工具，macOS）

只有開發這個 repo 的人需要。在 `main` 上 commit、merge、pull 之後，背景檢查並推送到 `origin/main`；其他分支不推。

## 安裝

```
git push -u origin main          # 只需一次
bash deploy/git-hooks/install.sh
```

## 檢查什麼

逐個 commit 檢查，中間加了又刪掉的也算：

- **檔案**：`data/`、`backups/`、`deploy/local/`、資料庫、`.pem`、`.key`、`.jsonl`、`.env`（`.env.example` 除外）、`vapid*.json`。
- **內容**：`.git/autopush-private-values` 裡的值（一行一個，放真實金鑰、機器名稱、個人網域，不進版控），以及像 Anthropic Key、GitHub Token、Telegram Token、私鑰區塊的字串，或 key／secret／token 旁邊的 UUID。

有問題就不推，寫 `~/Library/Logs/agent-board/git-autopush.log` 並發 Mac 桌面通知，同一則 6 小時內只發一次。不會 force push。

## 確認有沒有推成功

```
tail -5 ~/Library/Logs/agent-board/git-autopush.log
git fetch && git status -sb
```

## 暫停

把 `.git/hooks/post-commit`、`post-merge` 改名（例如加 `.off`）。`--no-verify` 跳不過這兩個 hook。

## 處理被擋下

`git log origin/main..HEAD --stat` 找出是哪個 commit，`git reset --soft origin/main` 撤回，移除問題內容後重新 commit。真的是金鑰就到該服務換一把新的。
