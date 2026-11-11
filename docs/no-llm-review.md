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
  session 裡的 Claude 自己呼叫派工工具（MCP，設定「允許 session 派工」開著時）送給成員的工作與送回的結果（2026-11-06 補）、
  使用者按「帶入進度卡」送出的卡片內容一行、按「請隊長更新 ◈」送出的固定一行（2026-11-08 P3 項目一補）。
  進度卡的 MCP 工具（get_progress／update_progress）只讀寫 hub 的資料，不送任何字進 PTY。
  隊長自主擴編（2026-11-10）：守則只寫在 MCP 工具說明與工具回傳裡（Claude 呼叫才看到），不用 hook 注入、不自動送字；
  `release_member` 走 hub 既有的封存流程（停 session、暫停交接規則），不送任何字進 PTY。
  全域搜尋（P3 項目三，快速層與 2026-11-09 的深層）只讀資料、回片段，不送任何字進 PTY、不呼叫模型。
  用量詳情（2026-11-09）沿用原本的用量統計：daemon 只讀本機對話紀錄檔算 token，hub 只存每台最新一筆，不送任何字進 PTY、不呼叫模型。
  daemon 不會自己產生 prompt。
  Codex 節點（2026-11-10，CONTRACTS §19）：Codex CLI 和 `claude` 一樣是使用者自己登入的官方互動式 CLI，由 daemon
  開在 PTY 裡（同一支 `session.ts`、同一個 `node-pty` 呼叫點），送進去的字是上面同樣的來源（使用者打的、新增 session
  時填的第一個指令——Codex 用官方的 `codex [PROMPT]` 帶入）。不用 `codex exec`／`review` 等非互動子指令，不帶
  `OPENAI_API_KEY`、不讀 `~/.codex/auth.json`。hook 只回權限決定（allow／deny），不輸出 `additionalContext`。
  發版與自動更新（2026-11-11，CONTRACTS §21）：hub 用已登入的 `gh`（子程序）查／下載 GitHub Release，daemon 只向
  已配對的 hub 下載成品、啟動獨立的更新程式（裝新版、重啟服務、健康檢查、回滾）。不送任何字進 PTY、不呼叫模型；
  更新失敗的推播只帶機器名稱、版本與原因代碼。
  發布檔自帶 Node（2026-11-11，CONTRACTS §21.10）：**建置時**（`build:release`、GitHub Actions）從 nodejs.org
  下載官方 Node、用官方 SHASUMS256 驗證後放進發布檔；各機執行時不下載任何東西，只用發布檔裡那支執行我們自己的程式。

## 重跑

```sh
corepack pnpm build:release   # 先打包，檢查才會掃 release/agent-board
corepack pnpm check:no-llm    # scripts/check-no-llm.mjs
```

通過時印出 `通過：沒有 LLM 呼叫；對外連線與終端機輸入共 29 處，都在審查清單內。`（2026-11-08 P3 項目一後重跑；進度卡沒有新增呼叫點，數字與 main 相同。2026-11-09 P3 ③b 深層搜尋後先跑 `build:release` 再重跑：原始碼 244 檔、第三方套件 134 個、發布檔 25 檔，仍是 29 處——深層搜尋沒有新的連線、行程或送字寫法，`CALL_SITES` 不用改。2026-11-10 session host 拆分後 35 處，審查修正加 `processCheck.ts` 後 36 處——`node-pty` 從 `session.ts` 搬到 `pty.ts`，新增 session host 的 socket、PTY、送字與 daemon 拉起 host 的 `launchctl`，見下表）
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
   耗用模型）。另外確認 `--allowedTools` 只會列 agent-board 自己的工具：protocol 的 `DispatchTool`＋`MemoryTool`
   必須正好是審查過的 7 個（`AGENT_BOARD_TOOLS`；2026-11-10 加 `release_member`），daemon 一律用 `mcp__agent-board__<tool>` 組全名（2026-11-08 加）。
   codex（2026-11-10 加，3c）：`packages/daemon/src/codex.ts` 與 `packages/protocol/src/codex.ts` 裡的參數只能是
   `resume`、`-s`、`-a`、`-m`、`-c`、`--dangerously-bypass-hook-trust`、`--dangerously-bypass-approvals-and-sandbox`
   （`CODEX_FLAGS`），不得出現 `exec`、`e`、`review`、`--json`、`-o`／`--output-last-message`（非互動模式會直接耗用模型）；
   daemon 原始碼不得出現 `codex exec`。開 codex 和開 claude 是同一個 `node-pty` 呼叫點（`session.ts`），
   探測版本是 `resources.ts` 既有的 `child_process`（多跑一次 `codex --version`），所以 `CALL_SITES` 沒有新增項目，仍是 29 處。

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

| 位置                                                                   | 做什麼                                                                                                                                                                                                                                                                                                                                                                                                      | 連到哪                                                                                                                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/daemon/src/pair.ts:52`                                       | `fetch` 交換配對碼                                                                                                                                                                                                                                                                                                                                                                                          | 使用者用 `--hub` 指定的 hub                                                                                                                                          |
| `packages/daemon/src/hubClient.ts:109`                                 | `ws` 連線，斷線重連                                                                                                                                                                                                                                                                                                                                                                                         | 配對時存下的 hub 網址                                                                                                                                                |
| `packages/daemon/src/pty.ts`（`localPtyBackend`）                      | `node-pty` 開 `claude`／`codex`（見下節；2026-11-10 從 `session.ts` 搬過來，參數照舊由 `buildClaudeArgs`／`buildCodexArgs` 產生）                                                                                                                                                                                                                                                                           | 本機行程                                                                                                                                                             |
| `packages/session-host/src/server.ts`（session host）                  | 2026-11-10 session host 拆分（CONTRACTS §20）：`net` 聽本機 Unix socket／named pipe（token 驗證），`node-pty` 開 daemon 給的指令與參數（同上），把 daemon 轉來的輸入原樣寫進 PTY。不連網路、不解析畫面、不產生任何文字                                                                                                                                                                                      | 本機 socket／本機行程                                                                                                                                                |
| `packages/session-host/src/client.ts`                                  | daemon 用 `net.connect` 連 session host                                                                                                                                                                                                                                                                                                                                                                     | 本機 Unix socket／named pipe                                                                                                                                         |
| `packages/daemon/src/sessionHostLauncher.ts`                           | 連不上 session host 時跑 `launchctl kickstart gui/<uid>/<label>`／`systemctl --user start`／`schtasks /Run` 拉起它（服務名稱由安裝程式設定）                                                                                                                                                                                                                                                                | 本機行程                                                                                                                                                             |
| `packages/daemon/src/processCheck.ts`                                  | 重開 session 前確認上一個 agent 還在不在：`ps -o lstart= <pid>` 讀程序啟動時間（只讀）                                                                                                                                                                                                                                                                                                                      | 本機行程                                                                                                                                                             |
| `packages/daemon/src/resources.ts:36`                                  | `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`                                                                                                                                                                                                                                                                                                                                                    | 本機行程                                                                                                                                                             |
| `packages/daemon/src/resources.ts:51`                                  | `systeminformation` 的 `currentLoad()`、`mem()`                                                                                                                                                                                                                                                                                                                                                             | 本機（讀系統資訊；套件裡其他會連網的函式沒有被呼叫）                                                                                                                 |
| `packages/daemon/src/resources.ts:67`                                  | `claude --version`（探測版本，不送 prompt）                                                                                                                                                                                                                                                                                                                                                                 | 本機行程                                                                                                                                                             |
| `packages/daemon/src/worktree.ts:11`                                   | `git`（`rev-parse`、`worktree add/remove`、`branch -d` 等），`GIT_TERMINAL_PROMPT=0`                                                                                                                                                                                                                                                                                                                        | 本機行程                                                                                                                                                             |
| `packages/daemon/src/sessionFiles.ts:47`                               | 只執行 `git`（`status --porcelain -z`，刪除前檢查 worktree 有無改動），`GIT_TERMINAL_PROMPT=0`，2026-11-05 Lead 審查                                                                                                                                                                                                                                                                                        | 本機行程                                                                                                                                                             |
| `packages/daemon/src/hookServer.ts:40`                                 | `net.connect` 探測舊的 socket 是否還有人在聽                                                                                                                                                                                                                                                                                                                                                                | 本機 Unix socket／named pipe                                                                                                                                         |
| `packages/hook/src/cli.ts:67`、`:85`                                   | `net.connect` 把 hook 事件交給 daemon                                                                                                                                                                                                                                                                                                                                                                       | daemon 的本機 socket（環境變數給的路徑）                                                                                                                             |
| `packages/hook/src/mcp.ts`（`callDaemon`）                             | 派工 MCP server（stdio，claude 啟動的子行程）：`net.connect` 把工具呼叫原樣交給 daemon，2026-11-06 審查。自己不產生任何文字，回覆只是 hub 給的結果                                                                                                                                                                                                                                                          | daemon 的本機 socket（MCP 設定檔 env 給的路徑）                                                                                                                      |
| `packages/hub/src/push.ts:31`                                          | `web-push` 送推播                                                                                                                                                                                                                                                                                                                                                                                           | 瀏覽器訂閱時給的推播服務 endpoint（Apple／Google／Mozilla）。內容加密，只有 session id、名稱、狀態、時間（`push.ts:67-73`），不含終端機內容；`push.ts:76` 擋內網位址 |
| `packages/hub/src/config.ts`、`auth.ts`                                | 只用 `node:net` 的 `BlockList`、`isIP` 判斷位址                                                                                                                                                                                                                                                                                                                                                             | 不連線                                                                                                                                                               |
| `packages/web/src/shared/hubBackend.ts:57`                             | `fetch` 呼叫 REST API                                                                                                                                                                                                                                                                                                                                                                                       | 同源（相對路徑）                                                                                                                                                     |
| `packages/web/src/shared/hubBackend.ts:153`                            | WebSocket                                                                                                                                                                                                                                                                                                                                                                                                   | 同源 `location.host`                                                                                                                                                 |
| `scripts/installer.mjs`（隨發布檔散布）                                | `npm ci`、`launchctl`／`systemctl`／`loginctl`／`schtasks`、`node -e` 載入原生模組自我檢查、`daemon pair`；`fetch` 等本機 hub 起來（`/api/auth/status`）；`net.createServer` 找空的埠                                                                                                                                                                                                                       | 本機與 npm registry                                                                                                                                                  |
| `packages/hub/src/release.ts`（`execGh`）                              | 2026-11-11 發版與自動更新（CONTRACTS §21）：hub 機器上**已登入**的 `gh` CLI（子程序）：`gh auth status`、`gh release list --repo <repo> --json …`、`gh release download v<版本> --pattern …`。子程序環境拿掉 `GH_TOKEN`／`GITHUB_TOKEN`／`GH_ENTERPRISE_TOKEN`／`GITHUB_ENTERPRISE_TOKEN`，hub 不讀任何權杖檔，gh 只能用自己登入時存的憑證。只下載成品與 `SHA256SUMS`、驗 SHA-256；不送任何資料、不呼叫模型 | GitHub（Releases，經 gh）                                                                                                                                            |
| `packages/hub/src/server.ts`（`GET /api/releases/:version/:platform`） | daemon 下載成品：機器 token 驗證，只回 `<dataDir>/release-cache/` 裡驗過 SHA-256 的檔案（hub 代轉，其他機器不放 GitHub 權杖）                                                                                                                                                                                                                                                                               | 無（回應 daemon）                                                                                                                                                    |
| `packages/daemon/src/selfUpdate.ts`                                    | 自動更新：`fetch` 用機器 token 向已配對的 hub 下載成品（驗 SHA-256）；系統 `tar -xf` 解壓；以 detached 方式啟動新版裡的 `node scripts/updater.mjs`（不送字進 PTY、不碰 agent）                                                                                                                                                                                                                              | 已配對的 hub                                                                                                                                                         |
| `scripts/updater.mjs`（隨發布檔散布）                                  | 獨立更新程式：跑新版的 `installer.mjs install`／`switch`、舊版 hub 的 `schema-version`；`fetch` 只連本機 hub 的 `/api/health` 做健康檢查；用目前這版的 better-sqlite3 備份 hub.db                                                                                                                                                                                                                           | 本機 hub                                                                                                                                                             |
| `scripts/install.sh:137`、`install.ps1:79`                             | 下載發布檔與 `.sha256`                                                                                                                                                                                                                                                                                                                                                                                      | `AGENT_BOARD_RELEASE_URL`（預設 GitHub Releases）                                                                                                                    |
| `scripts/install.sh`（偵測到 `AGENT_BOARD_SESSION_ID` 時）             | `node -e` 用 `child_process.spawn` 以 `detached` 重跑 `sh install.sh` 自己，輸出寫到本機紀錄檔，2026-11-06 Lead 審查                                                                                                                                                                                                                                                                                        | 本機行程                                                                                                                                                             |

hub 的 CSP 限制網頁只能連自己（`packages/hub/src/server.ts:76-87`：`default-src 'self'`、
`connect-src 'self'` 加上同主機的 ws/wss），網頁就算被注入也連不到外部 LLM。
service worker（`packages/web/src/flows/pwa/sw.js`）只處理 `install`、`activate`、`push`、
`notificationclick`，沒有 `fetch`。

### 建置時下載 Node（2026-11-11，CONTRACTS §21.10）

`scripts/fetch-node.mjs`（只在 `build:release` 與 GitHub Actions 的建置裡執行，**不進發布檔、各機執行時不會跑**）：
`fetch` 只連 `https://nodejs.org/dist/v<版本>/`，下載 `SHASUMS256.txt` 與這個平台的官方成品（版本＝`package.json`
的 `bundledNode`），用官方 SHASUMS256.txt 驗 SHA-256，不符就中止；用系統 `tar` 解開，只取 `node` 執行檔與
`LICENSE` 放到 `release/agent-board/runtime/node/`。不送任何資料、不呼叫模型。build-release 接著用這支 node 跑
`npm ci`（同下段的安裝腳本）與原生模組載入檢查。`check-no-llm` 掃發布檔時略過 `runtime/`（未修改的官方二進位檔）。
執行時：hub、daemon、session host、更新程式、安裝程式、hook 包裝、派工 MCP server 都用這支 node 跑我們自己的程式，
它本身不連任何地方。

安裝時 `npm ci` 會跑原生模組的安裝腳本（`argon2`：`node-gyp-build`；`node-pty`：
`scripts/prebuild.js || node-gyp rebuild`），沒有預編譯檔時 node-gyp 會從 nodejs.org 下載
Node 標頭檔。這是 npm 的行為，和 LLM 無關。

## Claude 的唯一使用方式：PTY 裡的 `claude`

- 執行檔：`AGENT_BOARD_CLAUDE_BIN`，預設 `claude`（`packages/daemon/src/config.ts:59`），開之前
  在 PATH 找到實際檔案（`packages/daemon/src/daemon.ts:94`）。
- 參數：`buildClaudeArgs`（`packages/daemon/src/session.ts:60-77`）只會產生
  `--resume <id>` 或 `--session-id <uuid>`、`--permission-mode <mode>`、唯讀 session 才有的
  `--disallowedTools Edit Write NotebookEdit`（只減少能用的工具）、可選的 `--model <name>`、
  `--name <name>`，以及「允許 session 派工」或「讓 session 讀寫進度卡」開著時的 `--mcp-config <daemon 產生的設定檔>` 與
  `--allowedTools <開著的功能的工具全名>`（派工 5 個、進度卡 2 個，最多 7 個，全部是 `mcp__agent-board__*`；
  MCP server 是本機的 `agent-board-mcp`，只連 daemon 的 socket；兩個設定都關就完全不掛；
  不加 `--strict-mcp-config`，使用者自己的 MCP 設定照舊；只允許 agent-board 自己的工具，不放寬別的）。
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

## Codex 的唯一使用方式：PTY 裡的 `codex`（2026-11-10）

- 執行檔：`AGENT_BOARD_CODEX_BIN`，預設 `codex`（`packages/daemon/src/config.ts`）。開機時跑一次 `codex --version`
  探測版本（`resources.ts` 的 `probeCodex`，不送 prompt），找不到就不回報、不能開 Codex session。
- 參數：`buildCodexArgs`（`packages/daemon/src/codex.ts`）只會產生 `resume <thread id>`（接回使用者自己的對話）、
  權限換算的 `-s <sandbox> -a <approval>` 或 `--dangerously-bypass-approvals-and-sandbox`（使用者選了 bypass）、
  可選的 `-m <model>`、`--dangerously-bypass-hook-trust`（只讓這次啟動跳過 hook 信任確認）、每個 hook 事件一個
  `-c hooks.<Event>=[{hooks=[{type="command",command="agent-board-hook --agent codex --session <id> --socket <path> <Event>",…}]}]`，以及新對話時
  `--` 後面使用者填的第一個指令。沒有 `exec`，所以永遠是互動式 TUI，等使用者輸入。`codex.test.ts` 有測試。
- hook：只有 `type = "command"`，不用 `prompt`／`agent`／`mcp_tool` 型別（`prompt`／`agent` 會讓 CLI 另外呼叫模型）。
  hook 的輸出只有權限決定（`codexHookOutput`），不輸出 `additionalContext`、`systemMessage`，Stop 不回 `decision: block`
  （那會把 reason 當新的使用者 prompt 送進去）。
- 環境：同 claude（拿掉 session 標記與機器 token），不設 `CLAUDE_CONFIG_DIR`，也不設 `OPENAI_API_KEY`、
  `OPENAI_BASE_URL`、`CODEX_API_KEY`，模型呼叫由使用者自己登入的 `codex` 決定。daemon 不寫 `~/.codex`、不建專案 `.codex`、
  不讀 `auth.json`；重啟接回時只列出 `$CODEX_HOME/sessions`（預設 `~/.codex/sessions`）底下的檔名、掃一次，找 thread 的
  對話紀錄是否存在（不讀檔案內容）。開 Codex 前只檢查 cwd 到 repo 根目錄的 `.codex/hooks.json`、`.codex/config.toml`
  在不在（不讀內容），有就不開。

## 送進 `claude` 的字從哪裡來（全部）

PTY 只有兩個寫入點：`ManagedSession.write`（`packages/daemon/src/session.ts:295`）與
`sendFirstPrompt`（`session.ts:376-377`）。往上追：

| 來源                                                  | 觸發者                                                                                                                                                                               | 位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 網頁終端機按鍵                                        | 使用者打字                                                                                                                                                                           | `packages/web/src/terminal/controller.ts:169` → hub `hub.ts:515-519`（先寫操作紀錄）→ daemon `daemon.ts:327-328`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 卡片指令框                                            | 使用者按送出                                                                                                                                                                         | `packages/web/src/canvas/CommandInput.tsx:30`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 收件匣、審核頁、待處理回覆                            | 使用者按送出                                                                                                                                                                         | `packages/web/src/flows/InboxPage.tsx:251`、`ReviewCards.tsx:301`、`InboxBoard.tsx:289`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 完成提示的 `/clear`                                   | 使用者按按鈕                                                                                                                                                                         | `packages/web/src/canvas/DoneHint.tsx:75`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 請隊長拆解（DISPATCH §6）                             | 使用者按「請隊長拆解」                                                                                                                                                               | `packages/web/src/team/TaskBoard.tsx:265`（按鈕 `:292`），固定提示在 `team/decompose.ts` 的 `decomposePrompt`，送進**已存在**的隊長 session。提示多要求每項標上成員縮寫（`role`），回覆在前端依縮寫指派負責人，不另外送任何字                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 第一個指令                                            | 使用者建立 session 時填（可從自己的範本帶入）                                                                                                                                        | `packages/web/src/flows/NewSessionPage.tsx:329` → hub `hub.ts:731-732`（寫操作紀錄）→ daemon `daemon.ts:415`，`SessionStart` 後送一次（`session.ts:372-379`），送出就清掉，重啟不會再送                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 團隊 Preset 的隊長第一個指令（P3 項目二，2026-11-08） | 使用者在 Preset 填（存成 Preset／編輯 Preset），在預覽按「建立」或 Enter 套用                                                                                                        | `packages/web/src/team/PresetPicker.tsx` → `team/runPlan.ts`（只給隊長那一列）→ `createSession` 的 `firstPrompt`，之後同上一列。內容是 Preset 存的指令；勾了「附上進度卡」時前面加固定格式的一行 `[Progress card: <團隊>] Status: … \| Next: … \| Blockers: … \| GM notes: …`（`packages/protocol/src/presets.ts` 的 `leadFirstPrompt`／`progressCardLine`，取自 Preset 存的初始進度卡文字，清控制字元、不呼叫模型；沒有指令時不送）。Preset 存的交接規則與任務自動執行照存的開關建立，送字仍走下面「交接規則」「任務自動執行」兩列的路                                                                                                                                                                                                                                                                                                                |
| 送出第一個指令（P3 項目二，全部暫停中套用 Preset）    | 使用者在隊長卡片或團隊面板按「送出第一個指令」                                                                                                                                       | 暫停中套用時 `runPlan` 不帶 `firstPrompt`（daemon 的第一個指令不經暫停閘門，D7），指令只記在這台瀏覽器（`team/heldPrompts.ts`）。按下後 `team/HeldFirstPrompt.tsx` → `backend.broadcastToTeam`（點名隊長，P2 群發）→ hub `broadcast.ts` → `SafeDelivery` 的 `manual` 項目：只在隊長等輸入時送、忙就排隊、寫 audit `team.broadcast` 與 `terminal.input`。沒有新的送字寫法（`check:no-llm` 的清單不變）                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 交接規則                                              | 使用者在團隊裡建立並啟用的規則（`on_done`／`on_file`／`on_fail`／`on_marker`）                                                                                                       | `packages/hub/src/handoff.ts` 的 `rulesFrom` 只取 `enabled` 的規則；排進共用的送字佇列 `packages/hub/src/delivery.ts`（`SafeDelivery`，`:113` 送文字、`:141` 送 Enter、`:142` 寫操作紀錄）。內容只有 `[Handoff]` 開頭的一句摘要、檔案路徑、分支名（`handoff.ts` 的 `handoffMessage`／`reportParts`），取自來源 session 的最後回覆，不是另外呼叫模型產生的                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 任務自動執行（GM 2026-11-06）                         | 使用者在任務板打開團隊的「任務自動執行」（`teams.task_auto`，預設關，開關寫 audit `team.task_auto`；全隊暫停／停止會關掉），之後移到進行中／待審查的任務                             | `packages/hub/src/tasks.ts` 的 `TaskEngine`：開關關著什麼都不送；同一條 `SafeDelivery` 佇列送出。內容是固定格式的一行：`[Task #n]` 任務標題＋團隊目標＋「完成時回覆 `[完成 #n]`」、`[Review #n]` 任務標題＋負責人回覆裡的一句＋檔案路徑＋分支、或審查退回原因的一句（`taskPrompt`／`reviewPrompt`／`rejectPrompt`）。下一步只由回覆裡的固定標記（純子字串）決定，不呼叫模型                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 額度恢復後自動接續（GM 2026-11-06）                   | owner 在設定「Session 與額度」打開 `Settings.autoContinue`（預設關，標 ◈ 耗額度；改設定寫 audit `settings.update`），之後因額度停下、而且限流訊息讀得出重置時間的 session            | `packages/hub/src/autoContinue.ts` 的 `AutoContinueEngine`：設定關著不排也不送；重置時間＋60 秒後排進同一條 `SafeDelivery` 佇列。內容是**固定的一行** `AUTO_CONTINUE_PROMPT`（`packages/protocol/src/models.ts`：`[Auto] The usage limit has reset. Continue where you left off.`），不帶任何對話內容。同一次限流只送一次；使用者在這之前打任何字、session 自己動起來、設定關掉就取消；讀不出重置時間就不送。排定與結果寫 audit `session.auto_continue`，送字照舊寫 `terminal.input`（user 為 null）                                                                                                                                                                                                                                                                                                                                                   |
| session 派工（GM 2026-11-06）                         | owner 設定「允許 session 派工（MCP 工具）」（`Settings.dispatch`，預設開，標 ◈；關掉後新開的 session 不掛工具）；之後由 session 裡的 Claude 自己決定呼叫 `spawn_member`／`send_task` | `packages/hub/src/dispatch.ts` 的 `DispatchEngine`。`spawn_member` 走 `hub.createSession`（第一個指令＝`[From <呼叫者>] <Claude 寫的工作>`，一行、清控制字元、4000 字截斷，daemon 照一般 firstPrompt 送）；`send_task` 同樣一行，排進同一條 `SafeDelivery`。成員做完那一回合（`Stop`）時，把**固定格式**的 `[Result from <成員>] Summary: <最後回覆的一句> \| Detected file edits: … \| Branch: …`（`reportParts`，和交接同一套）送回呼叫者，一份工作只送一次；結果不算新工作，不會再觸發任何自動送字。上限：團隊總人數（設定 `autoStaff.teamLimit`，預設 12，2026-11-10 取代「每個呼叫者同時 4 個」）、同團隊 10 分鐘最多新增 4 位、權限不比它寬、不能 bypassPermissions、成員不能再開成員、10 分鐘最多 20 則工作與 10 則結果。內容都是 session 裡的模型自己寫的（使用者叫它派工），中控台只轉送、不產生文字、不呼叫模型；每一步寫 audit `dispatch.*` |
| 帶入進度卡（P3 項目一，2026-11-08）                   | 使用者在進度卡上按「帶入進度卡 ▾」、選一個 session                                                                                                                                   | `packages/hub/src/progress.ts` 的 `deliver`：內容是卡片欄位組成的**一行** `[Progress card: <團隊名>] Status: … \| Next: … \| Blockers: … \| GM notes: …`（`protocol/src/progress.ts` 的 `progressLine`：空欄位略過、清控制字元、4000 字截斷），欄位是 GM 打的字或 session 裡的 Claude 用 `update_progress` 寫的字，中控台不產生文字。走團隊群發同一條 `SafeDelivery`（`DeliveryItem.manual`：只在對象等輸入時送、忙就排隊、全部暫停不擋），audit `progress.deliver`，送字照舊寫 `terminal.input`                                                                                                                                                                                                                                                                                                                                                       |
| 請隊長更新 ◈（P3 項目一，2026-11-08）                 | 使用者在團隊進度卡上按「請隊長更新」（標 ◈ 耗額度）                                                                                                                                  | `progress.ts` 的 `askUpdate`：**固定的一行** `PROGRESS_ASK_UPDATE_PROMPT`（`[Board] Please update the team progress card with update_progress (status, next, blockers).`）送給隊長，同一條 `SafeDelivery manual`，audit `progress.ask_update`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 終端機訊號                                            | 使用者按 Esc／Ctrl+C／停止                                                                                                                                                           | `daemon.ts:335-339`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

全部 `type: 'terminal.input'` 的產生點只有 `hubBackend.ts:282-284`、`controller.ts:169`（網頁，
使用者動作）與 `hub.ts` 的 `sendInput`（只給共用的送字佇列 `delivery.ts` 用，也就是交接規則、任務自動執行、額度恢復後自動接續、session 派工、團隊群發，以及進度卡的「帶入進度卡」「請隊長更新」）。

**進度卡（P3 項目一，2026-11-08）不會自己送字。** MCP 工具 `get_progress`／`update_progress` 走派工同一條路（claude → `agent-board-mcp` → daemon socket（密鑰）→ hub `ProgressEngine`），只讀寫 hub 資料庫裡的卡片；寫入不算交接、不算任務完成、不排進 `SafeDelivery`，不觸發任何送字。不用 hook `additionalContext`、不寫檔案進專案資料夾、session 開好後也不自動送卡片內容（`docs/p3-spec.md` §1.3）。設定 `Settings.memory`（預設開）只決定 daemon 掛不掛這兩個工具；卡片的「自動事實」由 hub 從既有資料算，不呼叫模型。

**全域搜尋（P3 項目三）不送任何字。** 快速層（③a）只讀 hub 自己的 SQLite。深層（③b，2026-11-09，`docs/p3-spec.md` §3.6、CONTRACTS §16）只有使用者按 Enter（或「也搜對話與終端機」鈕）時才跑：
瀏覽器送 `search.deep` → hub（`packages/hub/src/deepSearch.ts`）在**既有的** daemon WebSocket 上送 `search.request`／`search.cancel`（不是新的連線）→
daemon（`packages/daemon/src/deepSearch.ts`）只做兩件本機的讀取：用 `fs.open`（唯讀、`O_NOFOLLOW`）逐塊讀 `<CLAUDE_CONFIG_DIR>/projects/*/<claudeSessionId>.jsonl`（找檔用 `sessionFiles.ts` 的 `indexTranscripts`，規則同 `findTranscriptFiles`；解析沿用 `transcript.ts` 的 `parseLine`／`countEntries`；CLAUDE_CONFIG_DIR 只認這台開過 session 的），
以及讀記憶體裡 headless xterm 的畫面（`ManagedSession.screenLines`，只讀 buffer，不寫 PTY）。比對是 protocol 的子字串規則（`parseSearchTerms`／`makeSnippet`），不是語意搜尋、不呼叫模型；
結果只回 ≤ 160 字的片段（`search.result`／`search.done`），hub 只轉送給發起的那條瀏覽器連線、不存、不建索引（守 CONTRACTS §2），每次搜尋寫一筆 audit `search.deep`。
daemon 端不開行程、不對外連線、不送 `terminal.input`；有讀檔總量（1GB）、時間（15 秒）、筆數上限與取消，hub 送來的上限 daemon 會再收斂到自己的天花板以內。

全部暫停（P2 項目三，`hub.ts` 的 `pauseBoard`）的「立刻中斷」由 hub 對每個 RUN session 送
`terminal.signal escape`（只有 Esc，不送任何文字；使用者按下按鈕才送，帶 `onlyIfStatus: 'running'` 讓 daemon 再確認）。
暫停本身只會讓 `SafeDelivery` 少送，不會多送（按暫停時已打進輸入框、等 Enter 的那一則照樣按完 Enter，字是暫停前就送出的）；
「全部繼續」只放出原本就排著的，不另外產生文字。daemon 對帶 `onlyIfStatus` 的 signal 只回報結果（`terminal.signalResult`），不送字。

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
- daemon 用 `codex exec`、`codex review`、`codex app-server` 驅動 Codex，或在背景開 `codex` 做事；
  Codex 的 hook 改用 `prompt`／`agent` 型別、輸出 `additionalContext`，或 Stop hook 回 `decision: block`（會自動送新 prompt）。
- hub 或 daemon 在使用者沒有動作、也沒有啟用規則的情況下送字進 PTY（例如自動回答對話框、
  自動 `/clear`、自動 `/compact`、定時「繼續」）。額度恢復後自動接續是唯一的「繼續」，
  只在使用者打開設定時、知道重置時間時送一次固定的一行。
- 額度恢復後自動接續預設開啟、設定關著也送、讀不出重置時間時用猜的，或內容改成帶對話。
- 派工工具在設定關著時仍然掛上或仍然能開成員、成員上限或權限上限被拿掉、結果改成帶完整對話，或結果送進呼叫者後又自動觸發新的工作。
- 隊長守則改成用 hook `additionalContext` 注入、session 開好後自動送進對話，或 hub 在收到任務／卡住時自動替隊長呼叫 `spawn_member`（目前只有 Claude 自己呼叫工具才會新增或封存成員）；團隊人數上限或「設定關掉＝不能新增也不能封存」被拿掉。
- daemon 給 claude 加 `--strict-mcp-config`、把 `--allowedTools` 放寬到 agent-board 工具（派工 5 個＋進度卡 2 個）以外，或 MCP server 改成連 daemon 以外的地方。
- 進度卡寫入改成會觸發送字（例如每回合結束自動提醒更新、寫入後自動帶入），或改用 hook `additionalContext`／寫檔案進專案資料夾把卡片塞進對話，或「帶入進度卡」「請隊長更新」改成沒有使用者按就送。
- 交接規則預設啟用，或內容改成帶完整對話。
- 全域搜尋改成用模型做語意搜尋或摘要、把對話紀錄或終端機內容存進 hub 或建索引、daemon 搜尋時開行程（例如叫 `claude` 或 `rg`）或往 PTY 送字，或改成打字時就自動對各台 daemon 搜（目前只有按 Enter 才搜）。
- 套用團隊 Preset 時在全部暫停中仍隨建立送出隊長第一個指令，或第一個指令前的進度卡那一行改成由模型產生。
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
- `claude`、`codex` CLI 本身的行為不在範圍內（例如 Codex 的 `--approve-for-me` 會用 Codex 自己的審查模型，daemon 沒有用）。
- 本次沒有實際監聽網路流量（未驗證）。
