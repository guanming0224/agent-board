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
| `SessionStart`（`source` 為 startup）且目前是 `starting`                        | `waiting_input`，detail `idle:start`（`IDLE_START_DETAIL`：剛開好、閒著，不算「等你」，見 §10） |
| `SessionStart`（`source` 為 resume）且目前是 `starting`                         | `waiting_input`，detail null（重新接回算「等你」，GM 2026-11-08）                               |
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
| `src/canvas/index.ts`             | D 匯出 `CanvasPage`、`InboxDrawer`、`TerminalPage`                                   |
| `src/flows/index.ts`              | F 匯出 `NewSessionPage`、`InboxBoard`、`InboxPage`、`SettingsPage`、`OnboardingPage` |

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

- `sessionWaitsForUser`：沒封存、狀態是收件匣的範圍（`ATTENTION_STATUSES`：等你允許、回覆、審計畫、錯誤、卡住），**但不含 `statusDetail === 'idle:start'` 的 `waiting_input`**（daemon 在 `SessionStart` startup 時標的：剛開好，沒有新回覆；畫面上的代碼是 NEW。resume 重新接回不標，算「等你」，GM 2026-11-08）。做完一回合（`Stop`）detail 就變回 null，算「等你」；`idle_prompt` 不改 detail。信任對話框（detail `trust`）算。舊版 daemon 不標，照舊算。
- `waitingSessions(sessions, approvals)`：上面這些，加上有還沒決定的 approval 的 session（危險指令命中時常常還是 `running`），每個 session 只算一次。
- 收件匣、「下一個等我的」、待處理順序（web `shared/status.ts` 的 `attentionQueue`）也只算 ASK、PERM、PLAN、ERR，剛開好（NEW）不列（GM 2026-11-08）；剛開好的 session 只出現在待處理頁的「其他」組（triage kind `idle`）。數量、上限與推播用上面這個定義。
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

2026-11-10 加上**隊長自主擴編**（§11.7）：隊長自己評估人手、新增（理由必填）與封存成員，上限改成團隊總人數（設定 `autoStaff.teamLimit`，預設 12），每次都通知 GM。

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
- **掛法**：`Settings.dispatch` 開著（hub 在 `hub.welcome.dispatch` 下發，daemon 存在 `sessions.json`，重啟沒連上 hub 時照上次的值；舊版 hub 不送 → 不掛）時，daemon 每次開 PTY（新開、接續、重啟接回）都帶 `--mcp-config <dataDir>/mcp/<sessionId>.json --allowedTools mcp__agent-board__list_members mcp__agent-board__spawn_member mcp__agent-board__send_task mcp__agent-board__get_result mcp__agent-board__release_member`（`release_member` 2026-11-10 加）。**不用 `--strict-mcp-config`**：使用者自己的 MCP server 照常載入。設定關掉只影響之後開的 PTY；已經掛著的，工具呼叫時 hub 回 `dispatch_disabled`。
- **事先允許（`--allowedTools`）的決定**：只列這五個工具全名，不放寬任何其他工具（實測見 `docs/claude-code-notes.md`）。理由：原生 CLI 派子代理不會每次問；不允許的話 `default` 模式每次都跳權限對話框、`dontAsk` 模式會直接拒絕。會花額度的只有開成員，由 hub 的上限、權限上限與設定開關管。
- **密鑰**（每個 PTY 一把，`randomBytes(32)` base64url）：存在 `<dataDir>/mcp/<sessionId>.key`（資料夾 0700、檔案 0600，先寫暫存檔再換名）；MCP 設定檔（0600）的 `env` 只放 `AGENT_BOARD_SESSION_ID`、`AGENT_BOARD_SOCKET` 與密鑰**檔案路徑** `AGENT_BOARD_MCP_SECRET_FILE`。所以密鑰不在任何 argv（`ps` 看得到）、不在 claude 的環境變數（Bash 工具讀不到）、不在 MCP 設定檔（`/mcp` 畫面）、不在 log、audit、hub（daemon 轉送時不帶）、MCP server 的 stdout。daemon 用固定時間比較；session 結束、被忘掉、重開時密鑰作廢並刪檔，daemon 啟動與關閉時清空整個 `mcp/`。
- **限制（未驗證、也做不到的）**：同一個使用者帳號底下的其他程式（包括任何 session 的 Bash）讀得到 0600 的檔案，所以密鑰防的是「session 冒用別的 session」這種誤用，不是同帳號的惡意程式（hook socket 本身也沒有密鑰）。

### 11.2 工具（回覆是 JSON，失敗是 `<code>: <給 Claude 看的說明>`，`isError: true`）

| 工具             | 參數                                                                                                                                              | 行為                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_members`   | —                                                                                                                                                 | 呼叫者所在的每個團隊：成員 `name`、`role`、`kind`、`status`（結束的寫 `ended`）、`task`（進行中的任務 `#n 標題`）、`lastLine`、`readOnly`（`isReadOnlyMember`）、`branch`、`dispatchedBy`（名稱）、`working`（還欠呼叫者結果）、`addedReason`（隊長新增時的理由）、自己標 `you`；每個團隊另有 `staffing`（§11.7）。沒有團隊就 `teams: []` 加一句 `guide`。 |
| `spawn_member`   | `role`（worker／researcher／reviewer／tester）、`prompt`、**`reason`（必填，2026-11-10）**、選填 `name`、`permissionMode`、`useWorktree`、`model` | 見 11.3、11.7。成功回 `name`、`status`（可能是 `queued`）、`team`、`teamCreated`、`permissionMode`、`reason`、`teamSize`（`人數/上限`）、被降級時 `note`。                                                                                                                                                                                                 |
| `send_task`      | `member`（名稱不分大小寫，或 session id）、`text`                                                                                                 | 對象只能是**呼叫者當隊長的團隊的成員**或**它開的成員**（不含自己）。送 `[From <呼叫者>] <text>`（一行、清控制字元、4000 字截斷）進 `SafeDelivery`，key `dispatch:<呼叫者>:<成員>`（還沒送出又送，新的蓋舊的，回覆 `note`）。回 `state: sent／queued`。                                                                                                     |
| `get_result`     | `member`                                                                                                                                          | 同上的範圍。最後一則回覆的一句摘要、上次派工之後偵測到的改檔（最多 20）、分支、`working`、狀態。                                                                                                                                                                                                                                                           |
| `release_member` | `member`、`reason`（必填）                                                                                                                        | 2026-11-10。見 11.7。成功回 `released`、`team`、`teamSize`、`note`（可以在設定→已封存還原）。                                                                                                                                                                                                                                                              |

錯誤代碼：`dispatch_disabled`、`caller_inactive`（封存、結束、不認得、不是這台機器）、`invalid_arguments`、`permission_not_allowed`、`nested_spawn`、`read_only_caller`、`machine_offline`、（§11.7）`reason_required`、`autostaff_disabled`、`not_lead`、`team_full`、`spawn_rate_limit`、`account_rate_limited`、`member_busy`、`team_held`、`board_paused`（只有 spawn）、`cannot_release_self`、`worktree_unavailable`、`worktree_required`、`not_your_member`、`member_ended`、`rate_limit`，以及 `hub.createSession` 的 409 代碼（例如 `session_deleting`）。daemon 端另有 `unauthorized`、`hub_unreachable`、`timeout`（等 hub 30 秒）、`invalid_request`；MCP server 端 `not_configured`、`daemon_unreachable`、`timeout`（45 秒）。

### 11.3 開成員的規則（`spawn_member`）

- 位置：呼叫者的機器、`cwd`、專案、帳號（`accountProfile`）；`model` 沒給用呼叫者的。走 `hub.createSession` 同一條路（併發與限流排隊、worktree、hooks、第一個指令照常），audit 的 user 是 null、detail 多 `dispatchedBy`。`Session.dispatchedBy`（schema v8 `sessions.dispatched_by`）記是誰開的。
- **角色**：不能開 `lead`。worker 會改檔案：`readOnly: false`、預設開 worktree（`useWorktree` 沒給就是 true；呼叫者的 `repoRoot` 是 null（不是 git 或還沒回報）→ `worktree_unavailable`，除非明確 `useWorktree: false`）。researcher／reviewer 一律唯讀（`readOnly: true`，`--disallowedTools`），預設不開 worktree、共用資料夾。
- **同資料夾寫入者規則**：worker 又 `useWorktree: false` 時，和團隊裡同一個 working tree 的寫入者（`sameWorkingTree`、`isReadOnlyMember`，同 `hub/src/worktree.ts`）衝突 → `worktree_required`，不開。
- **權限上限**：寬鬆順序 `plan < default < acceptEdits < auto = dontAsk < bypassPermissions`（`clampPermissionMode`）。沒給用角色預設（worker `acceptEdits`、研究與審查 `plan`，同建立團隊表單）。上限是 min(呼叫者, auto／dontAsk)：超過就降成呼叫者的模式（呼叫者是 bypassPermissions 時降成 acceptEdits），回 `note`。明確要 `bypassPermissions` → `permission_not_allowed`。hub 只知道呼叫者**建立時**的模式（Shift+Tab 切換看不到）。
- **唯讀呼叫者**（`Session.readOnly`）只能開 researcher／reviewer → 否則 `read_only_caller`。
- **測試（tester，P2 Q5）**：和 worker 一樣會改檔案（`readOnly: false`、預設開 worktree），預設權限模式 `default`（每步問，名稱縮寫 `QA`）；可被派任務（任務負責人不限角色），**不當審查**（送審只找 `reviewer`）。新團隊放在呼叫者所在的工作區（§13）。
- **不能巢狀**：派工開的成員（`dispatchedBy` 不是 null）不能再開 → `nested_spawn`（防止一層層開下去）。它還是可以用 `list_members`、`get_result`。
- **上限**（2026-11-10 改，§11.7）：團隊總人數（含隊長、GM 配的，不含已封存）到 `autoStaff.teamLimit` → `team_full`（列出現有成員，建議 `release_member` 或 `send_task` 重用）；同一團隊 10 分鐘最多新增 `DISPATCH_SPAWN_RATE_MAX` = 4 位 → `spawn_rate_limit`。舊的「每個呼叫者同時 4 個」（`DISPATCH_SPAWN_LIMIT`、`limit_reached`）拿掉。
- **團隊**：呼叫者當隊長的團隊；在團隊裡但不是任何一隊的隊長 → `not_lead`（2026-11-10）；都沒有團隊就開一個新團隊（名稱＝呼叫者名稱、`teal`、目標空白、任務自動執行關），呼叫者當 `lead`。成員以 `role` 加入（直接寫 `team_members`，上面已檢查過寫入者規則）。前端團隊資料是 10 秒輪詢，框最慢 10 秒後出現。
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

- audit（user 一律 null）：`dispatch.spawn`（記在呼叫者，detail 有 from／to、team、角色、模式、worktree、唯讀、一句摘要，2026-11-10 起加 `reason`、`teamSize`、`teamLimit`）、`dispatch.release`（§11.7）、`dispatch.send`、`dispatch.delivered`、`dispatch.result`（記在成員，detail 有送出的整行）、`dispatch.result_delivered`、`dispatch.blocked`（reason）。開成員另有一般的 `session.create`、`terminal.input`（第一個指令）；送字照舊寫 `terminal.input`。
- session 事件（payload 都有 `fromSessionId`、`toSessionId`、`workId`，送出類有 `summary`）：`dispatch.spawn`（成員）、`dispatch.send`（呼叫者，排入）、`dispatch.delivered`（成員，送達；也是改檔分界）、`dispatch.result`（成員，結果排入）、`dispatch.result_delivered`（呼叫者，送達）、`dispatch.blocked`（來源那一邊）。daemon 送來的 `dispatch.*` 事件不收（同 `handoff.*`、`task.*`）。
- 畫布：交接動畫（`canvas/handoffActivity*.ts`）也聽 `dispatch.*`：spawn／delivered／result_delivered 畫成「已送達」、send／result 畫成「已排入」、blocked 畫成「擋下」，沒有規則線時用臨時線。成員卡片多一個晶片「派工自 <呼叫者>」（`views/session.tsx` 的 `DispatchedByChip`，找不到呼叫者就不顯示）。
- 畫布的往來（GM 2026-11-06，`canvas/interactions.ts`）：
  - **關係線**（一直在）：交接規則（虛線＋箭頭）、派工 呼叫者 → 成員（`Session.dispatchedBy`，實線＋箭頭）、隊長 → 成員（點線、無箭頭，只有兩人之間沒有交接規則或派工線時才畫）。同方向的線垂直錯開 14px；反方向本來就從不同把手出發。
  - **往來**：`handoff.*`、`dispatch.*`、`task.dispatched`／`task.delivered`（有 `fromSessionId` 的）、`task.reviewed`／`task.rejected`（判定）。畫在同方向優先順序最高的線上（交接規則 > 派工 > 隊長）；沒有就畫暫時的細點線，最近 10 分鐘有往來就留著。排入與送達的語意不變（送達才讓目標卡亮一圈），判定是另一種「已判定」。
  - **次數與紀錄**：排入後的送達、擋下、取消用 `workId`／`taskId`／`ruleId` 對上同一則（沒有就對同一對、同一類最近的排入）。每條線的徽章是最近 10 分鐘幾則；點線或徽章打開小視窗，列兩個方向最近 8 則（時間、做了什麼、結果、摘要先遮蔽再截斷）。紀錄只在前端、只記畫布開著時收到的、留一小時、每一對最多 20 則；**不從 hub 補讀舊事件**。
  - **篩選**：交接／派工／任務／關係線四個開關，記在這台瀏覽器（`localStorage` `agent-board.canvas.link-filters`，讀寫失敗就全開、只在這次有效）。交接關掉時連規則線一起藏。
- 設定：`Settings.dispatch`，**預設開**（GM 2026-11-06 的決定，見下）；設定頁「Session 與額度」的「允許 session 派工（MCP 工具）」標 ◈ 耗額度（上限改在「隊長自主擴編」，§11.7）。改了寫 audit `settings.update`，hub 重送 `hub.welcome`。
- **預設開的理由**：和自動接續、任務自動執行（預設關）不同，工具本身不花額度、也不會自己動：一定是 GM 叫畫布上的 Claude 派工、Claude 決定呼叫才會開成員。開成員就是開 session，所以標 ◈、有團隊人數上限（§11.7）、權限不比呼叫者寬、不能巢狀，GM 可以隨時關掉（關掉後新開的 session 完全不掛 MCP server）。

### 11.6 已知限制

- 實測只到 `claude -p`（見 `docs/claude-code-notes.md`）；互動模式（PTY）下的 `/mcp` 畫面、權限對話框、MCP server 啟動時間未在真的畫布 session 上驗證。
- hub 只知道建立時的權限模式；Claude 在 session 裡用 Shift+Tab 切到更寬的模式，上限不會跟著變（反過來也一樣）。
- `dispatch_work` 只在 `Stop` 時結算：成員回合中 API 錯誤（`StopFailure`）不算完成，工作留著，直到下一個 Stop、被中斷、結束或封存。
- 送字佇列只在記憶體：hub 重啟時還沒送出的 `send_task` 會遺失（audit 有 `dispatch.send`，沒有 `dispatch.delivered`）；已送達的工作（`dispatch_work`）在資料庫，結果照樣送回。
- 前端團隊資料靠 10 秒輪詢，新團隊與新成員的框最慢 10 秒後出現（2026-11-10 起派工新增、封存成員後 hub 另外推 `team.updated`，畫面馬上重讀）。

### 11.7 隊長自主擴編（GM 2026-11-10）

GM：「我組出來的團隊不見得合適；LD 要能自己新增它要的人才，人手不夠時可以自己新增成員、擴大自己的團隊。」GM 決定：自動新增（不用核准）＋通知 GM；團隊總人數上限 12；隊長可以封存任何成員（RUN 中的不行，封存可還原；審查後補：等 GM 允許、等審計畫、還欠結果的也不行）；評估時機＝收到任務時＋執行中卡住時。

- **守則放哪裡**：`protocol/src/leadGuide.ts` 一處（給 Claude 看，英文）。用在 MCP server 的 `instructions` 與工具說明（`hook/src/mcp.ts` 直接 import，這個檔案不 import 任何東西，打包也不帶 zod），以及 `list_members`、`get_progress` 回傳的 `staffing.guide`。**不用 hook `additionalContext`、不自動送字**：Claude 只有在讀工具清單或呼叫工具時看到（no-llm 保證不變）。節奏：收到任務先評估要哪些角色、對照 `list_members` → 不夠就 `spawn_member`（附理由）→ 分工寫進進度卡、`send_task`、等結果 → 執行中卡住、工作量太大、缺專長就補人 → 做完且之後用不到就 `release_member`。
- **`staffing`**（`dispatch.ts` `staffingView`）：呼叫者是那個團隊的隊長時 `{ autoStaff, size, limit, free, roles: { <角色>: { members, running } }, addsLeftThis10Minutes, guide }`；不是隊長只有 `{ guide }`（「你是成員，不能自己開人，需要人手在回覆裡告訴隊長」）。`get_progress` 的團隊卡也帶同一份（派工設定關著時不帶）。
- **新增（`spawn_member`）多的規則**，依序：全部暫停 → `board_paused`；設定關 → `autostaff_disabled`；沒帶 `reason`（空白也算）→ `reason_required`（舊呼叫會先看到這個，說明要補一句理由）；在團隊裡但不是隊長 → `not_lead`；呼叫者的團隊有全隊暫停／停止記錄（§17 `Team.hold`）→ `team_held`；同機器同帳號（`CLAUDE_CONFIG_DIR`）有還沒到重置時間的 `rate_limited` session（含呼叫者）→ `account_rate_limited`（不看「限流時排隊」設定）；團隊總人數 ≥ 上限 → `team_full`；同團隊 10 分鐘已新增 4 位 → `spawn_rate_limit`。權限上限、worktree、唯讀、巢狀規則照舊（§11.3）。理由一行、清控制字元、200 字截斷。
- **封存（`release_member`）**（全部暫停時照樣可以封存、沒有頻率上限，GM 2026-11-10），依序：設定關 → `autostaff_disabled`；沒帶理由 → `reason_required`；呼叫者不是任何團隊的隊長 → `not_lead`；對象只能是**呼叫者當隊長的團隊**裡沒封存的成員（名稱或 id）→ 否則 `not_your_member`（在別隊只是成員也一樣）；自己 → `cannot_release_self`；那一隊有全隊暫停／停止記錄 → `team_held`；對象還沒結束且回合中（`running`、`starting`、`waiting_permission`、`plan_review`：GM 可能正在看它的權限框或計畫）→ `member_busy`（訊息依狀態分開寫）；對象還沒結束且還欠結果（`sessions.dispatch_work` 還在，或呼叫者送給它的工作還在送字佇列）→ `member_busy`（叫它等 `[Result from …]`）。走 hub 的封存流程（§9.1：還活著的先停、機器離線就照樣封存等重連補停、暫停從它出發或指向它的交接規則、對話保留、可以在設定→已封存還原）；audit `session.archive` 的 user 是 null、detail 多 `byLead`。
- **人數怎麼算**：`team_members` 裡 session 沒封存的（含已結束、還沒封存的；含隊長）。還沒有團隊的呼叫者算 1。封存的成員還原後回到團隊，可能暫時超過上限（不會被擋，只是不能再新增）。
- **記錄**：成員卡（團隊名單）顯示「由 <隊長> 新增：<理由>」——settings 表 `memberAdded:<sessionId>`（`MemberAdded`：`bySessionId`、`byName`、`reason`、`at`），hub 回傳 `TeamMember.added`；永久刪除 session 時一起刪。audit `dispatch.spawn`（多 `reason`、`teamSize`、`teamLimit`）、`dispatch.release`（from、to、team、name、role、reason）、被擋下的 `dispatch.blocked`（`tool`、`reason`）；session 事件 `dispatch.spawn`（多 `reason`）、`dispatch.release`（記在成員）。
- **團隊動態**（收件匣）：settings 表 `teamActivity`（新的在前，最多 `TEAM_ACTIVITY_KEEP` = 100 筆）。`TeamActivity`：`id`、`at`、`kind`（`member_added`／`member_released`）、團隊 id 與名稱、隊長 id 與名稱、成員 id 與名稱、`role`、`reason`、`read`。board 快照帶 `teamActivity`，變了推 `team.activity`（整份）。`POST /api/team-activity/read`、`POST /api/team-activity/clear`（auth user，body `{ ids? }`，沒給＝全部，回傳新清單，audit `team_activity.read`／`team_activity.clear`）。已讀、清除是全站共用（不是每個帳號各自）。收件匣抽屜與手機收件匣底下都有「團隊動態」區塊（`flows/TeamActivity.tsx`），不算在「等你」裡；沒有動態時不顯示。
- **推播**：設定 `autoStaff.push`（預設開）且通知開著、不在勿擾時段。合併通知開著時併進下一則總表（`SummaryPayload.team`：`{ reason: team_member_added|team_member_released, lead, member, sessionId }`，最多 3 項；只有團隊動態時標題「團隊動態」）；關著時單獨一則 `{ reason, name: <隊長>, member, sessionId, at }`（tag `team-<成員 id>`）。**不帶理由**（理由是 Claude 寫的字，同「推播不帶內容」原則），點了開收件匣。
- **設定**：`Settings.autoStaff = { enabled: true, teamLimit: 12（2–20）, push: true }`（舊設定沒有這個鍵＝預設）；`PATCH /api/settings` 帶整個 `autoStaff` 物件。設定頁「Session 與額度」→「隊長自主擴編」（區塊 id `autostaff`）：開關（◈ 耗額度）、團隊人數上限、推播開關；派工關著時提示這一項沒作用。關掉＝隊長不能新增也不能封存，`send_task` 等照常。
- **上架順序**：hub、daemon、hook（`agent-board-mcp`）**要一起更新**。舊 hub 的 `DispatchTool` 不認得 `release_member`，新 daemon 轉過去會被拒；舊 daemon 不給 `AGENT_BOARD_MCP_TOOLS` 時，新 hook 只列原本四個派工工具（`LEGACY_DISPATCH_TOOLS`，沒有 `release_member`，因為舊 daemon 的 `--allowedTools` 沒有它，列出來一呼叫就跳權限框）。
- **已知限制**：守則只是工具說明與回傳裡的文字，Claude 會不會照著評估人手要實測（未驗證）；`account_rate_limited` 只看 hub 已知的 `rate_limited` 狀態（還沒撞到限流前不會擋）。

## 12. 全部暫停（P2 項目三，GM 2026-11-08；`docs/p2-spec.md` §3）

hub／protocol 在 P2 第一輪；前端（底部指令列、暫停提示列、手機收件匣暫停鈕）在 P2 第二輪接上，前端契約見本節最後一條。

- **兩種模式**（`BoardPauseMode`）：`finish_turn` 做完這輪就停——擋所有自動送字與自動開新 session，正在跑的回合跑完；`interrupt` 立刻中斷——同一個閘門，另外對每個 `running`（RUN）的 session 送一次 Esc。`interrupt` 一定包含 `finish_turn` 的閘門（Esc 後回到等輸入，不擋的話交接、任務會立刻再餵它）。
- **閘門**：所有 hub 自己送的字都經過 `SafeDelivery`（交接、任務自動執行、MCP `send_task` 與結果送回、額度恢復自動接續）。暫停中照收不送，**留在佇列**；每一則被擋下的寫 audit `board.held`（session＝目標，detail：`kind` handoff／task／dispatch／dispatch_result／auto_continue、`key`、訊息前 200 字）；按暫停時已在佇列裡的也各寫一筆；同一個 key 還沒送就被蓋掉重排（例如 `send_task` 取代前一則）不再寫，所以筆數＝排隊則數。字已打進去、Enter 前才按暫停：**照樣按 Enter** 把這一則送完（字已在輸入框，不按會留下殘字，這一則也會被當成沒送出丟掉）；暫停只擋還沒打字的。
- **自動開新 session**：`drainQueue` 暫停中一個都不開（QUE 維持排隊，statusDetail 不變）；MCP `spawn_member` 回 `board_paused: …`，不開 session，audit `dispatch.blocked`（reason `board_paused`）。**閘門擋不到的一個缺口**：暫停前剛被 `spawn_member` 開、還在 `starting` 的成員，daemon 開好後會自己把派工訊息（`firstPrompt`）送進去；按暫停時把這些 session 列在 `board.pause` 的 `startingDispatched`，讓 GM 知道。`send_task` 照收，回 `state: 'queued'`，detail 說明繼續後才送。
- **不擋**：GM 自己的操作——`terminal.input`／`terminal.signal`、核准、REST 開新 session（有名額就開，沒名額照常排隊）、接續（Q6）。
- **立刻中斷**：對 `endedAt === null && status === 'running'` 且機器在線的 session 送 `terminal.signal { signal: 'escape', onlyIfStatus: 'running' }`（daemon 看到的狀態不是 running 就不送，避免 Esc 變成拒絕權限請求），結果 `requested`；PERM／PLAN／ASK／ERR 不動。斷線前在跑（`status === 'offline'`、`pre_offline_status === 'running'`）的列為 `offline`（沒送到：失聯）。daemon hello 的 `features` 沒有 `signal.onlyIfStatus` 的（舊版 daemon，會無條件送 Esc）**不送**，列為 `unsupported`。
  - 帶 `onlyIfStatus` 的 signal，daemon 一定回 `terminal.signalResult { sessionId, signal, sent, status }`（找不到 session 時 sent false、status null）。hub 只認這次暫停送出、還沒回報的那幾個。`sent: true` 才照使用者按 Esc 的同一條路處理：清派工成員手上的工作（`dispatch.blocked` reason `interrupted`）、取消自動接續、audit `terminal.signal`（user＝按暫停的人）。`sent: false` 什麼都不清（成員之後 Stop 的結果照常送回呼叫者），audit `board.interrupt_skipped`（detail `{ status }`）。回報前 daemon 斷線：不處理（送了沒送不知道；成員之後 Stop 照常結算）。
- **全部繼續**：只解除閘門，然後 `SafeDelivery.flush()` 與 `drainQueue()` 放出排隊的，之後才廣播 `board.pause`（推的是放出之後的排隊數）；**不**對被中斷的 session 送「繼續」（Q8）。沒暫停時呼叫什麼都不做（不寫 audit）。
- **存放**：`settings` 表的 `boardPause` 鍵（不是 `Settings` 的欄位：`/api/settings` 讀不到也改不到；不升 schema）。內容 `{ mode, since, by, byName, clearedOnRestart, heldInMemory }`；`heldInMemory` 是記憶體佇列裡被擋下的則數（不含自動接續），暫停中每次變動就寫回。hub 重啟後仍是暫停；記憶體佇列遺失的則數加進 `clearedOnRestart`（audit `board.held_cleared`，reason `hub_restarted`），畫面在提示列交代，按繼續後歸零。自動接續存在 `sessions.auto_continue`，重啟後照樣排回來、照樣被擋。
- **API**（auth **user**，手機登入的一般帳號也能用）：`GET /api/board/pause` → `BoardPauseState`；`POST /api/board/pause { mode }` → `{ state, interrupted: BoardInterruptResult[] }`（已暫停時再按＝改模式，`since` 不變，interrupt 再送一次 Esc）；`POST /api/board/resume` → `{ state, released: BoardHeld }`（released 是按下時的排隊數）。
- **`BoardPauseState`**：`{ paused: BoardPause | null, held: { deliveries, sessions, sessionsWaiting, autoContinues } }`。deliveries＝佇列裡的交接／任務／派工；sessions＝繼續後 `drainQueue` 會馬上開的 QUE（帳號沒限流、機器在線，再依同時 session 上限截斷，順序同 `drainQueue`）；sessionsWaiting＝其餘 QUE（等名額、等限流解除、機器離線，繼續後也不會馬上開）；autoContinues＝已到期、等著送的自動接續。「全部繼續」前顯示「會放出：排隊送字 N 則、排隊 session M 個、到期的自動接續 K 個」用 deliveries／sessions／autoContinues。沒暫停時 held 照算。
- **WebSocket**：`board.state.pause`（舊版 hub 不送＝`NOT_PAUSED`）；暫停、繼續、排隊數變化時（不論有沒有暫停）廣播 `board.pause { pause }`（同一個事件迴圈內的變化合併成一則，沒變不送）。
- **audit**：`board.pause`（user，detail `{ mode, previous, interrupted, startingDispatched? }`）、`board.resume`（user，detail `{ mode, since, released }`）、`board.held`、`board.held_cleared`，每個 daemon 確認送了 Esc 的 session 一筆 `terminal.signal`，沒送的一筆 `board.interrupt_skipped`。
- **protocol 權限**：本節的 protocol 變更（`BoardPause*`、`BoardHeld`、`BoardInterruptResult`、3 條 REST、`board.pause`、`board.state.pause`、`terminal.signal.onlyIfStatus`、`terminal.signalResult`、`daemon.hello.features`、`DAEMON_FEATURES`）由實作者修改，**合併前須由 Lead 審查**（§8）。
- **前端（`packages/web/src/shared/`，§8 Lead 區域，合併前須由 Lead 審查）**：`BoardBackend.pauseBoard(mode)`／`resumeBoard()` 對應兩條 POST，回傳原樣；`BoardSnapshot.pause` 來自 `board.state.pause`，`board.pause` 廣播時更新（舊版 hub 沒有＝`undefined`，畫面當成 `NOT_PAUSED`）。REST 回應只在送出後還沒收到新的 `board.state`／`board.pause` 時才拿來更新畫面（`HubConnection.pauseSeq`），避免較晚到的回應蓋掉較新的廣播。立刻中斷的結果（`interrupted`）只有按的那個瀏覽器拿得到（hub 不廣播），其他裝置只看到模式。fake backend（demo）會模擬同一套：閘門擋交接、RUN 收 Esc、`board.pause`／`board.resume`／`terminal.signal` 稽核，另有 `setPauseState()` 給測試直接設定狀態。

## 13. 工作區與團隊群發（P2 項目二，GM 2026-11-08；`docs/p2-spec.md` §2）

- **命名**：工作區在程式裡一律叫 **zone**（`Zone`、`zoneId`、`zones` 表、REST `/api/zones`），和既有的 `layouts.workspace`（版面組 `'default'`／`'default.previous'`）分開。畫面上叫「工作區」／Workspace。
- **schema v9**（升級前照 `db.ts` 自動備份 `hub.db.bak-<時間>-v8`）：新表 `zones(id, name, created_at, position)`，建一個預設工作區 id `main`、名稱「主要」（`DEFAULT_ZONE_ID`／`DEFAULT_ZONE_NAME`，Q3）；`teams.zone_id`、`sessions.zone_id`（NOT NULL DEFAULT `'main'`，舊資料全部歸進去）；`notes.workspace` 改名 `notes.zone_id` 並改成 `'main'`（`Note.workspace` → `Note.zoneId`，`notesList` 的 query 改 `zoneId`）。`layouts` 不動（座標共用，工作區只是顯示篩選）。**外鍵用觸發器**：SQLite 不能 ALTER 加「有預設值又有外鍵」的欄位，重建表會觸發 ON DELETE CASCADE，所以寫入不存在的 zone、刪除還有團隊／session／便利貼的 zone 都由觸發器 `RAISE(ABORT)`。降級：v8 hub 拒絕 v9 資料庫（`tooNewMessage` 指出 `-v8` 備份）；升級後新增的工作區、角色 `tester` 會隨還原遺失。`TeamRole` 加 `tester` 必須和 v9 同版上架。
- **歸屬**：團隊成員所在的工作區**跟著團隊**（`Team.zoneId`）；不屬於任何團隊的 session 看 `Session.zoneId`（是成員時這欄被忽略但保留；同時在幾個團隊取名稱排序第一個）。成員離開團隊、團隊刪掉時，hub 把成員的 `zoneId` 設成團隊所在的工作區，卡片不會跳走。新建 session 放 `sessionsCreate.zoneId`（沒帶＝排第一個的工作區；「主要」只要不是最後一個就能刪，所以不寫死 `main`）；新團隊 `teamsCreate.zoneId`（同）；MCP `spawn_member` 新開的團隊放呼叫者所在的工作區，成員跟團隊。
- **REST**（auth user）：`GET/POST /api/zones`、`PATCH /api/zones/:id { name }`、`DELETE /api/zones/:id`：還有團隊或沒封存的單獨 session → 409 `zone_not_empty`（`ApiError.detail` 是 `ZoneNotEmpty { teams, sessions }`，message 也帶 `teams=N, sessions=M`）；最後一個 → 409 `last_zone`；可刪時封存的 session、便利貼搬到第一個剩下的工作區（audit `zone.delete` 的 detail 帶 `movedNotes`、`movedTo`）。換工作區：`PATCH /api/teams/:id { zoneId }`、`PATCH /api/sessions/:id { zoneId }`（不存在 → 400 `unknown_zone`）。audit `zone.create`／`zone.rename`／`zone.delete`、`team.zone`、`session.zone`。
- **移入時排到右側空白**（§2.8 必要規則）：團隊或單獨 session 換工作區時，**hub** 把每個使用者存在版面組 `'default'`（`CANVAS_LAYOUT_SET`）的這組卡平移到目標工作區現有卡片最右邊＋`ZONE_MOVE_GAP`（304＝團隊框內距 32×2＋間距 240）、上緣對齊（`protocol` 的 `zoneMoveShift`）；目標工作區沒有別的卡就不動，`'default.previous'` 不動。所以手機團隊面板、沒開畫布的瀏覽器、API 移動也會排好。開著畫布的瀏覽器收到變化時用同一個函式排自己畫面上的卡再存回（結果相同）。
- **WebSocket**：`board.state.zones`、`board.state.broadcasts`（舊版 hub 不送＝空）；`zone.list { zones }`（建立、改名、刪除時整份）；`team.updated { team }`／`team.removed { teamId }`（建立、修改、換工作區、刪除；前端收到就重讀團隊，不等 10 秒輪詢）；session 換工作區走既有的 `session.updated`。
- **群發**：`POST /api/teams/:id/broadcast { text, targets? }` → `Broadcast`。targets 有帶＝@ 點名（不是本團隊成員 → 400 `not_member`），沒帶＝整組（不含已封存）。**hub 端走 `SafeDelivery`**（`DeliveryItem.manual`）：只在對象 `waiting_input`（NEW、ASK）時送，文字與 Enter 分開、送 Enter 前再確認；RUN／PERM／PLAN／ERR／QUOTA／QUE／OFF 排隊；已結束／封存略過。`manual` 的不受全部暫停擋（Q6），也不算進 `BoardHeld.deliveries`、不寫 `board.held`。每個對象的狀態 `sent`（字已打進去；Enter 沒按成改 `failed`／`not_waiting`）、`queued`、`skipped`（`ended`／`archived`）、`cancelled`、`failed`（`target_ended`）；變化經 `broadcast.updated` 推。`POST /api/broadcasts/:id/cancel { sessionId }` 取消還在排隊的。群發只放在 hub 記憶體（最多 50 則），hub 重啟就沒有：前端重連時把原本排隊中的標成 `failed`／`hub_restarted`（「沒送出（hub 重啟）」）。Enter 送出時照使用者自己打字處理（重設交接鏈、取消這次限流的自動接續）。audit：建立時每個對象一筆 `team.broadcast`（user，detail `{ teamId, broadcastId, text, mentioned, state, reason?, boardPaused? }`），送出 Enter 時 `team.broadcast.delivered`、沒送出 `team.broadcast.dropped`、取消 `team.broadcast.cancelled`，另有 delivery 照舊寫的 `terminal.input`（user null）。
- **前端**：頁首原分頁列位置是工作區分頁（`web/src/zones/`）；畫布只畫目前工作區（存版面時仍送全部的卡，別的工作區的位置不會被 PUT 洗掉）；團隊面板＝名單＋群發（`web/src/team/Roster.tsx`）。目前工作區與每個工作區的畫面位置存在瀏覽器（`agent-board.zone.current`、`agent-board.zone.viewports`）。
- **protocol 權限**：本節的 protocol 變更由實作者修改，**合併前須由 Lead 審查**（§8）。

## 14. 進度卡與 Memory（P3 項目一，GM 2026-11-08；`docs/p3-spec.md` §1）

- **擁有者**：一張卡屬於一個團隊，或一個**不屬於任何團隊**的單獨 session（D1）；一個擁有者最多一張，第一次寫入時建立。欄位 `status`、`next`、`blockers`（GM、agent 都能寫，各 2,000 字）、`gmNotes`（只有 GM，4,000 字）。欄位存檔前清控制字元（保留換行）、超過上限一律拒絕不截斷。前端只渲染清單、粗體、行內 code。型別與共用規則在 `protocol/src/progress.ts`（`ProgressCard`、`ProgressFields`、`ProgressRevision`、`ProgressConflict`、`ProgressWrite`、`planProgressWrite`、`progressLine`、`progressStale`）。
- **schema v10**（升級前照 `db.ts` 自動備份 `hub.db.bak-<時間>-v9`）：`progress_cards`（`team_id`／`session_id` 各自 UNIQUE、外鍵 ON DELETE CASCADE、CHECK 剛好一個非空；四欄位；`revision`；`locked`；`updated_at`、`updated_by_kind`（user／session）、`updated_by_id`；`field_revisions` JSON）、`progress_revisions`（`card_id` CASCADE、`(card_id, revision)` UNIQUE、`fields` JSON、`by_kind`、`by_id`、`source` web／mcp／restore、`at`），每張卡只留最新 50 版（寫入同交易刪舊的）。團隊或 session 刪掉時卡片與歷史一起刪（audit 保留）。同一個 v10 也建項目二的 `team_presets`（§15）與項目三的 `session_events(type, at)` 索引（§16）：P3 只有這一個 migration（`MIGRATIONS` 長度 10），三個分支整合時已併好。降級：v9 hub 拒絕 v10 資料庫，回退＝停 hub → 換回 v9 版 → 還原 `-v9` 備份（之後寫的進度卡遺失）。
- **三方比對**（hub `progress.ts` 的 `writeCore`，同一個交易）：每次寫入帶 `baseRevision`。`== revision` 直接寫，`revision + 1`；不相等時只看這次真的會改的欄位（帶了而且內容不同）：任何一個的 `field_revisions[f] > baseRevision` 就整筆拒絕（`progress_conflict`，附目前的完整卡片、每個衝突欄位「讀到的（base，歷史已修剪時 null）／現在的」與最後改的人），否則合併寫入、回 `merged: true`。`baseRevision > revision` 拒絕（`invalid_revision`）。GM 與 agent 同一套規則，不自動重試。
- **鎖定**：只有 GM（網頁）能切 `locked`（不加版本，audit `progress.lock`）；鎖定中 agent 的 `update_progress` 回 `card_locked`，`get_progress` 照常並註明，GM 照樣可改。**還原**＝以舊版內容寫一個新版本（`source: restore`，不做三方比對、不刪歷史）。
- **REST**（auth user）：`GET /api/progress?zoneId=&all=`；`GET|PUT /api/teams/:id/progress`、`GET|PUT /api/sessions/:id/progress`（PUT body `ProgressWrite { baseRevision, status?, next?, blockers?, gmNotes?, locked? }` → 卡片，衝突 409 `progress_conflict`（`ApiError.detail` 是 `ProgressConflict`），太長 400 `field_too_long`，擁有者不存在 404）；`GET …/progress/revisions`（新到舊）；`POST …/progress/restore { revision }`；`POST …/progress/deliver { sessionId }`（帶入進度卡，卡片全空 400 `progress_empty`）；`POST /api/teams/:id/progress/ask-update`（請隊長更新，沒有隊長 400 `no_lead`）。後兩個回 `Broadcast`（`kind: progress｜ask_update`、`cardKey: team:<id>｜session:<id>`、單獨 session 的卡 `teamId` 是 null），和群發同一條 `SafeDelivery`（`manual`）與同一套結果、取消（`/api/broadcasts/:id/cancel`），audit `progress.deliver`／`progress.ask_update`（＋`.delivered`／`.dropped`／`.cancelled`）。
- **WebSocket**：`board.state.progress`（寫過的卡，含自動事實；舊版 hub 不送＝空）；`progress.updated { card }`（任何寫入、鎖定、還原都推給每個 client）。
- **自動事實**（`ProgressFacts`，hub 從既有資料算、不存、不呼叫模型）：`teamName`、任務板完成數／總數與進行中的標題、最近 24 小時的 `file.changed`（相對 repo 的路徑、最多 10 個、只有 Edit／Write 類）、研究階段、成員狀態、`lastStopAt`（卡片最後更新之後最後一次 Stop；沒有或卡片沒寫過是 null。hub 每個成員沿 `(session_id, at)` 索引倒著找、以 `updatedAt` 為下限、取第一筆）。`progressStale`：最後更新超過 24 小時而且之後有 Stop → 畫面標「⚠ N 天沒更新」。
- **MCP 工具**（`agent-board` server，全名 `mcp__agent-board__get_progress`／`update_progress`，走 §11 同一條 daemon → hub 路徑：`dispatch.request` 的 `tool` 改成 `AgentBoardTool`，hub 依 `isMemoryTool` 分派到 `ProgressEngine`）：
  - `get_progress { team? }`：呼叫者所屬團隊的卡（四欄位、revision、鎖定、更新時間與更新者、goal、doneCriteria、contextMd（超過 8,000 字截斷並註明）、自動事實）；在多個團隊沒給 team → `{ cards: [...] }`；不在團隊 → 它自己的卡；沒有卡 → 空欄位、`revision: 0`。
  - `update_progress { baseRevision, status?, next?, blockers?, team? }`：只寫有帶的欄位；帶 `gmNotes` 或沒帶任何欄位 → `invalid_arguments`；超過上限 → `invalid_arguments`（寫出字數與上限）。誰能寫（D2）：團隊的隊長；團隊沒有隊長時任一成員；單獨 session 寫自己的卡；其他 → `not_lead`。頻率：同一張卡、同一個 session 10 分鐘最多 10 次成功寫入，另外最多 30 次嘗試（含衝突、鎖定被拒），超過都回 `rate_limit`（不寫 audit、不附整張卡）。隊長寫入不用 GM 核准（GM 2026-11-08 Q2）。
  - 錯誤代碼（`<code>: <說明>`）：`memory_disabled`、`no_card_owner`、`not_lead`、`progress_conflict`、`card_locked`、`invalid_arguments`、`rate_limit`。
  - MCP `instructions` 加兩句固定英文（開始新工作或 /clear、compact 後先 `get_progress`；完成一段或停下來等使用者前 `update_progress`；gmNotes 是使用者的固定規則必須遵守）。
- **掛載**：`Settings.memory`（預設開，D3）由 `hub.welcome.memory` 下發，daemon 存在 `sessions.json`（舊檔沒有＝**關**：只有 hub 明確送過 `memory: true` 才掛，新 daemon 搭舊 hub 不會掛舊 hub 不認得的工具）。daemon 掛 MCP server 的條件是 `dispatch` 或 `memory` 開著（兩個都關完全不掛）；`--allowedTools` 只列開著的功能的工具全名；MCP 設定檔的 env `AGENT_BOARD_MCP_TOOLS` 列同一份短名稱，MCP server 的 `tools/list` 只列、`tools/call` 只接受這些（沒有這個 env＝舊版 daemon，只有原本的派工四個，不含 2026-11-10 的 `release_member`）。daemon hello `features` 加 `mcp.memory`（hub 不需要知道每個 session 掛了什麼）。設定改了只影響之後開的 PTY；已掛著的呼叫 hub 回 `memory_disabled`。
- **前端**（`web/src/progress/`）：畫布進度卡（`CanvasProgress`，節點之上自己的一層（ViewportPortal 在節點底下會被蓋住），團隊框右上角外側 16 螢幕 px；收合一行「下一步」；< 40% 只畫小標籤；展開或從 Memory／收件匣打開時反向縮放回螢幕大小）；團隊面板名單上方的進度卡；Memory 右側面板（`#/memory`，和收件匣、團隊面板互斥；手機全螢幕）；底部列 `[＋ 新增 session] [群組] [Presets] [Memory] │ …`（Presets 是 §15）；收件匣（手機）每列「下一步：…」；單獨 session 的卡片選單「進度卡」。一鍵整理畫布時團隊框、寫過卡的單獨 session（自己一塊）右邊預留 `PROGRESS_RESERVE`（296 畫布 px）。遮蔽模式開著時卡片、自動事實的檔案、編輯中的差異、衝突並排、歷史都過 `useMaskText`（編輯框是原文，旁邊有提示）。`BoardBackend` 加 `getProgress`／`saveProgress`／`progressRevisions`／`restoreProgress`／`deliverProgress`／`askProgressUpdate`，`BoardSnapshot.progress`；`ApiRequestError` 帶 `detail`；fake backend 用同一套 protocol 規則，另有 `agentProgress()`／`patchProgress()` 給測試模擬 agent 寫入與久未更新。
- **no-llm**：`docs/no-llm-review.md` 已列出新工具、`--allowedTools` 最多 6 個、「帶入進度卡」「請隊長更新」兩個送字來源；`scripts/check-no-llm.mjs` 檢查工具清單正好是審查過的 6 個。
- **已知限制（未驗證）**：Claude 在互動模式下會不會照 instructions 自己呼叫 `get_progress`／`update_progress`，沒有在真的畫布 session 實測（驗收 15，待 GM 實測）。
- **protocol 權限**：本節的 protocol 變更由實作者修改，**合併前須由 Lead 審查**（§8）。

## 15. 團隊 Presets（P3 項目二，GM 2026-11-08；`docs/p3-spec.md` §2）

- **是什麼**：把一組設定好的團隊（角色、權限模式、模型、worktree、機器與資料夾、目標與 TEAM.md、交接規則、任務自動執行、隊長第一個指令、初始進度卡）存起來，下次一鍵套用。和單一 session 的「範本」（`templates`）分開：範本＝一個 session；Preset＝整個團隊。內建組合（squad／standard／explore、研究四階段）仍只在新增團隊表單。
- **schema v10**（和 §14 進度卡、§16 搜尋索引同一個 migration）：新表 `team_presets(id, name UNIQUE COLLATE NOCASE, config JSON, position, created_at, updated_at, last_used_at)`，索引 `team_presets_position`；不參照任何表（機器被移除時 Preset 留著，預覽說「機器不存在」）。升級前自動備份 `-v9`；v9 hub 拒絕 v10 資料庫，回退後升級後存的 Preset 會遺失。
- **`TeamPresetConfig`**（`packages/protocol/src/presets.ts`，zod）：`teamType`（dev／research）、`phase`（研究團隊才有）、`color`、`goal`、`doneCriteria`、`contextMd`、`placement { machineId, cwd, projectId }`（不存工作區：套用時放目前工作區）、`rows[] { kind, permissionMode, model, useWorktree, label }`（1–12 列；`useWorktree` null＝依角色規則；`label` null＝預設命名，否則名稱是 `<團隊名>-<label>`）、`handoffRules[] { fromRow, toRow, trigger, filePattern?, marker?, maxRounds?, enabled }`（以列序號表示）、`taskAuto`、`leadFirstPrompt`（≤ 4,000 字）、`attachProgressCard`（預設開）、`initialProgress { status, next, blockers, gmNotes }`。欄位關係由 `teamPresetProblem` 檢查（剛好一位隊長、分工符合團隊類型、研究團隊要有階段、規則指到存在且不同的列、`on_marker` 要有標記），hub 存檔與前端存檔前都用。
- **REST**（auth **user**，手機一般帳號也能用）：`GET /api/team-presets`（照 position 排）、`POST /api/team-presets { name, config, position? }`（position 給了就插回那個位置，用在刪除後「復原」）、`PATCH /api/team-presets/:id { name?, config?, position? }`（position＝移到第幾個，其他依序重排）、`DELETE /api/team-presets/:id`（刪後補位）、`POST /api/team-presets/:id/used { teamId, created, failed, rulesCreated, rulesFailed, firstPromptHeld }`（套用完成回報：有建成至少一列才更新 `lastUsedAt`）。名稱不分大小寫重複 → 409 `preset_name_taken`；config 不合法 → 400。
- **WebSocket**：`board.state.presets`（舊版 hub 不送＝空）；建立、改名、修改、排序、刪除、套用後最後使用時間變了都廣播 `preset.list { presets }`（整份）。
- **audit**：`preset.create`／`preset.update`／`preset.delete`（detail 只有名稱、位置與摘要：列數、規則數、開啟的規則數、任務自動執行、有沒有第一個指令、有沒有略過權限，不記 TEAM.md 與指令全文）、`preset.apply`（`presetId`、`name`、新團隊 `teamId`、`created`、`failed`、`rulesCreated`、`rulesFailed`、`firstPromptHeld`）。建立 session、團隊、成員、規則照舊各自寫 audit。
- **套用（前端）**：hub 不建立任何東西。前端預覽（GM Q1：先預覽）即時檢查機器在線、資料夾存在（`machineBrowse`，`fs_error`＝不存在）、`validatePlan`、會不會排隊（owner 讀得到同時上限時），按「建立」或 Enter 後沿用 `web/src/team/runPlan.ts`：建團隊（`taskAuto` 一起設）→ 逐列 `createSession`＋加入團隊（隊長列帶第一個指令）→ 照列序號建交接規則（來源或目標沒建成的略過）→ 寫初始進度卡（P3 項目一的 `PUT /api/teams/:id/progress`，`BoardBackend.saveProgress({ teamId }, { baseRevision: 0, … })`，寫成 revision 1；失敗時留在預覽說「初始進度卡沒寫入」）。團隊面板「⋯ → 存成 Preset」在團隊寫過進度卡時多一個「把目前進度卡當初始內容」勾選。部分失敗保留已建的、不自動重試。隊長第一個指令＝附上進度卡時 `[Progress card: <團隊>] …` 一行＋空格＋Preset 的指令（`leadFirstPrompt`）。
- **全部暫停中套用**（D7）：照樣建立；隊長第一個指令**不隨建立送出**（daemon 的第一個指令不經 `SafeDelivery` 閘門），改記在該瀏覽器（localStorage `agent-board.preset.heldPrompts`），隊長卡片與團隊面板出現「送出第一個指令」，GM 按下才經 `POST /api/teams/:id/broadcast { targets: [隊長] }`（`SafeDelivery` 的 `manual`）送。**限制**：只有套用的那台瀏覽器看得到這顆按鈕（hub 不存）。
- **前端（`packages/web/src/shared/`，§8 Lead 區域，合併前須由 Lead 審查）**：`BoardBackend.listTeamPresets`／`createTeamPreset`／`updateTeamPreset`／`deleteTeamPreset`／`teamPresetUsed`；`BoardSnapshot.presets`（`board.state.presets`、`preset.list` 更新）。fake backend 有同一套（名稱不分大小寫唯一、position 重排、`preset.apply` audit），`browseDirectory` 對含 `does-not-exist` 的路徑回 `fs_error`，`createSession` 有第一個指令時寫 `terminal.input` audit（同 hub）。
- **protocol 權限**：本節的 protocol 變更（`presets.ts`、5 條 REST、`preset.list`、`board.state.presets`）由實作者修改，**合併前須由 Lead 審查**（§8）。

## 16. 全域搜尋（P3 項目三，GM 2026-11-08；`docs/p3-spec.md` §3）

> ③a 快速層與 ③b 深層（2026-11-09）都在本節。

- **兩段式**：輸入時（停 250ms、至少 2 字，`SEARCH_DEBOUNCE_MS`／`SEARCH_MIN_CHARS`）只跑**快速層**：hub SQLite 已有的資料。按 Enter（沒選任何一列時）或「也搜對話與終端機」鈕才跑**深層**：各台 daemon 即時搜對話紀錄 JSONL 與活著的 session 的終端機畫面（見下面「深層」）。hub 仍不存終端機與對話內容（§2），深層也不會在 hub 建索引、不落地。
- **比對**（`protocol/src/search.ts`，hub 與假後端共用同一份純函式）：不分大小寫子字串（`foldCase`，長度不變）；空白分隔的多個詞＝每個都要出現（AND）；雙引號包起來＝完整片語；連續空白與換行當一個空白；查詢字最多 200 字。不做正規表示式、模糊或語意搜尋，不呼叫模型。
- **快速層的來源**（`hub/src/search.ts` 的 `QuickSearchSource`，可插拔）：
  - 檔案改動：`session_events` 的 `file.changed`（只有 Edit／Write／MultiEdit／NotebookEdit 的路徑；Bash 改的沒有），同一個 session 同一個檔一列，附時間範圍內的次數（`count`），片段是相對 repo 的路徑（詞只出現在被去掉的前綴時改顯示完整路徑）。
  - session：名稱、分支、資料夾、worktree 路徑、最後 4 行（每個 session 最多一列），以及時間範圍內的每回合最後回覆（`hook` 的 `last_assistant_message`）、`handoff.*`／`dispatch.*`／`task.*` 事件的 `summary`。
  - 團隊：名稱、目標、完成條件、TEAM.md（每隊最多一列）、任務標題。不看時間範圍。
  - 進度卡（§14）：`progressSource`（`BUILTIN_SOURCES` 裡排在團隊前面），搜目前版本的狀態、下一步、阻礙、GM 備註（寫過的卡，每張最多一列，`kind: 'progress'`、`field: 'progress'`、`at`＝最後更新時間）。不看時間範圍；團隊卡跟著團隊的工作區（帶 `teamId`），單獨 session 的卡跟著 session（帶 `sessionId`）。點結果：桌面聚焦團隊（或 session）並展開畫布上的卡；手機團隊卡開團隊面板、單獨 session 的卡開 Memory 並展開。
  - GM 送出的指令：`audit_log` 的 `terminal.input`（hub 寫 audit 時已遮蔽密碼提示與金鑰），**只算人打的**（`user_id IS NOT NULL`）：自動交接、自動接續、群發由 delivery 代送的那幾筆是 user null，不放進這組（群發原文在 `team.broadcast` audit，這一版不搜）。**只回給 owner**（和 audit 權限一致）。
- **範圍**：`scope=all|zone`（zone 一定要帶 `zoneId`，沒帶回 400；不存在的工作區回空結果；團隊成員跟著團隊的工作區，同 §13）、`since=24h|7d|30d`（只套用在有時間的來源）、`archived=0|1`（含封存的 session）。預設全部工作區、7 天、不含封存（D8）；前端把選擇記在 `localStorage` 的 `agent-board.search.prefs`。
- **REST**：`GET /api/search?q=&scope=&zoneId=&since=&archived=&mask=`（auth **user**）→ `SearchResults { groups: { kind, total, capped, items: SearchItem[] }[], partial }`。組依序是 `file`（檔案改動）→ `team`（進度卡與團隊）→ `session` → `input`（送出的指令）→ `transcript`（深層，目前不會出現）；只放有結果的組。組內等你的（ASK／PERM／PLAN／ERR）與 RUN 在前，其餘依時間新到舊。每組最多 50 筆、總共 200 筆、查詢逾時 2 秒（`SEARCH_GROUP_LIMIT`／`SEARCH_TOTAL_LIMIT`／`SEARCH_TIMEOUT_MS`）；逾時或截斷時 `partial: true`。`total` 是這組回了幾筆（不另外算總數）；`capped: true` 表示這組被截斷、符合的不只 `total` 筆（來源多看到一筆就算），畫面顯示「50+」與「顯示前 50 筆（還有更多…）」。逾時檢查也放進 SQL：每個查詢的 WHERE 帶 `ab_search_alive()`（`db.function` 註冊、每 256 列看一次時鐘，逾時丟錯中止這條 SQL），掃很多列卻沒有一列符合的查詢也停得下來，不會卡住 hub。session 組裡的回覆、交接、派工、任務摘要四種各自取 50 筆再依時間合併。`SearchItem` 有 `kind`、`sessionId?`、`teamId?`、`field?`（片段來自哪個欄位，`SearchField`；規格之外多的欄位，畫面上當小標）、`snippet`（≤ 160 字，被截的那邊加「…」）、`matchRanges`（片段內的命中位置）、`at?`、`machineId?`、`transcriptIndex?`（深層用）、`count?`。快速層**不寫 audit**（太頻繁）。**查詢字不寫進日誌**：hub 的請求日誌（Fastify logger）用 `LOG_SERIALIZERS` 只記路徑、去掉查詢字串（`server.ts`），GM 在遮蔽模式下貼上的金鑰不會落地。
- **遮蔽**（§3.5、D9）：`mask=1` 時 hub 先用 `maskSecrets`（`secretPatterns.ts`，web 與 hub 兩份完全相同、`mask.test.ts` 比對；畫面遮蔽用的是同一個函式）把整段文字遮好再比對、擷取片段，所以金鑰不會出現在回應裡，也比對不到（不會透露「有這把鑰匙」），`matchRanges` 是遮蔽後的位置。`mask=0` 回原文。前端遮蔽模式開著時一律帶 `mask=1`；查詢字本身像金鑰時提示「搜尋金鑰不會顯示結果」。遮蔽是形狀比對，不是安全邊界（同 §9／`security/mask.ts`）。
- **schema v10（③a 的片段）**：`CREATE INDEX session_events_type ON session_events(type, at)`；沒有新表、不動資料。查詢時 `session_id` 條件寫成 `+session_id IN (...)`，讓 SQLite 用這個索引只掃那一種事件。和 §14、§15 的表同一個 v10 migration（只升一次，升級前照 `db.ts` 自動備份 `-v9`）。
- **效能**（單元測試量測，20 萬筆 events、50 個 session、6 種查詢各 5 次，含 30 天範圍）：p95 約 84–115ms（目標 < 300ms，每次跑不同）。最壞情況另外量（30 天、各 3 次）：`stop`（每筆 hook 的原始 payload 都有、回覆裡沒有，每筆都要 json_extract）約 123–141ms，`zzqx`（英文、哪裡都沒有）約 78–102ms。照線性推，200 萬筆約 1.2–1.4 秒，仍在 2 秒逾時內，逾時時 SQL 會中止。不做 FTS；接近 200 萬筆時再評估 FTS5 外部內容表或把搜尋移到 worker_threads 的唯讀連線。
- **前端**：`web/src/search/`。開啟：`⌘K`／`Ctrl+K`，或焦點不在輸入框時按 `/`；焦點在終端機（xterm）時一律交給終端機。頁首搜尋鈕在收件匣鈕左邊；手機在收件匣頂部。網址 `#/search`（`ModalKind` 加 `search`；可帶 `?q=` 當深連結），桌面是置中次畫面（760px 寬、80vh 高），手機是全螢幕頁。↑↓ 選、Enter 前往（畫布聚焦該 session，必要時先切工作區；封存的開 `#/archive/<id>`；團隊、任務開 `#/team/<id>`；手機上等你的開收件匣那一項，其餘開團隊面板或全螢幕終端機），沒選任何一列時 Enter＝深層（見上）。hub 斷線時視窗淡化並寫一行字。`BoardBackend.search(query)`；假後端（`shared/fakeSearch.ts`）照同一套規則搜 demo 資料。
- **深層（③b，§3.5–§3.7）**：
  - **WS（瀏覽器 ↔ hub）**：`search.deep { searchId, q, scope, zoneId?, since, archived, mask }`（`DeepSearchRequest`，searchId 由瀏覽器產生；scope=zone 要帶 zoneId）、`search.cancel { searchId }`。hub 回 `search.deepStarted { searchId, machines: { machineId, totalSessions }[] }`（規格外多的一則：先告訴畫面要搜哪幾台）、`search.deepResult { searchId, machineId, items }`、`search.deepDone { searchId, machineId, state: done|offline|unsupported|timeout, scannedSessions, totalSessions }`。**只推給發起的那條連線**。auth user 即可（同 `sessionTranscript`）。**同一個使用者同時只有一個**：新的 `search.deep` 取消他進行中的那個；瀏覽器連線關掉也取消。
  - **WS（hub ↔ daemon）**：`search.request { searchId, terms, mask, since, sessions: DeepSearchTarget[], limits }`、`search.cancel { searchId }`（hub → daemon）；`search.result { searchId, items }`、`search.done { searchId, state: done|timeout, scannedSessions, totalSessions }`（daemon → hub；被取消的不回）。terms 是 hub 用 `parseSearchTerms` 拆好的詞，daemon 不再自己拆。`DeepSearchTarget { sessionId, claudeSessionId, accountProfile, lastActivityAt }` 由 hub 從資料庫帶齊。
  - **向下相容**：daemon 在 hello `features` 宣告 `search.v1`（`DAEMON_FEATURES.search`）。沒有的機器 hub **不送請求**，直接回 `unsupported`（畫面「版本太舊不支援」）；不在線的回 `offline`（「失聯沒搜到」），搜到一半斷線或連線被取代也是 `offline`。舊版 hub 不認得 `search.deep` 會回 error `invalid_message`。
  - **挑哪些 session**：範圍同快速層（`searchScope`，工作區＋含封存）；排隊中（`queued`）的不搜；已結束的要有合法的 `claudeSessionId`，而且最後活動（`lastOutputAt`／`statusSince`／`endedAt` 取最新）在時間範圍內才送（範圍外的對話紀錄不會在範圍內被改過）；`accountProfile` 不是絕對路徑的不搜。依 `machineId` 分組，每台一個請求；範圍內沒有 session 的機器不列。
  - **daemon**（`daemon/src/deepSearch.ts`）：先搜活著的 session 的 headless 畫面（scrollback 5,000 行，連續非空白行一段、最多 20 行，由下往上），再依 `lastActivityAt` 新到舊逐份讀 JSONL：`fs.open`（`O_RDONLY | O_NOFOLLOW`，不跟符號連結、沒有先檢查再開的空窗）一塊一塊（1MB）讀、自己用 `\n` 切行（去掉行尾 `\r`），**不整檔載入**；單行超過 `MAX_LINE_CHARS` 的 3 倍位元組（24MB）整行丟掉不組字串，其餘照對話紀錄檢視的規則（字串長度 > `MAX_LINE_CHARS` 略過）；找檔：每個帳號設定目錄每次搜尋只掃一次 `projects/*`（`sessionFiles.ts` 的 `indexTranscripts`，規則同 `findTranscriptFiles`：不跟符號連結、在 projects 底下、同 id 取最新）；修改時間在 `since` 之前的檔不讀；`since` 之前的那幾則不算命中（還是要解析才算得出序號）；序號（`transcriptIndex`）和對話紀錄檢視的 `index` 同一套算法（同一個 `parseLine`；先篩沒過的行只用 `countEntries` 算則數，不組搜尋全文，規則和 `parseLine` 共用 `recordOf`）。先篩：每個詞拆成單字，原始 JSON 行（轉小寫）裡要都有才比對（引號、反斜線、控制字元等 JSON 會跳脫的字不拿來篩；非 ASCII 的字遇到有 `\u` 跳脫的行不篩），只省比對與擷取，不會漏。上限（`DeepSearchLimits`，預設在 protocol）：每 session 3 筆（畫面先，剩下的給對話紀錄、留最新的）、每台 100 筆、每台讀檔總量 1GB（`SEARCH_DEEP_MAX_BYTES`；規格原訂 300MB，一台 7 天內實測約 400MB 會每次停在讀檔上限，改成主要靠 deadline 擋，**待 GM 確認**）、15 秒 deadline（排隊等待也算）。daemon 自己再收斂一次（`DEEP_HARD_LIMITS`）：每 session ≤ 10、每台 ≤ 500、讀檔 ≤ 1GB、deadline ≤ 60 秒、session ≤ 2,000 個；`accountProfile` 只認這台開過 session 的帳號設定目錄（`sessions.json` 的 `accountProfiles`，升級後開過的才記得；還在清單上的 session 用的也算），不認得的只搜畫面、不讀對話紀錄。取消、時間與讀檔量每讀一塊前檢查一次（超過上限最多多讀 1MB）。讀檔量或時間到 → `timeout`；每台筆數到上限 → `done` 但 `scannedSessions < totalSessions`。停下之後，剩下的 session 裡本來就不必讀檔的（沒有 claudeSessionId、找不到檔、檔案修改時間在範圍之前）也算進 `scannedSessions`（只用已掃好的檔案清單判斷，不再碰磁碟）。每讀完一份送一批（`search.result`），畫面的結果先一批。收到 `search.cancel` 下一塊就停止讀檔、不再回。和對話紀錄檢視的 `readQueue`（同時只讀一份）**分開排隊**：深層搜尋之間排一條佇列，新的請求進來時正在跑與排隊中的「讓位」（下一塊就停、送出已找到的、回 `timeout`），不同使用者的搜尋不會互相卡到逾時；兩條都是逐塊非同步讀，搜尋期間打開對話紀錄不用等（`deepSearch.test.ts` 驗收 7）。hub 斷線時進行中的全部停掉。
  - **daemon 的執行緒**（收尾 2026-11-10）：對話紀錄的讀檔、切行、JSON 解析、比對、遮蔽在 `worker_threads` 裡跑（`deepScan.ts` 是共用程式，`deepSearchWorker.ts` 是 worker 入口，`deepScanPool.ts` 管 worker：整個 daemon 一個、第一次搜尋才開、閒置 60 秒關、`unref`）。取消、讓位、時間與讀檔量上限放在 `SharedBudget`（`SharedArrayBuffer`＋`Atomics`），主執行緒改了 worker 下一塊就看得到；每讀完一份照樣由主執行緒送一批，行為和上面一樣。畫面搜尋（記憶體）和檔案清單掃描（非同步 I/O）留在主執行緒。發布檔：`daemon/dist/deepSearchWorker.mjs`（和 `index.mjs` 同資料夾，`build:release` 打包後實際開一次確認回 ready）。worker 起不來時記一次警告、改在主執行緒掃（以前的做法）。量測（`deepSearch.worker.test.ts`，120MB、每行都要解析，每 10ms 計時器的延遲）：worker p95 約 1ms；同一份在主執行緒掃 p95 約 18ms、計時器只跑到 4 成的次數。
  - **hub**（`hub/src/deepSearch.ts` 的 `DeepSearchEngine`）：和 daemon 之間用 hub 自己產生的 id（`randomUUID`），瀏覽器的 `searchId` 只用在回給發起的連線（別的使用者送一樣的 searchId 碰不到、取消不了；新的 `search.deep` 只取消同一個使用者的）。轉送前補 `machineId`、片段超過 160 字截掉加「…」、`matchRanges` 只留落在片段裡的、只收這台機器、這次範圍內的 session、只收 `transcript`／`screen` 兩種、每台最多 100 筆；daemon 的 deadline＋3 秒（`SEARCH_DEEP_GRACE_MS`）還沒回 `search.done` 就回 `timeout` 並送 `search.cancel`；已取消的搜尋晚到的結果丟掉並再送一次 `search.cancel`。
  - **遮蔽**：`mask: true` 時 daemon 先用 `maskSecrets` 遮好整段文字再比對、擷取片段（金鑰比對不到、也不會出現在片段裡，`matchRanges` 是遮蔽後的位置）；hub 轉送前**再遮一次**片段（第二道，遮了有變就用 `findTerms` 重算位置）。`secretPatterns.ts` 現在是 web、hub、daemon **三份完全相同**的檔案（`web/src/security/mask.test.ts` 比對三份）。前端遮蔽模式開著、查詢字像金鑰時**不送出**深層搜尋（畫面寫明）。
  - **audit**：每次深層搜尋（完成或被取消）寫**一筆** `search.deep`（user、session null），detail 是 JSON：`q`（經 `redactSecrets`，整段 detail 寫入時也再過一次）、`mask`、`machines[{ machineId, state, items }]`（被取消時還在搜的那台寫 `cancelled`）、`timedOut`、`cancelled`。快速層不寫。
  - **前端**：Enter（沒選任何一列，桌面）或按鈕 → `BoardBackend.deepSearch(request, listener)` 回 `{ searchId, cancel }`；改字、改範圍或遮蔽模式、再按一次 Enter、關視窗都會 `cancel()`（送 `search.cancel`），舊結果不再顯示。看門狗（`hubBackend.ts`）：送出後 5 秒沒收到 `search.deepStarted`（例如舊版 hub 回 error `invalid_message`），或 15＋3＋5 秒還沒全部 `deepDone`，就當失敗（`search.deepFailed`，`error: no_reply`，畫面「中控台沒有回應深層搜尋」）並送 `search.cancel`。手機 Enter 不跑，要按鈕。「對話與終端機（N）」組：每台一行進度（搜尋中／完成 N 筆／完成 N 筆（到上限，只搜了 a／b）／失聯沒搜到／版本太舊不支援／逾時只搜了部分），列同其他組（狀態燈、session 名稱、「對話 #n」或「終端機畫面」小標、片段、時間、機器晶片），排序同快速層。`⌘Enter`（或 ⌘點擊）開 `#/transcript/<sessionId>?at=<transcriptIndex>`（新的次畫面 `ModalKind` `transcript`，活著與封存的 session 都能看；共用舊資料頁的對話紀錄元件，從那則前 5 則開始讀、捲到那則並加外框，有「從頭看」）。假後端（`shared/fakeDeepSearch.ts`）：demo-studio 300ms、demo-gpu 1.5 秒（慢）、demo-laptop 失聯，比對與遮蔽用同一套函式。
  - **效能（合成資料，`daemon/src/deepSearch.perf.test.ts`，`AB_DEEP_PERF=1` 跑實際量級；開發機 Apple Silicon，檔案剛寫完、在 page cache 裡（熱 cache），冷讀與兩台實機都未量）**：225 份、629MB（7 天內 145 份），預設上限（1GB、15 秒）：沒有命中的查詢讀完 7 天內全部 462MB 約 1.4 秒（`done`，225／225）；有命中的查詢到每台 100 筆約 0.9 秒（`done`，180／225），第一批結果約 45ms。上限改成 300MB 時同一份資料約 0.9 秒停在讀檔上限（`timeout`，172／225）。
  - **已知限制**：只搜每個 session 目前的 `claudeSessionId` 那份（`/clear` 之前的不在內）；結束的 session 沒有畫面可搜；Bash 改的檔案、子 agent 的紀錄（同名資料夾）不搜。
- **no-llm**：搜尋不送任何字進 session、不呼叫模型。快速層只讀 hub 自己的 SQLite；深層的 hub → daemon 訊息走既有的 daemon WebSocket，daemon 只讀本機檔案與記憶體裡的畫面、不開行程、不對外連線、不寫 PTY。`docs/no-llm-review.md` 已補一段；`scripts/check-no-llm.mjs` 的 `CALL_SITES` 不用改（沒有新的連線、行程或送字寫法，重跑仍 29 處）。
- **protocol 權限**：本節的 protocol 變更（`search.ts`、`routes.search`）與 `shared/backend.ts`、`hubBackend.ts`、`fakeBackend.ts`、`App.tsx` 的修改由實作者修改，**合併前須由 Lead 審查**（§8）。

## 17. 全隊暫停／停止與全隊繼續／啟動（GM 2026-11-09）

- **記錄**：全隊暫停、全隊停止時 hub 記下「這次為了這個團隊關掉的東西」（`TeamHold`）：`mode`（`pause`／`stop`；暫停後再停止算 `stop`）、`since`（第一次按的時間）、`by`／`byName`（最後一次按的人）、`ruleIds`（被關掉的交接規則，原本是開的）、`taskAuto`（任務自動執行原本是開的）、`stoppedSessionIds`（停止時被停掉的成員；排隊中的只是取消、沒有對話可接回，不記）。存在 `settings` 表的 `teamHold:<teamId>` 鍵（和 §12 的 `boardPause` 一樣不是 `Settings` 的欄位，`/api/settings` 讀不到也改不到；不升 schema），hub 重啟後仍在；讀不懂的當沒有。刪除團隊時一起刪。已有記錄時再按＝合併（規則、成員取聯集，任務自動執行只要有一次被關就算，停止優先）。
- **`Team.hold`**：有記錄時 hub 回傳的 `Team`（`GET /api/teams`、`PATCH` 的回應、WS `team.updated`）附上 `hold`，沒有就不帶。建立、修改團隊的 body 不接受 `hold`（被濾掉）。別的裝置靠 `team.updated` 換按鈕。
- **`POST /api/teams/:id/hold { mode }`**（auth **user**）→ `TeamHoldResult { team, rules, taskAuto, interrupted, offline, stopped, failed }`。hub 一次做完（瀏覽器做到一半斷線也不會只關一半）：先關掉啟用中的交接規則（每條一筆 `handoff_rule.update`）與任務自動執行（`team.task_auto`），立刻寫下記錄；`pause` 再對 `endedAt === null` 且 `running`／`stuck` 的成員送 Esc（走使用者按 Esc 的同一條路 `terminal.signal`，等你允許的不送：對權限對話框按 Esc 等於拒絕；機器失聯的列在 `offline`）；`stop` 對活著的成員 `stopSession`（停不了的列在 `failed`，`code` 例如 `machine_offline`，不記進 `stoppedSessionIds`）。`rules`／`taskAuto` 是這次才關掉的。成員不含封存的。
- **`POST /api/teams/:id/resume`**（auth **user**）→ `TeamResumeResult { team, mode, rules: { enabled, alreadyOn, deleted }, taskAuto: enabled|already_on|none, resumed, offline, alreadyRunning, failed, gone, boardPaused }`。**不自動送字**（和 §12「全部繼續」一樣不自動花額度）：
  - `stop` 的記錄：`stoppedSessionIds` 裡仍是團隊成員、`endedAt !== null`、機器在線的，呼叫 `resumeSession`（`--resume` 接回原對話，`firstPrompt` null）；已經在跑的列 `alreadyRunning`、機器失聯的列 `offline`、接不回的列 `failed`（`no_claude_session` 等）、已刪除或離開團隊的算 `gone`。
  - 然後打開 `ruleIds` 裡**現在還關著**的規則（每條一筆 `handoff_rule.update`）；暫停後被刪掉的算 `deleted`、已被手動打開的算 `alreadyOn`，都不動。`taskAuto` 記錄為真時：現在關著就打開（`enabled`），已被手動打開就不動（`already_on`）。
  - 沒有 `offline` 就清掉記錄；有的話記錄只留那些成員（`ruleIds` 清空、`taskAuto` false：已經恢復過，等機器回來再按一次只接回，不再碰規則）。沒有記錄時呼叫回 `mode: null`、什麼都不做（不寫 audit）。
  - `boardPaused`：§12 全部暫停中照做，畫面提示「自動送字仍會被擋」。
- **audit**：`team.hold`（user，detail `{ teamId, mode, rules, taskAuto, interrupted, offline, stopped, failed }`）、`team.resume`（user，detail `{ teamId, mode, rules: { enabled: id[], alreadyOn, deleted }, taskAuto, resumed, offline, alreadyRunning, failed, gone, boardPaused }`），另外照常有 `handoff_rule.update`、`team.task_auto`、`terminal.signal`、`session.stop`、`session.resume`。
- **前端**：`BoardBackend.holdTeam(id, mode)`／`resumeTeam(id)`。團隊面板 `TeamControls`：沒有記錄時「全隊暫停」＋「全隊停止」（按兩次）；`pause` 記錄時「全隊繼續」＋「全隊停止」；`stop` 記錄時「全隊啟動」（按一次，接回本身不送字），還有活著、又不是當初停掉的成員（停不了的、手動接回的）時也顯示「全隊停止」。有記錄時旁邊一行說明繼續／啟動會做什麼。結果訊息寫打開幾條規則、手動打開過幾條、刪掉幾條、接回幾個、幾個失聯（名字）、全部暫停中的提示。fake backend 照同一套規則，另有 `setMachineOnline(id, online)` 給測試。
- **protocol 權限**：本節的 protocol 變更（`TeamHold*`、`TeamSessionRef`、`TeamResumeResult`、`Team.hold`、2 條 REST）與 `shared/backend.ts`、`hubBackend.ts`、`fakeBackend.ts` 的修改由實作者修改，**合併前須由 Lead 審查**（§8）。

## 18. 用量詳情（GM 2026-11-09）

> 「畫面上有一個近 30 天使用的 token 數，我想要延伸內容，讓使用者看到更詳細的使用資料。」數字一律是各台機器讀本機 Claude Code 對話紀錄算出的 token，**不是官方方案額度**，沒有上限可比。

- **daemon**（`daemon/src/usage.ts` 的 `scanUsage`）：每 15 分鐘（`USAGE_INTERVAL_MS`，連上 hub 時先跑一次）掃一次 `<帳號設定目錄>/projects/**/*.jsonl`（預設帳號＋開過 session 的帳號設定目錄），**同一次掃描**算兩份：
  - 總數 `UsageSummary`：和以前一樣是「現在往前 30×24 小時」，同一則回應（`message.id`＋`requestId`）的多行只算一次、各欄取最大；沒有 timestamp 的行照算。
  - 細項 `UsageDetail`（`protocol/src/usage.ts`）：這台機器時區（`Intl` 的系統時區，`timeZone` 欄位）的最近 `USAGE_DETAIL_DAYS`（90）個日曆日，「日期 × 模型（`message.model`，沒寫是空字串）× Claude session id（行的 `sessionId`；沒有就從檔名推：`<id>.jsonl`，或 subagent 的 `<id>/subagents/*.jsonl` 算在叫它的 session 上；推不出來併進「其他」）」的四種 token 數，以及每個 session 第一個看到的 `cwd`。沒有 timestamp 的行排不進哪一天，只進總數。字典編碼：`days`、`models`、`sessions[{ id, cwd }]` 三張表，`rows` 每列 `[日期索引, 模型索引, session 索引, 輸入, 輸出, 快取讀, 快取寫]`，session 索引 -1 是「其他」。另帶 `earliestAt`（掃到的最早一筆時間：Claude Code 預設只留 30 天紀錄，更早的日子是沒資料、不是 0）。
  - **上限**：依四項合計留前 `USAGE_DETAIL_SESSION_LIMIT`（200）個 session，其餘併成「其他」（`otherSessions` 記幾個），總數不變；列數超過 `USAGE_DETAIL_ROW_LIMIT`（20,000）時 session 數減半重來，全部併成「其他」仍放不下才從最舊的日子丟。
  - **量測**（2026-11-09，開發機一台的真實資料，只讀）：260 個 JSONL、682MB，近 30 天內改過的 247 個、約 16 萬行、其中 4.7 萬行有 usage；一次掃描 1.7–2.5 秒、RSS 約 330MB，和只算總數的舊版（1.7–2.5 秒）差不多；細項 102 個 session、5 個模型、157–198 列，整則 `usage` 訊息 18–21KB。細項保留 30／60／90 天要讀的檔幾乎一樣（247／247／252 個），所以取 90 天（「近 30 天」要和前 30 天比至少要 60 天）。
- **WS**：`usage { summary, detail? }`。`detail` 是選用欄位，schema 用 `.catch(undefined)`：細項壞掉或超過上限只丟細項、總數照收。舊 daemon 不送 → hub 當「daemon 版本太舊，沒有細項」；`detail.version` 不是 `USAGE_DETAIL_VERSION`（1）也一樣。
- **hub**：每台最新一筆（總數＋細項）放記憶體，同時存進 settings 表的 `usage:<機器 id>` 鍵（**不升 schema**；`getSettings` 不讀 `usage:` 開頭的鍵，`/api/settings` 看不到），hub 重啟後、下一次掃描前先用上次存的（`restored: true`），`GET /api/machines/:id/usage`（頁首的總數）也一樣。刪機器時一起刪。存檔失敗只記 log。
- **REST**：`GET /api/usage`（auth **user**）→ `UsageReport { generatedAt, days, models, machines, sessions, rows }`。`machines[]` 依機器列表順序，`state`：`detail`｜`old_daemon`｜`not_reported`，另有 `online`、`summary`（同頁首）、`countedAt`（細項的統計時間）、`restored`、`timeZone`、`earliestAt`、`otherSessions`。`days` 是各台日期的聯集；`rows` 每列 `[機器索引, 日期索引, 模型索引, session 索引, 輸入, 輸出, 快取讀, 快取寫]`；`sessions[]` 是對應過的 Claude session：`{ machineId, claudeSessionId（null＝這台的「其他」）, cwd, boardSessionId, name, archived, teamId, teamName, zoneId, zoneName, projectId, projectName }`。
- **對應規則**（`protocol/src/usageReport.ts` 的 `buildUsageReport`，hub 與網頁的假後端共用）：同一台機器、`Session.claudeSessionId` 相同（不分大小寫）的 Agent Board session；好幾個（resume 開的新卡）時取沒封存、較新的。團隊取 `team_members` 裡名稱排序第一個團隊，工作區跟著團隊（沒團隊用 `Session.zoneId`），專案是 `Session.projectId`。對不到的 `boardSessionId: null`，畫面歸「中控台外的 session」並依 cwd 顯示。**已知限制**：Agent Board 只記每個 session 目前的 Claude id，`/clear` 或換過對話之前的用量也算「中控台外」（專案分頁照資料夾合在一起）；各台用自己的時區算日期，網頁的「今天」用瀏覽器時區。
- **前端**（`web/src/usage/`）：頁首的「近 30 天 N token」與側欄用量區下方的「看用量詳情 →」打開 `#/usage`（`ModalKind` 加 `usage`，桌面置中次畫面、手機全螢幕頁，可深連結）。開著時每分鐘重讀，重讀中保留上一次畫面（淡化）。由上而下：說明（不是官方額度、日期用各台時區）與每台狀態（最後統計時間、hub 重啟後的舊資料、daemon 太舊沒細項、還沒回報、失聯、幾個 session 併成「其他」）→ 一列篩選（期間 7／30／90 天、計算：輸入＋輸出（同頁首）或四項合計，管下面全部）→ 總覽（今天、近 7 天、近 30 天固定；大數字是輸入＋輸出，下方四項拆開＋四項合計；和前一期比，增減只用 ▲▼ 與文字；前一期早於某台最早紀錄時加 ⚠ 說明不完整）→ 每日趨勢（SVG 自己畫的堆疊長條，依 token 類型或依機器（前 4 台各一層、其餘併成「其他機器」）；滑鼠／鍵盤左右鍵看單日數字、可切表格）→ 排行（團隊／session／專案（資料夾）三個分頁，六個數字欄都可排序；點團隊開 `#/team/<id>`，點 session 在畫布聚焦那張卡（封存的開 `#/archive/<id>`；手機開收件匣、團隊頁或全螢幕終端機），專案列聚焦該資料夾用最多的看板 session）→ 依模型、依機器的分布。手機：表格改成清單（每格自帶欄名）、趨勢圖可橫向捲。遮蔽模式下名稱、資料夾、機器名都過 `useMaskText`。假後端：`shared/fakeUsage.ts`（固定種子，demo-studio、demo-gpu 有細項，demo-laptop 沒回報）。
- **顏色**：STYLE.md 的狀態色只給狀態、綠色只給 DONE 與 diff，所以圖表不用多色相類別色盤，改用 QUOTA 紫 `--quota` 的四階（`usage/usage.css` 有色碼與 `validate_palette.js` 實測數字），一定有圖例、提示框與表格檢視。
- **no-llm**：只讀本機對話紀錄檔（和原本的總數同一支），hub 只讀記憶體與 settings 表。沒有新的連線、行程或送字寫法。
- **protocol 權限**：本節的 protocol 變更（`usage.ts`、`usageReport.ts`、`ws.ts` 的 `usage.detail`、`routes.usageReport`）與 `shared/backend.ts`、`hubBackend.ts`、`fakeBackend.ts`、`App.tsx` 的修改由實作者修改，**合併前須由 Lead 審查**（§8）。
