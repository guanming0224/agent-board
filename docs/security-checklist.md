# 安全自我檢查清單

最後檢查：2026-11-02，分支 `phase3/h-security`。只測自己的程式，範圍是 127.0.0.1。**沒有跑過真的 `claude`**，凡是要真 `claude` 才能確認的都標未驗證。

結果只有三種：**通過**（有自動化測試或實跑過，附指令）、**未通過**（有已知缺口，寫明影響）、**未驗證**（沒驗過，附重現方式）。

共用指令（從 repo 根目錄）：

```sh
H() { corepack pnpm --filter @agent-board/hub exec vitest run "$@"; }
D() { corepack pnpm --filter @agent-board/daemon exec vitest run "$@"; }
W() { corepack pnpm --filter @agent-board/web exec vitest run "$@"; }
E() { corepack pnpm --filter @agent-board/web exec playwright test -c e2e/security.config.ts "$@"; }
```

## 未登入存取

| 項目                                            | 檢查方式                                                                                                     | 結果 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| `public` 以外的每條 REST 路由未登入回 401       | `H src/test/rest.test.ts -t "rejects every non-public"`                                                      | 通過 |
| 偽造或已登出的 cookie 回 401                    | `H src/test/rest.test.ts -t "forged or logged-out"`                                                          | 通過 |
| `owner` 路由對 member 回 403（含 audit 與匯出） | `H src/test/rest.test.ts -t "rejects members"`；`H src/test/security.test.ts -t "members cannot read audit"` | 通過 |
| 未登入的 WebSocket 升級回 401                   | `H src/test/ws.test.ts`；瀏覽器：`E -g "未登入"`                                                             | 通過 |
| 第一個管理員只能建立一次（含競爭）              | `H src/test/rest.test.ts -t "setup exactly once"`                                                            | 通過 |
| 登入限速（帳號、IP、同時猜測）                  | `H src/test/rest.test.ts -t "rate limit"`                                                                    | 通過 |

## CSRF 與 WebSocket 跨站

| 項目                                                           | 檢查方式                                                                                                                                                                                      | 結果 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| cookie `httpOnly`、`SameSite=Strict`；`document.cookie` 讀不到 | `E -g "跨站"`；`H src/test/rest.test.ts -t "httpOnly"`                                                                                                                                        | 通過 |
| `publicOrigin` 為 https 才 `Secure`，http 不設                 | `H src/test/rest.test.ts -t "httpOnly"`；`H src/test/security.test.ts -t "does not set Secure"`                                                                                               | 通過 |
| 別的來源帶 cookie 的 POST 改不了資料                           | `E -g "跨站"`（真瀏覽器 + 真 hub；不同 port 同 site，SameSite 擋不住，靠 Origin）                                                                                                             | 通過 |
| 別的來源開不了 `/ws/client`，同源開得了（正面對照）            | `E -g "跨站"`                                                                                                                                                                                 | 通過 |
| Origin 規則：缺少、`null`、非 http、http/https 不同、Host 偽造 | `H src/test/security.test.ts -t "Origin rules"`；`H src/test/units.test.ts`                                                                                                                   | 通過 |
| DNS rebinding：惡意網域解析到 127.0.0.1 搶先建立管理員         | `H src/test/security.test.ts -t "Host check"`。**本次發現並修正**：原本 Host 與 Origin 同網域就過，還沒設定的 hub 可被搶註。現在只接受 IP、`localhost`、`publicOrigin` 的主機名稱，其餘回 421 | 通過 |

修正的副作用：沒設 `publicOrigin` 又用自訂網域名稱開 hub 會被擋（回 421 並說明），要先用 IP 或 localhost 進去設定。daemon 的 `/ws/daemon` 靠 Bearer，不受影響；但配對走 HTTP，所以用網域名稱配對一樣要先設 `publicOrigin`。

## 監聽位址

| 項目                                                                                                           | 檢查方式                                            | 結果 |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---- |
| `0.0.0.0`、`::` 與各種等價寫法：環境變數、設定 API、資料庫被改，都擋                                           | `H src/test/rest.test.ts -t "listening address"`    | 通過 |
| **公開 IP 也擋**（DISPATCH §5.2 不提供公開網路模式）。**本次發現並修正**：原本只擋全部介面，`8.8.8.8` 這種會過 | `H src/test/security.test.ts -t "listen address"`   | 通過 |
| 真的入口 `main.ts`：被拒時非零結束並印原因                                                                     | `H src/test/security.test.ts -t "refuses to start"` | 通過 |
| 設定頁與 hub 範圍一致                                                                                          | `W src/security/validation.test.ts`                 | 通過 |

允許範圍：loopback、RFC1918、`100.64.0.0/10`（Tailscale）、link-local、IPv6 ULA（`fc00::/7`）。兩邊各寫一份，改的時候要一起改。

## 機器 token 外洩路徑

| 路徑                                                         | 檢查方式                                                                                                                     | 結果                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 資料庫只存雜湊，連 WAL checkpoint 後的檔案都找不到明文       | `H src/test/security.test.ts -t "machine token paths"`                                                                       | 通過                                                                |
| 機器清單、audit 不含 token                                   | 同上                                                                                                                         | 通過                                                                |
| hub log 不含 token、cookie、密碼、配對碼（真的跑 `main.ts`） | `H src/test/security.test.ts -t "logs never contain"`                                                                        | 通過                                                                |
| daemon log 不含 token                                        | `D src/hubClient.test.ts -t "401"`                                                                                           | 通過                                                                |
| 子程序（claude、git hook、nvidia-smi）環境變數沒有 token     | `D src/daemon.test.ts -t "token 不外洩"`                                                                                     | 通過                                                                |
| 憑證檔權限 `0600`，舊檔權限太寬會修正                        | `D src/pair.test.ts`                                                                                                         | 通過（只看測試；`credentials.ts` 原始碼這次被權限規則擋下，沒有讀） |
| hook socket `0600`、資料夾 `0700`                            | `D src/hookServer.test.ts`                                                                                                   | 通過                                                                |
| 撤銷後舊 token 立刻 401                                      | `H src/test/ws.test.ts -t "machine"`                                                                                         | 通過                                                                |
| 同一使用者身分的程序讀憑證檔                                 | **設計上擋不住**：`claude` 與 daemon 同一個 OS 帳號，agent 跑的指令讀得到 `~/.agent-board/` 下的憑證。要隔離得用不同 OS 帳號 | 未通過（接受的風險，列給 Lead）                                     |

## session cookie

| 項目                                                                                                                      | 檢查方式                                                                                                                                                                        | 結果   |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 登出後舊 cookie 與既有 WebSocket 失效                                                                                     | `H src/test/rest.test.ts -t "forged or logged-out"`；`H src/test/ws.test.ts`                                                                                                    | 通過   |
| 改密碼後其他裝置登出                                                                                                      | `H src/test/rest.test.ts -t "logs out other devices"`                                                                                                                           | 通過   |
| 管理員重設別人的密碼：對方全部登出（含 WebSocket）、記 audit 不含密碼；成員不能重設任何人；自己的密碼不能用這條繞過舊密碼 | `H src/test/account.test.ts -t "owner resets"`；瀏覽器：`corepack pnpm --filter @agent-board/web exec playwright test -c e2e/account-integration.config.ts -g "管理員從設定頁"` | 通過   |
| `agent-board-hub reset-password`：不印密碼、撤銷該帳號所有登入、找不到資料庫時不建新檔、打錯子指令不會開出第二個 hub      | `H src/test/account.test.ts -t "reset-password command"`；打包後經安裝捷徑：`corepack pnpm smoke:release`                                                                       | 通過   |
| 資料庫只存 token 雜湊                                                                                                     | `H src/test/rest.test.ts -t "never returns or stores"`（密碼）；`auth.ts` 的 `sha256`（token，讀程式確認）                                                                      | 通過   |
| 經 `tailscale serve` 實際走 https 的 Secure cookie                                                                        | 要真的代理環境。重現：設 `publicOrigin` 為 `https://<機器>.ts.net`，用瀏覽器登入看 cookie。另外 Safari 用 `http://127.0.0.1` 登入時可能存不了 Secure cookie                     | 未驗證 |

## XSS

| 項目                                                                                                     | 檢查方式                                                                                                     | 結果   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| session 名稱、分支、路徑、lastLines、指令、diff、JSON 參數、工具名稱、提問（畫布、待處理、審核、收件匣） | `E -g "只當文字"`                                                                                            | 通過   |
| 終端機輸出的 HTML、OSC 標題、`javascript:` OSC 8 連結                                                    | `E -g "終端機輸出"`；`W src/terminal/input.test.ts -t "只允許 http"`                                         | 通過   |
| 原始碼沒有 `dangerouslySetInnerHTML`、`innerHTML`、`eval`                                                | `grep -rn "dangerouslySetInnerHTML\|innerHTML\|eval(" packages/web/src`                                      | 通過   |
| JSON 任務清單（團隊畫面）                                                                                | Agent G 正在做，這個分支沒有畫面。重現：畫面合併後把 `XSS` 字串放進任務標題，跑 `E -g "只當文字"` 同樣的檢查 | 未驗證 |

## CSP 與標頭

| 項目                                                                                                          | 檢查方式                                                                                                                            | 結果                 |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `default-src 'self'`，沒有 `unsafe-eval`；注入的 inline script 不執行；正常載入無違規                         | `E -g "CSP：頁面"`                                                                                                                  | 通過                 |
| WebSocket 與 fetch 只能連自己。**本次發現並修正**：原本 `connect-src ws: wss:` 全開，XSS 能把資料送到任何主機 | `E -g "CSP：不能"`；`H src/test/security.test.ts -t "CSP limits"`                                                                   | 通過                 |
| `style-src 'unsafe-inline'` 還在                                                                              | xterm 與 React Flow 用 inline style。影響：CSS 注入仍可能，但前面的 XSS 檢查沒有注入點                                              | 未通過（接受的風險） |
| `nosniff`、`X-Frame-Options: DENY`、`frame-ancestors 'none'`、`no-referrer`、`object-src 'none'`              | `H src/test/rest.test.ts -t "security headers"`；`H src/test/security.test.ts -t "CSP limits"`                                      | 通過                 |
| service worker 只能是同源檔案（`worker-src 'self'`），`/sw.js` 不快取；推播內容只有 session 名稱與狀態        | `H src/test/rest.test.ts -t "service worker"`；`corepack pnpm --filter @agent-board/web exec playwright test -c e2e/push.config.ts` | 通過                 |

## 路徑穿越

| 項目                                                                     | 檢查方式                                                                                                     | 結果             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| 靜態檔：`../`、`%2e%2e`、`..%2f`、`..%5c`、雙重寫法、dotfile             | `H src/test/security.test.ts -t "static files"`                                                              | 通過             |
| `fs.list`：`../` 正規化、回實際路徑；只回名稱與類型；NUL、指向檔案回錯誤 | `D src/misc.test.ts -t "NUL"`                                                                                | 通過             |
| `fs.list` 能列機器上**任何**資料夾                                       | 這是功能（選工作目錄），任何登入使用者都能用。登入使用者本來就能在終端機下指令，沒有多給權限。沒有路徑白名單 | 通過（設計如此） |

## 危險指令與 hook 被繞過的路徑

| 路徑                                                                                                                             | 檢查方式                                                                                                                            | 結果                                                |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 指令變形（見下節判定表）                                                                                                         | `D src/approvals.test.ts -t "matchDangerRule"`                                                                                      | 通過                                                |
| 誤報                                                                                                                             | 同上，判定表的「不攔」欄                                                                                                            | 通過                                                |
| hook 設定檔 JSON 壞掉：不開 session                                                                                              | `D src/daemon.test.ts -t "hook 設定壞掉"`                                                                                           | 通過                                                |
| hook 連不上 daemon：Bash 回 `ask`                                                                                                | `corepack pnpm --filter @agent-board/hook exec vitest run -t "回 ask"`                                                              | 通過                                                |
| 等候逾時：Bash 回 `deny`                                                                                                         | `corepack pnpm --filter @agent-board/hook exec vitest run -t "超時"`                                                                | 通過                                                |
| `dangerRules` 被 owner 清空                                                                                                      | 什麼都不會攔。設定頁有寫明（`flows.security.rulesEmpty`）                                                                           | 通過（設計如此）                                    |
| 只有 owner 能決定 danger                                                                                                         | `H src/test/ws.test.ts -t "only an owner can decide"`                                                                               | 通過                                                |
| **腳本檔**（`bash ./cleanup.sh`）、變數組字（`RM=rm; $RM -rf /`、`rm${IFS}-rf`）、編碼（`base64 -d \| sh`）、`rm -r /` 少了 `-f` | hook 看不到執行時才有的內容。測試釘住現況：`D src/approvals.test.ts -t "已知看不到"`                                                | 未通過（比對做不到，靠 Claude Code 本身的權限模式） |
| **非 Bash 工具**：Write 寫腳本再執行、Edit 改設定、MCP 工具                                                                      | 只比對 `tool_name == 'Bash'`：`D src/approvals.test.ts -t "非 Bash"`                                                                | 未通過（設計範圍外）                                |
| agent 自己改 `.claude/settings.local.json` 拿掉 hook，或設 `disableAllHooks`                                                     | 要真 `claude`。重現：開 session，請它編輯該檔移除 hooks，再下 `git push --force`，看有沒有攔到；也要看 Claude Code 是否即時重讀設定 | 未驗證                                              |
| 終端機 `!` 模式直接執行 shell（不經工具）                                                                                        | 要真 `claude`。重現：在 session 打 `!git push --force --dry-run`，看 hub 有沒有 `approval.requested`                                | 未驗證                                              |
| 使用者層設定的其他 hook 搶先回 `allow`                                                                                           | 要真 `claude`。重現：`~/.claude/settings.json` 加一個 PreToolUse hook 回 allow                                                      | 未驗證                                              |
| 使用者在網頁終端機直接按鍵                                                                                                       | 人自己按的，不攔，只記 audit                                                                                                        | 通過（設計如此）                                    |

### 危險指令判定

比對方式：把指令解析成實際會執行的簡單指令（處理引號、跳脫、`;` `&&` `||` `|` `&`、換行、`$()`、反引號、`()`、`{}`、heredoc、註解），去掉前綴（`sudo`、`doas`、`env`、`command`、`exec`、`nohup`、`time`、`nice`、`timeout`、`xargs`、`busybox`…）與路徑（`/bin/rm`、`\rm`），展開 `bash -c`、`eval`、`watch`、`find -exec`，再比程式名、旗標（順序與合併不計）、位置參數。**判斷不出來時往多問的方向走。**

| 指令                                                                                                                            | 規則               | 決定               | 原因                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| `git push -f`、`-fu`、`--force-with-lease`、`--force-if-includes`、`origin +main`、`git -C x push -f`                           | `git push --force` | **攔**             | 都會覆寫遠端歷史。`--force-with-lease` 比較安全但仍是覆寫，由人決定                          |
| `git push`、`git push origin main`、`git push --no-force`、`git stash push -f`                                                  | `git push --force` | 不攔               | 沒有強制推送                                                                                 |
| `rm -rf /`、`rm -fr /`、`rm -r -f /`、`rm -Rf /`、`rm --recursive --force /`、`/bin/rm`、`\rm`、`r"m"`、`"/"`、`//`、`/.`、`/*` | `rm -rf /`         | **攔**             | 同一件事的寫法                                                                               |
| `rm -rf /tmp/x`、`rm -rf /etc`                                                                                                  | `rm -rf /`         | **攔**             | 絕對路徑一律問，包含暫存資料夾。寧可多問一次：`/tmp/../etc` 這種分不完。與舊的子字串行為相同 |
| `rm -rf ~`、`$HOME`、`$X`、`$(pwd)`                                                                                             | `rm -rf /`         | **攔**             | 值要執行時才知道                                                                             |
| `rm -rf .`、`./`、`*`、`./*`、`..`、`../x`、`a/../..`                                                                           | `rm -rf /`         | **攔**             | 清掉整個工作目錄或跳出工作目錄                                                               |
| `rm -rf ./node_modules`、`node_modules dist`、`build/`、`build/*`                                                               | `rm -rf /`         | 不攔               | 工作目錄內的相對路徑，日常清理                                                               |
| `find ./build -exec rm -rf {} +`                                                                                                | `rm -rf /`         | 不攔               | `{}` 以搜尋起點判斷                                                                          |
| `find . -exec rm -rf {} +`、`find / -exec …`、`ls \| xargs rm -rf`                                                              | `rm -rf /`         | **攔**             | 起點是工作目錄或根目錄；`xargs` 的目標看不到                                                 |
| `rm -f /tmp/x`、`rm -r build`、`rmdir /x`                                                                                       | `rm -rf /`         | 不攔               | 少了旗標。**`rm -r /` 也因此不攔**，要的話自己加一條規則                                     |
| `echo "rm -rf /"`、`printf`、`grep`、`rg`、`cat <<EOF`、註解                                                                    | `rm -rf /`         | 不攔               | 只是文字                                                                                     |
| `git commit -m "rm -rf /"`、`gh pr create --body "…"`、`git log --grep "…"`                                                     | `rm -rf /`         | 不攔               | 訊息參數只是文字                                                                             |
| `echo "$(rm -rf /)"`、`` echo `rm -rf /` ``                                                                                     | `rm -rf /`         | **攔**             | 命令替換一定會執行                                                                           |
| `echo "rm -rf /" \| sh`、`bash <<EOF`、`bash <<< "…"`、`bash -c "…"`、`eval "…"`                                                | `rm -rf /`         | **攔**             | 交給 shell 執行                                                                              |
| `ssh host 'rm -r -f /'`、`python3 -c "os.system('rm -rf /')"`                                                                   | `rm -rf /`         | **攔**             | 參數裡的文字可能被執行                                                                       |
| 引號沒收好、巢狀超過 8 層                                                                                                       | 任何               | 退回舊的子字串比對 | 解析失敗不能變成放行                                                                         |

**使用者自訂規則：** 寫法和指令一樣，`kubectl delete`、`terraform destroy`、`git clean -fd`、`chmod -R 777`、`docker system prune` 都會比旗標與子指令。其他寫法：`curl | sh`（比相鄰的管線）；`dd if=`（`=` 結尾比前綴）；`mkfs` 會比到 `mkfs.ext4`；`rm -rf /etc` 比路徑本身、子路徑與上層；`DROP TABLE` 比引號裡交給別的程式執行的文字（`psql -c "DROP TABLE x"`）；含重導向或解析不了的（`> /dev/sda`、fork bomb）比原始文字；`text:` 開頭強制比原始文字（含 `echo` 引號內）。大小寫有分別，`drop table` 要另外加。

## 遮蔽模式

| 項目                                                                                                            | 檢查方式                                                                  | 結果 |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---- |
| 常見金鑰形狀、`key=value`、Bearer、網址帳密、私鑰、配對碼；一般文字（git SHA、`max_tokens=`、`tokens: 12`）不動 | `W src/security/mask.test.ts`                                             | 通過 |
| 寫入 xterm 前過濾；切在任何位置都看不到金鑰本體；被顏色碼切開；折行；寬度不變                                   | `W src/security/mask.test.ts -t "StreamMasker"`；`E -g "遮蔽模式：xterm"` | 通過 |
| 輸出停在半路不會卡住（40ms 後打碼送出）                                                                         | `W src/security/mask.test.ts -t "TerminalMaskGate"`                       | 通過 |
| 開啟時已畫上去的內容會換掉（重拿快照）                                                                          | `E -g "已經畫上去"`                                                       | 通過 |
| 摘要卡、審核卡、兩段確認全文、diff、提問、待處理、收件匣                                                        | `E -g "遮蔽模式：畫面"`                                                   | 通過 |
| 頁首晶片、重新整理還開著、說明寫明不是安全邊界                                                                  | `E -g "頁首晶片"`                                                         | 通過 |

**限制（介面上也寫了）：遮蔽不是安全邊界。**

- 原始資料照樣送到瀏覽器，開發者工具看得到。hub 與 daemon 不受影響。
- 只認形狀：沒有固定前綴也沒有標籤的密碼遮不到；工作階段裡的路徑、機器名稱、程式碼都不遮。
- 切在辨識出前綴之前時，前綴本身（例如 `sk`）可能先露出；本體不會。
- TUI 只重畫一行的中間一段時，可能拼不起來。真 `claude` 的畫面未驗證。
- 折行判斷會多遮：金鑰打到行尾時，下一行夠長或獨占一行的字也會變星號。
- 開著時核准危險指令，看到的是打碼後的指令；要看原文就先關掉。
- OSC 8 連結的網址與終端機標題不遮。
- 真 `claude` 畫面下的實際效果：未驗證。

## audit 明文密碼

**做法：** hub 看得到輸出，所以按 Enter 當下看畫面尾巴。密碼提示沒有回顯，打完字尾巴還停在提示上。最後 3 行（去掉控制碼與框線）有行尾是「…password:」「…密碼：」「verification code:」之類，該筆記 `[redacted: typed at a password prompt]`。另外所有 audit 內容寫入前都打碼金鑰形狀（貼上的 API key）。轉送給 PTY 的輸入不受影響。

**為什麼不是只記長度：** DISPATCH §5.2 要求記下送入終端機的指令，全部只記長度就失去 audit 的意義；而提示後的那筆連長度都不記，因為密碼長度沒有稽核價值。

**取捨：** hub 多留每個 session 最後 2 KB 輸出在記憶體（不落地，session 移除時丟棄）。CONTRACTS §2「hub 不保存終端機資料」指的是持久保存，測試（`ws.test.ts`「OUTPUT_MARKER」）仍確認輸出不進資料庫。

| 項目                                                               | 檢查方式                                                        | 結果                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------- |
| 提示偵測（sudo、ssh、passphrase、中文、2FA、彩色、切開、TUI 框線） | `H src/test/security.test.ts -t "detects"`                      | 通過                                |
| 不誤判一般輸出                                                     | `H src/test/security.test.ts -t "does not flag"`                | 通過                                |
| 走完整條 WebSocket，資料庫檔案裡找不到明文；下一筆指令照常記       | `H src/test/security.test.ts -t "not recorded in plain text"`   | 通過                                |
| 沒按 Enter 就離開的 partial 也打碼                                 | `H src/test/security.test.ts -t "partial row"`                  | 通過                                |
| 輸入照常轉送                                                       | `H src/test/security.test.ts -t "forwarded unchanged"`          | 通過                                |
| 沒有輸出可看時（client 沒訂閱就送輸入、輸出比 Enter 晚到）仍是明文 | 測試釘住現況：`H src/test/security.test.ts -t "known limit"`    | 未通過（盡力而為，無法從 hub 根治） |
| 提示文字不符合樣式（自訂程式的 `Enter secret>`）仍是明文           | 同上性質                                                        | 未通過                              |
| 舊資料                                                             | 這版之前已寫入的明文不會回頭改，要等保留期限到期或手動清        | 未通過                              |
| 真 `claude` 內的提示（`!sudo`、Claude Code 自己的輸入框）          | 要真 `claude`。重現：`!sudo -k; sudo ls`，輸入後看 `/api/audit` | 未驗證                              |

## 移除機器

**做法（不需要改 protocol）：**

1. 機器在線：hub 對每個還活著的 session 送既有的 `session.stop`，再以 4401 關閉連線。
2. 機器離線：送不到。daemon 下次重連被 401／403 拒絕後開始算 10 分鐘（`REVOKED_GRACE_MS`）；期間沒拿回 `hub.welcome` 就停掉本機 session。只有 hub 掛掉（5xx、連不上）不算。
3. 對話紀錄還在，重新配對後可用 `--resume` 接回。

**為什麼等 10 分鐘：** 換資料庫或還原備份時 token 也會暫時對不上，這時立刻殺掉正在跑的工作代價太高。代價是撤銷後最多多跑 10 分鐘（加上重連間隔）。機器一直連不上 hub 時，session 會繼續跑到它連上為止；這種情況 hub 什麼都做不了。

| 項目                                              | 檢查方式                                              | 結果   |
| ------------------------------------------------- | ----------------------------------------------------- | ------ |
| hub 送 `session.stop`；已結束的不送               | `H src/test/security.test.ts -t "removing a machine"` | 通過   |
| daemon 持續被拒：停 session、結果落地、重啟不接回 | `D src/daemon.test.ts -t "持續被拒"`                  | 通過   |
| 寬限期內恢復不受影響；502 不算                    | `D src/daemon.test.ts -t "機器被移除"`                | 通過   |
| 真 hub + 真 daemon 整條                           | 兩端各自測過，沒有串起來跑過                          | 未驗證 |
| 設定頁文字說明會一起停                            | `flows.machine.removeHint`                            | 通過   |

## 資料保留

| 資料             | 預設                                 | 環境變數（0 = 不清）               |
| ---------------- | ------------------------------------ | ---------------------------------- |
| `session_events` | 30 天，總量上限 200 萬筆，超過刪最舊 | `AGENT_BOARD_EVENT_RETENTION_DAYS` |
| `audit_log`      | 180 天，**先寫 CSV 再刪**            | `AGENT_BOARD_AUDIT_RETENTION_DAYS` |

啟動時跑一次，之後每小時一次。audit 寫到資料庫旁的 `audit-archive/`（資料夾 `0700`、檔案 `0600`），暫存檔寫完才改名。每輪最多 5 萬筆。清除本身記一筆 `audit.retention`。

| 項目                             | 檢查方式                                                         | 結果                                  |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| 先匯出再刪；權限正確             | `H src/test/security.test.ts -t "exported to an owner-only CSV"` | 通過                                  |
| 匯出失敗就不刪                   | `H src/test/security.test.ts -t "export fails"`                  | 通過                                  |
| 事件依時間與總量清；0 天不清     | `H src/test/security.test.ts -t "retention"`                     | 通過                                  |
| 真的啟動流程                     | `H src/test/security.test.ts -t "runs at startup"`               | 通過                                  |
| 封存檔本身沒有上限，也不會自動刪 | 磁碟會慢慢長，內容含終端機輸入（已打碼金鑰與密碼提示）           | 未通過（給使用者自己處理，列給 Lead） |
| 設定頁調整天數                   | `Settings` schema 沒有這欄，protocol 不能動，目前只有環境變數    | 未通過（等 Lead）                     |

## 依賴審計

| 項目                                             | 檢查方式                       | 結果                         |
| ------------------------------------------------ | ------------------------------ | ---------------------------- |
| `corepack pnpm audit`（2026-11-02 有網路，實跑） | 0 high、0 critical、2 moderate | 未通過（2 moderate，影響低） |

- `minimatch`（GHSA-g3hv-75wg-m249，globparts 放大 DoS）：多數路徑是 eslint（開發用）；正式路徑 `hub > @fastify/static > glob > minimatch`。
- `glob`（GHSA-3g3m-2fjr-6pw4，AbortSignal 逾時後仍走訪）：`hub > @fastify/static > glob`。

兩者都只在 hub 啟動時掃描自己的 `web/dist`，pattern 不來自使用者（`wildcard: false`），判斷打不到。`@fastify/static` 已是最新 10.1.8，沒有可升的版本；用 `overrides` 跨大版本強升未測過，沒有動。上游出新版時再升。
