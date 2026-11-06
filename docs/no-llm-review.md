# 中控台不呼叫 LLM：程式碼審查

對應 DISPATCH §1.3-2「中控台本身不呼叫任何 LLM」與 §10 驗收項「中控台本身沒有任何 LLM 呼叫（程式碼審查確認）」。

- **日期：** 2026-11-03
- **審查的版本：** `97f4425`（main）加上本次新增的檢查腳本
- **結論：** 通過。hub、daemon、hook、web 與隨發布檔散布的第三方套件都沒有呼叫任何 LLM 服務。
  唯一用到 Claude 的方式是 daemon 在 PTY 裡開使用者自己登入的 `claude` CLI（互動模式），
  送進去的字只有六種來源：使用者在網頁打的、使用者建立 session 時填的第一個指令、
  使用者按「請隊長拆解」或「/clear」送出的固定文字、使用者自己設定並啟用的交接規則、
  使用者打開的「任務自動執行」送的固定格式任務提示（2026-11-06 補）、
  使用者打開的「額度恢復後自動接續」送的固定一行（2026-11-06 補）、
  session 裡的 Claude 自己呼叫派工工具（MCP，設定「允許 session 派工」開著時）送給成員的工作與送回的結果（2026-11-06 補）。
  daemon 不會自己產生 prompt。

## 重跑

```sh
corepack pnpm build:release   # 先打包，檢查才會掃 release/agent-board
corepack pnpm check:no-llm    # scripts/check-no-llm.mjs
```

通過時印出 `通過：沒有 LLM 呼叫；對外連線與終端機輸入共 28 處，都在審查清單內。`（2026-11-06 派工加入後）
這支腳本做三件事（任何一項不符就結束碼 1）：

1. 在自己的原始碼（`packages/*/src`，不含測試；會進發布檔的 `scripts/installer.mjs`、
   `install.sh`、`install.ps1`、`fix-node-pty.mjs`、`scripts/lib`）、所有散布的第三方套件
   （134 個，約 2400 個 `.js/.cjs/.mjs/.json` 檔）、`release/agent-board` 的每個檔案裡，
   找 LLM 服務的網址與 SDK：`api.anthropic.com`、`@anthropic-ai/`、`anthropic-version`、
   `/v1/messages`、`/v1/complete`、`/v1/chat/completions`、`/v1/responses`、`/v1/embeddings`、
   `api.openai.com`、`openai.azure.com`、`from 'openai'`、`generativelanguage.googleapis.com`、
   `aiplatform.googleapis.com`、`bedrock-runtime`、Mistral、Cohere、Groq、OpenRouter、DeepSeek、
   xAI、Together、Hugging Face Inference、Ollama（`localhost:11434`）。
2. 列出原始碼裡每一處對外連線、開行程、把字送進終端機的寫法（`fetch(`、`new WebSocket(`、
   `child_process`、`node-pty`、`node:http/https/net/tls/dgram` 的值匯入、`sendNotification(`、
   `systeminformation`、`XMLHttpRequest/sendBeacon/EventSource`、非相對路徑的動態 `import(`、
   `.pty.write(`、`type: 'terminal.input',`、`.sendPrompt(`），和腳本裡的 `CALL_SITES` 清單比對。
   多出沒審查過的位置就失敗。
3. daemon 給 `claude` 的參數只能是 `--resume`、`--session-id`、`--permission-mode`、
   `--disallowedTools`、`--model`、`--mcp-config`、`--allowedTools`、`--name`（以及探測版本用的 `--version`），daemon 原始碼不得出現 `-p`／`--print`（非互動模式會直接
   耗用模型）。

另外 `eslint.config.js:17-18` 用 `no-restricted-imports` 擋 `@anthropic-ai/*` 與 `openai`，
`corepack pnpm lint` 會跑。發布檔的第三方套件清單怎麼算見 `scripts/release-shipped.mjs`
（和 THIRD_PARTY_NOTICES.md 共用同一份清單）。

## 方法

1. 讀 DISPATCH §1.3、§6、§10。
2. 在 `packages/*/src` 用 grep 找出所有對外連線、開行程、送字進 PTY 的位置，逐一讀程式碼追到
   資料來源（下表）。
3. `corepack pnpm build:release` 打包，在 `release/agent-board`（hub、daemon、hook 打包檔、
   網頁 `web/dist/assets/*.js`、`sw.js`）grep LLM 網址與關鍵字，並列出所有出現的 `http(s)://` 主機。
4. 用 `npm ci --ignore-scripts` 在暫存資料夾裝發布檔的 `package-lock.json`（17 個套件），一起 grep。
5. 用 esbuild metafile 與 vite sourcemap 列出實際打包進去的套件，連同它們宣告的依賴一起掃。
6. 把以上寫成 `scripts/check-no-llm.mjs`，在本機跑過、通過。

### 打包檔 grep 結果

`vertex`、`googleapis`、`BEDROCK` 有出現，逐一確認都不是 LLM：

| 出現位置                                                              | 實際內容                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `web/dist/assets/index-*.js` 的 `vertex`／`VERTEX`                    | xterm WebGL 的 `VERTEX_SHADER`、`createVertexArray`                |
| `daemon/dist/index.mjs` 的 `Vertex`                                   | systeminformation 的 PCI 廠商表 `"Vertex International, Inc."`     |
| `daemon/dist/index.mjs` 的 `BEDROCK`                                  | daemon 自己的註解：保留使用者的 `CLAUDE_CODE_USE_BEDROCK` 環境變數 |
| `hub/dist/main.mjs` 的 `fcm.googleapis.com`、`android.googleapis.com` | web-push 判斷推播 endpoint 是不是 Google FCM／GCM                  |

打包檔裡其他網址都是註解或錯誤訊息裡的文件連結（json-schema.org、github.com、tools.ietf.org、
fastify.dev、react.dev、reactflow.dev、systeminformation.io 等），不是程式會連的位置。hook 打包檔
與 `sw.js` 沒有任何網址。

## 對外連線與行程（全部）

| 位置                                                       | 做什麼                                                                                                                                                                                | 連到哪                                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/daemon/src/pair.ts:52`                           | `fetch` 交換配對碼                                                                                                                                                                    | 使用者用 `--hub` 指定的 hub                                                                                                                                          |
| `packages/daemon/src/hubClient.ts:109`                     | `ws` 連線，斷線重連                                                                                                                                                                   | 配對時存下的 hub 網址                                                                                                                                                |
| `packages/daemon/src/session.ts:211`                       | `node-pty` 開 `claude`（見下節）                                                                                                                                                      | 本機行程                                                                                                                                                             |
| `packages/daemon/src/resources.ts:36`                      | `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`                                                                                                                              | 本機行程                                                                                                                                                             |
| `packages/daemon/src/resources.ts:51`                      | `systeminformation` 的 `currentLoad()`、`mem()`                                                                                                                                       | 本機（讀系統資訊；套件裡其他會連網的函式沒有被呼叫）                                                                                                                 |
| `packages/daemon/src/resources.ts:67`                      | `claude --version`（探測版本，不送 prompt）                                                                                                                                           | 本機行程                                                                                                                                                             |
| `packages/daemon/src/worktree.ts:11`                       | `git`（`rev-parse`、`worktree add/remove`、`branch -d` 等），`GIT_TERMINAL_PROMPT=0`                                                                                                  | 本機行程                                                                                                                                                             |
| `packages/daemon/src/sessionFiles.ts:47`                   | 只執行 `git`（`status --porcelain -z`，刪除前檢查 worktree 有無改動），`GIT_TERMINAL_PROMPT=0`，2026-11-05 Lead 審查                                                                  | 本機行程                                                                                                                                                             |
| `packages/daemon/src/hookServer.ts:40`                     | `net.connect` 探測舊的 socket 是否還有人在聽                                                                                                                                          | 本機 Unix socket／named pipe                                                                                                                                         |
| `packages/hook/src/cli.ts:67`、`:85`                       | `net.connect` 把 hook 事件交給 daemon                                                                                                                                                 | daemon 的本機 socket（環境變數給的路徑）                                                                                                                             |
| `packages/hook/src/mcp.ts`（`callDaemon`）                 | 派工 MCP server（stdio，claude 啟動的子行程）：`net.connect` 把工具呼叫原樣交給 daemon，2026-11-06 審查。自己不產生任何文字，回覆只是 hub 給的結果                                    | daemon 的本機 socket（MCP 設定檔 env 給的路徑）                                                                                                                      |
| `packages/hub/src/push.ts:31`                              | `web-push` 送推播                                                                                                                                                                     | 瀏覽器訂閱時給的推播服務 endpoint（Apple／Google／Mozilla）。內容加密，只有 session id、名稱、狀態、時間（`push.ts:67-73`），不含終端機內容；`push.ts:76` 擋內網位址 |
| `packages/hub/src/config.ts`、`auth.ts`                    | 只用 `node:net` 的 `BlockList`、`isIP` 判斷位址                                                                                                                                       | 不連線                                                                                                                                                               |
| `packages/web/src/shared/hubBackend.ts:57`                 | `fetch` 呼叫 REST API                                                                                                                                                                 | 同源（相對路徑）                                                                                                                                                     |
| `packages/web/src/shared/hubBackend.ts:153`                | WebSocket                                                                                                                                                                             | 同源 `location.host`                                                                                                                                                 |
| `scripts/installer.mjs`（隨發布檔散布）                    | `npm ci`、`launchctl`／`systemctl`／`loginctl`／`schtasks`、`node -e` 載入原生模組自我檢查、`daemon pair`；`fetch` 等本機 hub 起來（`/api/auth/status`）；`net.createServer` 找空的埠 | 本機與 npm registry                                                                                                                                                  |
| `scripts/install.sh:137`、`install.ps1:79`                 | 下載發布檔與 `.sha256`                                                                                                                                                                | `AGENT_BOARD_RELEASE_URL`（預設 GitHub Releases）                                                                                                                    |
| `scripts/install.sh`（偵測到 `AGENT_BOARD_SESSION_ID` 時） | `node -e` 用 `child_process.spawn` 以 `detached` 重跑 `sh install.sh` 自己，輸出寫到本機紀錄檔，2026-11-06 Lead 審查                                                                  | 本機行程                                                                                                                                                             |

hub 的 CSP 限制網頁只能連自己（`packages/hub/src/server.ts:76-87`：`default-src 'self'`、
`connect-src 'self'` 加上同主機的 ws/wss），網頁就算被注入也連不到外部 LLM。
service worker（`packages/web/src/flows/pwa/sw.js`）只處理 `install`、`activate`、`push`、
`notificationclick`，沒有 `fetch`。

安裝時 `npm ci` 會跑原生模組的安裝腳本（`argon2`：`node-gyp-build`；`node-pty`：
`scripts/prebuild.js || node-gyp rebuild`），沒有預編譯檔時 node-gyp 會從 nodejs.org 下載
Node 標頭檔。這是 npm 的行為，和 LLM 無關。

## Claude 的唯一使用方式：PTY 裡的 `claude`

- 執行檔：`AGENT_BOARD_CLAUDE_BIN`，預設 `claude`（`packages/daemon/src/config.ts:59`），開之前
  在 PATH 找到實際檔案（`packages/daemon/src/daemon.ts:94`）。
- 參數：`buildClaudeArgs`（`packages/daemon/src/session.ts:60-77`）只會產生
  `--resume <id>` 或 `--session-id <uuid>`、`--permission-mode <mode>`、唯讀 session 才有的
  `--disallowedTools Edit Write NotebookEdit`（只減少能用的工具）、可選的 `--model <name>`、
  `--name <name>`，以及「允許 session 派工」開著時的 `--mcp-config <daemon 產生的設定檔>` 與
  `--allowedTools <四個派工工具全名>`（MCP server 是本機的 `agent-board-mcp`，只連 daemon 的 socket；
  不加 `--strict-mcp-config`，使用者自己的 MCP 設定照舊；只允許那四個工具，不放寬別的）。
  沒有 `-p`／`--print`，所以永遠是互動模式，等使用者輸入。
  `packages/daemon/src/misc.test.ts:129` 有測試。
- 環境：繼承 daemon 的環境，拿掉 Claude Code session 標記與機器 token（`daemon.ts:47-58`、
  `:570-576`），加上 hook 的 socket 路徑與 session id、`TERM`、可選的 `CLAUDE_CONFIG_DIR`
  （`daemon.ts:578-591`）。**不設定** `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 等，所以模型
  呼叫由使用者自己登入的 `claude` 決定，中控台不代理、不轉送。
- hook：daemon 寫進 `<cwd>/.claude/settings.local.json` 的只有 `type: 'command'` 的
  `agent-board-hook <事件>`（`packages/hook/src/settings.ts:43-53`）。沒有 `type: 'prompt'`
  （那種 hook 會讓 Claude Code 另外呼叫模型）。hook 的輸出只有權限決定
  （`packages/hook/src/cli.ts:37-40`、`packages/daemon/src/approvals.ts:77-86`），不加
  `additionalContext`，不會往對話裡塞字。

## 送進 `claude` 的字從哪裡來（全部）

PTY 只有兩個寫入點：`ManagedSession.write`（`packages/daemon/src/session.ts:295`）與
`sendFirstPrompt`（`session.ts:376-377`）。往上追：

| 來源                                | 觸發者                                                                                                                                                                               | 位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 網頁終端機按鍵                      | 使用者打字                                                                                                                                                                           | `packages/web/src/terminal/controller.ts:169` → hub `hub.ts:515-519`（先寫操作紀錄）→ daemon `daemon.ts:327-328`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 卡片指令框                          | 使用者按送出                                                                                                                                                                         | `packages/web/src/canvas/CommandInput.tsx:30`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 收件匣、審核頁回覆                  | 使用者按送出                                                                                                                                                                         | `packages/web/src/flows/InboxPage.tsx:250`、`ReviewPage.tsx:300`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 完成提示的 `/clear`                 | 使用者按按鈕                                                                                                                                                                         | `packages/web/src/canvas/DoneHint.tsx:75`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 請隊長拆解（DISPATCH §6）           | 使用者按「請隊長拆解」                                                                                                                                                               | `packages/web/src/team/TaskBoard.tsx:265`（按鈕 `:292`），固定提示在 `team/decompose.ts` 的 `decomposePrompt`，送進**已存在**的隊長 session。提示多要求每項標上成員縮寫（`role`），回覆在前端依縮寫指派負責人，不另外送任何字                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 第一個指令                          | 使用者建立 session 時填（可從自己的範本帶入）                                                                                                                                        | `packages/web/src/flows/NewSessionPage.tsx:329` → hub `hub.ts:731-732`（寫操作紀錄）→ daemon `daemon.ts:415`，`SessionStart` 後送一次（`session.ts:372-379`），送出就清掉，重啟不會再送                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 交接規則                            | 使用者在團隊裡建立並啟用的規則（`on_done`／`on_file`／`on_fail`／`on_marker`）                                                                                                       | `packages/hub/src/handoff.ts` 的 `rulesFrom` 只取 `enabled` 的規則；排進共用的送字佇列 `packages/hub/src/delivery.ts`（`SafeDelivery`，`:113` 送文字、`:141` 送 Enter、`:142` 寫操作紀錄）。內容只有 `[Handoff]` 開頭的一句摘要、檔案路徑、分支名（`handoff.ts` 的 `handoffMessage`／`reportParts`），取自來源 session 的最後回覆，不是另外呼叫模型產生的                                                                                                                                                                                                                                                                                                                                                                                               |
| 任務自動執行（GM 2026-11-06）       | 使用者在任務板打開團隊的「任務自動執行」（`teams.task_auto`，預設關，開關寫 audit `team.task_auto`；全隊暫停／停止會關掉），之後移到進行中／待審查的任務                             | `packages/hub/src/tasks.ts` 的 `TaskEngine`：開關關著什麼都不送；同一條 `SafeDelivery` 佇列送出。內容是固定格式的一行：`[Task #n]` 任務標題＋團隊目標＋「完成時回覆 `[完成 #n]`」、`[Review #n]` 任務標題＋負責人回覆裡的一句＋檔案路徑＋分支、或審查退回原因的一句（`taskPrompt`／`reviewPrompt`／`rejectPrompt`）。下一步只由回覆裡的固定標記（純子字串）決定，不呼叫模型                                                                                                                                                                                                                                                                                                                                                                             |
| 額度恢復後自動接續（GM 2026-11-06） | owner 在設定「Session 與額度」打開 `Settings.autoContinue`（預設關，標 ◈ 耗額度；改設定寫 audit `settings.update`），之後因額度停下、而且限流訊息讀得出重置時間的 session            | `packages/hub/src/autoContinue.ts` 的 `AutoContinueEngine`：設定關著不排也不送；重置時間＋60 秒後排進同一條 `SafeDelivery` 佇列。內容是**固定的一行** `AUTO_CONTINUE_PROMPT`（`packages/protocol/src/models.ts`：`[Auto] The usage limit has reset. Continue where you left off.`），不帶任何對話內容。同一次限流只送一次；使用者在這之前打任何字、session 自己動起來、設定關掉就取消；讀不出重置時間就不送。排定與結果寫 audit `session.auto_continue`，送字照舊寫 `terminal.input`（user 為 null）                                                                                                                                                                                                                                                    |
| session 派工（GM 2026-11-06）       | owner 設定「允許 session 派工（MCP 工具）」（`Settings.dispatch`，預設開，標 ◈；關掉後新開的 session 不掛工具）；之後由 session 裡的 Claude 自己決定呼叫 `spawn_member`／`send_task` | `packages/hub/src/dispatch.ts` 的 `DispatchEngine`。`spawn_member` 走 `hub.createSession`（第一個指令＝`[From <呼叫者>] <Claude 寫的工作>`，一行、清控制字元、4000 字截斷，daemon 照一般 firstPrompt 送）；`send_task` 同樣一行，排進同一條 `SafeDelivery`。成員做完那一回合（`Stop`）時，把**固定格式**的 `[Result from <成員>] Summary: <最後回覆的一句> \| Detected file edits: … \| Branch: …`（`reportParts`，和交接同一套）送回呼叫者，一份工作只送一次；結果不算新工作，不會再觸發任何自動送字。上限：每個呼叫者同時 4 個成員、權限不比它寬、不能 bypassPermissions、成員不能再開成員、10 分鐘最多 20 則工作與 10 則結果。內容都是 session 裡的模型自己寫的（使用者叫它派工），中控台只轉送、不產生文字、不呼叫模型；每一步寫 audit `dispatch.*` |
| 終端機訊號                          | 使用者按 Esc／Ctrl+C／停止                                                                                                                                                           | `daemon.ts:335-339`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

全部 `type: 'terminal.input'` 的產生點只有 `hubBackend.ts:282-284`、`controller.ts:169`（網頁，
使用者動作）與 `hub.ts` 的 `sendInput`（只給共用的送字佇列 `delivery.ts` 用，也就是交接規則、任務自動執行、額度恢復後自動接續與 session 派工）。

**daemon 不會自己送 prompt。** daemon 只在收到 hub 的 `terminal.input`／`terminal.signal` 時寫
PTY，以及送使用者給的第一個指令。daemon 會自己做的事：重啟時用 `--resume` 接回原本的 session
（`daemon.ts:473`，不送任何字）；hub 也會在有名額時自動開始排隊中的 session（`hub.ts:783-790`），
送的是使用者建立時填的第一個指令。這兩者都只是開 `claude`，`claude` 啟動時自己會連什麼由
Claude Code 決定，不在中控台範圍。

## 什麼會打破這個保證

以下任何一項出現，就要重新審查並更新本文件與 `scripts/check-no-llm.mjs` 的 `CALL_SITES`：

- 加入任何 LLM SDK 或直接打 LLM API（例如用模型產生交接摘要、拆解任務、偵測狀態）。
- daemon 用 `claude -p`／`--print`、`--input-format stream-json` 等非互動模式，或在背景開
  `claude` 做事。
- hub 或 daemon 在使用者沒有動作、也沒有啟用規則的情況下送字進 PTY（例如自動回答對話框、
  自動 `/clear`、自動 `/compact`、定時「繼續」）。額度恢復後自動接續是唯一的「繼續」，
  只在使用者打開設定時、知道重置時間時送一次固定的一行。
- 額度恢復後自動接續預設開啟、設定關著也送、讀不出重置時間時用猜的，或內容改成帶對話。
- 派工工具在設定關著時仍然掛上或仍然能開成員、成員上限或權限上限被拿掉、結果改成帶完整對話，或結果送進呼叫者後又自動觸發新的工作。
- daemon 給 claude 加 `--strict-mcp-config`、把 `--allowedTools` 放寬到派工工具以外，或 MCP server 改成連 daemon 以外的地方。
- 交接規則預設啟用，或內容改成帶完整對話。
- 任務自動執行預設開啟、開關關著也送，或任務提示改成帶完整對話。
- hook 改用 `type: 'prompt'`／`type: 'agent'`，或回傳 `additionalContext` 往對話塞字。
- 給 `claude` 的環境加上 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL` 等，讓模型流量經過中控台。
- 網頁 CSP 放寬 `connect-src`，或加入連外的分析、遙測。
- 新增的第三方套件含 LLM 用戶端（`check:no-llm` 會掃到網址；SDK 被打包時也會掃到）。

## 限制

- 靜態審查：找的是寫法與網址特徵。用字串拼出來的網址、或執行期從設定檔讀進來的網址，掃描抓不到；
  這要靠 `CALL_SITES` 清單（任何新的 `fetch`／WebSocket／行程都會被擋下來審查）。
- 第三方套件只掃 `.js/.cjs/.mjs/.json`；原生模組（`.node`）沒掃，三個原生模組
  （`node-pty`、`better-sqlite3`、`argon2`）的用途與 LLM 無關。
- `claude` CLI 本身的行為不在範圍內。
- 本次沒有實際監聽網路流量（未驗證）。
