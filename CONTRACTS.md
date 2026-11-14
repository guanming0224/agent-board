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

Codex session（`SessionSpec.agent: 'codex'`）的指令、hook 帶入與接回見 §19；下面是 Claude Code。

指令：`claude [--session-id <uuid>|--resume <id>] [--permission-mode <mode>] [--disallowedTools Edit Write NotebookEdit] [--model <m>] [--mcp-config <file> --allowedTools <4 個派工工具>] [--name <n>]`（`--disallowedTools` 只有唯讀 session 帶，見「團隊事件」；`--mcp-config`／`--allowedTools` 只有派工設定開著時帶，見 §11），**權限模式一定要明確帶**，`default` 傳 `manual`：不帶的話 claude 會用使用者設定裡的預設模式（可能是 auto），畫面的放手線就會說謊。
env 加入 `AGENT_BOARD_SESSION_ID`、`AGENT_BOARD_SOCKET`，有 `accountProfile` 時加 `CLAUDE_CONFIG_DIR`，`TERM=xterm-256color`。

worktree：`git worktree add <repo>/../.agent-board-wt/<slug> -b ab/<slug>`。

`firstPrompt`：PTY 就緒後寫入一次（第一個 `SessionStart` hook 之後）。

### 3.2 daemon 重啟

把 session 清單存在本機（資料夾由 `AGENT_BOARD_DATA_DIR` 決定，預設 `~/.agent-board/`）。重啟後逐一 `claude --resume <claudeSessionId>`，狀態先標 `starting`，再送 `daemon.hello` 對帳。

session host 模式（§20）：agent 不隨 daemon 結束，還活著的 session 重播輸出、載入狀態快照接回，不 `--resume`；上面的規則只用在 host 裡已經沒有的 session（整台重開機、host 換版）與連不上 host 時的舊模式。

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
- 連不上 socket：exit 0 不輸出。唯一例外見 4.3。連不上時先重試（daemon 重啟中，非阻擋最多 10 秒），見 §20.4。
- 只有 `BLOCKING_HOOK_EVENTS` 會等回答，上限 `HOOK_WAIT_MS`；超時 exit 0 不輸出，交回原生流程。其他事件送出就走，總耗時目標 < 100ms。

傳輸：NDJSON（`HookRequest` → `HookReply`），`AGENT_BOARD_SOCKET` 是 unix socket 或 Windows named pipe（`\\.\pipe\agent-board-hook-<installId>`，§20.3）。

**先確認對方是 daemon（W5，2026-11-12，§20.7）**：daemon 啟動時建 `<dataDir>/hook.key`（600，有就沿用：活過 daemon 重啟的 agent 還拿著同一個路徑），路徑經 agent 的環境變數 `AGENT_BOARD_HOOK_KEY_FILE`、Codex hook 指令的 `--key-file`、派工 MCP 設定檔的 env 傳下（接回 host 裡的 session 時，舊設定檔缺這個 env 就補上，同 §21.10 的 `repointMcpConfig`）。hook CLI 與 MCP server 連上後先送 `auth.challenge{nonce}`，daemon 回 `auth.proof{proof}`（HMAC-SHA256(密鑰, hook 角色前綴＋nonce)，`@agent-board/protocol/local-auth`），驗過才送請求；密鑰本身不經過 socket、不在環境變數裡。

- 給了密鑰檔卻讀不到、證明不對、或 2 秒內沒回（0.1.6 以前的舊 daemon 不認得 `auth.challenge`）：hook 當成**連不上、不重試**（Bash 的 PreToolUse 照 §4.3 回 ask，Codex 回 deny）；MCP 讀不到密鑰回 `not_configured`、驗不過回 `daemon_unreachable`。
- 沒給密鑰檔：Unix socket 照舊不驗證（0.1.6 以前的 daemon 開的 agent 升級後還活著；socket 在 700 的資料夾裡，別的使用者進不去）；Windows named pipe 一律當成連不上（pipe 沒有資料夾權限保護）。
- daemon 照樣接受不先驗證的舊客戶端（舊版 hook、已經在跑的舊 MCP server）。nonce 格式不對或最近 4096 個裡用過：直接斷線。

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
- **等隊長／等成員結果**（GM 2026-11-11，§11.4）：`waiting_input` 且 hub 算出的 `Session.awaiting` 有值（`isAwaitingTeam`）也不算，畫面是 NEW。只管 `waiting_input`：PERM、PLAN、ERR、QUOTA 不受影響。
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

| 工具             | 參數                                                                                                                                                                | 行為                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_members`   | —                                                                                                                                                                   | 呼叫者所在的每個團隊：成員 `name`、`role`、`kind`、`status`（結束的寫 `ended`）、`task`（進行中的任務 `#n 標題`）、`lastLine`、`readOnly`（`isReadOnlyMember`）、`branch`、`dispatchedBy`（名稱）、`working`（還欠呼叫者結果）、`addedReason`（隊長新增時的理由）、自己標 `you`；每個團隊另有 `staffing`（§11.7）。沒有團隊就 `teams: []` 加一句 `guide`。 |
| `spawn_member`   | `role`（worker／researcher／reviewer／tester）、`prompt`、**`reason`（必填，2026-11-10）**、選填 `name`、`permissionMode`、`useWorktree`、`model`、`agent`（§22.2） | 見 11.3、11.7。成功回 `name`、`status`（可能是 `queued`）、`team`、`teamCreated`、`permissionMode`、`reason`、`teamSize`（`人數/上限`）、被降級時 `note`。                                                                                                                                                                                                 |
| `send_task`      | `member`（名稱不分大小寫，或 session id）、`text`                                                                                                                   | 對象只能是**呼叫者當隊長的團隊的成員**或**它開的成員**（不含自己）。送 `[From <呼叫者>] <text>`（一行、清控制字元、4000 字截斷）進 `SafeDelivery`，key `dispatch:<呼叫者>:<成員>`（還沒送出又送，新的蓋舊的，回覆 `note`）。回 `state: sent／queued`。                                                                                                     |
| `get_result`     | `member`                                                                                                                                                            | 同上的範圍。最後一則回覆的一句摘要、上次派工之後偵測到的改檔（最多 20）、分支、`working`、狀態。                                                                                                                                                                                                                                                           |
| `request_review` | `member` 或 `branch`（`base`、`repoPath` 選填）、`reason`（必填）                                                                                                   | Codex 第二輪（§22.3.6）。隊長要求 Claude 與 Codex 唯讀交叉審查；馬上回 `reviewId`，兩邊做完摘要送回隊長。                                                                                                                                                                                                                                                  |
| `release_member` | `member`、`reason`（必填）                                                                                                                                          | 2026-11-10。見 11.7。成功回 `released`、`team`、`teamSize`、`note`（可以在設定→已封存還原）。                                                                                                                                                                                                                                                              |

錯誤代碼：`dispatch_disabled`、`caller_inactive`（封存、結束、不認得、不是這台機器）、`invalid_arguments`、`permission_not_allowed`、`nested_spawn`、`read_only_caller`、`machine_offline`、（§11.7）`reason_required`、`autostaff_disabled`、`not_lead`、`team_full`、`spawn_rate_limit`、`account_rate_limited`、`member_busy`、`team_held`、`board_paused`（只有 spawn）、`cannot_release_self`、`worktree_unavailable`、`worktree_required`、`not_your_member`、`member_ended`、`rate_limit`、（§23）`request_pending`，以及 `hub.createSession` 的 409 代碼（例如 `session_deleting`）。daemon 端另有 `unauthorized`、`hub_unreachable`、`timeout`（等 hub 30 秒）、`invalid_request`；MCP server 端 `not_configured`、`daemon_unreachable`、`timeout`（45 秒）。

### 11.3 開成員的規則（`spawn_member`）

- 位置：呼叫者的機器、`cwd`、專案、帳號（`accountProfile`）；`model` 沒給用呼叫者的。走 `hub.createSession` 同一條路（併發與限流排隊、worktree、hooks、第一個指令照常），audit 的 user 是 null、detail 多 `dispatchedBy`。`Session.dispatchedBy`（schema v8 `sessions.dispatched_by`）記是誰開的。
- **角色**：不能開 `lead`。worker 會改檔案：`readOnly: false`、預設開 worktree（`useWorktree` 沒給就是 true；呼叫者的 `repoRoot` 是 null（不是 git 或還沒回報）→ `worktree_unavailable`，除非明確 `useWorktree: false`）。researcher／reviewer 一律唯讀（`readOnly: true`，`--disallowedTools`），預設不開 worktree、共用資料夾。
- **同資料夾寫入者規則**：worker 又 `useWorktree: false` 時，和團隊裡同一個 working tree 的寫入者（`sameWorkingTree`、`isReadOnlyMember`，同 `hub/src/worktree.ts`）衝突 → `worktree_required`，不開。
- **權限上限**：寬鬆順序 `plan < default < acceptEdits < auto = dontAsk < bypassPermissions`（`clampPermissionMode`）。沒給用角色預設（worker `acceptEdits`、研究與審查 `plan`，同建立團隊表單）。上限是 min(呼叫者, auto／dontAsk)：超過就降成呼叫者的模式（呼叫者是 bypassPermissions 時降成 acceptEdits），回 `note`。明確要 `bypassPermissions` → `permission_not_allowed`。hub 只知道呼叫者**建立時**的模式（Shift+Tab 切換看不到）。
- **唯讀呼叫者**（`Session.readOnly`）只能開 researcher／reviewer → 否則 `read_only_caller`。
- **測試（tester，P2 Q5）**：和 worker 一樣會改檔案（`readOnly: false`、預設開 worktree），預設權限模式 `default`（每步問，名稱縮寫 `QA`）；可被派任務（任務負責人不限角色），**不當審查**（送審只找 `reviewer`）。新團隊放在呼叫者所在的工作區（§13）。
- **不能巢狀**：派工開的成員（`dispatchedBy` 不是 null）不能再開 → `nested_spawn`（防止一層層開下去）。它還是可以用 `list_members`、`get_result`。
- **上限**（2026-11-10 改，§11.7）：團隊總人數（含隊長、GM 配的，不含已封存）到 `autoStaff.teamLimit` → `team_full`（列出現有成員，建議 `release_member` 或 `send_task` 重用）；同一團隊 10 分鐘最多新增 `DISPATCH_SPAWN_RATE_MAX` = 4 位 → `spawn_rate_limit`。**2026-11-13 起（§23）**：隊長已有團隊時，碰到這兩道上限不再回錯誤，改成向 GM 提出加開申請（回 `status: "pending_approval"`）；`team_full`／`spawn_rate_limit` 只剩「還沒有團隊」與「GM 同意後開的時候又碰到另一道上限」兩種情況會回。舊的「每個呼叫者同時 4 個」（`DISPATCH_SPAWN_LIMIT`、`limit_reached`）拿掉。
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
- **等隊長／等成員結果**（GM 2026-11-11）：hub 在送給網頁的 `Session` 上算 `awaiting?: 'lead' | 'members'`（protocol optional，只有 `waiting_input` 才帶；舊網頁忽略、舊 hub 不送＝照舊 ASK）。不存資料庫欄位，由 `store.withAwaiting` 每次讀的時候算（廣播、快照、REST、推播與「等你」計數都用同一份）。畫面是 **NEW**（灰），說明文字「等隊長」（Awaiting lead）／「等成員結果」（Awaiting members）；狀態代碼仍是 10 種。**不算等你**：不進頁首「等你 N」、收件匣與待處理（`triageItems` 不列，除非同時有 approval）、「下一個等我的」、合併通知總表，hub 不推播（`afterChange` 擋 `isAwaitingTeam`）。
  - `lead`（成員）：結果在送字佇列裡時只記在記憶體（佇列本身也只在記憶體，hub 重啟兩邊一起沒了）；**送到隊長時**才寫 settings 表 `awaitingLead:<成員 id>`＝隊長 id（不升 schema，hub 重啟照樣在；hub 啟動時清掉指向已不存在、結束、封存或 done 的隊長的記錄）。成員開始下一個回合（狀態變成 `running`、`starting`、`waiting_permission`、`plan_review`）、結束、封存，或收到沒有派工的 `UserPromptSubmit`／`Stop`（GM 直接下指令；`Stop` 照常推播），或收到新的工作時清掉。結果被擋下或在佇列裡沒送成（`dropped`／`aborted`）不標，照常 ASK 並推播。隊長結束、封存或 done 後不再算，在等它的成員清掉記錄並**推播**（GM 2026-11-11）；隊長離線時不算（記錄留著，連回來恢復，進出離線不推播）。
  - **寬限期**（`Timing.awaitingGraceMs`，預設 30 秒，審查後補）：成員手上還有 `dispatch_work`、已經 `waiting_input`（daemon 的狀態常比 `Stop` 早到），從「進入 waiting_input」與「工作送達」較晚的那個時間起 30 秒內也算 `lead`，不先推一則 ASK。Stop 掉了、送字被吃掉、開成員的第一個指令沒送進去時，寬限期一到 hub 重算並照常推播（成員變 ASK；隊長不再是等成員結果）。
  - `members`（隊長）：沒有全部暫停，而且有成員的結果正在送進它（記憶體），或有成員的 `dispatch_work.from` 是它且那位成員還在做事：狀態 `running`、`starting`、`waiting_permission`、`plan_review`、`stuck`、`error`，或寬限期內的 `waiting_input`（`offline`、`rate_limited`、`queued` 不算）。最後一則結果打進去後就不算（它接著讀結果，自己做完停下才是 ASK，不推播）；結果沒送成照常推播；成員狀態變化讓它不再算時照常推播（進出離線除外）。全部暫停、繼續時重算（GM 自己按的，不推播）。
  - 派工資料變了（工作送達、Stop、中斷、成員狀態變化、成員結束、結果送達或沒送成、寬限期到、全部暫停／繼續、刪除成員）hub 重新廣播受影響的成員與隊長（`DispatchDeps.awaitingChanged`），和畫面上最後一次送出的值比對；巢狀的變動只在最外層比一次，同一個變化不會推兩次。

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
- **新增（`spawn_member`）多的規則**，依序：全部暫停 → `board_paused`；設定關 → `autostaff_disabled`；沒帶 `reason`（空白也算）→ `reason_required`（舊呼叫會先看到這個，說明要補一句理由）；在團隊裡但不是隊長 → `not_lead`；呼叫者的團隊有全隊暫停／停止記錄（§17 `Team.hold`）→ `team_held`；同機器同帳號（`CLAUDE_CONFIG_DIR`）有還沒到重置時間的 `rate_limited` session（含呼叫者）→ `account_rate_limited`（不看「限流時排隊」設定）；團隊總人數 ≥ 上限 → `team_full`；同團隊 10 分鐘已新增 4 位 → `spawn_rate_limit`（2026-11-13 起這兩道改成加開申請，見 §23；順序也移到機器在線、worktree 檢查之後，那些先擋的不會變成申請）。權限上限、worktree、唯讀、巢狀規則照舊（§11.3）。理由一行、清控制字元、200 字截斷。
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

## 19. Codex 節點（Codex 接口第一版，GM 2026-11-10）

決策與範圍見 `../docs/dispatch/2026-11-10_核對與決策.md`「Codex 接口第一版」。Codex 和 Claude Code 一樣是使用者自己登入的官方互動式 CLI，由 daemon 開在 PTY 裡；PTY、送字佇列、approvals、危險規則、終端機串流全部共用，只有下面幾件事依 agent 分開。**第一版不做**：派工／進度卡 MCP 工具給 Codex、用量統計、交叉審查、Windows（hook 設定預留 `commandWindows`，還沒帶）、帳號資料夾（`CODEX_HOME`）。前三項在 Codex 第二輪（§22，2026-11-12）補上。

### 19.1 資料與協定

- `AgentKind = 'claude' | 'codex'`（`protocol/src/models.ts`）。`SessionSpec.agent`、`Session.agent` 都是選用欄位，**不送＝Claude Code**（舊 hub、舊資料、舊 daemon 全部相容）。
- `MachineCapabilities.codexVersion`（選用）：daemon 開機時跑 `codex --version`（`AGENT_BOARD_CODEX_BIN`，預設 `codex`），找不到就不回報。偵測到才在 hello `features` 宣告 `DAEMON_FEATURES.codex`（`agent.codex`）。
- hub 只把 `agent: 'codex'` 的 spec 送給宣告 `agent.codex` 的 daemon：建立／接續時沒有 → 409 `codex_unavailable`；排隊期間 daemon 換成沒有的版本 → 不送、`failStart('codex_unavailable')`（舊 daemon 不認得 agent 欄位，會照 Claude 開）。Codex 帶 `accountProfile` → 400 `codex_account_profile`。
- **不升 schema**：hub 把 agent 存在 settings 表 `sessionAgent:<sessionId>`（只寫 Codex；`getSettings` 不讀、刪 session 時一起刪），和 `memberAdded:*` 同一種做法。`Store` 讀 session 時補上 `agent`。
- `Session.claudeSessionId` 在 Codex session 裡存 **Codex 的 thread id**（SessionStart 的 `session_id`）：Codex 不能指定新對話的 id，所以新開時是 null，等第一個 hook 回報。daemon 本機清單 `PersistedSession.claudeSessionId` 因此改成可為 null。
- 帳號（§3.4 排隊、自主擴編的限流判斷）多看一個 agent：Claude 限流不擋 Codex，反之亦然（額度是不同方案）。
- `HookEventName` 多了 `Interrupt`、`PostModelRequest`（只有 Codex 送）；`HookRequest.agent`（hook CLI 帶 `--agent codex` 時是 `codex`）；`HookPayload.transcript_path` 可為 null。

### 19.2 開 Codex（`daemon/src/codex.ts`）

```
codex [resume <thread id>] <權限參數> [-m <model>] --dangerously-bypass-hook-trust \
      -c 'hooks.<Event>=[{hooks=[{type="command",command="agent-board-hook --agent codex --session <id> --socket <path> <Event>",timeout=N}]}]' …（每個事件一個 -c） \
      [-- <第一句>]
```

- **hook 設定只在這次啟動有效**（`-c` 覆寫，`protocol/src/codex.ts` 的 `codexHookOverrides`）：不寫 `~/.codex`、不建專案 `.codex`、不讀 `~/.codex/auth.json`（GM 決策 1、§13.3）。事件：SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、Stop、SessionEnd、Interrupt、PostModelRequest；timeout：PreToolUse 600 秒（同 Claude）、PermissionRequest 100 秒（見 §19.4）、SessionEnd／Interrupt 3 秒（文件上限）、其他 30 秒。不寫 matcher（全部工具都送，daemon 只對 Bash 比對危險指令）。
- **hook 指令直接帶 `--session <AB session id> --socket <hook socket 路徑>`**（`codexHookOverrides(target)`），不依賴 Codex 有沒有把 `AGENT_BOARD_SESSION_ID`／`AGENT_BOARD_SOCKET` 傳給 hook 子程序。值先做 POSIX shell 單引號跳脫，再做 TOML basic string 跳脫（`\`、`"`）。hook CLI 參數優先於環境變數；`--agent codex` 的 PreToolUse 拿不到 session、stdin 壞掉、未捕捉的例外 → 回 deny（不安靜放行）。
- `--dangerously-bypass-hook-trust` 只有中控台開的 Codex 帶，只對這次啟動有效，但作用範圍是**整次啟動的所有 hook**（使用者自己的、外掛的、專案 `.codex` 的都不必再確認信任）。所以 **cwd 到 repo 根目錄（有 `.git` 的那層；不在 repo 裡只看 cwd；不含家目錄）任何一層有 `.codex/hooks.json` 或 `.codex/config.toml` 就不開**：建立 → `session.createFailed`（訊息說明要先在終端機手動信任或移除）；重啟接回 → 這次不接回、清單留著。只看檔案在不在，不讀內容、不寫入（`codexProjectHookFiles`）。未驗證：Codex 對未信任專案的 `.codex` 本來會不會載入；確認不會之後可放寬。
- `-c hooks.<Event>` 會蓋掉使用者 `~/.codex/config.toml` 裡同一個事件的 `[hooks]`（只在這次啟動）；`hooks.json` 裡的照樣合併執行。
- 第一句（`firstPrompt`）用官方的 `codex [PROMPT]` 帶入，放在 `--` 之後，不再用送字佇列打一次。本機清單的 `pendingFirstPrompt` 等 Codex 回報 `UserPromptSubmit` 才清：開起來就崩潰（例如卡在資料夾信任畫面被關掉）時，daemon 重啟重新開始會再帶一次。接續（`resume`）不帶。已知：argv 裡的提示同一台機器的其他使用者用 `ps` 看得到。
- 環境變數同 Claude（`AGENT_BOARD_SESSION_ID`、`AGENT_BOARD_SOCKET`、PATH 前面加 hook 的資料夾），但不設 `CLAUDE_CONFIG_DIR`。
- 不寫任何 hook 設定檔，所以 §4.1 的 `settings.local.json` 安裝不適用；hook 執行檔一樣要找得到才開（§4.3）。找不到 codex → `session.createFailed`。
- **daemon 重啟接回**：知道 thread id、而且 `CODEX_HOME`（沒設就是 `$HOME/.codex`）的 `sessions/**/rollout-*-<id>.jsonl` 存在 → `codex resume <id>`；否則重新開始（沒送出的第一句照常帶）。daemon 重啟時只列出 `~/.codex/sessions` 的檔名一次（深度 4，`codexThreadIds`），所有 Codex session 共用；不讀檔案內容。
- **thread id 格式**：`Session.claudeSessionId` 是 `ClaudeSessionId`（UUID）。hook 回報的 id 不是 UUID 就忽略並記 warn（`ManagedSession.syncClaudeSessionId`），不寫進本機清單、不送 hub，否則整則 hello／runtime 驗證失敗、同一台的 Claude session 也會同步不了。這種 session 重啟時不能 resume，只能重新開始。

**權限換算**（`codexPermission`／`codexPermissionArgs`，新增頁的預覽與說明用同一份）。codex-cli 0.167.0 的 `-a` 只收 `on-request`、`never`（設定檔寫 `approval_policy="untrusted"` 會被拒絕：「is no longer supported」），沒有「改檔自動、指令要問」的選項。原則是寬鬆程度相當；acceptEdits、auto 的取捨由 GM 2026-11-10 決定：用可寫工作區（比 Claude 寬，知情接受）：

| Claude 模式                | Codex 參數                                                | 說明                                                                                                                   |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| plan                       | `-s read-only -a on-request`                              | 唯讀沙盒；要寫檔、連網、跑沙盒外的指令都要你允許。Codex 沒有「先交計畫」的審核，PLAN 狀態不會出現                      |
| default                    | `-s read-only -a on-request`                              | 同上。**已知差距**：唯讀的指令不問就跑、讀得到工作區外的檔案（例如 `~/.ssh`）；Claude default 每個 Bash 都會問，見待決 |
| acceptEdits                | `-s workspace-write -a on-request`                        | 工作區內改檔、跑指令都不問；連網、寫工作區外要問。**比 Claude 寬**（Claude 的 Bash 仍會問），GM 2026-11-10 決定        |
| auto                       | `-s workspace-write -a on-request`                        | 同 acceptEdits。沒有用 `--approve-for-me`（由 Codex 的自動審查模型決定核准，可能核准沙盒外的動作）                     |
| dontAsk                    | `-s read-only -a never`                                   | 唯讀、從不問，做不到的直接失敗回給模型（唯讀指令一樣讀得到工作區外）                                                   |
| bypassPermissions          | `--dangerously-bypass-approvals-and-sandbox`              | 沿用 bypass 的警示（新增頁紅框、卡片紅粗線）                                                                           |
| 唯讀 session（`readOnly`） | 沙盒一律 `read-only`；bypass 改成 `-s read-only -a never` |                                                                                                                        |

危險指令清單在所有模式（含 bypass）照樣經 PreToolUse 攔。

### 19.3 狀態

| Codex 事件                                                                                            | 狀態                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`（source startup）且目前 starting                                                       | `waiting_input`，detail `idle:start`（NEW）                                                                                                                                  |
| `SessionStart`（source resume）且目前 starting                                                        | `waiting_input`（ASK）                                                                                                                                                       |
| 畫面出現 `OpenAI Codex` 標題 3 秒後還是 starting（SessionStart 若要等第一句才送，未驗證）             | `waiting_input`，detail `idle:start`                                                                                                                                         |
| 畫面出現 Codex 的資料夾信任畫面（未驗證字串）                                                         | `waiting_input`，detail `trust`；要使用者自己在終端機回答，daemon 不替他選                                                                                                   |
| `UserPromptSubmit`、主線 `PreToolUse`                                                                 | `running`（RUN）                                                                                                                                                             |
| `PermissionRequest`                                                                                   | `waiting_permission`（PERM）                                                                                                                                                 |
| `Stop`                                                                                                | `waiting_input`（ASK）；這一輪最後一次 `PostModelRequest` 帶 error → `error`（ERR，detail 是錯誤）；這一輪已判定額度用完 → **維持 `rate_limited`**（不蓋掉，hub 才排得到隊） |
| `Interrupt`（使用者按 Esc）                                                                           | `waiting_input`                                                                                                                                                              |
| `PostModelRequest` 的 error 符合額度字樣（usage limit、quota、insufficient credits、rate limit、429） | `rate_limited`（QUOTA）；之後成功的 PostModelRequest 或下一句 `UserPromptSubmit` 回 `running`                                                                                |
| 畫面出現 `■ You've hit your usage limit…`（未驗證）                                                   | `rate_limited`                                                                                                                                                               |
| `SessionEnd`                                                                                          | 不改（PTY 結束時才判斷：Codex 的 `/new` 之類也可能送 SessionEnd）                                                                                                            |
| PTY exit 0 ／≠ 0                                                                                      | `done`（DONE）／`error`（ERR）                                                                                                                                               |
| daemon 失聯                                                                                           | `offline`（OFF，hub）                                                                                                                                                        |

其他照 §5（stuck、PostToolUse 只結算等待中的請求）。

### 19.4 核准與危險指令

- `PermissionRequest` 走同一套 approvals（網頁、手機可核准）。daemon 把回答換成 Codex 的格式（`codexHookOutput`）：`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`，或 `behavior: "deny"` 加 `message`。**不帶** `updatedPermissions`／`updatedInput`（Codex 不收）：「記住」對 Codex 沒有作用；提問的回答改成 deny 帶說明（Codex 沒有提問工具）。逾時、沒決定、連不上 → 不輸出，照常跳 Codex 原生確認。
- **Codex 的 PermissionRequest 是先等 hook、沒決定才顯示原生確認**（Claude 是原生對話框與 hook 並行）。所以 Codex 終端機要等網頁逾時才出現原生確認，等的時候終端機是卡住的。等待時間因此和 Claude 分開：daemon 90 秒（`CODEX_PERMISSION_WAIT_MS`）→ hook CLI 95 秒（`CODEX_PERMISSION_HOOK_WAIT_MS`）→ Codex 的 hook timeout 100 秒，各差 5 秒。網頁審核卡在 Codex session 上顯示倒數、不顯示「記住」。危險指令（PreToolUse）維持 565／570／600 秒（同 Claude，終端機本來就答不了）。
- 危險指令：`PreToolUse` 且工具是 shell（hook CLI 把 `Bash`、`shell`、`local_shell`、`exec_command`、`unified_exec`、`container.exec`，以及任何 `tool_input` 有 `command`／`cmd` 的工具，統一成 `Bash`、陣列指令接成字串）→ 同 §4.3 等網頁決定。Codex **不支援 ask**：允許 → 不輸出（照常執行）；拒絕、逾時 → `permissionDecision: "deny"`；**連不上 daemon 也回 deny**（Claude 是 ask），往安全的方向。

### 19.5 前端

- 新增 session 頁：「Agent」分段選 Claude Code／Codex；那台的 `capabilities.codexVersion` 沒有就停用並說明。選 Codex 時：每個權限模式下面列換算後的 Codex 參數、整段換算說明；模型不給 Claude 別名；帳號欄停用；接續清單只列 Codex 的對話；預覽是 codex 指令（hook 設定以 `-c <hooks>` 表示）。
- 卡片（畫布、團隊頁）：`AgentChip` 中性色「Codex」晶片（Claude Code 是預設，不標）。狀態、收件匣、核准沿用。

### 19.6 實測結果（2026-11-10，Lead 在 Mac mini 用真的 codex-cli 0.167.0，gpt-6-luna／low，送指令 5 次，每次約 6 千至 1.3 萬 token）

已驗證：

1. `-c hooks.<Event>=[{hooks=[{type="command",command="…",timeout=N}]}]` ＋ `--dangerously-bypass-hook-trust`：Codex 會載入並觸發 hook，沒有改 `~/.codex`。啟動畫面會有一則警告「Running without the shared background server: command-line configuration overrides (-c …) requires embedded mode」，不影響功能。
2. **SessionStart 不是開好就送，是送出第一句時才送**（`source: "startup"`），所以 NEW 要靠畫面後備規則；`codex resume <id>` 時送 `source: "resume"`。
3. `session_id` 就是 `codex resume` 用的 id（UUID 格式），各事件都一樣；`transcript_path` 有值，檔名含這個 id。
4. shell 工具：`tool_name` 是 `Bash`，`tool_input.command` 是整段字串（例如 `python3 -c "…"`）；PermissionRequest 的 `tool_input` 另有 `description`（模型寫的說明）。
5. 唯讀沙盒（`-s read-only -a on-request`）：唯讀指令（`pwd && ls -la`）不問；要寫檔時先送 PreToolUse 再送 PermissionRequest。PermissionRequest 回 `hookSpecificOutput.decision.behavior = "allow"` → 指令執行、檔案寫入；PreToolUse 回 `permissionDecision: "deny"`＋理由 → 指令沒執行，模型收到理由並停下說明。
6. resume：hook 照常觸發，模型記得前文。
7. 沒有接回終端機查詢回應時，Codex 仍會畫出輸入提示（daemon 不必轉送 headless xterm 的回應）。
8. hook 子程序繼承 Codex 的 PATH：hook 指令只寫程式名稱也找得到（daemon 把 hook 資料夾放在 PATH 最前面，和 Claude 相同）。

仍未驗證：

- `PostModelRequest` 的 `status`／`error` 格式、額度用完的實際訊息（沒有故意耗盡額度）。
- Codex 對未信任專案的 `.codex` 會不會載入（§19.2 的專案 hook 檢查維持保守）。
- PreToolUse 回 allow（不帶 updatedInput）的行為——daemon 維持不輸出。

## 20. session host（daemon 重啟時 agent 不中斷，GM 2026-11-10）

規格與 GM 決定見 `docs/session-host-spec.md`。agent（claude／codex）改由另一個常駐程式 **session host**（`packages/session-host`，`agent-board-session-host`）用 node-pty 開、養著；daemon 只透過本機協定讀寫它。daemon 重啟或更新時 agent 不結束，daemon 回來後重播輸出重新接上。**session host 不懂 claude／codex、不解析畫面、不連網路、不呼叫 LLM**；執行紀錄不寫終端機內容、env、token。

### 20.1 程式、位置與驗證

| 程式         | 職責                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session host | 開 agent、轉送輸入與 resize、送訊號、回報結束碼；每個 session 保留最近 **2 MB** 原始輸出（環狀緩衝、位元組序號，`SESSION_HOST_BUFFER_BYTES`），**只在記憶體**、不落地                                                |
| daemon       | 同以前（hub 連線、headless xterm 與狀態機、hook／MCP socket、審批、派工、搜尋、用量）；開 agent 改走 `PtyBackend`（`daemon/src/pty.ts`）：`HostPtyBackend`（host 模式）或 `LocalPtyBackend`（舊模式，daemon 自己開） |

- 傳輸（`session-host/src/endpoint.ts`）：Mac／Linux 是 Unix socket `<dataDir>/session-host.sock`（檔案 600、資料夾 700；路徑超過 100 bytes 時改放 `tmpdir()/ab-host-<資料夾雜湊>/`，固定名稱、只有自己能進）；Windows 是 named pipe `\\.\pipe\agent-board-session-host-<使用者名稱>-<installId>`（`installId`＝每份安裝的隨機亂數，存在 `<dataDir>/install-id`，600；別的使用者猜不到名稱、搶不了先開同名 pipe。**未在 Windows 實機測過**（Windows CI 跑 session host 的單元測試）；pipe 的存取權限見 §20.7）。
- 驗證（協定 2，W5，2026-11-12）：host 每次啟動產生隨機 token 寫進 `<dataDir>/session-host.token`（600，socket 開好才寫）。**token 不經過 socket**：daemon 讀檔後只送 nonce，**host 先證明自己拿得到 token**，daemon 驗過才回自己的證明（§20.2）。第一則不是 hello、5 秒內沒驗完、證明不對、nonce 重送 → 斷線。
- 同一個資料夾已有 host 在跑（socket 連得上）：第二個正常結束（exit 0，launchd 不會一直重啟）。Windows 同名 pipe 已開（`EADDRINUSE`，審查 W3）：先用這個資料夾的 token 請對方證明（`proveHost`：只送 nonce、驗 `hello.challenge`），證明得了才正常結束；證明不了（別的程式占了名稱）記錯誤、exit 1（工作排程器重試，紀錄看得到）。
- host 收到 SIGTERM／SIGINT（換版、停服務）：先送 `shutdown` 給已連上的 daemon，SIGHUP 所有 agent、2 秒後 SIGKILL 整個程序群組，再結束。SIGHUP 不理（沒有終端機）。

### 20.2 協定（`protocol/src/sessionHost.ts`，子路徑 `@agent-board/protocol/session-host`）

NDJSON，一行一則，上限 16 MB。`SESSION_HOST_PROTOCOL = 2`（2026-11-12 從 1 升：hello 改成挑戰／回應，W5）；不相容的改動才加一。

- 握手（協定 2）：daemon `hello{protocol, nonce}` → host `hello.challenge{protocol, proof, nonce}`（proof＝HMAC-SHA256(token, host 角色前綴＋daemon 的 nonce)，nonce＝host 出的）→ daemon 驗過才送 `hello.auth{proof}`（HMAC(token, daemon 角色前綴＋host 的 nonce)）；驗不過什麼都不送、斷線（`unauthorized`，照 §20.3「host 可能還活著但不能用」處理）→ host 驗過才回 `hello.ok`（含清單），不對回 `hello.error unauthorized` 後斷線。共用 `protocol/src/localAuth.ts`（子路徑 `@agent-board/protocol/local-auth`，只用 `node:crypto`，不從 index 匯出）：三個角色前綴（host、daemon、hook 伺服器）分開、常數時間比對；伺服器記最近 4096 個用過的 nonce，重送拒絕。
- 舊版相容：協定 1 的舊 daemon（`hello{protocol:1, token}`）連新 host → `hello.error protocol_mismatch`（不比對它送來的 token）；新 daemon 連協定 1 的舊 host → 舊 host 看不懂沒有 token 的 hello、回 `error bad_message` → daemon 當 `protocol_mismatch`。兩種都照 §20.3 的「不能用」處理，安裝程式照 §20.5 換 host。
- daemon → host：`hello{protocol, nonce}`、`hello.auth{proof}`、`spawn{reqId, id, bin, args, env, cwd, cols, rows}`、`attach{id, fromSeq}`、`write{id, data}`、`resize{id, cols, rows}`、`kill{id, signal}`（`SIGTERM|SIGHUP|SIGINT|SIGKILL`；SIGKILL＝整個程序群組；Windows 一律直接結束）、`list{reqId}`、`release{id}`（session 結束、daemon 處理完才送；還活著的不理）。
- host → daemon：`hello.challenge{protocol, proof, nonce}`、`hello.ok{protocol, hostVersion, sessions}`／`hello.error{protocol, error: protocol_mismatch|unauthorized}`、`result{reqId, ok, error, pid?, sessions?}`（spawn、list 的回覆）、`attached{session}`、`output{id, seq, data(base64)}`、`replay.gap{id, lostBytes}`、`replay.done{id, seq}`、`exit{id, code, signal}`、`error{id, error}`（`unknown_session` 等）、`shutdown`。
- `HostSessionInfo`：`id, pid, alive, exitCode, signal, seqStart（緩衝最舊的位元組序號）, seqEnd（總位元組數）, cols, rows`。
- 序號以位元組計：`output.seq`＝這塊第一個位元組的序號。緩衝超過上限整塊丟最舊的（單一塊超過上限才切），`seqStart` 往前推。
- `attach`：同一個同步區段依序送 `attached` →（要的位置已丟掉時）`replay.gap` → 緩衝裡 `fromSeq` 之後的 `output` → `replay.done`；已結束的再送 `exit`。之後這個 session 的即時輸出只送給最後 attach（或 spawn）的連線；daemon 斷線時 agent 照跑、輸出只進緩衝。
- 結束了但沒人 release 的 session 最多留 100 個（丟最舊的）。
- 背壓：送給 daemon 的連線積著還沒送出的超過 8 MB（daemon 卡住讀不完）就斷線，輸出照樣進環狀緩衝，daemon 重新 attach 補回。還沒 hello 的連線一行上限 4 KB。
- host 開好之後的未預期例外記錄後繼續跑（host 一掛所有 agent 都會結束）。

### 20.3 daemon 的模式與接回規則

**模式**：`AGENT_BOARD_SESSION_HOST`（預設 `auto`）。啟動時連 host，結果三種（`daemon.ts` 的 `connectSessionHost`）：

- **連上**＝host 模式。
- **確定沒有 host**（socket 不存在或連線被拒；有 `AGENT_BOARD_SESSION_HOST_SERVICE` 時先叫服務管理程式拉起——macOS `launchctl kickstart gui/<uid>/<label>`、Linux `systemctl --user start`、Windows `schtasks /Run`——最多等 5 秒還是沒有）→ **舊模式**（daemon 自己開 PTY，行為同 §3.2），上一輪的 session 照舊 `--resume`。
- **host 可能還活著但不能用**（協定不相容、token 不符或 host 證明不了自己、逾時，或 `off` 但 host 還在跑）→ 新的 session 用舊模式開（**絕不能因此開不了 session**），但**上一輪的 session 不自動重開**（同一個對話不能有兩個 agent）：它們留在本機清單，hello 回報 `status: 'error'`、`endedAt: null`、`statusDetail` 寫原因（例如「舊的 session host 還在跑（協定不相容）…重新安裝並加 --restart-session-host」）。`off` 而且連得上 host 時只擋還在 host 裡的。使用者在網頁上停止它才從清單移除；下次 daemon 啟動會重新判斷。

另外，快照記著 agent 的 pid 與啟動時間：任何模式要 `--resume` 重開前，pid 還在而且啟動時間對得上（誤差 15 秒內；讀不到啟動時間時當成還在）就不重開，同樣標成錯誤（`daemon/src/processCheck.ts`）。啟動時間：Mac／Linux `ps -o pid=,lstart= -p a,b,c`；Windows（N2，2026-11-12）用絕對路徑 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive` 跑 `Get-Process -Id a,b,c` 取 UTC 的 `o` 格式，逾時 10 秒、只認含時區的 ISO 8601，失敗當成還在；讀到的值快取 60 秒。**非同步、一次查完所有 pid**（審查 W1：daemon 重啟時逐一同步開 PowerShell 會卡住 event loop 數十秒，hook 等不到 `auth.proof`、hub 心跳停）：`agentsStillRunning`（`execFile`、`windowsHide`），`resumeEach` 與舊模式清 MCP 檔前各查一次。沒有改成由 host 回報啟動時間：用到這個檢查的情況（確定沒有 host、host 不能用、網頁停止被擋住的 session）都拿不到 host 的清單。安裝程式判斷「session 還在工作」（`busySessions`，§20.5）用同一套規則、同樣一次查完（`scripts/lib/process-start.mjs`，同步）。

**daemon 停止（host 模式）**：

1. 不殺 agent。每個活著的 session 寫狀態快照 `<dataDir>/state/<id>.json`（600、資料夾 700；`daemon/src/sessionState.ts`）：`status, statusDetail, statusSince, claudeSessionId, contextTokens, hookModel, transcriptModel, lastOutputAt, pendingApprovalIds`。不含終端機內容、prompt、工具輸入。**狀態每次變化時也寫**，daemon 被 kill -9 時也有最近的一份。
2. 等待中的審批交回終端機（`ApprovalManager.handOffToTerminal`）：hub 收到 `approval.resolved by: 'terminal'`，hook 拿到放棄的答案（PermissionRequest 不輸出→Claude 原生對話框；危險指令 deny）。畫布上那筆就是現有的「請在終端機回答」退路；session 狀態（等你允許）保留。快照記 `approvalsHandedOff: true`。daemon 崩潰（沒跑到 stop）時快照裡的審批（`pendingApprovals`：id、kind、toolName、matchedRule、createdAt，不含工具輸入）在接回時放進 hello 讓 hub 對上帳，welcome 後送 `by: 'terminal'`。
3. MCP 設定檔與密鑰檔（`<dataDir>/mcp/<id>.json|.key`）**不刪**：MCP server 還拿著它們。
4. hook socket 旁邊寫停止記號 `<hook socket>.down`（600，§20.4 用）。不是 host 開的 session（例如 host 斷線後用舊模式開的）照舊 SIGHUP 結束、下次 `--resume`。

**daemon 啟動**（先開 hook socket：另一個 daemon 在跑時在這裡就失敗，不會去搶 host；接回完成前進來的 hook 與 MCP 請求先等著）：

1. 連 host、取 `hello.ok` 的清單。本機清單上有、host 裡也有的 session：建 headless xterm（尺寸用 host 那邊 PTY 目前的尺寸），`attach{fromSeq: 0}` 從緩衝開頭重播（只餵 headless 與限流偵測、不轉送、不算進度）；有缺口時畫面最上面插一行「[Agent Board] 重新接上前有 N KB 輸出未保留」。重播完載入快照（`StatusTracker.restore`，不觸發狀態事件），再對 agent 的 PTY 做一次尺寸微調（cols-1、等 100ms、改回）觸發 TUI 整個重畫，等畫完（有輸出後安靜 150ms，最多 800ms）才看畫面補正（下面）。**不 `--resume`**。MCP 密鑰從檔案讀回。
2. 停機期間已結束的（`alive: false`）：重播完再照一般的結束處理（exit 0→done、其他→error，結果送 hub、移出本機清單、刪快照與 MCP 檔、`release`）。
3. host 裡有、本機清單沒有的：SIGKILL 並 release（沒人管的 agent 不留；沒收到結束就留著，下次再處理）。**接回失敗**（重播逾時：15 秒＋每 MB 緩衝 10 秒）：重試一次（逾時加倍）；還是不行就**不殺、不重開**，標成錯誤留在清單（同上，hub 看得到原因），下次 daemon 啟動再試。
4. 本機清單上有、host 裡沒有的（整台重開機、host 換版、第一次升級前由舊 daemon 開的）：照 §3.2／§19.2 的規則 `--resume` 或重新開始，新程序交給 host（先做上面的 pid 檢查）。host 回 `session_exists`（同一個 id 還活著）：不從清單刪掉，標成錯誤。host 回覆 spawn 逾時：補送 SIGKILL，不留孤兒 agent。
5. 刪掉不在本機清單上的快照、不是活著的 session 的 MCP 檔、停止記號。

**畫面補正**（停機期間漏掉的 hook；`session.ts` 的 `screenCorrection`，只認 Claude Code 的畫面，Codex 維持快照的狀態）：看畫面最下面 15 行。

| 畫面                                      | 從這些狀態                                                      | 補正成                                  |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| 選單選項 `❯ 1. …`（權限對話框）           | 不是 waiting_permission、plan_review、rate_limited、error       | `waiting_permission`（`screen:dialog`） |
| `esc to interrupt`（工作中提示）          | waiting_input、waiting_permission、plan_review、starting、stuck | `running`（`screen:busy`）              |
| 平常的輸入框（§3.5 的 `inputBoxVisible`） | running、stuck、waiting_permission、plan_review、starting       | `waiting_input`（`screen:input-box`）   |
| 資料夾信任畫面                            | starting                                                        | 同 §5（`trust`）                        |

認不出來就維持快照的狀態（不誤報）。補正和之後重試送到的 hook 照一般規則疊加。`esc to interrupt` 在使用者設了 statusLine 時會被收起（只在 claude 2.1.x 看過，**未驗證**其他版本）。

**host 連線中斷**（host 崩潰、被停掉、背壓斷線；收到 `shutdown` 也走這條）：host 開的 session 不算結束、不回報，留在本機清單；daemon 重新連（拉起）host，接回還活著的，其他的照上面的規則重開（確定沒有 host 才用舊模式）。接回途中又斷一次：這一輪做完再跑一輪。

**hook socket 位置固定**：agent 的環境變數（`AGENT_BOARD_SOCKET`、Codex 的 `--socket`、MCP 設定檔）會活過 daemon 重啟，所以位置由資料夾決定：Mac／Linux `<dataDir>/hook.sock`（太長時 `tmpdir()/ab-hook-<雜湊>/hook.sock`）；Windows `\\.\pipe\agent-board-hook-<installId>`（以前是每次隨機）。hook 密鑰 `<dataDir>/hook.key` 同理固定沿用（§4.2）。hook server 每次啟動都先 `ensurePrivateDir(dataDir)`（審查 W6：Mac／Linux chmod 700，「沒給密鑰檔的舊 agent 照舊不驗證」的前提）。**一份資料夾一個 daemon（複查 R1）**：daemon 啟動先拿 `<dataDir>/daemon.lock`（`daemon/src/daemonLock.ts`；內容 pid、啟動時間；`wx` 建立，已存在時看主人：pid 在而且啟動時間對得上＝另一個活著的 daemon → 拒絕啟動並說明；主人不在了、pid 被重用、或是同一個 pid 上次崩潰留下的 → 先寫暫存檔再改名接手，改完再讀一次確認是自己的；空的或讀不懂而且 10 秒內建立的不搶），stop 時只刪自己的。Mac／Linux 一樣拿這把鎖，hook socket「連得上就是另一個 daemon」的判斷照舊保留（舊版 daemon 不拿鎖）。Windows 同名 pipe 已經有人開著（`EADDRINUSE`，審查 W3）：對方不在了就再 listen；在的話用 hook.key 請對方證明（`proveDaemon`，每次最多等 8 秒、試 2 次，合法 daemon 忙一下不會被誤判）；是 daemon → 不搶、啟動失敗；一直證明不了，而且**已經拿到 daemon.lock**（確定這份資料夾沒有其他活著的 daemon）→ 改用備用名稱 `<原名>-<亂數>` 照常啟動；沒拿到鎖一律啟動失敗（新開的 session 用它；占用期間舊名稱上還活著的 agent 的 hook 當成連不上），並報 `daemon.alert hook_pipe_squatted`。

**機器警示（審查 W3）**：`daemon.alert { code: session_host_unauthorized | hook_pipe_squatted, message }`（daemon → hub，每次連上 hub 都送）。host 證明不了自己（`unauthorized`）或 hook pipe 被占時送；hub 寫 audit `machine.alert`（機器 id、名稱、代碼、說明），同一台同一種一小時一次，面板的操作紀錄看得到。說明不含 token、密鑰。舊 hub 不認得這個訊息類型，回 error 不斷線。

### 20.4 hook CLI 重試（GM 2026-11-10）

連不上 daemon（連線錯誤）時每 200ms 重試：非阻擋事件最多 10 秒（`RETRY_WINDOW_MS`；Codex 的 SessionEnd、Interrupt 只有 3 秒 timeout，最多 2 秒）；阻擋事件也最多 10 秒，而且算在原本的等待上限裡。重試到上限的結果同 §4.2／§4.3（連不上）。agent 在重試期間會等這個 hook。

- 停止記號 `<socket>.down` 超過 60 秒：daemon 是停了不是在重啟，**不重試**（不然每個 hook 都讓 agent 卡 10 秒）。沒有記號（daemon 崩潰、Windows）照樣重試。
- hook CLI 重試到上限還是連不上：自己把記號寫成 `gave-up <時間>`，15 秒內的下一個 hook 不再重試（daemon 崩潰沒留記號時，不會每個 hook 都卡 10 秒）。daemon 啟動成功時清掉記號。
- 已經連上、等待中才斷（daemon 在等審批時重啟）：不重送，照舊交回原生流程（§20.3 停止的第 2 點）。
- `AGENT_BOARD_HOOK_RETRY_MS` 只給測試縮短。

### 20.5 安裝、更新與上架

- `scripts/installer.mjs`：daemon 角色一起裝 session host 服務，順序在 daemon 前面：macOS LaunchAgent `com.agent-board.session-host`（同一份模板：RunAtLoad、失敗才重啟、不需要 `AbandonProcessGroup`）、Linux `agent-board-session-host.service`、Windows 工作排程器「登入時」工作 `AgentBoard-session-host`（未實測）。**host 跑自己資料夾裡那份**：`~/.local/share/agent-board/session-host/`（Windows `%LOCALAPPDATA%\agent-board\session-host\`），內含 `dist/main.mjs`、`dist/meta.json`（協定版本）與複製來的 `node_modules/node-pty`（0.1.1 曾經多一份 `runtime/node`，沒人用時由安裝程式清掉，§21.10）；只在 host 要（重新）啟動時才從 app 複製（確認 node-pty 載得起來才換上），換 app 時完全不動。daemon 服務多帶 `AGENT_BOARD_SESSION_HOST_SERVICE`。解除安裝一起移除。紀錄 `<dataDir>/logs/session-host.log`。
- **只更新 daemon／hub**：不必等 session 停下（agent 不中斷）。安裝程式**不重啟 session host**（會結束所有 agent），除非：(1) **協定版本變了**（`meta.json` 和 `install.json` 的 `sessionHostProtocol` 不同，新 daemon 連不上舊 host）一定要重啟；(2) 加了 `--restart-session-host`。這兩種情況下快照（`<dataDir>/state/*.json`）裡還有 agent 在（pid 在而且啟動時間對得上，§20.3 的同一套規則）、狀態是 RUN／PERM／PLAN／starting 的 session 就**中止安裝、什麼都不改**，說明要等它們停下。其他情況 host 的版本雜湊（程式＋node-pty 版本＋這個平台的 `pty.node`／`spawn-helper`）變了只印提醒。重啟後照 §3.2 `--resume` 接回。Windows 換 app 時只停 hub／daemon（host 的 node-pty 在自己的資料夾，不被鎖）。
- **回滾到沒有 session host 的版本**：先 `launchctl bootout gui/$UID/com.agent-board.session-host`（會結束所有 agent）→ 用舊版發布檔安裝 → 刪 `~/Library/LaunchAgents/com.agent-board.session-host.plist` 與 `~/.local/share/agent-board/session-host/`。不先停 host 的話，舊 daemon 不會去接、host 也不會走，agent 留著沒人管。
- **第一次上架（從沒有 host 的版本升級）**：現有 session 是舊 daemon 直接開的，舊 daemon 停止時照舊 SIGHUP 結束它們；新 daemon 連上剛啟動的 host 後，依 §3.2 用 `--resume` 接回、交給 host。從這次之後的 daemon 重啟才不中斷。
- 整台重開機：host 與 agent 都沒了，行為同 §3.2（`--resume`）。

### 20.6 未驗證／已知限制

- 只在 Mac 用假 claude 驗證（`packages/web/e2e/session-host.spec.ts`、`daemon/src/sessionHost.test.ts`）；真的 claude／codex 的重播畫面、`esc to interrupt` 判斷、Windows named pipe 與工作排程器、Linux systemd 都未實測。
- 重播是從緩衝開頭（最多 2 MB）重畫，TUI 在中間改過尺寸的話，舊段落可能排版錯亂；之後 TUI 自己重畫就會正確。
- 快照與實際狀態可能不一致：狀態在快照寫入後、daemon 停止前改變且 hook 重試也失敗（daemon 停超過 10 秒），只能靠畫面補正；畫面也認不出來（例如 Codex、使用者自訂 statusLine）就停在快照的狀態，直到下一個 hook。
- daemon 停機期間使用者在終端機回答了權限對話框、或 agent 在這段時間結束一輪：hook 重試送得到就正確；送不到時靠畫面補正。
- session host 本身崩潰：agent 收到 SIGHUP 跟著結束（PTY 主端關閉），daemon 收到連線中斷 → `--resume` 重開；崩潰前的緩衝與停機期間的輸出都會遺失。

### 20.7 Windows 上線前必修（2026-11-12）

目標：原生 Windows、PowerShell 7、工作排程器「登入時」啟動（`AgentBoard-session-host`、`AgentBoard-daemon`，優先順序 5＝一般；預設 7 會讓 agent 跟著變慢）。各機用自己的系統 Node（≥22.18），原生模組都是 N-API。

- **W5 伺服器先證明身分**：session host（§20.1、§20.2，協定 2）與 hook／MCP socket（§4.2）都是伺服器先證明自己拿得到密鑰，客戶端驗過才送任何秘密或請求。別的程序搶先開了同名 pipe 也騙不到 token、請求內容，也不能冒充 daemon 回答危險指令檢查。
- **pipe 只允許目前使用者：做不到**。Node 的 `net.Server.listen(pipe)` 沒有設定安全描述元（DACL）的 API；libuv 建 named pipe 用預設的安全描述元，同一台機器的其他帳號（含 Everyone 的唯讀）可能看得到、連得上。目前靠三層擋：名稱含每份安裝的隨機 `installId`（猜不到）、同名 pipe 已開時先請對方證明（host 證明不了就 exit 1；hook pipe 改用備用名稱；兩者都報 `daemon.alert`，§20.3）、連上之後的挑戰／回應（拿不到密鑰什麼都做不了）。之後要更嚴就得用原生模組設 DACL（未做）。
- **資料夾的 ACL（審查 W2；複查 R2、R3、R4）**：設 ACL 前先用 PowerShell `Get-Acl` 讀資料夾擁有者的 SID（路徑經環境變數 `AB_ACL_DIR` 帶入），擁有者必須是自己、Administrators（`S-1-5-32-544`）或 SYSTEM（`S-1-5-18`），否則拒絕啟動並說明（其他使用者的資料夾擁有者隨時能改回權限；Administrators／SYSTEM 本來就比自己權限高，以系統管理員權限跑安裝程式時資料夾擁有者預設是 Administrators）。只對 dataDir 本身設，子資料夾（`state\` 等）用 `ensurePrivateSubdir` 只建資料夾、繼承 dataDir 的 ACL；結果（含失敗）每次啟動只算一次，失敗之後照樣丟同一個錯但不重跑外部指令。Unix 的 600／700 在 Windows 沒有作用。`ensurePrivateDir`（`session-host/src/endpoint.ts`）在 Windows 用 System32 的 `whoami /user` 取自己的 SID，再 `icacls <dir> /inheritance:r /grant:r *<SID>:(OI)(CI)F /grant:r *S-1-5-18:(OI)(CI)F`（拿掉繼承、只給自己與 SYSTEM，子資料夾與檔案跟著繼承；用 SID 不受網域、語系、引號影響；參數不經過 shell）。session host 與 daemon（hook server）啟動時各對 dataDir 做一次；whoami 或 icacls 失敗就丟例外、服務不啟動並說明。**已知限制**：安裝程式配對時寫 `machine.json` 早於第一次啟動，`AGENT_BOARD_DATA_DIR` 指到使用者資料夾外時，這段時間它繼承的是原本的 ACL。
- **N2 程序啟動時間**：見 §20.3（PowerShell `Get-Process`，一次查完、非同步，逾時 10 秒、只認含時區 ISO 8601、失敗當成還在、快取 60 秒）。
- **Codex（審查 W5）**：Codex 的 hook 指令用 POSIX 單引號，cmd 讀不懂（`--socket \\.\pipe\…`、`--key-file` 會壞，危險指令檢查失效）；cmd 的跳脫沒辦法在實機驗證前做穩，所以 **Windows 機器先不開 Codex**：hub 回 409 `codex_windows_unsupported`、daemon 開之前也擋、新增 session 頁說明原因。`commandWindows` 不帶。
- **回滾的最低版本（審查 W4）**：win-x64 不能從面板回滾到 0.1.7 以前（`MIN_ROLLBACK_VERSION`；0.1.6 以前的 hello 帶明文 token），`canRollback: false`、`POST /rollback` 回 409 `previous_unsupported`。
- **安裝路徑**：`current`／`app` 是 junction（不需要系統管理員或開發人員模式），先拿掉再建，拿掉只拿連結本身；清舊版先改名成 `releases\.trash-<名稱>-<亂數>` 再刪（被鎖住改不了名就整份留著，原本名稱的版本要嘛完整、要嘛整個不見），`scripts/lib/release-dirs.mjs`。hook 的 `.cmd` 包裝用 cmd.exe 跑：參數、stdin、結束碼原樣傳；`AGENT_BOARD_NODE` 失效退回 PATH 上的 node；node 或 `.cjs` 都找不到 exit 2（§21.10）。
- **install.ps1**：建議 `pwsh -NoProfile -ExecutionPolicy Bypass -File <解開的資料夾>\agent-board\scripts\install.ps1 daemon --hub … --code … --name …`；找不到 git 只提醒不中止（worktree、repo 狀態、Claude Code 的 Bash 工具要它）。README 有完整步驟（下載、驗 SHA256、tar 解壓、配對、schtasks 確認、實測、最後在面板允許自動更新）。
- **CI**：`ci.yml` 的 `windows` job（push 到 main、PR、手動）與 `release.yml` 的 Windows 建置跑同一組：protocol、web、session-host、hook 全部，daemon 的 processCheck／hookServer／codex，安裝的 `windows-paths`（junction、檔案鎖住時的清理、cmd.exe 跑 hook 包裝，只在 Windows 跑）、`process-start`（真的 PowerShell）、`service-templates`。跑不了的測試 `skipIf(win32)` 並寫原因（daemon 整套的假 claude／hook 是 sh 腳本；Unix 檔案權限；ConPTY 沒有 SIGWINCH）；測試用的假 daemon／假 host 在 Windows 改用 pipe。
- **自動更新**：win-x64 照舊預設不發，owner 對單一機器打開（§21.3）。
- **未驗證**：以上全部沒在 Windows 實機跑過；Windows CI 也還沒實際跑過（只在 Mac 跑過其中不限 Windows 的部分）。

## 21. 發版與自動更新（GM 2026-11-11）

規格與 GM 決定見 `docs/release-update-spec.md`。型別在 `protocol/src/release.ts`。**只從 tag 的 Release 更新正式版**；`install.sh --from` 留給第一次安裝與緊急修復；不從畫布裡的 session 部署自己。

### 21.1 版本與成品

- 版本號＝根目錄 `package.json` 的 `version`（從 0.1.0 起），tag `v<版本>`；`BUILD_ID`（內容雜湊）保留。hub 與 daemon 在執行期讀 `<發布檔>/package.json` 與 `BUILD_ID`（`hub|daemon/src/version.ts`；開發模式是 repo 的版本、buildId `dev`），hello 與 `GET /api/health`（public，`HealthInfo { ok, version, buildId, protocolVersion }`）回報。`agent-board-hub schema-version` 印出這版 hub 的 schema 版本。
- `corepack pnpm build:release` → `release/agent-board-<版本>-<平台>.tar.gz`（Windows `.zip`，`tar -a`）與 `SHA256SUMS`（sha256sum 格式）。平台＝建置那台（`platformKey`：`darwin-arm64`、`win-x64`）。發布檔**附這個平台的 `node_modules`**（`npm ci --omit=dev`，含 node-pty／better-sqlite3／argon2 原生檔，三個都是 N-API，prebuilds 不分 Node 版本），**不自帶 Node**（§21.10）。`.node-modules-platform` 記平台、建置用的 Node 與 ABI（只供參考）、`napi: true` 與 `minNode`（package.json 的 engines，目前 `22.18`）；安裝時平台相同而且原生模組用這台的系統 node 載得起來就直接用；手動安裝（`install.sh --from`）載不起來時退回 `npm ci`，**自動更新中不跑 `npm ci`**（直接失敗）。workflow 建置用的 Node 是 repo 變數 `RELEASE_NODE_VERSION`（預設 24），只要符合 engines。BUILD_ID 在裝依賴前算，兩個平台同一個值。
- `.github/workflows/release.yml`：`push: tags: ['v*']`；`macos-14`、`windows-latest` 各跑 install → typecheck → 單元測試（Windows 跑的那一組見 §20.7，和 `ci.yml` 的 windows job 相同）→ `build:release`，並檢查 tag 和 `package.json` 版本一致；`publish` job 合併兩份 `SHA256SUMS`、`sha256sum -c`，用 `GITHUB_TOKEN` `gh release create/upload`。ubuntu CI 不變。

### 21.2 安裝配置

```
~/.local/share/agent-board/            （Windows %LOCALAPPDATA%\agent-board\）
  releases/<版本>/        每版一個資料夾（.installed＝依賴與原生模組檢查都過了）；同版本不同內容裝到 <版本>+<BUILD_ID 前 8 碼>
  releases/.incoming/     daemon 下載解壓的新版（更新程式結束刪掉）
  current -> releases/<版本>   Mac／Linux 相對 symlink（暫存連結 rename 蓋過，原子）；Windows junction（先刪再建，未實測）
  app -> current          只有從舊配置遷移過來的才有（舊 session 的 PATH、MCP 設定檔寫的是 app/…）
  session-host/           不變（§20.5）
  install.json            多了 currentRelease、currentVersion、previousRelease、previousVersion；通道不放這裡
  update.lock             更新程式執行中（pid）
```

- launchd plist、systemd unit、Windows 工作排程器、`~/.local/bin` 捷徑一律指 `current/…`，換版只換 `current`（服務設定不變）再重啟 hub／daemon。執行檔是安裝時找到的系統 node 路徑（三個服務都一樣，不 realpath，§21.10）。daemon 服務多帶 `AGENT_BOARD_INSTALL_ROOT`（自動更新用）、`AGENT_BOARD_HOOK_BIN`、`AGENT_BOARD_MCP_SERVER`（指 `current/…`：node 會把入口的 symlink 解開，不指定的話 agent 的 PATH 與 MCP 設定檔會寫 `releases/<版本>/…`，舊版清掉後還活著的 agent 就找不到）。
- 保留最近 3 版（依 `.installed` 時間），`current` 與上一版一定留。
- **第一次（從單一 `app/`）**：安裝程式把 `app/` 搬成 `releases/<app 的版本；0.0.0 或沒有記成 0.0.0-legacy>/`、建 `current`、`app` 留成指向 `current` 的連結，再照常裝新版。正在跑的程式不受影響（檔案沒變只是換名字），換 current 後重啟 hub／daemon；session host 照 §20.5 的規則（協定沒變就不重啟），agent 不中斷。
- `installer.mjs switch --to <releases 底下的資料夾> [--restore-db <備份>] [--no-start]`：current 指回已裝好的某一版、重寫服務設定、重啟 hub／daemon；`--restore-db` 先停 hub、用備份蓋回 `hub.db`（刪 -wal／-shm）；目標版的 session host 協定和現在跑的不同時連 host 一起換回（會結束 agent，之後 `--resume`）。

### 21.3 更新流程

**hub**（`hub/src/release.ts` 的 `ReleaseManager`）：

- settings 表鍵（不升 schema，`getSettings` 濾掉）：`release.repo`（`owner/name`，面板設定；沒有時用環境變數 `AGENT_BOARD_RELEASE_REPO`）、`release.canary`、`release.stable`、`release.canaryStats`（`since`、斷線、更新失敗次數；換 canary 時重設）、`release.lastCheck`、`machineChannel:<機器 id>`（`canary`／`stable`，預設 stable）、`machineRelease:<機器 id>`（hello 回報的 platform、version、buildId、protocolVersion、previousVersion、hostsHub、最後的 `UpdateState`、已推播過的失敗時間）。刪機器時一起刪。
- 每 10 分鐘（開機 30 秒後第一次；`AGENT_BOARD_DISABLE_RELEASE_CHECK=1` 關）或面板「檢查新版」：`gh auth status` → `gh release list --repo <repo> --exclude-drafts --json tagName,isDraft,publishedAt` → 最大的 `v<semver>` 比 canary 新，就 `gh release download v<版本> --pattern SHA256SUMS --pattern agent-board-<版本>-<平台>.*` 到 `<dataDir>/release-cache/.download-*`、對 `SHA256SUMS` 驗每個成品，全部對才寫 `verified.json`、改名成 `release-cache/<版本>/`、設為 canary、audit `release.canary`。不符或下載失敗：不改 canary，`lastCheckError` 記原因，audit `release.fetch_failed`。cache 留 5 版（canary、stable 一定留）。
- **gh**：`AGENT_BOARD_GH_BIN` 或 PATH 上的 `gh`；子程序環境拿掉 `GH_TOKEN`、`GITHUB_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`，加 `GH_PROMPT_DISABLED=1`。hub 不讀任何權杖檔。找不到 gh → `gh.state: missing`；沒登入 → `not_logged_in`（帶 gh 的第一行訊息）；沒設 repo → `no_repo`。都只影響這個功能。
- 目標：`channelTarget`（canary 跟 canary 與 stable 較新的那個，stable 只跟 stable），而且這台回報的平台在 cache 裡有成品才有（`ReleaseTarget { version, platform, asset, sha256, size }`），放在 `hub.welcome.release`；canary／stable／通道變了送 `release.target { target, force: false }` 給每台連著的 daemon。
- `GET /api/releases/:version/:platform`：**機器 token**（`Authorization: Bearer`），只回 cache 裡驗過的檔（`x-agent-board-sha256`），audit `release.download`。瀏覽器 cookie 不行。
- REST（`protocol/src/rest.ts`）：`GET /api/releases`（user，`ReleaseOverview`）；以下 owner：`POST /api/releases/check`、`POST /api/releases/promote { version, confirm }`（canary 不到 24 小時 `CANARY_SOAK_MS` 而沒 `confirm` → 409 `canary_too_new`；不在 cache → 409 `not_cached`）、`PATCH /api/releases/config { repo }`、`PUT /api/machines/:id/channel { channel }`、`POST /api/machines/:id/update`（送 `release.target { force: true }`；離線 409 `machine_offline`、沒目標 409 `no_target`）、`POST /api/machines/:id/rollback`（送 `release.rollback`；不知道上一版 409 `no_previous`）、`PUT /api/machines/:id/allow-unverified { allow, confirm }`（2026-11-12，見下）。audit：`release.repo`、`release.channel`、`release.promote`（`early` 標不到 24 小時）、`release.update_now`、`release.rollback`、`release.update_failed`、`release.allow_unverified`。
- **未驗證平台逐台允許（2026-11-12，§20.7）**：settings `machineAllowUnverified:<機器 id>`（`true` 或沒有）。`PUT /api/machines/:id/allow-unverified`：owner 才能改；打開沒帶 `confirm: true` 回 400 `confirm_required`；這台回報的平台不在 `UNVERIFIED_PLATFORMS`（或還沒回報）回 409 `platform_verified`；關掉不用 confirm；audit `release.allow_unverified`（machineId、platform、allow）；改了就重送目標；刪機器一起刪。預設照舊不發 win-x64（`platform_unverified`）。`MachineRelease` 多 `unverifiedPlatform`、`allowUnverified`（舊 hub 不送＝false）。面板對未驗證平台的機器顯示說明與「允許自動更新」（打開要再確認一次）／「停止自動更新」（不用確認），中英文；demo 的 demo-gpu（Windows）是已允許的。
- 「升為 stable」旁的統計（`CanaryStats`）：canary 開始時間、期間 canary 機器 session 進入 error 的狀態事件數、daemon 非預期斷線數（更新中的斷線不算）、更新失敗數。
- 更新失敗（`UPDATE_FAILED`：failed、rolled_back、rollback_failed；同一次只算一次）：audit、canary 統計、推播 `{ kind: 'update_failed', machineId, machine, version, phase, reason, at }`（只有機器名稱、版本、原因代碼，**不帶 `detail`、不帶任何 Claude 寫的內容**；遵守通知開關與勿擾時段）。

**daemon**（`daemon/src/selfUpdate.ts`）：

1. 收到目標（welcome、`release.target`、`daemon.rejected.release`）：平台不同、同版、比目前舊（沒 force）、上次在這版失敗過（沒 force）、更新程式還在跑 → 不動。沒有 `AGENT_BOARD_INSTALL_ROOT`（開發模式、dev 實例）→ 只回報 `phase: idle, reason: not_installed`。
2. 延後（`updateDeferReason`）：有 PERM 就延後；下載解壓後看新版 `session-host/dist/meta.json` 的協定和 `install.json` 的 `sessionHostProtocol` 不同（要換 host）而有 RUN／PERM／PLAN／starting 也延後。`phase: deferred, reason`，每 5 分鐘再看（解好的新版留著不重下載）。
3. 下載：`GET <hub>/api/releases/<版本>/<平台>`（機器 token），邊下載邊算 SHA-256，和目標的 `sha256` 不同 → `failed/checksum_mismatch`；系統 `tar -xf` 解到 `releases/.incoming/<版本>/`，確認 `package.json` 名稱與版本、`BUILD_ID`、`scripts/updater.mjs` 都在。
4. 寫 `phase: installing`，用安裝時記下的系統 node（`AGENT_BOARD_NODE`；沒有才用 daemon 自己的 node，§21.10）以 **detached**（`setsid`，新的 session 與 process group）、stdio 接 `<dataDir>/logs/updater.log`、`unref` 啟動**新版裡的** `scripts/updater.mjs update --source … --to … --from … --data … --root …`。launchd 停 daemon 只對 daemon 的 process group 送訊號，收不到它（`scripts/updater.test.mjs` 用「停服務時殺整個 process group」的假 launchctl 驗證；**未用真的 launchd 驗證**）。
5. 每次連上 hub 寫 `<dataDir>/daemon-status.json`（pid、version、buildId、connectedAt；600）；`update-state.json` 放進 hello 的 `update`，還在進行中時每 2 秒讀一次、變了送 `update.status`（最多 10 分鐘）。

**更新程式**（`scripts/updater.mjs`，只用 node 內建模組；讀 schema、hub 的 `schema-version`、安裝程式都用系統的 node 另開程序跑，§21.10）：

1. `update.lock`（原子取得，見 §21.8 W1；拿不到 → `failed/busy`）。有 hub 的機器用舊版的 better-sqlite3 先讀 schema 版本，並帶 `--backup-db` 給安裝程式：安裝程式在**停 hub 前一刻**線上備份 `hub.db` 到 `hub.db.pre-update-<舊版>-<時間>`（600，只留最近 5 份）；備份失敗 → 中止（hub 沒重啟、資料庫沒變）。
2. 跑新版的 `installer.mjs install <hub 或 daemon> --source …`（`AGENT_BOARD_UPDATER=1`）：裝到 `releases/<版本>`、換 current（隨即寫 install.json）、重啟 hub／daemon；session host 只在協定變了才換（§20.5，有工作中的 session 就中止、什麼都不改）。安裝程式失敗而 current 沒換 → `failed/install_failed`。
3. `checking`：時限（預設 60 秒，`--health-timeout-ms`；daemon 帶的是 `AGENT_BOARD_UPDATE_HEALTH_MS`，只給測試）內每秒看：`daemon-status.json` 的版本是新版、連上時間在更新開始之後、pid 活著；有 hub 的機器另外 `/api/health`（install.json 的 host／port）回 200 而且是新版。過了 → `succeeded`，刪 `.incoming`。
4. 沒過（或安裝程式換了 current 才失敗）→ `rolling_back`：`hub.db` 的 schema 和備份時不同就帶 `--restore-db <備份>`，用新版的 `installer.mjs switch --to <舊版>`（新版的安裝程式壞了就用舊版裡的）；再用同樣的時限檢查舊版 → `rolled_back`（reason `health_timeout` 或 `install_failed`），回不去 → `rollback_failed`。回滾窗口只有健康檢查的時間，還原備份損失極小。
5. `rollback`（面板「回滾到上一版」，從 current 裡的更新程式跑）：current 指回 `previousRelease`；上一版 hub 的 `schema-version` 比現在的資料庫舊 → `failed/schema_changed`（還原備份會丟掉之後的資料，交給人處理）；上一版沒通過健康檢查就切回原本的版本、回 `failed`。成功是 `succeeded`＋`reason: rollback_requested`（不推播）。

hub 自己的更新也走這條（Mac mini 的 daemon 啟動更新程式，roles 有 hub）。hub 重啟期間 daemon 斷線重連，session host 讓 agent 不中斷。

### 21.4 協定版本相容

- `PROTOCOL_VERSION = 1`（hello 與 welcome 都帶 `protocolVersion`）；舊 daemon 不送＝1。`protocolCompat`：daemon 比 hub 舊兩版以上 `needs_update`、新兩版以上 `hub_too_old`，其他接受（**新一版的 daemon 也接受**：canary 比 hub 先升級時，新 daemon 有責任照舊協定和舊 hub 說話）。
- 不接受：hub 記下 hello 的版本資訊（面板顯示「需要更新」／「hub 太舊」），送 `daemon.rejected { reason, hubProtocolVersion, release }`（`needs_update` 時 `release` 是這台可以更新到的目標：下載走 HTTP 不需要 WebSocket，daemon 照常自己更新）後以 4426 斷線；不算上線、不對帳 session。daemon 收到後改成每 5 分鐘重連一次（不轟炸）。既有 `features` 旗標保留；加欄位、加訊息類型不用加協定版本。
- 加協定版本時：hub 要繼續接受前一版（舊 daemon 照常運作直到更新），新 daemon 要能和前一版的 hub 說話。

### 21.5 schema：先加後刪（從 v11 起）

- hub 資料庫的變更分兩版做：**這一版只加**（新表、新欄位、新索引；新欄位要有預設值或可為 null，舊程式不認得也照常讀寫），**下一版才刪或改名**舊的。這樣回滾到上一版時，上一版的 hub 至少讀得懂資料內容。
- 但 hub 開資料庫時 schema 版本比自己新一律拒絕（`db.ts`），所以跨 schema 的回滾仍要還原備份：自動更新的回滾會自動還原（§21.3 更新程式第 4 點）；手動回滾跨過 schema 不做。
- 升級前備份照舊（`hub.db.bak-<時間>-v<舊版>`），更新程式另外有 `hub.db.pre-update-*`。

### 21.6 dev 實例

- `scripts/dev-instance.sh start|pair <配對碼>|stop|status`：從工作目錄用 tsx 跑 hub、session host、daemon，各自 detached、pid 檔在資料夾裡。hub 只綁 `127.0.0.1:8024`（`AGENT_BOARD_DEV_PORT`），資料夾 `~/.agent-board-dev`（`AGENT_BOARD_DEV_DIR`；不能是 `~/.agent-board`、埠不能是 8787），機器名稱 `<hostname>-dev`。不建 launchd、不推播（`AGENT_BOARD_DISABLE_PUSH=1`）、不查新版（`AGENT_BOARD_DISABLE_RELEASE_CHECK=1`）、不自動更新（沒有 `AGENT_BOARD_INSTALL_ROOT`）。正式版服務的 `AGENT_BOARD_*` 環境不繼承。要從別台看就自己 `tailscale serve` 另一個埠（不自動做）。

### 21.7 測試與未驗證

- 單元：`protocol/src/release.test.ts`（版本比較、通道、延後條件、協定相容、SHA256SUMS）、`hub/src/test/release.test.ts`（假 gh：沒 repo、gh 不存在／沒登入、下載驗證、SHA 不符、權杖環境變數不給 gh、通道與目標、下載端點驗證、升 stable 的 24 小時、協定拒絕、失敗推播只推一次、回滾）、`daemon/src/selfUpdate.test.ts`、`scripts/updater.test.mjs`（`test:install`：遷移、保留 3 版、同版不同內容、更新成功、壞版回滾＋schema 還原、安裝程式失敗、鎖、手動回滾與 schema_changed、detached 存活）。
- e2e：`corepack pnpm e2e:update`（先 `build:release`；只在 Apple Silicon Mac）：真的成品改版本號當假 Release、假 gh、假 launchctl（照 plist 真的跑），hub 從原始碼跑。canary 自動更新成功；壞版（新 daemon 起不來）在健康檢查時限後自動回滾、面板標失敗。
- **未驗證**：真的 GitHub Actions（workflow 只做過 YAML 解析）、Windows 成品的建置與安裝（junction、zip、工作排程器停服務時 detached 更新程式會不會被收掉；實機驗證前 hub 不發 win-x64 目標）、真的 gh（只測假的）。
- **已驗證**：macOS 真的 launchd 停服務（`launchctl bootout`）時，detached（setsid）＋stdio 導到檔案的子程序會活下來（2026-11-11，Lead 用拋棄式 label 在真機實測）；`scripts/updater.test.mjs` 另用「停服務時殺整個 process group」的假 launchctl 驗證同一件事。
- **Linux／systemd 的限制**：沒有 Linux 成品（daemon 回報 `linux-x64` 不會有目標，只能 `install.sh --from` 手動更新）。systemd 的 user unit 預設 `KillMode=control-group`：停 daemon 時會殺掉整個 cgroup，**detached（setsid）擋不住**，所以就算之後有 Linux 成品，自動更新程式也要改用 `systemd-run --user --scope` 之類的方式啟動才能活過 daemon 重啟（未實作）。

### 21.8 審查後的修正（2026-11-11）

- **進行中的狀態會過期（S1；判斷規則 §21.9 N2 改過）**：`UpdateState` 多了 `pid`、`startedAt`。`downloading` 只有 daemon 下載時寫，daemon 不在下載（重啟過）就是中斷；其他進行中的階段：開始超過 `UPDATE_STALE_MS`（15 分鐘），或 `update.lock` 的持有者不在（寫完 installing 一分鐘後還沒有）→ 過期。daemon 連上 hub、收到目標、輪詢時都會檢查，過期就寫 `failed/interrupted`（中斷的可以自動重試，「立即更新」也會清掉過期狀態；真的還在進行的 force 也不重複啟動）。輪詢沒有時間上限。hub 只把「最近 15 分鐘內的進行中狀態」期間的斷線當成預期的（canary 統計）。
- **spawn（S2）**：啟動更新程式等 `spawn` 事件，`error` → `failed/spawn_failed`；紀錄檔的 fd 交給子程序後關掉。
- **先升 hub（S3a）**：hub 那台（hello `hostsHub`）的通道目標也是這一版、但它還沒升上去時，其他機器的目標是 null（`targetNote: hub_first`）；hub 那台換了版本（hello 版本變了）再送目標給其他機器。不同版本（例如 canary 比 hub 的 stable 新）不用等。
- **健康檢查分辨「連不上 hub」（S3b）**：daemon 一啟動就寫 `daemon-status.json`（`startedAt`、`connectedAt: null`），連上 hub 再寫一次。新 daemon 程序活著、本機 hub（有的話）也正常、只是還沒連上 hub：等到 `--connect-timeout-ms`（預設 5 分鐘）；daemon 起不來、崩潰（pid 不在）就照健康檢查時限（60 秒）回滾。
- **鎖（W1）**：先寫 `update.lock.<pid>`，再 `link` 成 `update.lock`（已存在就失敗，原子）；已有的鎖內容是空的或 10 秒內建立的一律當作有人拿著；pid 不在了才清掉重試；結束時只刪自己的鎖。
- **解壓（W2）**：解到 `.incoming/<版本>.partial`，檢查內容（名稱、版本、BUILD_ID、updater.mjs）後寫 `.extracted` 標記再改名成 `.incoming/<版本>`；沒有標記的一律重下載。
- **成品檢查（B2–B4）**：daemon 只接受 `asset === releaseAssetName(version, platform)`；hub 的下載端點同樣比對檔名。解壓前 `tar -tf` 檢查：每一項都要在 `agent-board/` 底下、沒有絕對路徑或 `..`；symlink 的目標在解開後檢查（§21.9 N3）。
- **原生模組 ABI（B5）**：hub 驗證成品時讀 `.node-modules-platform` 的 `modules`（Node ABI）記在 `verified.json`；daemon hello 帶 `nodeAbi`（`process.versions.modules`）。不合 → 不發目標（`targetNote: abi_mismatch`），面板請人手動安裝。**0.1.2 起拿掉**：原生模組是 N-API，不比 ABI；改成 Node 主版本低於成品 `minNode` 時 `node_too_old`（§21.10）。
- **win-x64（W8）**：`UNVERIFIED_PLATFORMS`（目前 `win-x64`）：hub 照樣下載、驗證成品，但預設不發目標（`targetNote: platform_unverified`）；owner 可以在面板對單一機器打開「允許自動更新」（2026-11-12，§21.3 的 `machineAllowUnverified`）；實機驗證後從清單拿掉（測試用 `AGENT_BOARD_ALLOW_UNVERIFIED_PLATFORMS=1`）。workflow 照樣建 win-x64 成品，Windows 建置跑的單元測試見 §20.7。
- **延後（W5、W6）**：安裝程式因為 session 忙碌（要換 session host）中止時以 **75** 結束（什麼都沒改）；更新程式寫 `deferred/host_busy`（不算失敗、不推播），daemon 5 分鐘後再試。手動回滾套用同樣的延後條件（上一版的 session host 協定不同就看 RUN／PERM／PLAN／starting）。上一版是 `0.0.0-legacy` 或比 `FIRST_UPDATER_VERSION`（0.1.0）舊：hub 回 409 `previous_unsupported`，面板不給按並說明（要用 `install.sh --from` 重裝）。
- **schema 判斷（W3）**：回滾時用舊版的 better-sqlite3 讀現在的 schema；和更新前不同（或讀更新前時讀不到、改用舊版 hub 的 `schema-version` 比對 `user_version >` 它）就帶 `--restore-db`。
- **保留舊版（W4）**：清舊版失敗（例如 Windows 檔案被鎖）吞掉、下次再清。**已知限制**：agent 的 PATH 與 MCP 設定檔寫的是 `current`／`app`，但 node 啟動時會把 symlink 解開，長時間跑的 agent 底下的 MCP server 其實是從 `releases/<當時的版本>` 載入的；那一版被清掉後，已經載入記憶體的部分照常運作，之後才要讀的檔會失敗（重開 session 即可）。只留 3 版、current 與上一版一定留，要連續換三版以上才會遇到。沒有用 session host 快照的 agentPid 判斷要不要留。
- **app 連結（W7）**：每次 install，`app` 不存在而 `current` 存在就補建 `app → current`（新安裝也有）。
- **下載退避（W9）**：同一版從 GitHub 下載失敗，自動檢查照 10、20、40…分鐘（上限 6 小時）退避，記在 settings `release.fetchFailure`；手動「檢查新版」不受限，成功後清掉。重新讀 cache 時刪掉 `.download-*` 暫存。
- **workflow（W10）**：最上層 `permissions: contents: read`，只有 publish job `contents: write`；checkout `persist-credentials: false`；actions 釘 commit SHA；先 `gh release create --draft` 上傳完再 `gh release edit --draft=false`（hub 只看非草稿）。
- **沒做**：成品簽章／attestation（B1）與審查清單上的 B6、B7。

### 21.9 複查後的修正（2026-11-11）

- **hub_first 只在 hub 那台真的會升時才擋（N1）**：哪一台是 hub＝最後一次 hello 說自己有 hub 的那台（settings `release.hubMachine`；那台之後的 hello 說沒有就清掉、刪機器也清）。其他機器只在「hub 那台自己的目標（不看 hub_first）也是這一版、它還沒升上去、而且在線」時才拿到 null（`hub_first`）；hub 那台被平台（win-x64）、ABI 擋住、或離線時不擋。hub 那台這一版 `rolled_back`／`rollback_failed`：不管在不在線都繼續擋，說明改成 `hub_update_failed`（面板「hub 更新失敗，其他機器暫停」）。hub 那台上線、離線、換版本都會重送目標。
- **過期判斷（N2）**：更新程式寫的狀態帶自己的 pid，`startedAt`＝更新程式拿到鎖的時間。它還拿著 `update.lock` 就不算過期，只有 `UPDATE_STALE_MS`（改成 60 分鐘）的硬上限；鎖不是它的或它不在了＝中斷。daemon 自己寫的 installing／rolling_back（更新程式還沒拿到鎖）：有活著的鎖持有者就等，沒有的話一分鐘後算中斷。hub 的斷線統計也用 60 分鐘。
- **不重複啟動（N2）**：hub 在這台有最近 60 分鐘內的進行中狀態時，「立即更新」「回滾」回 409 `update_in_progress`；daemon 的 `rollback()` 也先看狀態檔，有更新在跑就不啟動第二個、狀態檔不動。回滾延後中收到新目標不會取消回滾（面板照樣看到延後的回滾，回滾做完才處理新目標）；按「立即更新」（force）會取代它，並明確記成 `idle/superseded`。
- **解開後檢查整棵樹（N3）**：`tar -tf` 的路徑檢查留著當第一道；解到 `.partial` 之後用 lstat 走 `agent-board/` 整棵樹，每個 symlink 的實際目標（realpath；懸空的照連結文字算）都要在 `.partial/agent-board` 裡，不是一般檔案／資料夾／symlink 的一律拒絕，過了才寫完成標記。真的發布檔（node_modules/.bin 有 6 個 symlink）實測不誤擋。不再解析 `tar -tvf` 的文字。
- **手動回滾後暫停那一版（M1）**：hub 送 `release.rollback` 時把這台目前的版本記在 settings `machineHold:<機器 id>`。通道目標等於這一版時不發目標（`targetNote: rolled_back_hold`，面板「已手動回滾，暫停這一版；按『立即更新』或通道換新版才解除」）；通道目標換成別的版本時自動清掉，按「立即更新」（force）也清掉，刪機器時一起刪。hub_first 的計算用同一套：hub 那台被暫停時視同它拿不到目標，不擋其他機器。daemon 另有保險：上次狀態是 `succeeded/rollback_requested`、目標等於那次的 `fromVersion`、不是 force 時不升回去。

### 21.10 Node：用各機的系統 Node（GM 2026-11-11）

**現行規則（0.1.2 起）**：發布檔**不自帶 Node**。hub、daemon、session host 三個服務、更新程式、安裝程式、hook、派工 MCP server 一律用**安裝時找到的系統 node 路徑**。

- **原生模組是 N-API**：node-pty 1.1.0、better-sqlite3 13.0.3、argon2 0.45.1 都依賴 node-addon-api，prebuilds 只分平台、不分 Node 版本，跨 Node 主版本通用（MacBook 用 Node 26 跑 Node 24 建的 0.1.0 一直正常）。build-release 照舊 `npm ci` 附這個平台的 node_modules，並用建置的 node 實際載入一次、開一次 PTY。
- **最低版本**：根目錄 `package.json` 的 `engines.node`（`>=22.18`）。build-release 寫進 `.node-modules-platform` 的 `minNode`（還有 `napi: true`；`node`、`buildModules` 是建置用的 Node 與 ABI，只供參考）。ABI 刻意不叫 `modules`：0.1.0／0.1.1 的 hub 讀 `modules` 跟 daemon 的 ABI 比、不合就 `abi_mismatch`，讀不到就不擋，所以舊 hub 也會把 0.1.2 發給 Node 26 的 MacBook。**沒做**：建置時用 engines 的最低版本（22.18）實際載入原生模組（建置機只有一個 Node）。install.sh 先擋 Node 低於 22.18；安裝程式再用發布檔的 engines 檢查服務要用的那支 node，太舊就中止（什麼都還沒改）。
- **hub**：**不比 ABI**（0.1.1 以前的 `abi_mismatch` 不再產生，enum 留著相容）。daemon hello 多帶 `nodeVersion`（`process.versions.node`），hub 用完整版本和成品 `verified.json` 的 `minNode` 比（`nodeTooOld`），低於就不發目標（`targetNote: node_too_old`，面板請人升級 Node）。0.1.2 以前的 daemon 只送 `nodeAbi`：用對照表推主版本（108→18、111→19、115→20、120→21、127→22、131→23、137→24、141→25、147→26）只比主版本，推不出來就不擋。成品的 ABI 讀 `buildModules`（沒有就讀舊的 `modules`），只供參考。成品沒記 `minNode`（0.1.1 以前）不擋；舊 hub 驗過、`verified.json` 沒有 `minNode` 欄位的 cache，讀 cache 時成品還在就重讀 `.node-modules-platform` 補上並寫回。`nodeVersion` 也放進面板的機器資料（只供顯示）。
- **系統 node 怎麼找**（`installer.mjs` 的 `systemNode`，照 0.1.0 的寫法）：PATH 上的 node 和執行安裝程式的是同一個檔案時用 **PATH 上的路徑**（例如 `/usr/local/bin/node`、`/opt/homebrew/bin/node`），否則用執行安裝程式的 node（那是 Homebrew Cellar 之類的實際路徑時，`/opt/homebrew/bin/node` 或 `/usr/local/bin/node` 指到同一個檔案就改用它）；**不做 realpath**（macOS 的隱私權限照實際執行的路徑認，Homebrew 的 Cellar 路徑也會隨升級失效）。安裝資料夾裡的、以及**任何發布檔自帶的 runtime**（0.1.1 的 `…/runtime/node/bin/node`，比對 realpath）不算系統 node——例如 0.1.1 的 daemon 用它自己的 node 啟動更新程式時，改用 PATH 上的或 install.json 記的 `systemNode`。找到的路徑記進 install.json 的 `systemNode`。
- **服務設定**：plist／systemd unit／Windows 工作的執行檔都是那支 node；PATH 最前面是它的資料夾（同 0.1.0）。daemon 服務帶 `AGENT_BOARD_NODE`（同一個路徑）：派工 MCP 設定檔的 command、啟動更新程式、hook 包裝都用它。更新程式跑安裝程式、讀 schema 也用系統 node（`AGENT_BOARD_NODE` → install.json 的 `systemNode` → 自己 → PATH，跳過自帶的 runtime）。
- **hook**：`daemon/node_modules/.bin/agent-board-hook` 是小的 sh 包裝（`.cmd` 同理，`lib/node-runtime.mjs` 的 `hookWrapperSh`／`hookWrapperCmd`）：用 `AGENT_BOARD_NODE`（daemon 傳給 agent 的安裝時路徑）執行 `daemon/dist/agent-board-hook.cjs`，不能執行才用 PATH 上的 node；**node 或 `.cjs` 都找不到就往 stderr 說明並 exit 2**（Claude Code 當成擋下：裝壞了不能讓危險指令檢查被放行）。`~/.local/bin/agent-board-hook` 是 exec 包裝的 shell 腳本（不是 symlink，包裝用相對路徑找 `.cjs`）。
- **session host 換版判斷**：只有協定版本變了（§20.5）或 `--restart-session-host` 才重啟。**Node 換了不重啟**（N-API，node-pty 換哪個 Node 都載得起來）：服務設定改成系統 node，**下次 session host 重新載入（重開機或 `--restart-session-host`）時才生效**（launchd 的 kickstart、KeepAlive 用的是載入當下的設定，不重讀 plist），安裝程式印一行說明；正在跑的 agent 不中斷。install.json 的 `sessionHostNode` 一律寫 `system`（0.1.1 的 daemon 看這個欄位決定要不要換 host）。`--keep-session-host` 參數保留但不需要了（印一行說明）。
- **接回時修 MCP 設定檔**：daemon 接回 host 裡還活著的 session 時，MCP 設定檔（`<dataDir>/mcp/<id>.json`）的 command 和現在的 `AGENT_BOARD_NODE` 不同、或那個路徑不存在，就改成現在的 node（只改 command；密鑰、env、args 不動；0600、先寫暫存檔再換名，`mcpFiles.ts` 的 `repointMcpConfig`）。0.1.1 期間開的 session 寫的是 `current/runtime/node/bin/node`，升到 0.1.2 後就不在了，claude 之後重開 MCP server 也能用。
- **0.1.1 的殘留**：session host 資料夾裡的 `runtime/`，沒有程序從它執行（`ps` 的指令列不以它開頭）、而且 launchd 載入中的 host 設定（`launchctl print` 的 `program =` 與 `arguments` 第一個）也不在它底下時才刪；host 還在用它跑就留著並說明，下次安裝再清。`releases/0.1.1/runtime` 跟著舊版一起被保留／清掉（只留 3 版）。
- **launchd 停服務要等卸載完**：`launchctl bootout` 回來時 job 可能還在（程式還沒結束），這時 `print` 照樣成功、`bootstrap` 回 5。
  - plist 明確設 `ExitTimeOut` 15 秒（SIGTERM 之後最多等 15 秒就 SIGKILL；launchd 預設 20 秒）；安裝程式等卸載的上限是 **45 秒**，比它長。換 session host 前停 host 逾時就**中止安裝**（還沒換資料夾）並以非 0 結束。
  - 換了 host 之後一律由這次 bootstrap 載入（`mustBootstrap`），不走「已載入就當成在跑」的捷徑。bootstrap 失敗重試 5 次，再用 `print` 確認載入；bootstrap 後 10 秒內 `print` 要有 `pid =` 或 `state = running`（沒配對的 daemon 會馬上結束，不檢查）；換了 host 另外等它這次寫的 token 與 socket 連得上（最多 10 秒；socket 位置同 `session-host/src/endpoint.ts`，路徑太長時試安裝程式與服務兩邊的 tmpdir）。
  - **服務沒起來就非 0 結束**（W3）：hub、daemon 沒起來、或換了 host 卻沒起來，安裝程式說明後以 1 結束（程式已裝好，處理後再跑一次）。同一台有 hub 時，不論裝的是哪個角色，hub 重啟了都等 `/api/auth/status` 回應。`switch`（回滾）同樣。
  - 測試用的假 launchctl 照真的語意：載入和在跑分開；bootstrap 時存 plist 快照，kickstart 用快照；bootout 不等程式結束、照 `ExitTimeOut`（預設 20 秒）才 SIGKILL；bootstrap 已載入的回 5、正在卸載時再 bootout 回 36、kickstart 沒載入的回 113；print 印 program、arguments、state、pid。回歸測試含「host 不理 SIGTERM」（靠 ExitTimeOut 收掉）與「host 沒開 socket → 非 0」。
- **換了 node 執行檔要注意 macOS 隱私權限**：TCC 照實際執行的路徑（與檔案）認，`brew upgrade node`、重裝 Node 之類換掉 node 執行檔之後，可能要重新允許取用「桌面」「文件」等資料夾。症狀同 2026-11-11 的事故：agent 開了沒有畫面輸出、幾乎不用 CPU、MCP 沒起來、session 卡在 starting。處理：系統設定 → 隱私權與安全性 →「檔案和資料夾」／「完整磁碟取用權限」允許那支 node（或從終端機用同一支 node 存取一次專案資料夾觸發詢問），再 `launchctl kickstart -k gui/$UID/com.agent-board.session-host`（會結束 agent，之後 `--resume`）。**未驗證**確切規則。
- **Windows**（未在實機測過；Windows CI 的 `scripts/windows-paths.test.mjs` 實測 junction、檔案鎖、cmd.exe 跑 hook 包裝，§20.7）：清舊版先把資料夾改名成 `releases\.trash-<名稱>-<亂數>` 再刪（亂數：上次沒刪完的同名 trash 不衝突；檔案被鎖住改不了名就整個留著，下次再清），連結與清理在 `scripts/lib/release-dirs.mjs`。install.ps1 用系統 node。
- **install.sh**：線上下載驗 SHA-256 用 `shasum -a 256`／`sha256sum`，不需要 node。

**2026-11-11 的事故（0.1.1 自帶 Node，從沒打 tag）**：0.1.1 讓發布檔自帶 Node 24.22.2（以為原生模組綁 ABI，要讓 MacBook 的 Node 26 也拿得到更新）。在 Mac mini 手動上架時出了兩個問題，GM 決定改回系統 Node：

1. **session host 沒重新載入**：`install.sh hub --from …0.1.1…` 結束碼 0，但 session host 收到 SIGTERM 結束了 15 個 agent 之後沒有再載入（`launchctl list` 沒有它），daemon 退回舊模式、15 個 session 離線，Lead 手動 `launchctl bootstrap` 才恢復。**根因**：安裝程式換 host 時 `launchctl bootout` 完立刻呼叫 `startService(restart: false)`，裡面先 `launchctl print`——job 還在收（host 要花約 2 秒結束 agent），`print` 成功，就當成「已經在跑」直接回傳，沒有 bootstrap；接著 job 被收掉，什麼都沒載入。安裝紀錄沒有任何錯誤。當時的假 launchctl 是「bootout 同步等程式結束、print 只看程式在不在跑」，和真的 launchd 不同，所以測試沒抓到。修正見上（等卸載完、確認載入、假 launchctl 照真的語意，`scripts/system-node.test.mjs` 回歸測試）。這個問題和自帶 Node 無關，協定變了換 host 也會遇到。
2. **macOS 隱私權限**：host 改用自帶的 node（`session-host/runtime/node/bin/node`）後，claude（host 的子程序）開 47 秒只用 0.02 秒 CPU、沒有畫面輸出、MCP 沒起來，15 個 session 卡在 starting；專案都在 `~/Desktop`。host plist 改回 `/usr/local/bin/node`（系統 Node 24，官方 pkg）立刻正常。兩支 node 簽章相同，推測 TCC 對不是 App 的執行檔是照路徑認（**未驗證**確切機制）。所以現在一律用系統 node 的原路徑。
3. **前提錯了**：原生模組都是 N-API（見上），擋住 MacBook 的只是 hub 用 `process.versions.modules` 的比對。

**過渡**：Mac mini 目前回報 0.1.1（hub、daemon 跑 `current/runtime/node/bin/node`；host plist 已被 Lead 手動改成 `/usr/local/bin/node`；install.json 還記 `sessionHostNode: bundled:…`）。手動 `install.sh hub --from <0.1.2 成品>`：協定沒變 → **不重啟 session host**，只重啟 hub／daemon（agent 不中斷）；三個服務改成系統 node；host 資料夾的 `runtime/` 沒人用就清掉。MacBook 是 0.1.0（系統 Node 26）：hub 升上 0.1.2 之後不比 ABI，MacBook 照常自動收到 canary 並更新（0.1.0 的 daemon 用它的系統 node 啟動新版的更新程式；更新程式只用內建模組）。

- **已驗證**（2026-11-11，Apple Silicon Mac、系統 Node 24.17，假 launchctl 照真的語意）：`test:install`（含回歸測試）、`smoke:release`、`e2e:update`（真的 0.1.0 → 0.1.1 自帶 Node 成品＋host plist 手動改回系統 node → 開著 session 手動升 0.1.2：host 沒重啟、agent 還在、三個服務都在系統 node；再自動更新、壞版回滾；daemon 用 `AGENT_BOARD_TEST_NODE_VERSION` 假裝 Node 26 照樣拿到目標；`E2E_LEGACY_AUTO=1` 走舊 daemon 自動更新）。
- **未驗證**：真的 launchd 的時序（只用照語意寫的假 launchctl；修正是保守的「等到卸載完」）；真的 Node 26 機器（只用回報值模擬）；TCC 的確切規則；Windows、Linux systemd。

## 22. Codex 第二輪：Codex 用量、Codex 派工、交叉審查（GM 2026-11-12）

規格與 GM 決策：`docs/codex-round2-spec.md`。三件事照 §6 的順序做。原則不變：**中控台不呼叫 LLM**；交叉審查是 daemon 在 GM 或隊長明確要求時開使用者自己登入的官方 CLI（`claude -p`、`codex exec`），吃使用者自己的訂閱額度（界線見 22.3.6、`docs/no-llm-review.md`「交叉審查」）。不讀、不複製 `~/.claude` 與 `~/.codex/auth.json`；不改 `~/.codex`，Codex 的設定一律在啟動時用 `-c` 帶入。

### 22.1 Codex 用量

- **daemon**（`daemon/src/usage.ts` 的 `scanCodexUsage`／`codexFile`）：和 Claude 同一次 `reportUsage`、同一套彙總（`scanFiles`：30 天總數＋90 天「日期 × 模型 × session」細項、上限、「其他」），讀 `$CODEX_HOME/sessions/`（沒設是 `~/.codex/sessions/`）底下的 `rollout-…-<thread id>.jsonl`。只讀 sessions 資料夾，不碰 `auth.json`、不呼叫任何 API；讀不懂的行、檔案略過。
- **格式**（2026-11-12 用本機 144 個真檔確認，codex-cli 0.130–0.167，只看欄位結構）：
  - `{"type":"session_meta","payload":{"cwd",…}}`：工作資料夾（第一個）。
  - `{"type":"turn_context","payload":{"model",…}}`：之後的 token 算在這個模型上。
  - `{"type":"event_msg","timestamp","payload":{"type":"token_count","info":{"last_token_usage":{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, cache_write_input_tokens, total_tokens},"total_token_usage":{同上}}}}`；`info` 可能是 null（只帶額度資訊，略過）。同一檔裡 `total_token_usage.total_tokens` 和上一則一樣的是重複送的（實測 4,529 則裡 45 則），略過；其餘 `last_token_usage` 加總＝最後的 total（144 檔全部相等）。
  - 0.167 起另有 `token_usage_record`（與 token_count 重複），不讀。
  - session id 一律取檔名裡的 thread id（`Session.claudeSessionId` 存的就是它，§19.1）。
- **換算成 Claude 的四欄**：輸入＝`input_tokens − cached_input_tokens`（Codex 的 input 含快取，Claude 的不含）、快取讀＝`cached_input_tokens`、輸出＝`output_tokens`（已含推理）、快取寫＝`cache_write_input_tokens`（目前都是 0）。
- **WS**：`usage` 多一個選用欄位 `codex: { summary, detail }`（`CodexUsage`，`.catch(undefined)`：壞掉當沒送）；偵測到 codex 或資料夾裡有紀錄才送。舊 hub 不認得就忽略，Claude 的總數與細項照收。**頁首「近 30 天」仍只算 Claude**（Codex 是不同方案）。
- **hub**：`StoredUsage.codex`（settings `usage:<機器>`，不升 schema；舊資料沒有＝null）。`buildUsageReport` 依 agent 分開對：Codex 的細項只對 `agent: 'codex'` 的看板 session（thread id），各自有自己的「其他」。`UsageReportSession.agent`（預設 `claude`）、`UsageReportMachine.codexSummary`／`codexOtherSessions`。
- **網頁**（`usage/`）：有 Codex 用量時篩選列多一個「代理」（合計／Claude Code／Codex，管下面全部），分布多「依代理」。沒有 Codex 用量時畫面和以前一樣。
- 已知：Codex 的 fork（同一檔多個 session_meta）會不會把上一段的 token 帶進來未驗證（實測加總和 total 一致）；交叉審查跑的 `codex exec` 也會留紀錄，算進「中控台外」。

### 22.2 Codex 也能派工

- **MCP 帶入**（`protocol/src/codex.ts` 的 `codexMcpOverrides`，`daemon/src/codex.ts` 的 `buildCodexArgs({ mcp })`）：和 Claude 同一支 `agent-board-mcp`、同一份 env（`AGENT_BOARD_SESSION_ID`、`AGENT_BOARD_SOCKET`、密鑰**檔案路徑** `AGENT_BOARD_MCP_SECRET_FILE`、`AGENT_BOARD_MCP_TOOLS`、`AGENT_BOARD_HOOK_KEY_FILE`），同一套密鑰（`writeMcpFiles`，每次開 PTY 換新），改成啟動參數：
  ```
  -c mcp_servers.agent-board.command="<node>"
  -c mcp_servers.agent-board.args=["<agent-board-mcp>"]
  -c mcp_servers.agent-board.env={AGENT_BOARD_SESSION_ID="…",…}
  -c mcp_servers.agent-board.enabled_tools=["list_members",…]     # 只露出開著的工具（同 --allowedTools）
  -c mcp_servers.agent-board.default_tools_approval_mode="approve" # 這些工具不跳 Codex 的核准
  ```
  `default_tools_approval_mode` 的值（`auto | prompt | writes | approve`）取自 Codex 官方設定文件與 0.167 執行檔裡的設定鍵名（`RawMcpServerConfig`）；文件範例用 `approve` 讓單一工具免核准。**未用真的 codex 驗證**：`-c` 帶入的 MCP server 會不會要求信任、`approve` 是否真的不跳核准、`enabled_tools` 是否生效（列入 GM 實測清單）。設定都關著或找不到 MCP server 時不帶。密鑰不在 argv（只有檔案路徑），和 Claude 一樣。
- **spawn_member**：新參數 `agent`（`claude`／`codex`，選填，**預設和隊長同一種**）。換 agent 時不沿用隊長的模型（各家模型名稱不同，用那個 CLI 的預設；有明確給 `model` 照用）；帳號資料夾只在 Claude 開 Claude 時沿用（Codex 沒有、Codex 開 Claude 用預設帳號）；`account_rate_limited` 看目標 agent 的帳號。那台沒有 codex → `codex_unavailable`、Windows → `codex_windows_unsupported`（`hub.createSession` 的 409，剛開的空團隊收掉）。回覆與 audit 多 `agent`。
- **Codex 當隊長或成員**：工具全部照 §11（`list_members`、`spawn_member`、`send_task`、`get_result`、`release_member`、`get_progress`／`update_progress`、`request_review`）。結果送回：Codex 的 `Stop` hook 一樣帶 `last_assistant_message`，hub 的 `DispatchEngine.onEvent` 不分 agent，照 §11.4 送回隊長，「等隊長／等成員結果」照常。送進 Codex 的工作、結果一樣走 SafeDelivery（等輸入才送）。
- 上架：hub、daemon、hook 一起更新（新工具 `request_review` 與 Codex 的 MCP 參數）。舊 daemon 不給 Codex 掛 MCP：Codex session 照第一版只有 hook。

### 22.3 交叉審查

#### 22.3.1 流程

```
GM：網頁發起（session 或 分支）→ POST /api/reviews/prepare → hub 建紀錄（preparing）→ WS review.prepare → daemon 只跑 git 產生 diff
     → review.prepared（摘要）→ awaiting_confirm：GM 看檔案清單與大小 → 按確認 POST /api/reviews/:id/start
隊長：MCP request_review（理由必填、頻率上限）→ 同上，但 diff 好了就自動 start（跳過確認），推播通知 GM
start → WS review.run → daemon 並行開 claude -p 與 codex exec（唯讀、逾時）→ 各自 review.side → 兩邊都結束：done
     → 收件匣、推播「審查完成」、隊長發起的把摘要送回隊長（SafeDelivery）
```

#### 22.3.2 對象與 diff（`daemon/src/reviewDiff.ts`，只跑 git、不改 repo）

- **session**：那個 session 的工作資料夾（worktree 或 cwd）`git diff HEAD`（含 staged；還沒 commit 過的 repo 和空樹比）＋未追蹤檔（`ls-files --others --exclude-standard`，`.gitignore` 的不算；二進位不送內容；最多 500 個；Agent Board 自己裝的 `.claude/settings.local.json` 不算）。
- **branch**：指定機器上的 repo 路徑＋分支，`git diff <base>...<branch>`（base 預設 `main`）。分支名稱 `ReviewRef`：不能以 `-` 開頭、不能有空白與 `..`（不會被當成 git 參數），git 也先 `rev-parse --verify` 確認存在（`unknown_ref`）。
- **上限**：單檔 `REVIEW_FILE_MAX_BYTES` 200 KB 截斷並在內容裡標明；整份 `REVIEW_TOTAL_MAX_BYTES` 1 MB，超過的檔案只列名稱（`omitted`）並在內容最後列出。git 輸出超過 64 MB 當失敗（`diff_too_large`）。
- 整份 diff 只留在 daemon 記憶體（`REVIEW_PREPARED_TTL_MS` 30 分鐘，跑過就丟）；hub 只存摘要 `ReviewDiffSummary`（檔案、狀態、+/- 行數、位元組、截斷／略過）。沒有變更 → `failed`／`no_changes`。

#### 22.3.3 執行（`daemon/src/review.ts`，`ReviewRunner`）

- 在 diff 所在的資料夾、兩邊並行，prompt＝固定審查指示（`protocol/src/review.ts` 的 `REVIEW_INSTRUCTIONS`，版本 `REVIEW_INSTRUCTIONS_VERSION`＝1；要求繁中三段：嚴重問題、建議、整體結論；不要求 JSON）＋diff，**經 stdin**（不在 argv）。
  - Claude：`claude -p --output-format json --restricted --tools Read,Grep,Glob --allowedTools Read Grep Glob --disallowedTools Bash Edit MultiEdit Write NotebookEdit WebFetch WebSearch Task mcp__* --strict-mcp-config --mcp-config '{"mcpServers":{}}' --permission-mode plan --no-session-persistence [--model …]`。審查對象是 Claude session 時用它的帳號資料夾（`CLAUDE_CONFIG_DIR`）。結果讀 `{ result, is_error, usage }`。
  - Codex：`codex exec --json -s read-only -c approval_policy="never" --skip-git-repo-check --ephemeral [-m …] [-c model_reasoning_effort="…"] -`。**偏離規格**：規格寫 `-a never`，但 codex-cli 0.167 的 `exec --help` 沒有 `-a`（只有互動模式有），所以用等效的設定覆寫。結果讀 JSONL：最後一則 `item.completed`（`agent_message`）的 text、`turn.completed.usage`；`turn.failed`／`error` 是失敗。事件格式取自官方文件與社群整理，**未用真的 codex 驗證**。
- 逾時 `REVIEW_TIMEOUT_MS` 10 分鐘：整個程序群組 SIGTERM、5 秒後 SIGKILL，標 `timeout`。一邊失敗、逾時不影響另一邊。同一台最多 2 份同時跑（再多回 `busy`）。意見文字最多 6 萬字。
- **Windows 機器只跑 Claude**：hub 送 `codex: null`、Codex 那邊 `skipped`，原因「windows: …」寫在結果上（daemon 也擋一次）。沒有 codex 的機器同樣 `skipped`／`codex_unavailable`。
- 結果 `review.side` 斷線時留著，連回 hub（welcome）後補送；hub 只收 `running` 中、同一台機器、還沒結束那一邊的結果。daemon 停止時跑到一半的全部結束。hub 心跳把跑太久的（逾時＋2 分鐘，daemon 重啟、結果沒回來）標 `failed`／`no_result`；hub 重啟時沒跑完的標 `hub_restarted`。

#### 22.3.4 資料（schema v11，`hub/src/db.ts`，**只加表**）

`reviews`：`id`、`requested_by`（JSON `{kind: user|lead, id, name}`）、`team_id`、`reason`、`machine_id`、`target`（JSON：`kind`、`label`、`sessionId`、`cwd`、`branch`、`base`）、`status`（preparing／awaiting_confirm／running／done／failed／cancelled）、`error`、`diff`（摘要 JSON）、`claude`／`codex`（`ReviewSide` JSON：狀態、意見文字、錯誤、模型、輸入／輸出 token、耗時）、`instructions_version`、`read`、`created_at`、`started_at`、`completed_at`；索引 `reviews_created`。不設外鍵（session、機器刪掉後紀錄照樣看得到）。保留：和 `session_events` 同一個期限（`AGENT_BOARD_EVENT_RETENTION_DAYS`，預設 30 天），只刪已結束的（`retention.ts`）。升級走既有的「升級前自動備份」（`hub.db.bak-<時間>-v10`）。降級：v10 hub 拒絕 v11 資料庫並指出 `-v10` 備份；回退＝停 hub → 換回舊版 → 還原備份（升級後的審查紀錄遺失）。

#### 22.3.5 介面

- **REST**（auth user）：`GET /api/reviews`（新的在前 100 筆）、`GET /api/reviews/:id`、`POST /api/reviews/prepare { target: ReviewTargetInput, reason? }`、`POST /api/reviews/:id/start`（只有 `awaiting_confirm` 可以，否則 409 `review_not_ready`）、`POST /api/reviews/:id/cancel`、`POST /api/reviews/read { ids? }`。機器離線 409 `machine_offline`；daemon 沒宣告 `review.v1` 409 `review_unsupported`。
- **WS**：daemon hello `features` 多 `review.v1`（`DAEMON_FEATURES.review`）；hub → daemon `review.prepare`／`review.run`／`review.cancel`；daemon → hub `review.prepared`／`review.side`；hub → web `board.state.reviews`（最近 50 筆）、`review.updated`。
- **audit**：`review.prepare`、`review.start`、`review.cancel`、`review.done`、`review.read`、`review.result_delivered`／`review.result_blocked`；隊長的另有 `dispatch.review`（含理由）、被擋的 `dispatch.blocked`（`tool: request_review`）。
- **推播**（不併進合併通知，不是「等你」）：`{ kind: 'review', event: 'done' | 'requested', reviewId, lead?, at }`——只說「審查完成」或「<隊長> 要求交叉審查」，**不帶審查內容、不帶理由**；點了開那份審查。
- **網頁**：發起流程（先看檔案清單與大小，按確認才送，◈ 耗額度）、左右並排兩家意見的疊加面板（手機上下）、從卡片／團隊面板／收件匣開；完成的進收件匣「交叉審查」區塊（不算等你）；團隊動態顯示隊長的要求（`TeamActivityKind` 多 `review_requested`、`TeamActivity.reviewId`）；設定頁「交叉審查」（`Settings.review`：`leadPerHour` 預設 3（0–20，0＝隊長不能發起）、`claudeModel`、`codexModel`、`codexEffort`，null＝CLI 預設）。

#### 22.3.6 隊長的 `request_review` 與 no-llm 界線

- 參數：`member`（自己團隊的成員：它的未 commit 變更）**或** `branch`（`base` 預設 main、`repoPath` 預設隊長的 repo），`reason` 必填（一行、200 字截斷；進 audit 與團隊動態，不進推播）。
- 依序擋：`reason_required` → `invalid_arguments`（兩個都給或都沒給、分支名稱不合法）→ `board_paused` → `not_lead` → `team_held` → `review_disabled`（設定 0）→ `review_rate_limit`（同一隊一小時內已達 `Settings.review.leadPerHour`，預設 3，算資料庫裡這一隊隊長發起的筆數）→ `not_your_member` → hub 的 409（`machine_offline`、`review_unsupported`）。
- 成功馬上回 `{ reviewId, status, target, reviewsLeftThisHour }`，diff 與兩邊在背景跑；做完把一行摘要 `[Review from Agent Board] <對象> | Claude: <整體結論那段的第一句> | Codex: … | Full review is in the Agent Board inbox.` 送回隊長（SafeDelivery，只在它等輸入時送；摘要是固定規則取字，不解讀內容；沒跑成是 `| not run: <原因>`）。送回的摘要不是新的派工，不會觸發任何自動送字。
- **界線**（`docs/no-llm-review.md`「交叉審查」、`scripts/no-llm-review-boundary.mjs`）：非互動 CLI 只在 `daemon/src/review.ts`；daemon 只在 `case 'review.run'` 呼叫 `ReviewRunner.run`；hub 只有 `ReviewEngine.startReview` 會送 `review.run`，而 `startReview` 只有兩個呼叫點：GM 的 REST `reviewStart`、隊長的 `requestByLead`（只從 `DispatchDeps.requestReview` → `dispatch.ts` 的 `request_review` 處理呼叫）。白名單以外、或呼叫點和所在函式之間有計時器，`check:no-llm` 一律失敗。排程（hub 心跳）只會把審查**結束**（逾時），不會開始。
- **上架影響**：schema v10 → v11（只加表、升級前自動備份、不中斷 agent：session host 不受影響，hub 重啟期間 session 照跑）；hub、daemon、hook 要一起更新（`request_review` 進 `--allowedTools`／`enabled_tools`；舊 daemon 不宣告 `review.v1`，GM 發起回 `review_unsupported`）。

### 22.4 獨立審查後的修正（2026-11-13）

- **讀檔安全（S1）**：未追蹤檔先 `lstat`：符號連結只列 `(symlink -> 目標)`、不讀內容；FIFO、裝置、socket 等非一般檔案略過（不會卡住）；`realpath` 必須在 repo 裡；開檔 `O_RDONLY|O_NOFOLLOW`。
- **機密檔（W2）**：檔名像機密的（`.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.keystore`、`*.jks`、`*.der`、`*.crt`、`*.cer`、`id_rsa`／`id_dsa`／`id_ecdsa`／`id_ed25519`、`credentials*.json`、`service-account*.json`、`.npmrc`、`.netrc`、`.pypirc`、`.git-credentials`、`.pgpass`，以及 `.aws/`、`.ssh/`、`.gnupg/`、`.docker/`、`.kube/` 底下）只列名稱、不送內容，摘要 `omitted: "sensitive"`；`git diff` 也用 pathspec 排除。`id_*` 只認 SSH 金鑰的檔名（不擋 `id_utils.ts` 這類程式檔）。git 一律 `--no-textconv`、`-c core.fsmonitor=false`、`GIT_CONFIG_NOSYSTEM=1`。
- **Claude 審查端（S2）**：參數見 22.3.3（claude 2.1.322 `--help` 確認）。`--restricted` 不讀 user／project／local 設定檔（repo 的 `.claude/settings*.json` hooks 不載入）、拿掉跑指令的工具；`--strict-mcp-config` 加空的 `--mcp-config` 不載入任何 MCP（含 `.mcp.json`）。所以在 repo 資料夾執行即可，不另開暫存資料夾。舊版 claude 不認得 `--restricted` 時那一邊會失敗（往安全的方向）。Codex 審查加 `--ephemeral`（不留紀錄）；repo 有自己的 `.codex/hooks.json`／`config.toml` 時 Codex 那邊略過（`project_codex_hooks`）。`codex exec --ignore-user-config` 沒帶（會連 provider／登入相關設定一起略過，未驗證）。`check:no-llm` 檢查參數白名單、`-c` 值白名單（只准 `approval_policy="never"` 與 `model_reasoning_effort`）、Claude 拒絕清單至少含 Bash、Edit、Write、MultiEdit。
- **Codex 掛 MCP 改成開關（S3）**：`Settings.codexMcp`，**預設關**，設定頁「Session 與額度」→「Codex 掛派工工具」，`hub.welcome.codexMcp` 下發（daemon 只記在記憶體，沒收到就不掛）。帶 MCP 開的 Codex 在 15 秒內、還沒有任何 hook 就以非 0 結束：daemon 不回報這次結束、不帶 MCP 重開一次，之後這個 daemon 開的 Codex 都不帶，並送 `daemon.alert`（`codex_mcp_failed`）。
- **e2e（S4）**：所有啟動 daemon 的 e2e 都設暫存 `CODEX_HOME` 與 `AGENT_BOARD_E2E=1`；daemon 在 `AGENT_BOARD_E2E=1` 時 `CODEX_HOME` 指到真的 `~/.codex`（或沒設）就拒絕啟動。
- **隊長 `repoPath`（W1）**：只能是隊長自己或它能派工的成員的 `repoRoot`／`cwd`（同一台機器），否則 `invalid_repo`；`repoPath` 必須是絕對路徑（protocol `isAbsolutePath`）。
- **遮蔽（W3）**：兩邊的意見與錯誤訊息在存檔、廣播前先過 `redactSecrets`（同 audit）；送回隊長的摘要也遮。
- **開始前重查（W4）**：隊長發起的，diff 準備好、`startReview` 之前再查全部暫停與全隊暫停／停止，有就 `failed`（`board_paused`／`team_held`）並告訴隊長。
- **頻率（W5）**：多一層全面板上限 `Settings.review.boardPerHour`（所有隊長合計，預設 10，0–60），超過 `review_board_rate_limit`。計數只算真的跑到模型的（沒有變更、git 失敗、暫停擋下、取消、`busy` 拒絕都不算）。daemon 同時跑 2 份，再來的排隊最多 2 份（輪到才開 CLI），排不下才 `busy`；同時最多 2 個 git diff，準備好的 diff 最多留 10 份。hub 的「跑太久」改成 2 × 10 分鐘＋2 分鐘（排隊的那份）。
- **過期（W6）**：`awaiting_confirm` 超過 30 分鐘（`REVIEW_PREPARED_TTL_MS`，daemon 的 diff 也過期）→ `failed`／`expired`；保留期限也清 `awaiting_confirm`。
- **只送摘要（W7）**：board 快照、`review.updated`、`GET /api/reviews` 的兩邊 `output` 是 null、`outputChars` 是字數；全文只有 `GET /api/reviews/:id`（網頁打開審查、狀態變了時讀）。
- **界線檢查（W8）**：多檢查 `case 'dispatch.request'` → `onDispatchRequest` → `dispatch.handle` → `case 'request_review'` → `requestReview`；`.then`、`queueMicrotask`、`process.nextTick`、事件監聽 `.on(`／`.once(` 包著的呼叫也算延後觸發（只有 `requestByLead` 等 diff 好才開始，明列例外）。hub 測試另外跑一輪心跳、recover／expire、自動接續、交接規則、全隊暫停／繼續，確認沒送出 `review.run`。
- **Windows（W9）**：審查 CLI 只用 `.exe`（不用 `.cmd`，那要經 cmd.exe、JSON 參數會壞）；結束用 `taskkill /T /F /PID`。仍未在 Windows 實機驗證。
- **Codex 用量去重（W10）**：整次掃描共用一份去重（事件時間＋累計 `total_tokens`），fork／resume 複製過來的事件只算一次。沒做「路徑＋大小＋mtime」快取。
- 其他：`tomlString` 跳脫所有控制字元；`POST /api/reviews/prepare`、`/:id/start` 改成 owner 權限；分支審查的 prompt 註明「工作資料夾可能在別的分支，以 diff 為準」（沒有另外檢出 worktree）。
- **複查（2026-11-13）**：
  - 讀未追蹤檔開檔後比對 dev／ino 與一開始的 `lstat` 相同、讀完再確認 `realpath` 沒變，否則略過（擋中間資料夾被換成連結）。
  - Codex 帶 MCP 一開就失敗時，輸出要有設定錯誤字樣（取自 codex 0.167 執行檔：`Error loading config.toml`、`Error loading configuration`、`failed to load configuration`、`Failed to deserialize overridden config`、`` unknown field ` ``、`` unknown variant ` ``、`` missing field ` ``、`` MCP client for ` ``，加上 `mcp_servers`、`default_tools_approval_mode`、`enabled_tools`、`invalid configuration`）才退回不帶 MCP；登入過期、網路錯誤等照一般結束回報。判斷只做一次、`onRuntime` 與 `onExit` 都用 PTY 真正的結束碼。
  - 網頁：不認得的 session 狀態獨立顯示成 `UNK`（`?`、「不認得的狀態」、錯誤色），算等你、排在待處理最前；正式版也 `console.warn` 一次。
  - 隊長 `request_review` 的推播（「<隊長> 要求交叉審查」）延到真的開始跑之後；沒有變更、暫停、開始失敗都不推播。
- **真 CLI 實測（2026-11-13）**：claude -p（haiku）照 `claudeReviewArgs` 在含 SessionStart／PreToolUse hook 的 repo 跑，hook 沒觸發、要求的 Bash／寫檔都沒產生、沒留對話紀錄；codex exec（gpt-6-luna）照 `codexReviewArgs` 跑，`~/.codex/sessions` 檔數不變；兩份真輸出餵 `parseClaudeOutput`／`parseCodexOutput` 都讀得出。dev 實例開 `codexMcp`：Codex 呼叫 `list_members` 不跳核准；Codex 隊長 `spawn_member` 開 Codex 成員，成員結果 `[Result from …]` 送回隊長。
  - 發現：Codex 隊長派工後用內建 `clocksleep` 在同一回合裡等結果，不結束回合；結果只在隊長等輸入時送，兩邊互等（中斷隊長後立刻送達）。修正：守則與 `spawn_member`／`send_task`／`request_review` 的說明和回傳改成「結果在你這回合結束後才會送進來，現在就結束回合，不要 sleep、輪詢或為了等而繼續工作」。修正後尚未用真 Codex 再測（未驗證）。
  - 另記（第一版就有，未修）：Codex 在還沒信任的資料夾會先跳「Trust this folder?」，選了會寫進使用者的 `~/.codex/config.toml`；這時面板顯示 NEW（`idle:start`），沒有判斷成需要注意。互動模式的推理強度跟使用者的 Codex 預設（session 沒有欄位可設）。

## 23. 加開申請（隊長超過上限時向 GM 申請，GM 2026-11-13）

隊長自主擴編原本有兩道硬上限，碰到就拒絕 `spawn_member`：團隊總人數（`autoStaff.teamLimit`）→ `team_full`；同一隊 10 分鐘最多新增 `DISPATCH_SPAWN_RATE_MAX` = 4 位 → `spawn_rate_limit`。改成：碰到上限時不拒絕，改成「提出加開申請」，GM 批准後才開。

### 23.1 規則

- **什麼時候變成申請**：`spawn_member` 走完原本所有檢查（§11.7 的順序：全部暫停、設定關、理由、不是隊長、全隊暫停／停止、帳號限流；再加機器在線、權限、worktree、寫入者衝突）都過了，只差人數或頻率上限時。這些先擋的照舊回錯誤，**不會**變成申請。隊長擴編設定（`autoStaff.enabled`）關掉時照舊 `autostaff_disabled`，不產生申請。
- **只有已經有團隊的隊長**：還沒有團隊（第一次開人）時理論上不會超限；真的碰到（例如團隊剛被刪）照舊回 `team_full`／`spawn_rate_limit`。
- **同一隊同時最多一件待處理**：已有一件時再超限回 `request_pending`（錯誤，記 audit `dispatch.blocked`、reason `request_pending`），不記新申請、**不再推播**。
- **兩道都超過**：`limit` 是 `team_full`，`limits` 兩個都列；同意時兩道都略過。
- **申請時記下完整的 spawn 參數與團隊**（role、prompt、reason、name、permissionMode、useWorktree、model、agent，和原本 `spawn_member` 一樣；`teamId`），同意時照用，不再問隊長。`spawn_member` 的 prompt 上限 4,000 字（`SPAWN_PROMPT_MAX`，以 Unicode code point 計，`promptLength`），和送進成員時 `[From …]` 的內容上限是同一個常數，所以 GM 在收件匣看到的全文就是成員會收到的；超過回 `invalid_arguments`，不產生申請。`promptChars` 用同一種算法。
- **同意**：先把紀錄存成 `approving`，再用申請時的參數、**開進申請時的團隊**（`spawnApproved(leadId, teamId, …)`）走一次 `DispatchEngine` 的開成員流程，**只略過 `limits` 裡的上限**。開始前確認那一隊還在、呼叫者還是它的隊長，否則 `failed`／`team_changed`（絕不另開新團隊；隊長帶多隊時也不會開進別隊）。其他擋法照舊（全部暫停、全隊暫停／停止、帳號限流、設定關、派工關、隊長已封存／結束、機器離線、`hub.createSession` 的錯…），又碰到別道上限也照舊擋。被擋＝申請 `failed`，`error` 是代碼，告訴隊長原因。開好＝申請 `approved`，成員和一般 `spawn_member` 開的完全一樣（`dispatch.spawn` audit、session 事件、`member_added` 團隊動態與推播、派工工作記在隊長名下，結果照常 `[Result from …]` 送回隊長、算進 10 分鐘頻率）。
- **拒絕**：不開，告訴隊長。
- **團隊或隊長變了**（審查 S1）：團隊被刪（REST `teamsDelete`）、團隊成員被改（`teamMembersPut`／`teamMembersDelete`，隊長不再是 `lead`）、隊長被封存或結束時，hub 重新檢查（`StaffRequestEngine.revalidate`），這一隊待處理的申請直接 `failed`（`team_deleted`／`not_lead`／`lead_inactive`），告訴隊長「was withdrawn because …」，不用等 30 分鐘。沒經過這些路的變動（例如直接改資料庫），同意時的 `team_changed` 檢查兜底。
- **同意途中 hub 掛掉**（審查 W2）：重啟時還是 `approving` 的一律 `failed`／`interrupted`，告訴隊長「Agent Board restarted while starting it, so it may not have been started. Check list_members before asking again.」，**不自動重試**（避免開兩位）。`approving` 也算「同一隊待處理」，擋新申請。
- **失效**：`expiresAt`（申請時間＋30 分鐘，`STAFF_REQUEST_TTL_MS`；hub `Timing.staffRequestTtlMs` 測試縮短）到了還沒處理 → `expired`，告訴隊長。到期後或已處理後才按同意／拒絕 → 409 `request_decided`（紀錄已刪也一樣回 409，網頁顯示「已經處理過」）。
- **同意後的動態**：開好的成員和一般 `spawn_member` 一樣會記一筆團隊動態 `member_added`（推播設定開著時也會有一則「新增了成員」推播），另外加開申請的動態記一筆 `staff_approved`，所以收件匣會看到兩筆。

### 23.2 給隊長的字

- `spawn_member` 回 `ok: true`、JSON：`{ status: "pending_approval", requestId, limit: "team_full"|"spawn_rate", team, role, reason, teamSize: "12/12", expiresAt, result }`。`result` 先說是哪道上限，接著是固定的 `STAFF_REQUEST_PENDING_GUIDE`：已向使用者申請、什麼都還沒開；結果會在這回合結束後以 `[Agent Board] …` 送進來，**現在就結束回合，不要 sleep、輪詢或為了等而繼續工作**（不說「wait」：§22.4 真 Codex 實測說 wait 會在回合裡 clocksleep 互等）；同意後照這次呼叫的參數開；30 分鐘沒處理失效；這段時間可以繼續用現有成員。
- `request_pending: A request to add a member (<role>) is already waiting for the user (request <id>); this call was not sent. Do not ask again: end your turn. …`
- `list_members`／`get_progress` 的 `staffing` 有待處理申請時多一欄 `pendingRequest: { id, role, limit, expiresAt, note }`；這一隊處理過申請後多一欄 `lastDecision: { requestId, at, role, result: approved|rejected|expired|failed, code?, memberName? }`（`StaffLastDecision`，固定欄位，不含 prompt、理由；settings 表 `staffLastDecision:<teamId>`，每隊只留最後一次）。結果通知沒送到時，隊長從這裡查得到。
- 結果通知一律走 SafeDelivery（只在隊長 `waiting_input` 時送、文字和 Enter 分開、全部暫停時排隊），key `staff-request:<id>`，一行、開頭固定 `[Agent Board]`（不會以 `/`、`!` 開頭），內容是固定英文加名稱與代碼，**不帶 prompt**：
  - 同意且開好：`[Agent Board] The user approved your request to add a member (over the team size limit|too many members added in 10 minutes). <成員> (<role>) has been started with your prompt; its result comes back to you as "[Result from <成員>] …" when it finishes its turn.`
  - 同意但開不起來：`[Agent Board] The user approved your request to add a <role> member, but it could not be started: <代碼>: <原因（固定英文，300 字截斷）>`
  - 拒絕：`[Agent Board] The user rejected your request to add a <role> member. Nothing was started. Continue with your current members (send_task) or do the work yourself.`
  - 失效：`[Agent Board] Your request to add a <role> member expired: the user did not answer within 30 minutes. Nothing was started. …`
  - 團隊或隊長變了：`[Agent Board] Your request to add a <role> member was withdrawn because the team was deleted|you were archived or ended|you are no longer the lead of that team. Nothing was started.`
  - hub 中途重啟：見 23.1。
- 通知打進去、按 Enter 前隊長不再等輸入（SafeDelivery 的 `aborted`）時**不重送**（和交接、任務一致：重送會在輸入框疊出兩份、甚至把使用者自己打的字一起送出），紀錄結案（audit `staff_request.notice_dropped`、reason `target_busy`）。隊長可從 `staffing.lastDecision` 查到結果。
- 守則（`protocol/src/leadGuide.ts`）：`LEAD_STAFFING_RHYTHM` 多一段「上限與申請」、`TEAM_FULL_GUIDE` 說滿了再開會變成申請、`spawn_member` 工具說明改寫。

### 23.3 資料與 API

- 型別（`protocol/src/models.ts`）：`StaffRequest { id, at, expiresAt, teamId, teamName, leadSessionId, leadName, limit, limits, teamSize, teamLimit, role, name?, agent?, permissionMode?, useWorktree?, model?, reason, promptPreview, promptChars, status: pending|approving|approved|rejected|expired|failed, decidedAt?, decidedBy?, memberSessionId?, memberName?, error? }`。`promptPreview` 是 prompt 的一行、前 300 字（`STAFF_PROMPT_PREVIEW_MAX`），`promptChars` 是全文字數；全文用 `StaffRequestDetail`（多 `prompt`）。
- 持久化：**不升 schema（仍是 v11）**。settings 表 `staffRequest:<id>`，值是 `StaffRequest` 加 `args`（完整 spawn 參數）、`notice`（還沒送到的通知）。待處理的一直留著；處理後（同意／拒絕／失效／失敗）留到通知送到隊長（或隊長已結束、通知被丟掉）就刪。hub 啟動時（`StaffRequestEngine.restore`）：`at` 超過 24 小時的直接刪、不通知；待處理的重排失效計時器（已過期的馬上失效）；`approving` 的標 `interrupted`（見 23.1）；已處理但通知還沒送到的重新排進送字佇列；最後再跑一次 `revalidate`（關機期間團隊沒了、隊長被封存的待處理申請也撤回）。讀不懂的列略過；54cb33d 留下、沒有 `promptChars` 的紀錄當 0。`getSettings` 不讀 `staffRequest:*`、`staffLastDecision:*` 與 `staffActivity`（不會每次讀設定都 parse 長 prompt）。
- REST（`protocol/src/rest.ts`）：
  - `GET /api/staff-requests`（user）：待處理的，舊的在前。
  - `GET /api/staff-requests/:id`（owner）：`StaffRequestDetail`，含 prompt 全文；紀錄已刪 → 404。
  - `POST /api/staff-requests/:id/approve`（owner）：同意並開；回處理後的 `StaffRequest`（`approved` 或 `failed`＋`error`）。
  - `POST /api/staff-requests/:id/reject`（owner）：拒絕；回 `rejected` 的 `StaffRequest`。
  - 同意／拒絕：已處理、已到期、或紀錄已刪（處理完、通知送到後就刪）→ 409 `request_decided`。
  - `POST /api/staff-activity/read`、`/clear`（user，body `{ ids? }`）：加開申請的動態標已讀／清除，回整份新清單。
- WebSocket：`board.state.staffRequests`（待處理的）與 `board.state.staffActivity`（加開申請的動態，新的在前）；舊版 hub 不送＝空。變了推 `{ type: 'staff.requests', items }`、`{ type: 'staff.activity', items }`（整份）。
- **加開申請的動態和團隊動態分開存**（審查 W1）：`StaffActivity { id, at, kind: staff_requested|staff_approved|staff_rejected|staff_expired|staff_failed, staffRequestId, teamId, teamName, leadSessionId, leadName, role, limit, reason, memberSessionId?, memberName?, error?, read }`，存在 settings 表 `staffActivity`（最多 100 筆，`STAFF_ACTIVITY_KEEP`）。`TeamActivity` 的格式和 0.1.8 完全一樣（成員欄位必填、只有原本三種）。網頁把兩份依時間合在一起顯示，標已讀／清除各自送回原本那份。
- **退回舊版的相容性**（審查 W1，2026-11-13 用 `dec9f93` 的 protocol 實際檢查過）：舊版 `HubToClient` 的 `board.state` 沒有 `.strict()`，zod 預設把不認得的 `staffRequests`、`staffActivity` 丟掉，快照照常解析；舊版收到 `staff.requests`／`staff.activity` 這兩種 WS 訊息時 `safeParse` 失敗、直接略過（舊版 `hubBackend.ts` 只處理解析成功的）；`teamActivity` 仍是舊格式，舊版 hub 讀得懂。舊版 `getSettings` 會讀到 `staffRequest:*`／`staffActivity` 列但會被 `Settings` schema 濾掉。新版 `listTeamActivity` 改成逐筆 `safeParse`，將來再加種類時讀不懂的那一筆略過、其他照常。
- audit（全部 `session_id` 是隊長）：`staff_request.created`（user null；detail：requestId、teamId、limit、limits、role、reason、teamSize、teamLimit）、`staff_request.approved`（GM；memberSessionId、memberName）、`staff_request.rejected`（GM）、`staff_request.expired`（user null）、`staff_request.failed`（GM；code）（失敗也可能是 user null：`team_deleted`、`not_lead`、`lead_inactive`、`interrupted`；同意後收尾（audit、動態、存檔、排通知）丟例外時標 `finalize_failed`，紀錄存成 `failed`，不會卡在 `approving`，REST 回 500）、`staff_request.notice_delivered`／`staff_request.notice_dropped`（通知送到／沒送到）、`staff_activity.read`／`staff_activity.clear`。開好的成員另有原本的 `dispatch.spawn`。
- 推播（只有新申請，不併進合併通知、不看 `autoStaff.push`，看一般的推播開關與勿擾時段）：`{ kind: 'staff_request', requestId, lead, limit, at }`。`sw.js` 顯示固定文字「加開申請／<隊長> 請求加開成員（超過人數上限）」或「（10 分鐘內新增太多）」，英文「Member request／<lead> asks to add a member (…)」，點了開收件匣；**不帶理由、prompt**（同 §11.7 推播不帶 Claude 寫的字）。同意、拒絕、失效不推播。

### 23.4 網頁

- 收件匣（桌面抽屜 `InboxBoard`、手機 `InboxPage`）在交叉審查與團隊動態上面多一區「加開申請」（`flows/StaffRequests.tsx`，`data-testid="staff-requests"`），沒有待處理時不顯示。每件顯示：隊長、角色、上限種類、團隊、目前人數／上限、理由、指定名稱、prompt 摘要與「共 N 字」、失效時間；摘要比全文短時 owner 有「展開全文」（讀 `GET /api/staff-requests/:id`；按鈕加 `.touch`，手機 ≥ 44px）、再按「收合」。理由、prompt、隊長名稱、團隊名稱、指定名稱都經遮蔽模式（`useMaskText`）。
- 「同意並開成員」（`.primary.act`）與「拒絕」（`.act`）只有 owner 看得到（不是 owner 顯示「只有擁有者能同意或拒絕」）。桌面標準 36px，手機 `.act` 56px（STYLE §5.1）。按下後顯示結果（已開好 <名稱>／開不起來（代碼）／已拒絕）；hub 回 409 `request_decided` 時顯示「這件申請已經處理過（或已失效）」。
- 團隊動態區把 `teamActivity` 與 `staffActivity` 合在一起列（五種 staff 事件）；`staff_approved` 在桌面有「在畫布上看」。

### 23.5 不呼叫模型

- 申請、同意、拒絕、失效全是固定規則；送給隊長的是固定英文＋名稱與代碼（不帶 Claude 寫的 prompt），走既有的 SafeDelivery（`docs/no-llm-review.md` 送字來源表多一列「加開申請結果通知」）。同意後開成員走 `spawn_member` 原本的路（第一個指令是隊長申請時寫的 `[From <隊長>] <prompt>`），觸發者是 GM 在網頁按「同意」。

## 24. 不是 git 的資料夾：一鍵 git init 與團隊共用資料夾（GM 2026-11-13）

在不是 git repo 的資料夾建團隊時，BD（會改檔案）開不了 worktree，又不能和 LD 共用資料夾（同一個資料夾只能有一位會改檔案的成員），整隊建不起來；隊長 `spawn_member` 開 worker／tester 也被擋。GM 決定兩條路都給：**一鍵 git init（建議）**與**使用者自己勾選的共用資料夾**。既有團隊（補成員、隊長正在跑）也適用。

### 24.1 一鍵 git init

- **誰能按**：只有 owner（REST `auth: 'owner'`）。網頁在「不是 git」時顯示「在這裡 git init」（`flows/GitInit.tsx`，`.touch`，手機 ≥ 44px）：新增團隊、補成員（含沿用隊長位置的 fixed 模式）、套用 Preset 換位置、新增 session 的 worktree 提示底下。按下先展開確認區，列出會做的事（init 分支 main、沒有 `.gitignore` 才建、第一個 commit 與大檔上限、身分只對這次、只在本機不設 remote 不 push、正在這個資料夾的 session 不中斷、成員的 worktree 只有 commit 進去的檔案——`.env`、`node_modules`、略過的大檔不會在裡面），再按「確認 git init」才送；「取消」收起。非 owner 顯示「只有擁有者能在這裡 git init」；還沒讀到使用者資料前什麼都不顯示。
- **API**：`POST /api/machines/:id/git-init`，body `{ path }`（去頭尾空白、1–4096 字），回 `GitInitResult`（`protocol/src/gitInit.ts`）。拒絕也是 200、`ok: false`＋`code`。daemon 太舊（hello `features` 沒有 `fs.gitInit`）→ 409 `daemon_too_old`，**不送出**（網頁顯示「<機器> 的 daemon 太舊，請先更新。」，不會卡到逾時）；機器離線 409 `machine_offline`；hub 等 11 分鐘（`Timing.gitInitTimeoutMs`）沒回 → 504 `daemon_timeout`。
- **協定**：hub → daemon `{ type: 'fs.gitInit', requestId, path }`；daemon → hub `{ type: 'fs.gitInitResult', requestId, result }`；`DAEMON_FEATURES.gitInit = 'fs.gitInit'`。hub 只對宣告了旗標的 daemon 送。不升協定版本。
- **daemon 的步驟**（`daemon/src/gitInit.ts`；所有 git 都走 `worktree.ts` 的 `git()`：參數陣列、不經 shell、`GIT_TERMINAL_PROMPT=0`、環境變數拿掉 `GIT_DIR`／`GIT_WORK_TREE`／`GIT_INDEX_FILE`（審查 N6，所有 daemon 的 git 都適用），Windows 不必處理引號。**不跑任何 hook**（審查 W1）：init 之後的每個指令都帶 `-c core.hooksPath=<dir>/.git/agent-board-no-hooks`（不存在的資料夾，蓋過使用者全域的 `core.hooksPath`；post-commit、reference-transaction 等都不跑）與 `-c core.fsmonitor=false`，`git init` 帶 `--template=`（不複製 `init.templateDir` 範本，範本裡可能有 hook）；這些 `-c` 只對單次指令，不寫進 repo 設定）：
  1. `~`／`~/` 展開成家目錄（家目錄一律是 **daemon 執行帳號**的 `os.homedir()`，暫存資料夾是它的 `os.tmpdir()`）；不是絕對路徑 → `not_absolute`。不存在 → `not_found`；不是資料夾 → `not_directory`。之後一律用 realpath。路徑中有任一段是 `.git` → `already_repo`（審查 W2）。
  2. **太大的位置 → `too_broad`**（比對時 Windows、macOS 不分大小寫）：檔案系統根目錄（`/`、`C:\`）；家目錄本身與它的任何上層（例如 `/Users`、`/home`）；家目錄底下的 `Desktop`、`Documents`、`Downloads`、`Library`、`Pictures`、`Music`、`Movies`、`Videos`、`Public`、`Applications`、`AppData`、`OneDrive` 本身（子資料夾可以）；家目錄底下以 `.` 開頭的資料夾與它裡面（`~/.config/…`，審查 N5）；iCloud Drive 根目錄 `~/Library/Mobile Documents/com~apple~CloudDocs`、`~/Library/CloudStorage` 與它底下每個雲端硬碟的根目錄（`~/Library/CloudStorage/*`，裡面的專案資料夾可以）；**磁碟或網路碟的根目錄**（POSIX：資料夾和上層的 `stat().dev` 不同＝掛載點，GM 決定，審查 W5；裡面的專案資料夾照常可以；Windows 磁碟機根目錄照上面擋）；系統資料夾本身（`/bin`、`/boot`、`/dev`、`/etc`、`/home`、`/lib`、`/lib64`、`/media`、`/mnt`、`/opt`、`/proc`、`/root`、`/run`、`/sbin`、`/srv`、`/sys`、`/tmp`、`/usr`、`/usr/local`、`/var`、`/Applications`、`/Library`、`/System`、`/Users`、`/Volumes`、`/private`、`/private/etc`、`/private/tmp`、`/private/var`；Windows 任一磁碟機的 `Windows`、`Program Files`、`Program Files (x86)`、`ProgramData`、`Users`）；作業系統暫存資料夾本身。
  3. 同一個資料夾同時只做一次（key 用比對用的正規化路徑，macOS／Windows 不分大小寫；第二個回 `busy`，網頁「已經有一次 git init 正在進行，這次沒有做任何事」，審查 W3／N1）。`git --version` 找不到 git（ENOENT）→ `git_missing`。
  4. **已經是 repo → `already_repo`**：`git -C <dir> rev-parse --absolute-git-dir` 成功（上層是 repo 也算）。失敗時只有 stderr 含 `not a git repository` 才繼續；其他失敗（dubious ownership、設定檔壞掉、權限…）一律 `git_failed`，不 init（審查 W2，避免在別人的 repo 裡 init 出巢狀 repo）。接著先自己 `mkdir .git`（不遞迴）：已經存在（EEXIST，含別人剛好同時建）→ `already_repo`、不刪它；建成了才算「這次建的」（審查 W3）。不動任何東西。
  5. 沒有 `.gitignore`（含連結）才建（`wx`，不覆寫），內容是 `DEFAULT_GITIGNORE_LINES`：註解一行、`node_modules/`、`dist/`、`build/`、`.venv/`、`venv/`、`__pycache__/`、`*.pyc`、`.terraform/`、`*.tfstate`、`*.tfstate.*`、`.env`、`.env.*`、`!.env.example`、`.npmrc`、`.pypirc`、`.netrc`、`.git-credentials`、`.aws/`、`.ssh/`、`.gnupg/`、`credentials.json`、`service-account*.json`、`client_secret*.json`、`token.json`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`*.keystore`、`*.ppk`、`*.kdbx`、`id_rsa*`、`id_ed25519*`、`id_ecdsa*`、`.DS_Store`、`Thumbs.db`（審查 W4）。已有就完全不動。
  6. `git init -q --template=`（在剛建的空 `.git` 裡），再 `git symbolic-ref HEAD refs/heads/main`（舊版 git 沒有 `init -b` 也能用）。
  7. **大檔**：`git ls-files -z --others --exclude-standard` 列出要收的檔案，單一檔案（`lstat`，一般檔案）超過 `GIT_INIT_MAX_FILE_BYTES` = 50 MB 的寫進 `.git/info/exclude`（`/` 開頭；萬用字元與 `#`、`!`、結尾空白跳脫；超過上限的檔案名稱有換行、寫不進排除清單時**整次失敗並還原**，不會回報略過卻 commit 進去，審查 W7），只在這台、不改 `.gitignore`，之後 `git add -A` 也不會收。另外一律把 `.claude/settings.local.json`（Agent Board 的 hook 設定，含本機路徑）寫進 exclude。回報最多列 50 個（`GIT_INIT_SKIPPED_LIST_MAX`，由大到小），其餘算 `skippedMore`。
  8. `git add -A`。`git config user.name`／`user.email` 有一個沒設定 → 這次 commit 加 `-c user.name=Agent Board -c user.email=agent-board@localhost`（**只對這一次指令，不寫任何 git 設定檔**）。commit 一律帶 `-c commit.gpgsign=false`、`--no-verify`（不簽章；hook 已由上面的 `core.hooksPath` 全部擋掉）、`--allow-empty`（空資料夾也要有第一個 commit，`worktree add` 才能開），訊息固定 `Agent Board：初始 commit`。add／commit／列檔每步上限 5 分鐘。
  9. **只在本機**：不設 remote、不 push、不 fetch。
  10. 自己建了 `.git` 之後、commit 成功之前任何一步失敗（含逾時被殺）→ 刪掉這次建的 `.git` 與 `.gitignore`（使用者的檔案沒被動過），回 `git_failed`（git 的 stderr，截 500 字）。commit 成功之後不再還原：之後讀 commit hash、數檔案失敗就回空字串／0（審查 N2）。
- **結果**：`{ ok: true, path, branch: 'main', commit, gitignoreCreated, identity: 'user'|'fallback', files, skipped: [{ path, bytes }], skippedMore }`。網頁顯示幾個檔案進了第一個 commit、commit 前 7 碼、有沒有建 `.gitignore`、是否用了固定身分、略過的大檔清單；接著重新問 daemon 這個資料夾是不是 git（`useWorktreeAdvice().recheck`），BD 那一列改成「自己的 worktree」，共用勾選消失。
- **正在這個資料夾跑的 session 不中斷**：daemon 成功後，把 `sessionDirs`（realpath）在這個資料夾（或子資料夾）裡、沒有自己 worktree 的活 session 重新算 `repoInfo`／`currentBranch`，呼叫 `ManagedSession.updateRepo` 換上新的 `repoRoot`／`repoCommonDir`／`branch` 並立刻送 `session.runtime`（PTY 不動），也寫回本機 `sessions.json` 的 branch。hub 照一般的 runtime 更新 session（hub 沒有另外快取 git 狀態），所以隊長**不用重開**，下一次 `spawn_member` 開 worker 就會開 worktree。init 進行中才登記的 session（開 session 時已算成「不是 git」）：成功後 2 秒再補掃一次（只更新還是 `repoRoot` null 的，審查 N7）。daemon 重啟接回時本來就重算 `repoInfo`。
- **audit** `fs.git_init`（`session_id` null）：`{ machineId, path, ok, commit?, files?, gitignoreCreated?, identity?, skipped?（數量）, code? }`；hub 已回 504 之後才到的結果也記（user null、`late: true`）。

### 24.2 團隊「共用資料夾」

- **資料**：`Team.sharedWriters?: boolean`，存在 settings 表 `teamSharedWriters:<teamId>`（值 `true`，**不升 schema**，同 `teamHold:`）；關掉＝刪列；刪團隊（`store.deleteTeam`）時一起刪。hub 回傳時只有開著才帶 `sharedWriters: true`。`POST /api/teams`、`PATCH /api/teams/:id` 可以帶（`upsertTeam` 只在有帶時改），開關都記 audit `team.shared_writers` `{ teamId, on }`。**開和關都只有 owner**（GM 決定，審查 W6）：帶了 `sharedWriters`（true 或 false）的非 owner 一律 403 `forbidden`；不帶照常。
- **規則**（開著時，而且**只在不是 git 的資料夾生效**，審查 N10）：
  - `PUT /api/teams/:id/members/:sessionId`：要加入的 session `repoRoot` 為 null 時不檢查同資料夾寫入者衝突（`worktreeConflicts`）；git 資料夾照常擋。
  - 隊長 `spawn_member`：呼叫者 `repoRoot` 為 null 時，會改檔案的角色 `useWorktree` 預設 false、和別人共用主資料夾，不檢查 `writerClash`。git 資料夾照舊預設開 worktree，明說 `useWorktree: false` 也照常檢查衝突。明說 `useWorktree: true` 但不是 git → `worktree_unavailable`（請改 false）。
  - git 資料夾的團隊設了 `sharedWriters`：API **採忽略**——設定照存（團隊不綁定資料夾，hub 判斷不了），但在 git 資料夾不生效。
- **沒勾的團隊**（或還沒有團隊）在不是 git 的資料夾開會改檔案的成員：`worktree_unavailable: <cwd> is not a git repository … ` 或 `worktree_required: Same folder as <名稱>. `，後面接固定的 `NOT_GIT_WRITER_GUIDE`（`protocol/src/leadGuide.ts`）：請使用者在面板按「git init」，或允許這一隊共用資料夾；在那之前用 researcher／reviewer 或自己做；最後一句是中文「（請使用者在面板按「git init」，或允許這一隊共用資料夾。）」讓隊長原樣轉述。MCP `spawn_member` 的 `useWorktree` 說明補上共用資料夾的預設。
- **網頁**：
  - 新增團隊、補成員、套用 Preset 換位置（`PlaceFields allowShared`）在「不是 git」時，提醒改成「建議在這裡 git init；或勾選下面讓 BD 和 LD 共用資料夾」，下面是 git init 按鈕與勾選「我知道風險：讓 BD 和 LD 共用這個資料夾（可能互相覆蓋修改）」——勾選只給 owner（還沒讀到使用者資料前不顯示），一般成員看到「只有擁有者能設定共用資料夾」。勾了之後 `validatePlan(..., sharedOk)` 不再擋「主資料夾只能有一位會改檔案的」，會改檔案的列標「主資料夾（共用）」，BD 不開 worktree。新增團隊／套用 Preset 隨 `createTeam` 帶 `sharedWriters: true`；補成員時先 `updateTeam(id, { sharedWriters: true })` 再開人；這次才開、結果一位都沒加進去時改回關（審查 N8）。換到 git 資料夾後勾選失效（不會無故把團隊設成共用）。
  - 既有團隊已是共用資料夾：補成員不再給勾，顯示「這一隊已設定共用資料夾」。
  - 團隊面板（工作台）顯示「共用資料夾」說明；owner 有「關掉共用資料夾」（按兩下確認，第二下的文字寫明「已在跑的成員不受影響，之後新增會改檔案的成員會被擋」），非 owner 看到「只有擁有者能關掉」。開啟的地方只有建立團隊／補成員的勾選。
  - 畫布團隊框標籤後面加「· 共用資料夾」（`.team-shared`，滑過有說明）。

### 24.3 不呼叫模型

- git init 是 GM 在網頁按確認後 daemon 跑固定的 git 指令（同一個審查過的 `worktree.ts` 呼叫點，`check:no-llm` 的 `CALL_SITES` 不變），不送任何字進 PTY。給隊長的指引是固定文字，只出現在工具回傳裡（Claude 呼叫才看到）。

### 24.4 測試與未驗證

- daemon `gitInit.test.ts`（暫存資料夾、測完刪；`GIT_CONFIG_GLOBAL` 指到空檔、`GIT_CONFIG_NOSYSTEM`、`GIT_CEILING_DIRECTORIES`，不碰使用者的 git 設定）：成功、`.gitignore` 不覆寫、身分只對單次、大檔略過、空資料夾、`~/`、各拒絕情況；`daemon.test.ts`：hello 宣告、init 後同資料夾 session 不中斷且回報新的 repo。hub `nongit.test.ts`：轉送與 audit、owner 限定、舊 daemon 409、逾時後的 late audit、共用設定存取／刪團隊清除、加成員不擋；`dispatch.test.ts`：非共用隊的固定指引、共用隊 BD 不開 worktree、git init 後隊長不用重開就開 worktree。web：`teamPlan.test.ts`、`canvas/teams.test.ts`；e2e `team.spec.ts`（新增團隊 git init／太大的位置／daemon 太舊、新增團隊勾共用與團隊面板關掉、既有團隊補成員兩條路）、`flows.spec.ts`（新增 session 的 git init）、`team-integration.spec.ts`（真 daemon、真 git：隊長被擋 → 補成員按 git init → 隊長不重開 `spawn_member` 開到 worktree）。
- 獨立審查後（2026-11-13）補：hook 不跑（全域 hooksPath＋範本）、`.git` 裡的路徑、git 判斷失敗不 init、已有空 `.git` 不刪、同時兩次 `busy`、大檔名有換行整次還原、掛載點／隱藏資料夾／iCloud、`gitEnv`（daemon）；非 owner 403、git 資料夾不生效（hub）；非 owner 看不到按鈕與勾選、補成員全失敗還原（e2e）。
- 未驗證：Windows 實機（`gitInit.test.ts` 已列進 `test:windows`，只在 macOS 跑過；hook 測試在 Windows 上靠 Git for Windows 的 sh）；非常大的資料夾（上萬檔）的實際耗時；N7 的 2 秒補掃沒有獨立的單元測試（`daemon.test.ts` 測的是第一次掃）。

### 24.5 session 卡片上的 git init（GM 2026-11-14）

還沒有團隊、之後要自己當隊長的 session 在不是 git 的資料夾 `spawn_member` 開會改檔案的成員會被擋（固定指引叫使用者按 git init），但這時沒有團隊可勾共用，git init 按鈕又只在新增 session 等頁面。改成每個 session 自己就有入口。

- **顯示條件**（`flows/gitInitState.ts` 的 `needsGitInit`）：沒封存、`repoRoot === null`、`worktreePath === null`（不是自己的 worktree）、狀態不是 `offline`／`done`（daemon 只替活的 session 換 repo，失聯或已結束的提示消不掉，所以不顯示），也不是 `starting`／`queued`（審查 N6：hub 建 session 時先填 `repoRoot: null`，daemon 回報 runtime 前這個 null 是「還不知道」；daemon 在開 PTY 之前就算好 repo，隨 `session.created` 一起送）。
- **畫布卡片**：標題下 `.sign` 那一行多一個「不是 git」晶片（`.chip.not-git`，`NotGitChip`）——是說明不是按鈕，不加觸控高度、卡片不變高；畫布縮到 30% 以下跟著 `.sign` 一起藏起來。所有人都看得到。git init 在卡片「⋯」選單的「在這裡 git init…」（`card-git-init`，**只有 owner**，還沒讀到使用者資料前不顯示），打開置中次畫面 `#/git-init/<sessionId>`（`ModalKind` `gitInit`，`flows/SessionGitInit.tsx` 的 `GitInitPage`；手機是全螢幕頁），一打開就是確認步驟（`GitInitAction startOpen`），路徑是 session 的 `cwd`；確認內容、結果、略過的大檔、daemon 太舊「請先更新」都和 §24.1 同一個元件。非 owner 直接開網址只看到「只有擁有者能在這裡 git init」；已經不需要時顯示一句說明。
- **全尺寸頁**（`#/terminal/<id>`）：標題下同一個晶片；側欄最上面「這個資料夾不是 git」區塊（`SessionGitInitPanel`，只有 owner），先按「在這裡 git init」再確認。側欄按鈕在手機／觸控照 `.touch` 回到 44px。
- **送出中與結果**（審查 N7）：`GitInitAction` 在已經是 git（`notGit` false）時，只有還沒開始或只在確認步驟才不顯示；送出中（busy）與有結果時照常顯示到使用者離開，不再給「在這裡 git init」按鈕。新的 `repoRoot` 比 API 回應早到時不會空白。
- **成功後**：不另外重新偵測——daemon 照 §24.1 讓這個 session 換上新的 `repoRoot` 並送 `session.runtime`，hub 推給網頁，晶片與選單項目自己消失，不用重整。次畫面／側欄按過確認後留著結果（標題改「已 git init」）；新的 `repoRoot` 比 API 回應早到也不會把結果卸掉（`GitInitAction onStart`）。
- **團隊已勾共用資料夾**：照樣顯示 git init，多一句「共用只在不是 git 的資料夾生效：git init 之後，新開的會改檔案成員改用各自的 worktree；已在跑的成員不受影響」。
- **隊長被擋的提示**：hub 在 `spawn_member` 回 `NOT_GIT_WRITER_GUIDE` 的兩條路（`worktree_unavailable`、不是 git 時的 `worktree_required`）上，audit `dispatch.blocked` `{ fromSessionId, tool: 'spawn_member', reason: 'not_git' }`，並在呼叫者記事件 `dispatch.not_git`（`NOT_GIT_BLOCKED_EVENT`），payload 固定 `{ tool: 'spawn_member' }`，不帶任何模型寫的字。**同一個 session 60 秒內只記一筆**（`NOT_GIT_RECORD_MS`，審查 N5；指引每次照回，只是不重複記事件與 audit；記憶體裡的時間表，hub 重啟清空）。唯讀角色或共用隊收到的「Set useWorktree: false」不算。hub 端的 `repoRoot === null` 一律當「不是 git」：呼叫 `spawn_member` 的 session 一定已經回報過 runtime（daemon 開 PTY 前就算好 repo），所以不會有「還沒回報」的情況；但 daemon 的 `repoInfo` 在 git 指令失敗（找不到 git、git < 2.31 不支援 `--path-format`、dubious ownership 等）時也回 null，hub 分不出來——要分得做 daemon 協定（例如回報 repo 狀態三種值），這版沒做。網頁（畫布、全尺寸頁開著時）收到後把那張卡的晶片改成「開成員被擋：不是 git」（`.chip.not-git.blocked`，等你的琥珀色），git init 區塊也多一句說明。**只認頁面開著時收到的事件**：重新整理後回到一般的「不是 git」（事件存在資料庫，但網頁開機不回讀）。事件沒有 `toSessionId`，畫布的往來動畫不畫它。
- **沒做**：收件匣項目與推播（現有的團隊動態要有團隊，這個情況多半還沒有團隊；要做得新增一種收件匣項目，另案）。
- **不呼叫模型**：同 §24.3；新增的只有固定文字與固定事件。
- **測試**：hub `dispatch.test.ts`（兩條路都記事件與 audit、還沒有團隊的 session 也記、唯讀角色不記、60 秒內只記一筆／過了再記／各 session 分開算）；web `gitInitState.test.ts`、`overlay.test.ts`；e2e `canvas.spec.ts`「session 卡片上的 git init」（git 資料夾／worktree／失聯不顯示、被擋提示、⋯ 次畫面確認後晶片消失、非 owner 沒有按鈕、全尺寸頁側欄、共用隊說明、縮小時藏起來、starting／queued 不顯示、repoRoot 先到時送出中不空白）；`team-integration.spec.ts`（真 daemon、真 git：沒有團隊的 session 開 BD 被擋 → 全尺寸頁提示 → git init → 晶片消失、不重開就開到 worktree）。假後端：`s-docs` 是不是 git 的 session，`s-etl`、`s-ml` 改成 git。截圖 `docs/card-gitinit/`。
- **未驗證**：真 claude 收到固定指引後的實際反應（沒跑真 CLI）；手機實機上的次畫面；網頁重新整理後被擋提示不保留（設計如此）。
