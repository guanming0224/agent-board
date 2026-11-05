# 介面合約

Phase 1 各 agent 只看這份就能開工。型別的唯一來源是 `packages/protocol`（zod schema）；這份解釋**語意**。
`packages/protocol` 只有 Lead 能改；需要改就回報給 Lead。Claude Code 細節見 `docs/claude-code-notes.md`。

## 1. 共通約定

- 指令：這台機器沒有全域 pnpm，用 `corepack pnpm <cmd>`。檢查：`corepack pnpm -r typecheck`、`corepack pnpm -r test`、`corepack pnpm lint`。
- 所有套件 `import { ... } from '@agent-board/protocol'`，直接用 TS 原始碼。開發用 `tsx` 執行，發布才打包。
- 時間一律 ISO 8601 字串；ID 由建立方產生 `crypto.randomUUID()`。
- API 與 WebSocket 欄位 camelCase，SQLite 欄位 snake_case，hub 負責轉換。
- 程式碼、路徑、機器名稱不得寫死任何使用者的資料（DISPATCH §1.2）。範例資料只在 demo 模式與測試。
- **中控台本身不得呼叫 LLM**，eslint 已禁止 import Anthropic／OpenAI SDK。

## 2. 架構與資料歸屬

| 資料                                                | 擁有者        | 說明                                               |
| --------------------------------------------------- | ------------- | -------------------------------------------------- |
| PTY、畫面快照、輸出、待決定的 approval              | daemon        | hub 只轉送，**不保存終端機資料**                   |
| 機器、使用者、session 中繼資料、layout、團隊、audit | hub（SQLite） | daemon 回報的 `SessionRuntime` 覆蓋 hub 的對應欄位 |
| session 的 `archived`、`projectId`、`name`          | hub           | daemon 不知道也不該管                              |

hub 在記憶體留每個 session 最後 2 KB 輸出（不落地），只用來判斷按 Enter 時畫面是不是密碼提示，是的話 audit 不記內容。

### 團隊事件

- daemon 在 `PostToolUse` 且工具為 Write、Edit、MultiEdit、NotebookEdit 時送 `session.event`，type `file.changed`，payload 只有 `{ path }`。透過 shell 改的檔案偵測不到。
- 交接規則：`on_done` 是使用者標記完成或 PTY exit 0；`on_fail` 只算 `error`；`on_file` 在回合結束時判斷。只有目標是 `waiting_input` 才送，否則排隊。
- 同機器、同一個 working tree 且沒有各自 worktree 的成員，`teamMembersPut` 回 409 `worktree_required`。判斷用 `sameWorkingTree`（`packages/protocol/src/repo.ts`）：daemon 回報了 `repoRoot` 就比根目錄（同 repo 的不同子資料夾也算），還不知道時退回比資料夾是否相同或巢狀。同 repo 的 linked worktree 根目錄不同，不算。
- **只讀成員例外**（GM 2026-11-06）：兩個成員**都會改檔案**才算衝突。只讀 = 團隊角色是 `researcher` 或 `reviewer`，**而且** session 的 `permissionMode` 是 `plan`；兩個條件缺一就算會改檔案（例如 `reviewer` + `default`、`worker` + `plan`）。hub `hub/src/worktree.ts` 與 web `web/src/team/worktree.ts` 同一套規則（`isReadOnlyMember`）。
- **已知限制**：只在**加入**時檢查。已經是成員的改角色（`teamMembersPut` 對既有成員）不重新檢查；之後把只讀成員切出 plan 模式也沒有人重新檢查。工作台只在前端提醒：成員列上，目前規則下和別的成員衝突的（例如研究／審查不在 plan 又和會改檔案的成員共用資料夾），兩邊都顯示提醒文字（`memberClashes`）。
- **建立團隊時一起開 session**（`web/src/team/NewTeamForm.tsx`）：預設組合「只建團隊」（原本的行為）、小隊 LD+1 BD、標準 LD+2 BD+1 RV、探索 LD+1 RS+1 BD；每列可改角色、名稱（預設 `<團隊名>-LD`、`-BD1`…）、權限模式。預設權限：lead `default`、worker `acceptEdits`、researcher／reviewer `plan`（不預設 `bypassPermissions`、`dontAsk`）。資料夾：LD 用主資料夾、每個 BD 各開 worktree（daemon 確認不是 git 時不開）、RS／RV 共用主資料夾。送出前檢查：剛好一位 LD、名稱不空不重複、主資料夾裡最多一位會改檔案的。順序：`teamsCreate` → 每列 `sessionsCreate`（同畫布與 `#/new` 的路，worktree、hooks、額度排隊照常）→ `teamMembersPut`。團隊本身建不起來就停；某列失敗就記下是哪一步、原因，繼續下一列，**不刪任何已建立的東西**，全部成功才自動進工作台。

### Lead 對 DISPATCH 的增補（已回報 GM）

1. `queued` 狀態：§8-4 要求排隊，§4 的表沒有對應狀態。由 hub 設定，不是 daemon。
2. `settings` 鍵值表：§5.3-7、§7、§8 需要，§3 沒列。
3. `Settings.publicOrigin`：經 `tailscale serve` 等反向代理時，用它檢查 WebSocket `Origin`，並決定 cookie 要不要 `Secure`。
4. 限流偵測以 `StopFailure` hook 為主，輸出比對為輔。
5. approval 不開資料表：hook 卡在 daemon 上等，重啟後 hook 也不在了，存 DB 沒有意義。決定結果寫 `audit_log`、`session_events`。

### 權限與提問

- 任何登入使用者都能操作 session 與一般核准；**`kind: 'danger'` 的 approval 只有 `owner` 能決定**，hub 必須擋，前端要停用並說明。
- `behavior: 'answer'` 用來回答提問：`PermissionRequest` 回 `allow`，`updatedInput.answers` 以問題原文為鍵（實測 2.1.316 可行）。audit 與事件記為 answer。
- 配對指令固定為 `agent-board-daemon pair --hub '<origin>' --code <code>`。

## 3. Session 生命週期

```
使用者 POST /api/sessions
  → hub 寫入（同帳號有 session 限流、或超過 maxConcurrentSessions 時 status=queued，停在這裡；見 3.4）
  → hub 送 session.create 給 daemon（requestId、sessionId、spec）
  → daemon：需要時建 worktree → 合併 hook 設定 → 開 PTY
  → daemon 回 session.created 或 session.createFailed
```

### 3.1 daemon 開 PTY

指令：`claude [--session-id <uuid>|--resume <id>] [--permission-mode <mode>] [--model <m>] [--name <n>]`，**權限模式一定要明確帶**，`default` 傳 `manual`：不帶的話 claude 會用使用者設定裡的預設模式（可能是 auto），畫面的放手線就會說謊。
env 加入 `AGENT_BOARD_SESSION_ID`、`AGENT_BOARD_SOCKET`，有 `accountProfile` 時加 `CLAUDE_CONFIG_DIR`，`TERM=xterm-256color`。

worktree：`git worktree add <repo>/../.agent-board-wt/<slug> -b ab/<slug>`。

`firstPrompt`：PTY 就緒後寫入一次（第一個 `SessionStart` hook 之後）。

### 3.2 daemon 重啟

把 session 清單存在本機（資料夾由 `AGENT_BOARD_DATA_DIR` 決定，預設 `~/.agent-board/`）。重啟後逐一 `claude --resume <claudeSessionId>`，狀態先標 `starting`，再送 `daemon.hello` 對帳。

### 3.3 斷線

- daemon 斷線 → hub 把該機器 session 標 `offline`；重連後由 `daemon.hello` 帶回真實狀態。**session 不會因 hub 或網頁斷線而結束。**
- 重連用指數退避：1s 起、上限 30s、加 ±20% 抖動。

### 3.4 排隊（DISPATCH §8-4、§8-5）

沒有官方額度來源，§8-5「額度接近上限」用唯一可靠的訊號：同一個帳號已經有 session 是 `rate_limited`。

- **帳號**＝同一台機器＋同一個 `accountProfile`（`CLAUDE_CONFIG_DIR`）；`null` 與空字串都是該機器的預設帳號。另一台機器的同名資料夾是另一個帳號。
- `Settings.quotaGuards.queueWhenRateLimited`（預設 `true`，舊設定沒有這個鍵也是 `true`）開著時，新建（`POST /api/sessions`）與接續（`/resume`）的 session 只要同帳號有「還活著（`endedAt` 為 null）、狀態 `rate_limited`、重置時間還沒到」的 session，就進 `queued`，`statusDetail` 為 `QUEUE_DETAIL_RATE_LIMITED`（`'queue:rate_limited'`）。只因併發上限排隊的維持 `statusDetail: null`。排隊原因變了 hub 會更新 `statusDetail`。
- 放行：該帳號沒有符合條件的限流 session 時，`drainQueue` 依進入排隊的順序開始。觸發點：限流 session 離開 `rate_limited`（例如 Claude Code 自動續跑、使用者再下指令、結束）、設定改變、機器重連、以及**重置時間到**。帳號被擋的 session 不擋別的帳號，也不擋只等名額的 session。
- 重置時間：hub 從限流 session 的 `statusDetail` 解析（`hub/src/rateLimitReset.ts`），格式取自 claude 2.1.317：`resets 3pm (Asia/Taipei)`、`resets Nov 5, 3pm (UTC)`、跨年加年份。認不出來（例如 `StopFailure` 的 `429 Too Many Requests`）就只等狀態改變。到期後再等 60 秒才放行。限流 session 本身的狀態不變，仍顯示 `rate_limited`。
- daemon：`StopFailure` 先到、畫面上帶重置時間的訊息後到時，狀態機送一次 `from === to` 的 `StatusChange` 補上 `statusDetail`，`at` 沿用進入限流的時間（`statusSince` 不重算）。

## 4. Hook 協定

### 4.1 安裝

開 session 時合併寫入 `<cwd>/.claude/settings.local.json`：

- 事件見 `HookEventName`，command 為 `agent-board-hook <Event>`，`timeout` 為 `HOOK_TIMEOUT_SECONDS`。
- **不得覆蓋使用者原有設定**；重複安裝要冪等；JSON 壞掉就不動它，**回 `session.createFailed`，不開 PTY**，訊息寫明哪個檔案壞了、怎麼修。hook 沒裝上時危險指令檢查不會執行，所以各種權限模式都一樣。

### 4.2 agent-board-hook CLI

```
agent-board-hook <EventName>   stdin：Claude Code 的 JSON
```

**這支程式跑在使用者每一次工具呼叫的路徑上，鐵律：**

- 沒有 `AGENT_BOARD_SESSION_ID` → 立刻 exit 0、不輸出（使用者自己開的 `claude` 也會讀到同一份設定）。
- **永遠不准 exit 2**，也不准印 JSON 以外的東西到 stdout。任何例外都 exit 0。
- 連不上 socket：exit 0 不輸出。唯一例外見 4.3。
- 只有 `BLOCKING_HOOK_EVENTS` 會等回答，上限 `HOOK_WAIT_MS`；超時 exit 0 不輸出，交回原生流程。其他事件送出就走，總耗時目標 < 100ms。

傳輸：NDJSON（`HookRequest` → `HookReply`），`AGENT_BOARD_SOCKET` 是 unix socket 或 Windows named pipe（`\\.\pipe\agent-board-<id>`）。

### 4.3 危險指令

`PreToolUse` 且工具為 Bash：daemon 用 `dangerRules`（hub 在 `hub.welcome` 下發）解析 `tool_input.command` **實際會執行的指令**再比對（`packages/daemon/src/dangerRules.ts`），認得旗標順序、路徑、前綴、串接、`bash -c` 等；`text:` 開頭的規則比對原始文字。判定表與做不到的變形見 `docs/security-checklist.md`。**這不是安全邊界**，只防手滑與一般情況。

- 命中 → daemon 建 `kind: 'danger'` approval，hook 卡住等待 → 回 `permissionDecision: allow|deny`。**不用 `ask`**（見筆記，`dontAsk` 下會被拒）。
- 未命中 → `output: null`。
- 命中但連不到 daemon：hook 無法判斷是否命中，對 Bash 回 `permissionDecision: "ask"`；其他工具 exit 0。超時也回 `deny`，**危險指令失敗要往安全的方向**。

超時與斷線的規則：PreToolUse + Bash **超時回 `deny`**；**連不上、中途斷線或回答壞掉回 `ask`**。其他 blocking 事件一律安靜結束，交回原生流程。

**必須確保 hook 找得到**：`agent-board-hook` 不在 PTY 的 PATH 上時會 exit 127，Claude Code 視為非阻擋錯誤照常執行工具，危險指令檢查就被靜默跳過。daemon 開 session 前要確認 hook 可執行，找不到就不開並回 `session.createFailed`。

### 4.4 網頁核准

```
PermissionRequest hook → daemon（建 Approval，卡住）→ hub → 瀏覽器
瀏覽器 approval.decide → hub（寫 audit）→ daemon → hook 印 decision JSON
```

`allow` + `remember` → `updatedPermissions` 帶 `suggestions`。`deny` → `message` 帶 reason。
使用者改在終端機處理 → 送 `approval.resolved by: 'terminal'`。
**未驗證：hook 卡住時原生對話框的行為**（筆記「未驗證」第一項）。實作要把核准方式封裝在單一模組，Phase 2 若要改成送按鍵才不用大改。

## 5. 狀態機（DISPATCH §4）

| 事件                                                                            | 新狀態                                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| PTY 開啟                                                                        | `starting`                                                                                     |
| `SessionStart`（`source` 為 startup 或 resume）且目前是 `starting`              | `waiting_input`                                                                                |
| `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`           | `running`                                                                                      |
| `Notification` + `permission_prompt`，或 `PermissionRequest`                    | `waiting_permission`                                                                           |
| `Notification` + `idle_prompt`（不覆蓋 `plan_review`、`rate_limited`、`error`） | `waiting_input`                                                                                |
| `PermissionRequest` 且 `tool_name == 'ExitPlanMode'`                            | `plan_review`（實測：計畫是這樣送出的；plan 模式下的 `Stop` 可能只是提問或計畫剛被拒絕，不算） |
| `Stop`                                                                          | `waiting_input`                                                                                |
| `StopFailure` + `rate_limit`，或輸出比對到用量上限                              | `rate_limited`                                                                                 |
| `StopFailure` 其他                                                              | `error`                                                                                        |
| PTY exit ≠ 0                                                                    | `error`                                                                                        |
| PTY exit 0（使用者自己離開）                                                    | `done`，並設 `endedAt`                                                                         |
| `running` 且超過 `stuckMinutes` 沒輸出                                          | `stuck`；有新輸出回 `running`                                                                  |
| 使用者標記（hub）                                                               | `done`                                                                                         |
| 機器斷線（hub）                                                                 | `offline`                                                                                      |
| 超過併發上限（hub）                                                             | `queued`                                                                                       |

| 同帳號有 session 限流（hub，3.4） | `queued` |

判斷不出來就維持或回到 `running`，**不要誤報**。其他 `notification_type` 只記錄不改狀態。每次變化寫 `session.event`（type `status`，payload 含 from、to、原因）並更新 `session.runtime`。

`PostToolUse`、`PostToolUseFailure` 的細則：工具結束不代表下一步開始，所以它們**只**讓 `stuck`、`starting`（僅主線）、`waiting_permission` 回 `running`，不動 `waiting_input`、`plan_review`、`rate_limited`、`error`。`waiting_permission` 要等同一 agent、同工具、同輸入的待決請求都結算才離開。子代理（payload 有 `agent_id`）的 PreToolUse 只讓 `stuck` 回 `running` 或結算自己的請求；主線 PreToolUse 一律回 `running`。

### 5.1 daemon 內部介面

`packages/daemon/src/status/types.ts` 定義 `StatusTracker`：**Agent B 實作、Agent A 呼叫**。A 不准改 `src/status/`，B 不准碰其外。兩邊都只依賴這個介面，整合時由 Lead 接線。

## 6. WebSocket

- `/ws/daemon`：`Authorization: Bearer <機器 token>`，訊息 `DaemonToHub`／`HubToDaemon`。連線後 daemon 先送 `daemon.hello`，hub 回 `hub.welcome`。
- `/ws/client`：登入 cookie，且檢查 `Origin`；訊息 `ClientToHub`／`HubToClient`。連線後 hub 先送 `board.state`。
- **未登入的升級請求一律 401**（DISPATCH §10）。訊息一律用 zod 驗證，不合法就丟棄並回 `error`，不關連線。

### 6.1 終端機串流

1. client 送 `terminal.subscribe`。hub 第一個訂閱者才往 daemon 訂閱。
2. daemon 回 `terminal.snapshot`（`seq` 為快照涵蓋到的序號），之後持續 `terminal.output`（`seq` 遞增）。
3. client 寫入 snapshot，丟棄 `seq` ≤ 快照的 output。**發現跳號就重新 subscribe**。收到新快照時要以它的 `seq` 重設序號，**包括比目前小的情況**：session resume 會開新 PTY，seq 從頭開始，hub 會替還在看的 client 重送訂閱。
4. 慢的 client：hub 緩衝超過 1 MiB 就丟掉該 client 的輸出並送新快照，不拖累其他人。
5. 全部 client 退訂後 hub 向 daemon 退訂；daemon 的 headless 仍持續更新。
6. **尺寸擁有者**：同一個 session 只有一個 client 的 resize 會套用到 PTY，其他人照 PTY 尺寸縮放顯示。
   - hub（`relay.ts`）記每個 session 的擁有者。還沒人擁有時，第一個送 `terminal.resize` 的訂閱者成為擁有者；之後只接受擁有者的 resize。
   - 使用者在終端機裡**打字或點擊**時，client 送 `terminal.resize` 帶 `claim: true` 搶下擁有權（程式自動 focus 不算）。`claim` 只在 hub 用，不轉給 daemon。
   - hub 在快照之後、以及尺寸或擁有者改變時，送 `terminal.size { cols, rows, owner }` 給每個訂閱者，`owner` 是 `you`、`other`、`none`。不接受的 resize 也回一則給送的人。
   - `other`：xterm 用遠端 cols/rows（輸出是照它排版的），整個等比縮小放進容器，遠端比較小就留白、不放大；不送 resize；外框外顯示說明（xterm 內不疊東西）。`none`：送一次 resize，即使尺寸相同。
   - 擁有者退訂或斷線：交給剩下的訂閱者中最近訂閱或搶過的那個，它收到 `you` 後送自己的尺寸。
   - 沒訂閱就送的 resize（腳本、舊版）不會成為擁有者，只在還沒人擁有時照舊轉送。
   - **沒人看時**：最後一個訂閱者離開（hub 送 `terminal.unsubscribe`，或 hub 斷線）後 30 秒，daemon 把 PTY 縮回預設 120×32（`IDLE_RESIZE_MS`）。等 30 秒是因為畫布切到全尺寸頁會先退訂再馬上訂閱，立刻縮回去會讓 TUI 多重畫兩次；期間有人訂閱或 resize 就取消。摘要卡的最後幾行照 PTY 寬度排版，不會一直是全尺寸頁的寬度。

7. hub 不存內容，所以後來的訂閱者與慢 client 要快照時，hub 會**再送一次** `terminal.subscribe`。daemon 收到重複訂閱要冪等，每次都回新快照。退訂仍只在最後一個 client 離開時才送。
8. 不合法的 daemon 訊息：hub 記 log 並丟棄，不斷線，也不回 error（`HubToDaemon` 沒有這個型別，daemon 是已驗證的對象）。

### 6.2 資源

client 看得到側欄時送 `resources.watch: true`。hub 有任何 watcher 才通知 daemon。daemon：CPU／RAM 每 5 秒、GPU 每 10 秒，沒人看就暫停。

### 6.3 資料夾瀏覽與 repo

`fs.listResult.repo`（REST `machineBrowse` 回應的 `repo`）是列出的資料夾本身所在的 git working tree：`root` 為 `git rev-parse --show-toplevel`、`commonDir` 為 `--git-common-dir`（都用 `--path-format=absolute`，需 git 2.31+）。不是 git、git 太舊或舊版 daemon 為 `null`。新 session 頁用它判斷「同一個 working tree」（建議 worktree）與「同 repo 但各自 worktree」（只告知）。

`SessionRuntime` 另帶 `repoRoot`、`repoCommonDir`（session 實際工作資料夾的同樣兩個值，daemon 開 PTY 時算一次）與 `contextWindow`（見 `docs/claude-code-notes.md`「Context 上限」）。舊版 daemon 不送時 zod 補 `null`。

## 7. REST

見 `packages/protocol/src/rest.ts` 的 `routes`。

- `auth`：`public` 不用登入；`user` 要登入；`owner` 要管理員。測試保證 `public` 只有 setup、login、status、pair。
- 錯誤：HTTP 狀態碼 + `ApiError`（`code` 穩定可比對，`message` 給人看）。
- 登入：argon2、cookie `httpOnly`、`SameSite=Strict`、`publicOrigin` 為 https 時 `Secure`。`authSetup` 只在沒有任何使用者時可用。
- 監聽：預設 `127.0.0.1`，可改指定 IP，**只接受 localhost 或私有 IP，拒絕 `0.0.0.0`、`::` 與公開 IP**；Host 不合法回 421（防 DNS rebinding），用自訂網域要先設 `publicOrigin`。環境變數 `AGENT_BOARD_HOST`、`AGENT_BOARD_PORT`（預設 8787）、`AGENT_BOARD_DATA_DIR`。
- audit：送入終端機的每筆輸入**以 Enter 為界**記一筆指令（不記每個按鍵）、每個 approval 決定。
- audit 查詢與匯出（`auditList`、`auditExport`）吃同一組篩選 `AuditQuery`：`action`、`sessionId`、`userId`、`from`、`to`，全部是 AND、時間含兩端。`userId=system`（`AUDIT_SYSTEM_USER`）查沒有使用者的紀錄（daemon、交接、登入失敗、reset-password 指令）。列表有 `limit`（預設 100、上限 1000）；匯出沒有上限、由舊到新、開頭有 BOM、防公式注入，`audit.export` 的 detail 記下用了哪些條件。
- 密碼：改自己的走 `usersUpdate`，必附 `currentPassword`。owner 重設**別人**的走 `usersResetPassword`（不需對方舊密碼，對方所有登入與 WebSocket 立刻失效，audit `user.password_reset`，detail 只有 id 與名稱）；對自己用回 400 `own_password`。唯一的 owner 忘記密碼：在 hub 機器上執行 `agent-board-hub reset-password <name>`（`packages/hub/src/resetPassword.ts`），直接改 `$AGENT_BOARD_DATA_DIR/hub.db`，終端機不回顯輸入、非終端機讀 stdin 第一行，撤銷該帳號所有登入，audit 記為系統（`via: cli`），不印密碼。資料庫不存在就停，不建新檔。hub 不帶參數才啟動，未知子指令 exit 2。
- 語言：登入前用這個瀏覽器的選擇（localStorage），沒有就跟瀏覽器。登入後（登入、開頁確認已登入）一律用 `User.locale`，並記到這個瀏覽器。登入後在頁首或設定頁換語言，畫面、瀏覽器、帳號（`PATCH /api/users/:id { locale }`）一起改。`flows/locale.ts`。
- 推播：每台裝置在設定頁各自訂閱（`flows/push.ts`），`pushSubscribe` 只收公開的 https endpoint。payload 是 `{ sessionId, name, status, at }`，不含終端機內容。service worker 是 `web/src/flows/pwa/sw.js`，hub 從網站根目錄以 `/sw.js`、`Cache-Control: no-cache` 提供，CSP 有 `worker-src 'self'`；點通知開 `#/inbox/<sessionId>`。

## 8. 前端（`packages/web`）

依賴方向：`canvas`、`flows` → `terminal` → `shared`。**`shared/` 與 `App.tsx` 只有 Lead 能改。**

| 路徑                              | 內容                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `src/shared/backend.ts`           | `BoardBackend` 介面：畫面只透過它存取資料                                            |
| `src/shared/fakeBackend.ts`       | 假資料實作，`?demo=1` 或測試時用；Phase 2 Lead 接真後端                              |
| `src/shared/store.ts`             | Zustand，`useBoard()`                                                                |
| `src/shared/i18n.ts`              | `useT()`、`registerMessages(locale, dict)`；各資料夾註冊自己的字串                   |
| `src/shared/status.ts`            | 狀態的符號、語意色、文字 key、排序（**不要自己再寫一份**）                           |
| `src/shared/terminal-contract.ts` | `TerminalViewProps`                                                                  |
| `src/shared/styles/tokens.css`    | 設計 token                                                                           |
| `src/terminal/index.ts`           | E 匯出 `TerminalView`                                                                |
| `src/canvas/index.ts`             | D 匯出 `CanvasPage`、`QueuePage`                                                     |
| `src/flows/index.ts`              | F 匯出 `NewSessionPage`、`ReviewPage`、`InboxPage`、`SettingsPage`、`OnboardingPage` |

**視覺規格：`docs/design/STYLE.md`（必讀）**，範例 `docs/design/style-sample.html`。token 都在 `tokens.css`，元件裡不寫死色碼。重點：顏色只回答「球在誰手上」、每張卡有放手線與模式晶片、xterm 內不疊任何東西、整個介面只有 diff 能出現綠色。

## 9. 封存、刪除、看舊資料（2026-11-05，GM 決策）

一定先封存才能刪除。封存可還原；刪除不可還原，只清 Agent Board 的紀錄與勾選的機器上檔案，**永遠不碰使用者的專案檔案**，**`audit_log` 一律保留**。schema：`sessions` 加 `archived_at`（v3）。

### 9.1 封存／還原（`sessionsUpdate { archived }`，auth user）

- `archived: true`：設 `archivedAt`。session 還沒結束（`endedAt === null`）時 hub 先停止它：`queued` 走取消排隊、其他送 `session.stop`（與 `sessionsStop` 同一條路）。從它出發或指向它（`action.toSessionId`）的交接規則全部改成 `enabled: false`。audit `session.archive`，detail `{"stopped":bool,"rulesPaused":n}`。
- `archived: false`：`archivedAt = null`，audit `session.restore`。不自動重開；已結束的照舊可按「接續」（`sessionsResume`）。被暫停的交接規則不自動恢復。
- 已封存的 session 不出現在畫布、待處理、推播。
- 機器離線時也能封存未結束的 session（detail `"stopPending":true`）；daemon 重連時 hub 對「已封存且 `endedAt` 為 null」的補送 `session.stop`。
- `sessionsResume` 遇到已封存的：自動還原（audit `session.restore` detail `{"via":"resume"}`）再接續。

### 9.2 檢查（`sessionInspect`，auth user）

hub 用資料庫裡的路徑組 `SessionLocator` 送 `session.inspect`，等 `session.inspectResult`（逾時同資料夾瀏覽，504）。`hooksShared` 由 hub 算：同一台機器、同一個 `cwd`、還存在的其他 session 數 > 0。機器離線 409 `machine_offline`。

### 9.3 對話紀錄（`sessionTranscript`，auth user）

- daemon 找檔：`<accountProfile ?? ~/.claude>/projects/*/<claudeSessionId>.jsonl`（不依賴路徑編碼規則，掃一層資料夾）。`claudeSessionId` 為 null 或檔案不存在 → `missing: true`、空頁。
- 逐行解析 JSONL：`type: user` 的文字（`message.content` 為字串或 text block）→ `user`；`tool_result` block → `tool`；`type: assistant` 的 text block → `assistant`，`tool_use` block → `tool`，內容 `→ <name> <input JSON 前 300 字>`。`isMeta: true`、其他 type 略過。每則 text 最多 4000 字（tool 最多 1000），超過截斷加 `…`。`at` 取 `timestamp`。
- `q`：不分大小寫的子字串；有 `q` 時 entries 只含符合的（保留原 `index`），`matched` 為符合數。`cursor` 是（篩選後）清單的位置，`limit` 預設 100、上限 500。
- 機器離線 409 `machine_offline`。

### 9.4 刪除（`sessionsDelete`，auth **owner**）

- 前提：`archived === true` 否則 409 `not_archived`；`endedAt === null` 否則 409 `session_active`。
- 勾了任何清理項而機器離線 → 409 `machine_offline`；`removeHooks` 而 `hooksShared` → 409 `hooks_shared`。都沒勾時不聯絡 daemon，三項結果 `skipped`。
- 有勾時送 `session.purge` 等 `session.purgeResult`（逾時 30 秒 → 504，**不刪** hub 資料）。daemon 不論勾選與否都從自己的 session 清單忘掉這個 id。
  - worktree：`worktreePath` 為 null → `not_found`；`git worktree remove <path>`（不加 --force）失敗 → `kept`（detail 說有改動）；成功再 `git branch -d <branch>`，失敗 → worktree 仍算 `removed`，detail 寫「分支 X 沒合併，保留」。
  - transcript：刪 `<id>.jsonl` 與同名資料夾；沒有 → `not_found`。
  - hooks：只拿掉 command 以 `agent-board-hook` 開頭的項目，其他設定不動；檔案壞掉 → `failed`，不覆寫。
- 保守規則：只刪 `.agent-board-wt/` 底下的 worktree（使用者自己的 linked worktree、主 worktree 一律 `kept`）；`branch -d` 只對 `ab/` 開頭的分支。先處理 hooks 再處理 worktree；勾了 removeWorktree 時，worktree 內我們寫的 hook 項目一律先拿掉（該資料夾要刪），拿完只剩 `{}` 就刪檔、`.claude` 空了也刪。等 purge 回覆期間 session 被還原或接續 → 不刪，回 409，audit `session.purge_aborted`。PurgeOutcome.detail 目前是中文字串（未 i18n）。`git worktree remove` 會連同被 gitignore 的檔案一起刪（例如全域 ignore 了 `.claude/settings.local.json`），worktree 資料夾是 Agent Board 建的，接受這個行為。
- 刪除時，其他 session 指向它的交接規則（`action.toSessionId`）一起刪除。
- daemon 回應後 hub 刪 `sessions` 那一列（events、layouts、團隊成員、從它出發的交接規則跟著 CASCADE；任務 owner 變 null），廣播 `session.removed`，audit `session.delete`，detail `{"name","cwd","machineId","result"}`。

### 9.5 前端

- 畫布：卡片「⋯」選單（重新命名、封存）、選取後按 Delete 鍵開封存確認、框選多張可一起封存。還在跑的先確認「會停止」；封存後 10 秒內可復原（即 `archived: false`）。
- 設定頁「已封存」：搜尋（名稱、呼號、資料夾、專案）、每列顯示對話大小（`sessionInspect`，機器離線顯示「—」）、開啟、還原、刪除（只有 owner 看得到）。
- 開啟 = 舊資料頁 `#/archive/<id>`：基本資料、狀態歷史（`sessionEvents`）、對話紀錄（可搜尋、載入更多）。
- 刪除確認框：列出一定刪、可選、一定留三組；預設勾 worktree（有的話）與 hooks（不共用時），**不勾** transcript；依 `sessionInspect` 顯示 git 警告（沒 commit、沒 push、分支沒合併）；按兩次確認。

### 9.6 共用與並行防護（審查後補，2026-11-05）

- `SessionInspect` 加 `worktreeShared`（同機器另一個 session 的 `worktreePath` 相同，或其 `cwd` 在這個 worktree 底下）與 `transcriptShared`（同機器、同 `accountProfile` 另一個 session 記著同一個 `claudeSessionId`）。刪除時勾 `removeWorktree` 而 worktreeShared → 409 `worktree_shared`；勾 `removeTranscript` 而 transcriptShared → 409 `transcript_shared`。前端遇到共用就停用該選項並說明。
- 刪除鎖：hub 對刪除中的 session 記在 `deleting`，期間 `sessionsResume`、`sessionsUpdate { archived: false }`、以及同機器同 cwd 或落在其 worktree 內的 `sessionsCreate` 一律 409 `session_deleting`。鎖到 daemon 回 `purgeResult` 或 daemon 斷線才解（hub 先回 504 也不解）。
- daemon：session 活著或建立中 → purge 回 `error: 'session_active'`，什麼都不做；`purging` 集合中的 id 不能建立；同一 id 的 purge 序列化。hook 安裝與移除對同一個設定檔共用 mutex。
- worktree 只在下列全部成立時移除：`worktreePath` 是絕對路徑、`realpath` 與 `resolve` 相同（沒經過 symlink）、位於 `<主 worktree>/../.agent-board-wt/` 底下、`git worktree list --porcelain` 有一筆剛好是它且分支是 `refs/heads/ab/…` 並等於 `branch`；remove 用 realpath。否則 `kept`。
- daemon 對 `accountProfile` 要求絕對路徑，否則對話紀錄相關回 error。`ClaudeSessionId` 改成嚴格 UUID；hub 從資料庫組 locator 時，不合格的 id 當成 null。建立 session 時 `resumeClaudeSessionId` 用 `ClaudeSessionId`、`accountProfile` 用 `AbsolutePath` 驗證。
- 對話紀錄讀取：daemon 同時只跑一個讀取、有 deadline（同 hub 逾時）到期就停；行內沒有 `"type":"user"`／`"type":"assistant"` 就不 `JSON.parse`，超過 8 MB 的行跳過；搜尋比對截斷前的全文。
- `ClaudeSessionId` 解析後一律轉小寫；hub 的共用比對用 `lower()`。
- daemon 的第二道防線：清理中的 worktree／cwd（realpath）記在 `purgingDirs`，新 session 的 cwd 等於或落在其中 → `session_deleting`，就算 hub 的鎖已遺失（斷線、到期、重啟）也擋得住。
- 接續時資料庫的 `accountProfile` 不是絕對路徑（舊資料）→ `""` 當 null，其他回 409 `invalid_account_profile`，不送出。daemon 只在處理對話紀錄時才要求 accountProfile 是絕對路徑；驗證失敗不先忘掉 session。
- 前端：`daemon_timeout`／`daemon_disconnected`／`daemon_error` 的刪除錯誤要說「機器可能還在清理，部分檔案可能已刪除」，並重新檢查；`*_shared` 409 後重新檢查。
