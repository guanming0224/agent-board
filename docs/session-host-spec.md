# session host 拆分規格（草稿，2026-11-10）

來源：`docs/dispatch/2026-11-09_派工補充_AI接口與多機部署.md` §14「session host 拆分」。GM 11/10 決定 **Mac 與 Windows 都做**（原文只寫 Windows；本專案沒有用 tmux，見核對檔第 1 點）。

## 1. 目標與完成條件

- daemon 重啟或更新時，agent（claude／codex）**不中斷**；daemon 回來後重新接上，畫布輸出不缺。
- 完成條件（派工單）：agent 跑到一半時更新 daemon，agent 不中斷、畫布重新接上且輸出不缺。Mac mini 先做到，再到 Windows 實機驗證。
- 上架規則因此可以放寬：只更新 daemon／hub 時不必等 session 停下；只有 session host 本身更新才要等。

## 2. 現況（main `ba57d93`）

- `packages/daemon/src/session.ts`：每個 session 一個 node-pty ＋ 一個 headless xterm（畫面權威）＋狀態機。用到的 pty 介面只有：`spawn`、`onData`、`onExit`、`write`、`resize`、`kill`、`pid`。
- daemon 關閉（`Daemon.stop` → `detachAndKill`）送 SIGHUP 結束所有 agent，下次啟動用 `--resume` 接回。
- hook CLI、MCP server 都連 daemon 的 `~/.agent-board/hook.sock`。MCP 密鑰存在 daemon 記憶體，`stop()` 時 `clearMcpDir` 清掉。
- launchd 停 job 時預設會殺掉整個程序群組，所以 session host 一定要是**另一個 launchd job**，不能是 daemon 的子程序。

## 3. 設計

### 3.1 兩個程式

| 程式 | 職責 | 更新頻率 |
| --- | --- | --- |
| session host（新，`agent-board-session-host`） | 用 node-pty 開 agent、養著程序、每個 session 保留最近 N MB 原始輸出（環狀緩衝，附位元組序號）、轉送輸入與 resize、回報結束碼 | 很少；協定穩定後幾乎不動 |
| daemon（現有） | hub 連線、headless xterm 與狀態機、hook／MCP socket、審批、派工、搜尋、用量 | 隨發版 |

session host **不懂** claude／codex、不解析畫面、不連網路、不呼叫 LLM。

### 3.2 本機協定

- 傳輸：Mac／Linux 用 Unix socket `~/.agent-board/session-host.sock`（權限 600，資料夾 700）；Windows 用 named pipe `\\.\pipe\agent-board-session-host-<使用者 SID>`，只接受本機、同一使用者。
- 格式：NDJSON 控制訊息＋輸出資料用 base64（先求正確；量大再換二進位框）。
- 訊息（草案）：
  - daemon → host：`hello{protocol, token}`、`spawn{id, bin, args, env, cwd, cols, rows}`、`attach{id, fromSeq}`、`write{id, data}`、`resize{id, cols, rows}`、`kill{id, signal}`、`list`、`release{id}`（session 結束後清緩衝）。
  - host → daemon：`hello.ok{protocol, hostVersion, sessions:[{id, pid, alive, exitCode, seqStart, seqEnd}]}`、`output{id, seq, data}`、`exit{id, code, signal}`、`replay.gap{id, lostBytes}`（緩衝不夠時）。
- 驗證：host 啟動時產生隨機 token 寫進 `~/.agent-board/session-host.token`（600），daemon 讀檔帶入 `hello`。
- 版本：`hello` 交換 `protocol` 整數；不相容時 daemon 退回「自己開 pty」舊模式並在 hub 顯示警告（不會開不了 session）。

### 3.3 daemon 重啟時的接回流程

1. daemon 停：**不殺** agent。只關 hub 連線與 socket；狀態機快照（status、detail、claudeSessionId、contextTokens、等待中的審批 id）寫到 `~/.agent-board/state/<id>.json`。
2. daemon 起：連 host、`list`。
   - 還活著的 session：建 headless xterm，`attach{fromSeq: 緩衝開頭}` 重播輸出重建畫面，載入狀態快照，回報 hub。**不再 `--resume`。**
   - 已結束的：照現在的規則（`--resume` 接回或標結束）。
   - host 沒在跑：自動啟動 host（Mac 用 `launchctl kickstart`），失敗就退回舊模式。
3. 停機期間漏掉的 hook：
   - hook CLI 連不上 daemon 時**重試**（非阻擋事件最多 10 秒、阻擋事件在原本時限內），所以 2–5 秒的重啟期間事件不會掉。
   - 仍掉了的：接回後用畫面判斷補正（輸入框可見＝ASK、權限對話框＝PERM），和現在 `inputBoxVisible` 一樣的手法。
4. MCP：密鑰改存檔（`~/.agent-board/mcp/<id>.secret`，600），daemon 重啟不清；MCP server 本來就每次呼叫都重新連 socket，所以接得回來。
5. 等待中的審批：daemon 停機時 hook CLI 會失去連線；PermissionRequest 走 Claude 自己的終端機對話框（現有退路），所以畫布上那筆審批在接回後改成「請在終端機回答」。

### 3.4 session host 更新與整台重開機

- host 換版：等所有 session 不在 RUN／PERM／PLAN／starting 才重啟 host；重啟後照現在的 `--resume` 接回。
- 整台重開機：host 與 agent 都沒了，行為和現在一樣（`--resume`）。
- 自動啟動：Mac 新增 LaunchAgent `com.agent-board.session-host`（KeepAlive、`AbandonProcessGroup` 不需要，因為 agent 是 host 的子程序、host 不常停）；Windows 工作排程器多一個「登入時」工作。`install.sh`／`install.ps1` 都要改。

### 3.5 輸出緩衝

- 每個 session 預設 2 MB（約 headless 5,000 行 scrollback 的量級）；超過就丟最舊的，`seqStart` 往前推。重播時若 daemon 要的位置已被丟掉，送 `replay.gap`，畫布顯示「重新接上前有 N KB 輸出未保留」。
- 只在記憶體，不落地（避免把對話內容寫到磁碟）。

## 4. 實作順序

1. `PtyBackend` 介面：把 `session.ts` 對 node-pty 的依賴抽成介面，現有行為包成 `LocalPtyBackend`（純重構，測試不變）。
2. 新套件 `packages/session-host`：協定（zod，放 protocol）、Unix socket 伺服器、環狀緩衝、單元測試。
3. `HostPtyBackend`＋daemon 接回流程（3.3）、狀態快照、hook CLI 重試、MCP 密鑰存檔。
4. 安裝：launchd plist、install.sh、build-release 打包；e2e：跑到一半重啟 daemon，畫面與狀態正確。
5. Mac mini 上架實測（先在 fake claude 上驗證，再用 GM 的實際 session）。
6. Windows：named pipe、install.ps1 工作排程器、在 i7／4060 筆電實測（i7 需先裝 Tailscale）。

## 5. GM 決定（2026-11-10）

| 項目 | 決定 |
| --- | --- |
| daemon 重啟時漏掉的 hook | hook CLI 重試（非阻擋最多 10 秒）＋接回後看畫面補正；session host 不代收 hook |
| 每個 session 的輸出緩衝 | 2 MB，只在記憶體 |
| 上線方式 | 先用假 claude 的 e2e 驗證「跑到一半重啟 daemon」，全過就上架；上架後挑一個閒置 session 實際重啟 daemon 再驗一次 |
