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
- **唯讀 session**（2026-11-06）：`SessionSpec.readOnly`／`Session.readOnly`（預設 false），建立時決定、之後不能改。hub 存在 `sessions.read_only`（schema v4），接續時照舊送；daemon 存在自己的 session 清單裡（spec），重啟接回也照舊。daemon 對唯讀 session 帶 `--disallowedTools Edit Write NotebookEdit`（`READ_ONLY_DISALLOWED_TOOLS`），前端在畫布卡片與成員列顯示「唯讀」晶片。**只擋這幾個改檔工具：透過 Bash 仍然寫得了檔案（例如 `echo > f`、`sed -i`），不是完整的唯讀保證。** 權限模式和它無關：plan 模式會被 ExitPlanMode 核准或 Shift+Tab 切掉，hub 不會知道，所以不拿 plan 當唯讀。
- **只讀成員例外**（GM 2026-11-06）：兩個成員**都會改檔案**才算衝突。只讀成員 = 團隊角色是 `researcher` 或 `reviewer`，**而且** session 是唯讀（`readOnly`）；缺一就算會改檔案（例如 `reviewer` + 非唯讀 session、`worker` + 唯讀 session）。規則在 `protocol/src/repo.ts` 的 `isReadOnlyMember`，hub `hub/src/worktree.ts` 與 web `web/src/team/worktree.ts` 共用。
- 何時檢查：新成員一律檢查；既有成員改角色時，只有從只讀變成會改檔案（例如審查改成 worker）才重新檢查，衝突回 409 `worktree_required`、角色不變，工作台說明原因。往只讀角色改、或會改檔案的角色之間互換一律放行（衝突狀態不會變差，也才解得開舊衝突）。
- **已知限制**：唯讀不擋 Bash 寫檔（見上）。檢查上線前就存在的舊資料、或還沒開好時判斷不到的（例如要開 worktree 但沒建成），hub 不會回頭檢查；工作台只在前端提醒：成員列上，目前規則下和別的成員衝突的兩邊都顯示提醒文字（`memberClashes`）。
- **建立團隊時一起開 session**（`web/src/team/NewTeamForm.tsx`）：預設組合「只建團隊」（原本的行為）、小隊 LD+1 BD、標準 LD+2 BD+1 RV、探索 LD+1 RS+1 BD；每列可改角色、名稱（預設 `<團隊名>-LD`、`-BD1`…）、權限模式。預設權限：lead `default`、worker `acceptEdits`、researcher／reviewer `plan`（不預設 `bypassPermissions`、`dontAsk`；選了這兩個都會提醒）。RS／RV 一律開成唯讀 session（`readOnly: true`）。資料夾：LD 用主資料夾、每個 BD 各開 worktree（daemon 確認不是 git 時不開）、RS／RV 共用主資料夾。送出前檢查：剛好一位 LD、名稱不空不重複、主資料夾裡最多一位會改檔案的。順序：`teamsCreate` → 每列 `sessionsCreate`（同畫布與 `#/new` 的路，worktree、hooks、額度排隊照常）→ `teamMembersPut`。團隊本身建不起來就停；某列失敗就記下是哪一步、原因，繼續下一列，**不刪任何已建立的東西**，全部成功才自動進工作台（使用者中途離開這頁就不拉回）。團隊建好後表單就鎖住，重新讀取失敗也不會讓人再按出第二組；連按也只送一次。

- **雙向交接與輪數上限**（GM 2026-11-06）：`HandoffRule.action.maxRounds`（整數 1–10，選填）。沒設定的規則完全照舊：目標已在交接鏈裡就擋（`loop`）。有設定：目標在鏈裡出現的次數 < `maxRounds` 才送，否則擋下，原因 `round_limit`，並走一般的推播（`attentionPayload` 多帶 `reason: 'handoff_round_limit'`、`maxRounds`，service worker 用 `handoff-<id>` tag 顯示「已來回 N 輪，等你決定」）。輪數＝目標在鏈裡已出現次數＋1（例：EX→WR 第 1 輪、WR→EX 第 2 輪、EX→WR 第 2 輪……）；`handoff.fired`／`delivered`／`blocked` 的 payload 與 audit 帶 `round`、`maxRounds`（單向規則不帶）。每條規則 10 分鐘 10 次的限流照舊是第二道防線。使用者在任一邊親自輸入（Enter）就清掉那一邊的鏈，重新算輪數。鏈只在記憶體，hub 重啟會重算。
- **`on_marker`**：`Stop` hook 時，該事件的 `last_assistant_message` 含有 `action.marker`（1–40 字、不可空白，純子字串比對）就觸發；不用改檔案。摘要從標記的位置開始取一句。`on_marker` 沒有標記 → REST 400 `marker_required`（`handoffRuleProblem`，建立與修改都檢查）。同一回合同時符合 `on_file` 與 `on_marker` 會一起判斷，改過的檔案分界只寫一次。規則的 action 本來就是 JSON，這兩個欄位不用改結構；舊規則照常讀得到。
- **學術研究團隊**（GM 2026-11-06）：`Team.phase`（`topic`／`experiment`／`writing`／`revision`，選填；有值＝研究團隊）、`TeamMember.kind`（`ld`／`lr`／`ex`／`wr`／`rv`，選填）疊在既有四種角色上（`RESEARCH_KIND_ROLE`：指導＝lead、文獻＝researcher、實驗與寫作＝worker、審稿＝reviewer），**沒有新增 TeamRole**：實驗與寫作的權限、worktree、唯讀規則都和 worker 相同，只差命名與換階段的分工，所以只多存一個標籤。kind 和 role 對不上時以 role 為準（`memberKind`）。`teamMembersPut` 沒帶 `kind` 時保留原本的。schema v5：`teams.phase`、`team_members.kind`，舊資料都是 null。
  - 新建團隊選「學術研究」時用四個階段的固定組合（`PHASE_PRESETS`），命名 `<團隊>-EX1`、`-WR`…；有實驗也有寫作時預設勾選建立雙向交接：EX→WR `on_marker` `[結果完成]`（實驗結果多半由 Bash 產生，`on_file` 看不到）、WR→EX `on_marker` `[需要實驗]`，共用輪數（預設 3），**建好先關著**（開啟才花額度）。TEAM.md 先放研究範本；TEAM.md 不會自動送進 session，只有使用者按「請隊長拆解」時帶上。
  - 工作台「研究階段」：顯示目前階段；選新階段時列出用不到的成員（封存要按兩次，走 `sessionsUpdate { archived: true }`，不刪任何東西）與缺的分工（用補成員建立），按「切換」才改 `team.phase`。任務、規則、TEAM.md 不動（封存會依 §9.1 暫停該成員的規則）。
- **補成員**（GM 2026-11-06）：工作台對任何團隊都可以用同一套列（`team/PlanEditor.tsx`）一次開 session 並加入，`runPlan` 接受 `{ existing: team }`。現有成員一起檢查（`validatePlan(rows, gitOk, existing)`）：隊長最多一位（團隊還沒有成員時要剛好一位）、名稱不能和任何現有 session 撞名、主資料夾寫入者連同現有的算；團隊已有隊長時組合裡的隊長拿掉，預設名稱接著編號（已有 BD1 → BD2）。位置沿用隊長（沒有隊長就第一位成員）的機器、`cwd`、專案；沒有成員才讓使用者選資料夾。建過一批就鎖住，要按「再補一批」。
- **任務板自動跑**（GM 2026-11-06）：hub `packages/hub/src/tasks.ts`（`TaskEngine`），送字與交接共用 `packages/hub/src/delivery.ts`（`SafeDelivery`：只在目標 `waiting_input` 才送、文字和 Enter 分開、送 Enter 前再確認、60 秒確認逾時；同一個目標一次一則，交接與任務排在同一條佇列）。全部是固定規則與純子字串比對，不呼叫模型。
  - **自動指派（不花額度、一直開著）**：請隊長拆解的提示要求 `[{"title":"…","role":"BD"}]`，`role` 只列團隊裡實際有的縮寫（程式開發 LD／BD／RS／RV，研究團隊用分工 LD／LR／EX／WR／RV，`web/src/team/decompose.ts` 的 `roleRefs`、`presentAbbrs`）。解析後依縮寫（不分大小寫，也接受 `worker`、`ex` 這種代碼）指派給沒封存的成員，同縮寫多位就依名稱順序輪流（`assignOwners`）；對不到或沒標的留在未指派。舊格式（字串、只有 title）照樣讀。指派後還是在「待分配」，使用者移到進行中才開始。
  - **開關「任務自動執行」**：`Team.taskAuto`（schema v6 `teams.task_auto`，舊團隊與新團隊預設關；hub 回傳一定帶）。`teamsUpdate` 改開關寫 audit `team.task_auto`。工作台任務板上有開關、◈ 耗額度晶片與說明。**全隊暫停、全隊停止會先把它關掉**（前端，和關交接規則同一步）；hub 在開關關掉時把排隊中的任務標成沒送出（`automation_off`），已送出的不收回。開關關著時 hub 什麼都不做（不送、也不處理標記）；打開開關不會補送已經在進行中的任務。
  - **任務編號**：`Task.number`（團隊內 #n，`teams.task_seq` 發號，刪掉的不重發；舊任務 migration 依建立順序補號）。另外 `rejectCount`、`needsUser`、`reviewerSessionId`、`auto`（最後一步：`state` queued／sent／reported／review_queued／review_sent／passed／limit／dropped，`sessionId`、`note`、`at`）都存在任務上，hub 重啟不會遺失。`tasksCreate`／`tasksUpdate` 的 body 不變，這些欄位只有 hub 寫。
  - **開始**：開關開著、任務進入進行中且有負責人（使用者移的或退回造成的）→ 排一則給負責人：`[Task #n] <標題> | Team goal: <目標> | When this task is finished, reply with [完成 #n] and a one-sentence summary. Do not write that marker before then.`（避免負責人一開始就複述標記而提早送審）（一行、清控制字元，標題 300 字、目標 500 字截斷）。同一欄重存、改標題不重送；進行中換負責人算新的進入，送給新負責人。送出前任務被移走、刪掉或開關關掉就不送（`task_moved`／`task_deleted`／`automation_off`）。
  - **完成**：負責人的 `Stop` hook，`last_assistant_message` 含 `[完成 #n]`（也接受 `[完成#n]`）且該任務在進行中、是它負責 → 移到待審查。不帶編號的 `[完成]` 只在它剛好只有一個進行中的任務時才算。`[結果完成]`、`[需要實驗]` 不含 `[完成]`，不會誤判（`hub/src/test/tasks.test.ts` 有測）。摘要取標記後面的一句，沒有就取回覆第一句。
  - **送審**：進入待審查時（標記或使用者移的）挑審查：同一個任務上次的審查還在就沿用，否則在團隊的 `reviewer` 成員（沒封存、沒結束、不是負責人）之間輪流（輪到誰只在記憶體）。送 `[Review #n] Task: <標題> | Summary: … | Detected file edits: … | Branch: … | Reply with [通過 #n] or [退回 #n] followed by the reason.`（摘要、檔案、分支和交接同一套 `reportParts`；檔案是上次送給負責人之後改的）。沒有審查成員 → 留在待審查，`auto.state = reported`，等使用者。
  - **審查結果**：審查的 `Stop` 回覆含 `[通過 #n]` → 完成；`[退回 #n] 原因` → 退回次數 +1、回到進行中，原因（一句、清過）用 `[Task #n] Sent back by review: <原因> | Task: … | When this task is finished, reply with [完成 #n] …` 送回負責人。兩個都寫以退回為準。審查只有一個待審的任務時也接受不帶編號的 `[通過]`／`[退回]`。退回到上限（`TASK_REJECT_LIMIT` = 3，第 3 次）就停：留在待審查、`needsUser: true`、`auto.state = limit`（原因在 `note`），走一般推播（`attentionPayload` 帶 `reason: 'task_reject_limit'`、`maxRounds`＝上限、`task`＝編號，service worker 用 `task-<sessionId>` tag，不帶內容）。
  - **使用者自己移卡片**：移欄或換負責人會清掉 `needsUser` 與 `auto`（使用者接手了），**退回次數不歸零**（任務的歷史）。所以到上限的任務被移回進行中，會再送一次，下一次退回又停（每次使用者介入多一輪）。移出進行中／待審查會取消還沒送出的那則。
  - **紀錄**：每一步寫 audit（user 為 null）與 session 事件：`task.dispatched`（排入，記在目標；也是送審「改過的檔案」的分界）、`task.delivered`（送達，記在目標，送審／退回帶 `fromSessionId`，畫布的交接線會亮）、`task.completed`（負責人）、`task.reviewed`／`task.rejected`／`task.limit`（審查；reviewed、rejected 在任務有負責人時帶 `fromSessionId`＝審查、`toSessionId`＝負責人，2026-11-06 加，畫布畫成判定）、`task.dropped`（沒送出，原因代碼）；使用者移卡片寫 `task.update`。daemon 送來的 `task.*` 事件不收（同 `handoff.*`）。送字本身照舊寫 `terminal.input`（user 為 null）。任務卡顯示最後一步，例如「已送給 BD1・等回覆」、「RV 退回 1/3」、「RV 退回 3/3・等你決定」（`web/src/team/taskStatus.ts`）。
  - **不算使用者輸入**：自動送的字直接給 daemon，不經過使用者輸入那條路，不會清掉交接鏈（`onUserInput`）。
  - **重啟**：送字佇列只在記憶體。hub 啟動時把 `queued`／`review_queued` 的任務標成 `dropped`（`hub_restarted`），**不自動重送**；卡片會寫「hub 重啟過，排隊中的沒送（移出再移回就會重送）」。已送出、等回覆的不受影響（回覆一樣會被比對）。
  - **已知限制**：同一個 session 在兩個團隊、兩邊都有同編號的進行中任務時，`[完成 #n]` 兩邊都算。標記是純子字串，回覆裡引用了別的任務的標記也會算。只看 `Stop` 時的最後一則回覆。

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

指令：`claude [--session-id <uuid>|--resume <id>] [--permission-mode <mode>] [--disallowedTools Edit Write NotebookEdit] [--model <m>] [--mcp-config <file> --allowedTools <4 個派工工具>] [--name <n>]`（`--disallowedTools` 只有唯讀 session 帶，見「團隊事件」；`--mcp-config`／`--allowedTools` 只有派工設定開著時帶，見 §11），**權限模式一定要明確帶**，`default` 傳 `manual`：不帶的話 claude 會用使用者設定裡的預設模式（可能是 auto），畫面的放手線就會說謊。
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

### 3.5 額度恢復後自動接續（GM 2026-11-06）

`Settings.autoContinue`（預設 `false`，會花額度；設定頁「Session 與額度」，標 ◈ 耗額度）。hub `packages/hub/src/autoContinue.ts`（`AutoContinueEngine`），固定規則、不呼叫模型。

- **偵測（沿用 3.4）**：session 進入 `rate_limited`（`StopFailure` + `rate_limit`，或 daemon 比對到畫面上的用量上限訊息），`statusDetail` 用 `parseRateLimitReset` 讀得出重置時間 → 排在**重置時間＋60 秒**（`AUTO_CONTINUE_GRACE_MS`，和排隊放行同一個值），寫在 `Session.autoContinue`（`{ state: 'scheduled', at, resetAt, limitSince, reason }`，schema v7 `sessions.auto_continue` JSON），hub 重啟照樣計時（啟動時 `restore`，心跳時也再看一次）。`limitSince` 是那次限流的 `statusSince`：**同一次限流只排一次**（排過、送過、取消過都算）。
- **不排**：設定關著；讀不出重置時間（例如只有 `429 Too Many Requests`）——不猜，session 照舊停在 `rate_limited`；訊息含 `continuing automatically`（Claude Code 自己的自動繼續在倒數，讓它送）；重置時間已經過了（時鐘差或額度根本沒回來，送了只會再撞）；上一次限流已經送過、而且是同一個重置時間（防迴圈）。
- **送出**：時間到就排進 `SafeDelivery`（和交接、任務同一條佇列：文字和 Enter 分開、送 Enter 前再確認、60 秒確認逾時）。能送的時候：`waiting_input`（例如 daemon 重啟後接回），**或**還在同一次 `rate_limited`（`statusSince === limitSince`）而且 daemon 回報 `SessionRuntime.inputReady === true`。`inputReady` 是 daemon 從畫面判斷的：最下面 8 行內有 claude 平常的輸入框（橫線下一行 `❯`，`daemon/src/session.ts` 的 `inputBoxVisible`），選單選項 `❯ 1. …`（權限、額度選單「What do you want to do?」）不算。舊版 daemon 不送 → false → 只有 `waiting_input` 才送。送的是固定一行 `AUTO_CONTINUE_PROMPT`：`[Auto] The usage limit has reset. Continue where you left off.`。送出前再確認：還是 scheduled、設定還開著、`lastLines` 沒有 `continuing automatically`。
- **取消**（`state: 'cancelled'`，`reason`）：使用者在網頁上對它送了任何 `terminal.input`（任何按鍵，不只 Enter）或 `terminal.signal` → `user_input`；session 自己動起來（`running`、`waiting_permission`、`plan_review`、`error`、`stuck`、`done`：Claude Code 自己接續、有人在機器上直接下指令）→ `resumed`；結束或封存 → `ended`；又撞到新的限流 → `new_limit`（照新的重排）；設定關掉 → `setting_off`；文字打進去但按 Enter 前不能打字了 → `aborted`（字留給使用者，不重試）。`offline`、`starting`、`waiting_input` 不取消。
- **紀錄**：audit `session.auto_continue`（detail `{"state":"scheduled","at"}`／`{"state":"cancelled","reason"}`／`{"state":"sent","at"}`，user 為 null）；送字照舊寫 `terminal.input`（user 為 null）；送出時 session 事件 `auto_continue.sent`。**不算使用者輸入**：直接送給 daemon，不清交接鏈。
- **通知**：送出後放進合併通知（「BD1 已自動接續」）；合併通知關著時單獨一則 `attentionPayload` 帶 `reason: 'auto_continued'`，service worker 用 `auto-<sessionId>` tag。
- **前端**：`state === 'scheduled'` 時卡片（畫布、收件匣）顯示「額度恢復後自動接續：HH:MM」（`at`，瀏覽器時區）。
- **未驗證**：沒有真的撞過上限。claude 2.1.319 有自己的 `autoContinueAtUsageLimit` 設定：開著時它自己接續（我們偵測到 `running` 就取消，或看到 `continuing automatically` 不排）；關著時會跳「What do you want to do?」選單，選單開著時 `inputReady` 為 false，我們不送，要使用者先關掉選單（未在真實限流下確認選單的畫面）。

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

| 事件                                                                            | 新狀態                                                                                          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PTY 開啟                                                                        | `starting`                                                                                      |
| `SessionStart`（`source` 為 startup 或 resume）且目前是 `starting`              | `waiting_input`，detail `idle:start`（`IDLE_START_DETAIL`：剛開好、閒著，不算「等你」，見 §10） |
| `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`           | `running`                                                                                       |
| `Notification` + `permission_prompt`，或 `PermissionRequest`                    | `waiting_permission`                                                                            |
| `Notification` + `idle_prompt`（不覆蓋 `plan_review`、`rate_limited`、`error`） | `waiting_input`                                                                                 |
| `PermissionRequest` 且 `tool_name == 'ExitPlanMode'`                            | `plan_review`（實測：計畫是這樣送出的；plan 模式下的 `Stop` 可能只是提問或計畫剛被拒絕，不算）  |
| `Stop`                                                                          | `waiting_input`                                                                                 |
| `StopFailure` + `rate_limit`，或輸出比對到用量上限                              | `rate_limited`                                                                                  |
| `StopFailure` 其他                                                              | `error`                                                                                         |
| PTY exit ≠ 0                                                                    | `error`                                                                                         |
| PTY exit 0（使用者自己離開）                                                    | `done`，並設 `endedAt`                                                                          |
| `running` 且超過 `stuckMinutes` 沒輸出                                          | `stuck`；有新輸出回 `running`                                                                   |
| 使用者標記（hub）                                                               | `done`                                                                                          |
| 機器斷線（hub）                                                                 | `offline`                                                                                       |
| 超過併發上限（hub）                                                             | `queued`                                                                                        |

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
- 推播：每台裝置在設定頁各自訂閱（`flows/push.ts`），`pushSubscribe` 只收公開的 https endpoint。payload 是 `{ sessionId, name, status, at }`，不含終端機內容。合併通知開著（預設）時改送總表，見 §10。service worker 是 `web/src/flows/pwa/sw.js`，hub 從網站根目錄以 `/sw.js`、`Cache-Control: no-cache` 提供，CSP 有 `worker-src 'self'`；點通知開 `#/inbox/<sessionId>`。

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

## 10. 通知與「等你」（GM 2026-11-06）

### 10.1 「等你」的定義

`packages/protocol/src/attention.ts`，hub 與 web 共用：

- `sessionWaitsForUser`：沒封存、狀態是收件匣的範圍（`ATTENTION_STATUSES`：等你允許、回覆、審計畫、錯誤、卡住），**但不含 `statusDetail === 'idle:start'` 的 `waiting_input`**（daemon 在 `SessionStart` startup／resume 時標的：剛開好或剛接回，沒有新回覆）。做完一回合（`Stop`）detail 就變回 null，算「等你」；`idle_prompt` 不改 detail。信任對話框（detail `trust`）算。舊版 daemon 不標，照舊算。
- `waitingSessions(sessions, approvals)`：上面這些，加上有還沒決定的 approval 的 session（危險指令命中時常常還是 `running`），每個 session 只算一次。
- 收件匣、「下一個等我的」的清單**沒有改**（閒著的 `waiting_input` 照樣列出、照樣可回覆）；只有數量、上限與推播用這個定義。
- `rate_limited` 不在範圍裡（和收件匣一樣）。

### 10.2 合併通知（`Settings.notifications.coalesce`，預設開）

hub `packages/hub/src/attention.ts`（`NotifyCoalescer`、`buildSummary`）。觸發點和原本 `notifyAttention` 一樣：進入需要人的狀態、交接到輪數上限（`roundLimits`）、任務退回到上限（`taskLimits`）、自動接續送出、跨過「等你」上限。

- **時間**（`protocol` 的 `NOTIFY_*`）：第一個事件起等 15 秒；期間有新事件就從新事件再算 15 秒，但從第一個事件起最多 60 秒。**權限請求**（`waiting_permission`）最急：批次裡有它時最晚在它發生後 5 秒送出，後來的事件不會再延長。
- **送什麼**：時間到才看當下——`waitingSessions` 的全部（不只這一批觸發的），加上交接上限（使用者在那個 session 按 Enter 就清掉）與任務上限（任務 `needsUser` 還是 true）的 session。等待期間已經處理掉的不列；什麼都不剩（也沒有自動接續）就不送。勿擾與總開關在送出時再看一次。
- **payload**（一個 tag `agent-board-summary`，新的蓋舊的、`renotify`）：`{ kind: 'summary', count, items: [{ sessionId, name, status, reason?, maxRounds?, task? }], more, autoContinued: [{ sessionId, name }], overLimit?, at }`。欄位和單則推播一樣只有名稱、狀態、原因代碼與數字，沒有對話內容；最多 5 項（其餘算在 `more`），名稱超過 60 字截斷。順序：權限請求 → 自動流程停下的 → 這一批觸發的（新的在前）→ 其他。
- **service worker**：標題「3 個 session 在等你」（跨過上限時加「（超過上限 N）」），內文「BD1 問權限、RV 退回 #3、EX 來回到上限、還有 N 個、BD2 已自動接續」。只有一個在等時點了到 `#/inbox/<id>`，否則 `#/inbox`。
- **關掉**＝舊行為：每個事件一則 `attentionPayload`（`session-`／`handoff-`／`task-`／`auto-<id>` tag）。從開改成關時，手上這一批馬上送出。

### 10.3 同時等你的上限（`Settings.notifications.waitingLimit`，1–20，預設 3）

- hub `checkWaiting`：每次 session 狀態、detail、封存或 approval 改變時算 `waitingSessions` 的數量，用 `WaitingThreshold`：數量 > 上限、而且上一次 ≤ 上限才算「跨過」，**每次跨過通知一次**，回到 ≤ 上限才重設。機器重連帶回原本的狀態時只更新計數、不通知（和單則推播的「不重複推播」同一個判斷）。上限改低也算跨過。
- 合併通知開著：跨過時併進下一則總表（`overLimit` = 上限，送出時還超過才標）；關著：單獨一則 `{ kind: 'overload', count, limit, at }`，tag `agent-board-overload`。
- 前端：設定只有 owner 讀得到，所以上限跟著 `board.state.waitingLimit` 給每個人，改了廣播 `board.waitingLimit`。頁首「等你 N」連到 `#/inbox`；超過上限時頁首下方（與收件匣）一條橫幅「同時有 N 個 session 在等你，超過上限 M」＋去收件匣＋知道了（只收起這一次跨過，`views/waiting.tsx`）。

### 10.4 設定頁

「通知」：合併通知（寫出 15／5／60 秒）、同時等你的上限（1–20，不合法不能存）。「Session 與額度」：額度恢復後自動接續（§3.5，◈ 耗額度，區塊 id `autocontinue`）、允許 session 派工（§11，◈，區塊 id `dispatch`）。舊設定沒有這些鍵：`coalesce` 視為開、`waitingLimit` 3、`autoContinue` 關、`dispatch` 開。

`PATCH /api/settings` 的 body 是 `SettingsPatch`（`protocol/src/rest.ts`）：只改有帶的鍵。原本用 `Settings.partial()`，zod 會把沒帶的 `autoContinue` 補成預設值 false（存別的設定時悄悄關掉自動接續），2026-11-06 一起修掉。

## 11. session 派工（MCP 工具，GM 2026-11-06）

GM：在原生 Claude CLI 裡只要叫 Claude 派給 agent；Agent Board 要自己建角色、規則、任務，感覺不一樣。新的用法：GM 只跟**一個** session 講話，那個 session 裡的 Claude 自己在畫布上開成員、送工作、自動收到結果。手動的團隊功能全部照舊。固定規則，不呼叫任何模型（`docs/no-llm-review.md`）。

### 11.1 架構與資料流

```
claude（呼叫者）──stdio──► agent-board-mcp（hook 套件 src/mcp.ts；發布檔 daemon/dist/agent-board-mcp.mjs）
   ▲                         │ 本機 socket（同 hook 的 AGENT_BOARD_SOCKET），{type:'mcp', sessionId, secret, tool, args}
   │                         ▼
   │                      daemon：比對密鑰 → WS `dispatch.request` → hub（DispatchEngine，hub/src/dispatch.ts）→ `dispatch.reply`
   │                                                                     │ 開成員（hub.createSession 同一條路）、SafeDelivery 送字
   └──────────── `[Result from …]`（SafeDelivery 送進呼叫者）◄── 成員 Stop
```

- **MCP server 放 hook 套件**：和 `agent-board-hook` 一樣跑在 claude 底下、只用 node 內建模組、只連 daemon 的本機 socket（可直接 `node src/mcp.ts`，type stripping）。發布檔打包到 `daemon/dist/agent-board-mcp.mjs`（不放 `node_modules/.bin`：那個資料夾會加進 PTY 的 PATH，只能有 hook）。daemon 用自己的 `process.execPath` 執行它；`AGENT_BOARD_MCP_SERVER` 可覆寫，找不到就不掛。
- **為什麼走 daemon 不直接連 hub**：daemon 已經有認證過的 hub 連線，MCP server 不必拿到機器 token 或登入 cookie；密鑰只在這台機器上比對；hub 再確認這個 session 屬於這條 daemon 連線的機器（`ownsSession`），別台機器冒用 session id 一律 `caller_inactive`。能做什麼（團隊、上限、權限）只由 hub 判斷，daemon 不知道團隊。
- **掛法**：`Settings.dispatch` 開著（hub 在 `hub.welcome.dispatch` 下發，daemon 存在 `sessions.json`，重啟沒連上 hub 時照上次的值；舊版 hub 不送 → 不掛）時，daemon 每次開 PTY（新開、接續、重啟接回）都帶 `--mcp-config <dataDir>/mcp/<sessionId>.json --allowedTools mcp__agent-board__list_members mcp__agent-board__spawn_member mcp__agent-board__send_task mcp__agent-board__get_result`。**不用 `--strict-mcp-config`**：使用者自己的 MCP server 照常載入。設定關掉只影響之後開的 PTY；已經掛著的，工具呼叫時 hub 回 `dispatch_disabled`。
- **事先允許（`--allowedTools`）的決定**：只列這四個工具全名，不放寬任何其他工具（實測見 `docs/claude-code-notes.md`）。理由：原生 CLI 派子代理不會每次問；不允許的話 `default` 模式每次都跳權限對話框、`dontAsk` 模式會直接拒絕。會花額度的只有開成員，由 hub 的上限、權限上限與設定開關管。
- **密鑰**（每個 PTY 一把，`randomBytes(32)` base64url）：存在 `<dataDir>/mcp/<sessionId>.key`（資料夾 0700、檔案 0600，先寫暫存檔再換名）；MCP 設定檔（0600）的 `env` 只放 `AGENT_BOARD_SESSION_ID`、`AGENT_BOARD_SOCKET` 與密鑰**檔案路徑** `AGENT_BOARD_MCP_SECRET_FILE`。所以密鑰不在任何 argv（`ps` 看得到）、不在 claude 的環境變數（Bash 工具讀不到）、不在 MCP 設定檔（`/mcp` 畫面）、不在 log、audit、hub（daemon 轉送時不帶）、MCP server 的 stdout。daemon 用固定時間比較；session 結束、被忘掉、重開時密鑰作廢並刪檔，daemon 啟動與關閉時清空整個 `mcp/`。
- **限制（未驗證、也做不到的）**：同一個使用者帳號底下的其他程式（包括任何 session 的 Bash）讀得到 0600 的檔案，所以密鑰防的是「session 冒用別的 session」這種誤用，不是同帳號的惡意程式（hook socket 本身也沒有密鑰）。

### 11.2 工具（回覆是 JSON，失敗是 `<code>: <給 Claude 看的說明>`，`isError: true`）

| 工具           | 參數                                                                                                    | 行為                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_members` | —                                                                                                       | 呼叫者所在的每個團隊：成員 `name`、`role`、`kind`、`status`（結束的寫 `ended`）、`task`（進行中的任務 `#n 標題`）、`lastLine`、`readOnly`（`isReadOnlyMember`）、`branch`、`dispatchedBy`（名稱）、`working`（還欠呼叫者結果）、自己標 `you`；另外 `spawned: { live, limit }`。沒有團隊就 `teams: []`。 |
| `spawn_member` | `role`（worker／researcher／reviewer）、`prompt`、選填 `name`、`permissionMode`、`useWorktree`、`model` | 見 11.3。成功回 `name`、`status`（可能是 `queued`）、`team`、`teamCreated`、`permissionMode`、被降級時 `note`。                                                                                                                                                                                         |
| `send_task`    | `member`（名稱不分大小寫，或 session id）、`text`                                                       | 對象只能是**呼叫者當隊長的團隊的成員**或**它開的成員**（不含自己）。送 `[From <呼叫者>] <text>`（一行、清控制字元、4000 字截斷）進 `SafeDelivery`，key `dispatch:<呼叫者>:<成員>`（還沒送出又送，新的蓋舊的，回覆 `note`）。回 `state: sent／queued`。                                                  |
| `get_result`   | `member`                                                                                                | 同上的範圍。最後一則回覆的一句摘要、上次派工之後偵測到的改檔（最多 20）、分支、`working`、狀態。                                                                                                                                                                                                        |

錯誤代碼：`dispatch_disabled`、`caller_inactive`（封存、結束、不認得、不是這台機器）、`invalid_arguments`、`permission_not_allowed`、`nested_spawn`、`read_only_caller`、`limit_reached`、`machine_offline`、`worktree_unavailable`、`worktree_required`、`not_your_member`、`member_ended`、`rate_limit`，以及 `hub.createSession` 的 409 代碼（例如 `session_deleting`）。daemon 端另有 `unauthorized`、`hub_unreachable`、`timeout`（等 hub 30 秒）、`invalid_request`；MCP server 端 `not_configured`、`daemon_unreachable`、`timeout`（45 秒）。

### 11.3 開成員的規則（`spawn_member`）

- 位置：呼叫者的機器、`cwd`、專案、帳號（`accountProfile`）；`model` 沒給用呼叫者的。走 `hub.createSession` 同一條路（併發與限流排隊、worktree、hooks、第一個指令照常），audit 的 user 是 null、detail 多 `dispatchedBy`。`Session.dispatchedBy`（schema v8 `sessions.dispatched_by`）記是誰開的。
- **角色**：不能開 `lead`。worker 會改檔案：`readOnly: false`、預設開 worktree（`useWorktree` 沒給就是 true；呼叫者的 `repoRoot` 是 null（不是 git 或還沒回報）→ `worktree_unavailable`，除非明確 `useWorktree: false`）。researcher／reviewer 一律唯讀（`readOnly: true`，`--disallowedTools`），預設不開 worktree、共用資料夾。
- **同資料夾寫入者規則**：worker 又 `useWorktree: false` 時，和團隊裡同一個 working tree 的寫入者（`sameWorkingTree`、`isReadOnlyMember`，同 `hub/src/worktree.ts`）衝突 → `worktree_required`，不開。
- **權限上限**：寬鬆順序 `plan < default < acceptEdits < auto = dontAsk < bypassPermissions`（`clampPermissionMode`）。沒給用角色預設（worker `acceptEdits`、研究與審查 `plan`，同建立團隊表單）。上限是 min(呼叫者, auto／dontAsk)：超過就降成呼叫者的模式（呼叫者是 bypassPermissions 時降成 acceptEdits），回 `note`。明確要 `bypassPermissions` → `permission_not_allowed`。hub 只知道呼叫者**建立時**的模式（Shift+Tab 切換看不到）。
- **唯讀呼叫者**（`Session.readOnly`）只能開 researcher／reviewer → 否則 `read_only_caller`。
- **不能巢狀**：派工開的成員（`dispatchedBy` 不是 null）不能再開 → `nested_spawn`（防止一層層開下去）。它還是可以用 `list_members`、`get_result`。
- **上限**：同一個呼叫者同時活著（沒封存、沒結束）的派工成員最多 `DISPATCH_SPAWN_LIMIT` = 4 → `limit_reached`（列出是哪幾個，建議用 `send_task` 重用或請使用者封存）。
- **團隊**：呼叫者當隊長的團隊；沒有就它所在的第一個團隊；都沒有就開一個新團隊（名稱＝呼叫者名稱、`teal`、目標空白、任務自動執行關），呼叫者當 `lead`。成員以 `role` 加入（直接寫 `team_members`，上面已檢查過寫入者規則）。前端團隊資料是 10 秒輪詢，框最慢 10 秒後出現。
- **名稱**（`memberName`，同 `teamPlan.defaultNames`）：`<團隊名>-BD1`、`-BD2`；研究、審查第一位 `-RS`／`-RV`，之後 `-RS2`。指定的名稱撞名（不分大小寫，所有 session）加 `-2`、`-3`。
- 第一個指令：`[From <呼叫者>] <prompt>`（一行、清控制字元、4000 字截斷），由 daemon 在 `SessionStart` 後送（§3.1）。

### 11.4 結果自動送回（一份工作一次）

- **一份工作**＝一次 spawn 的第一個指令，或一次送達的 `send_task`。開成員時、`send_task` 按下 Enter 時，hub 在成員上寫 `dispatch_work`（schema v8 `sessions.dispatch_work` JSON：`{ from, workId, kind, at }`，hub 重啟照樣在）。
- 成員的 `Stop` hook 事件到 hub、而且有 `dispatch_work` → **先清掉**，再把 `[Result from <成員>] Summary: <一句> | Detected file edits: <…> | Branch: <…>`（`resultMessage`，和交接同一套 `reportParts`；摘要取這個 Stop 的 `last_assistant_message` 一句；檔案是上次派工分界 `dispatch.spawn`／`dispatch.delivered` 之後的）排進 `SafeDelivery` 送給呼叫者（只在它 `waiting_input` 才送，忙就排隊）。沒有 `dispatch_work` 的回合（例如使用者自己問成員問題）不送。
- **防迴圈**：結果送進呼叫者不算新的工作（不寫任何 `dispatch_work`），所以呼叫者之後的回合不會再觸發任何自動送字；成員不能再開成員。第二道防線：每個呼叫者 10 分鐘最多收 `DISPATCH_RESULT_MAX` = 10 則結果、最多送 `DISPATCH_SEND_MAX` = 20 則工作，超過擋下（`rate_limit`，結果可再用 `get_result` 看）。
- **一次一份**：成員手上的工作還沒回報（還沒 Stop）時，新的 `send_task` 留在佇列（`DeliveryItem.ready` 要求沒有 `dispatch_work`），Stop 處理完立刻 `SafeDelivery.retry`。這是因為 daemon 的 `session.runtime`（回到等輸入）常比 `Stop` 事件早到，不等的話新工作會在舊結果之前送進去、兩份混在一起。
- **沒有 Stop 的情況**：使用者在成員回合進行中（running／stuck／waiting_permission）按 Esc 或 Ctrl+C（`terminal.input` 剛好是 `\x1b`／`\x03`，或 `terminal.signal` escape／ctrl_c）→ 清掉工作，事件 `dispatch.blocked` reason `interrupted`；成員結束或封存 → 清掉，reason `member_ended`。呼叫者已結束或封存、設定關掉 → 結果不送（`target_ended`／`dispatch_disabled`）。
- 使用者自己在成員終端機裡打字**不**清掉工作（例如 GM 回答了成員的問題，成員接著把工作做完，結果照樣送回）。

### 11.5 紀錄與畫面

- audit（user 一律 null）：`dispatch.spawn`（記在呼叫者，detail 有 from／to、team、角色、模式、worktree、唯讀、一句摘要）、`dispatch.send`、`dispatch.delivered`、`dispatch.result`（記在成員，detail 有送出的整行）、`dispatch.result_delivered`、`dispatch.blocked`（reason）。開成員另有一般的 `session.create`、`terminal.input`（第一個指令）；送字照舊寫 `terminal.input`。
- session 事件（payload 都有 `fromSessionId`、`toSessionId`、`workId`，送出類有 `summary`）：`dispatch.spawn`（成員）、`dispatch.send`（呼叫者，排入）、`dispatch.delivered`（成員，送達；也是改檔分界）、`dispatch.result`（成員，結果排入）、`dispatch.result_delivered`（呼叫者，送達）、`dispatch.blocked`（來源那一邊）。daemon 送來的 `dispatch.*` 事件不收（同 `handoff.*`、`task.*`）。
- 畫布：交接動畫（`canvas/handoffActivity*.ts`）也聽 `dispatch.*`：spawn／delivered／result_delivered 畫成「已送達」、send／result 畫成「已排入」、blocked 畫成「擋下」，沒有規則線時用臨時線。成員卡片多一個晶片「派工自 <呼叫者>」（`views/session.tsx` 的 `DispatchedByChip`，找不到呼叫者就不顯示）。
- 畫布的往來（GM 2026-11-06，`canvas/interactions.ts`）：
  - **關係線**（一直在）：交接規則（虛線＋箭頭）、派工 呼叫者 → 成員（`Session.dispatchedBy`，實線＋箭頭）、隊長 → 成員（點線、無箭頭，只有兩人之間沒有交接規則或派工線時才畫）。同方向的線垂直錯開 14px；反方向本來就從不同把手出發。
  - **往來**：`handoff.*`、`dispatch.*`、`task.dispatched`／`task.delivered`（有 `fromSessionId` 的）、`task.reviewed`／`task.rejected`（判定）。畫在同方向優先順序最高的線上（交接規則 > 派工 > 隊長）；沒有就畫暫時的細點線，最近 10 分鐘有往來就留著。排入與送達的語意不變（送達才讓目標卡亮一圈），判定是另一種「已判定」。
  - **次數與紀錄**：排入後的送達、擋下、取消用 `workId`／`taskId`／`ruleId` 對上同一則（沒有就對同一對、同一類最近的排入）。每條線的徽章是最近 10 分鐘幾則；點線或徽章打開小視窗，列兩個方向最近 8 則（時間、做了什麼、結果、摘要先遮蔽再截斷）。紀錄只在前端、只記畫布開著時收到的、留一小時、每一對最多 20 則；**不從 hub 補讀舊事件**。
  - **篩選**：交接／派工／任務／關係線四個開關，記在這台瀏覽器（`localStorage` `agent-board.canvas.link-filters`，讀寫失敗就全開、只在這次有效）。交接關掉時連規則線一起藏。
- 設定：`Settings.dispatch`，**預設開**（GM 2026-11-06 的決定，見下）；設定頁「Session 與額度」的「允許 session 派工（MCP 工具）」標 ◈ 耗額度、寫出上限 4。改了寫 audit `settings.update`，hub 重送 `hub.welcome`。
- **預設開的理由**：和自動接續、任務自動執行（預設關）不同，工具本身不花額度、也不會自己動：一定是 GM 叫畫布上的 Claude 派工、Claude 決定呼叫才會開成員。開成員就是開 session，所以標 ◈、有上限 4、權限不比呼叫者寬、不能巢狀，GM 可以隨時關掉（關掉後新開的 session 完全不掛 MCP server）。

### 11.6 已知限制

- 實測只到 `claude -p`（見 `docs/claude-code-notes.md`）；互動模式（PTY）下的 `/mcp` 畫面、權限對話框、MCP server 啟動時間未在真的畫布 session 上驗證。
- hub 只知道建立時的權限模式；Claude 在 session 裡用 Shift+Tab 切到更寬的模式，上限不會跟著變（反過來也一樣）。
- `dispatch_work` 只在 `Stop` 時結算：成員回合中 API 錯誤（`StopFailure`）不算完成，工作留著，直到下一個 Stop、被中斷、結束或封存。
- 送字佇列只在記憶體：hub 重啟時還沒送出的 `send_task` 會遺失（audit 有 `dispatch.send`，沒有 `dispatch.delivered`）；已送達的工作（`dispatch_work`）在資料庫，結果照樣送回。
- 前端團隊資料靠 10 秒輪詢，新團隊與新成員的框最慢 10 秒後出現。
