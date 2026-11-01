#!/bin/bash
# 安裝 GitHub 自動推送：把 post-commit、post-merge 放進 .git/hooks/。說明：docs/git-autopush.md
set -e
cd "$(git rev-parse --show-toplevel)"
hooks="$(git rev-parse --git-path hooks)"
for h in post-commit post-merge; do
  cp "deploy/git-hooks/$h" "$hooks/$h"
  chmod +x "$hooks/$h"
done
chmod +x deploy/git-hooks/autopush.sh
echo "已安裝：$hooks/post-commit、$hooks/post-merge"
