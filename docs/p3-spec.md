# P3 規格：進度卡與 Memory、Presets、全域搜尋（三項）

> 2026-11-08 撰寫，給派工用。來源：派工單（改進計畫與派工單）§8 P3、§1 原則（價值看推進了多少正事，不看功能數）；`docs/p2-spec.md`（格式）、`docs/design/STYLE.md`、`docs/CONTRACTS-summary.md`／`CONTRACTS.md` §2、§11–§13、`docs/no-llm-review.md`，以及 `main` 現有程式（P2 已上架，schema v9；下文的檔案路徑都以 `packages/` 為起點）。
> 狀態：**草稿，含「待 GM 決定」問題**（見 §7，只有 2 題；其餘用預設值決定，列在 §7.2，GM 不回就照做）。
> 範圍只有三項：①畫布進度卡＋Memory ②團隊 Presets ③全域搜尋。底部指令列的 Presets、Memory 按鈕隨 ①、② 上線時加上。

---

## 0. 現況（動工前要知道的事實）

| 主題              | 現況                                                                                                                                                                                                                                                                                                                                                               | 位置                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 便利貼            | `notes` 表（id、zone_id、x、y、text、color）與 REST `/api/notes` CRUD 都在，前端只有 `getNotes(zoneId)`，**畫布沒有顯示便利貼**（`backend.ts` 註解寫明）。沒有和團隊或 session 關聯的欄位                                                                                                                                                                          | `hub/src/db.ts`、`hub/src/store.ts`、`protocol/src/rest.ts`、`web/src/shared/backend.ts` |
| 團隊文字欄位      | `teams.goal`、`done_criteria`、`context_md`（畫面叫 TEAM.md／context）、`phase`（研究階段）。`contextMd` **不會自動送進任何 session**，只有 GM 按「請隊長拆解」時帶進固定提示                                                                                                                                                                                      | `team/TeamWorkbench.tsx`、`team/decompose.ts`、`team/NewTeamForm.tsx`                    |
| 團隊快速建立      | `NewTeamForm` 選內建組合（`teamPlan.ts` 的 `PRESETS`：squad、standard、explore；研究團隊 `PHASE_PRESETS`）→ 列（分工、名稱、權限模式）→ `runPlan.ts` **在瀏覽器端**逐列 `createSession`＋加入團隊，失敗的列記在進度裡、已建的保留。研究團隊可一起建「實驗 ⇄ 寫作」雙向交接                                                                                         | `web/src/team/teamPlan.ts`、`runPlan.ts`、`NewTeamForm.tsx`                              |
| 角色預設          | 權限：隊長 default、成員 acceptEdits、研究／審查 plan、測試 default；worker、tester 是 git 時開 worktree；研究、審查唯讀                                                                                                                                                                                                                                           | `teamPlan.ts` `ROLE_DEFAULT_MODE`、`rowUsesWorktree`                                     |
| 單一 session 範本 | `templates` 表（id、name、config JSON：machineId、cwd、permissionMode、model、firstPrompt、quotaGuards），設定頁有「範本」區、新增 session 頁可帶入。**只管單一 session，不含團隊**                                                                                                                                                                                | `protocol/src/models.ts` `TemplateConfig`、`flows/TemplatesSection.tsx`                  |
| MCP 工具          | `agent-board-mcp`（stdio）只有 4 個派工工具：`list_members`、`spawn_member`、`send_task`、`get_result`。`Settings.dispatch` 開著（預設開）時 daemon 開 PTY 一律帶 `--mcp-config` 與 `--allowedTools <四個工具>`（新開、接續、重啟接回都掛）。工具呼叫路徑：claude → MCP server → daemon 本機 socket（密鑰）→ hub `DispatchEngine`                                  | `hook/src/mcp.ts`、`daemon/src/mcpFiles.ts`、`hub/src/dispatch.ts`、CONTRACTS §11        |
| 往對話塞字的限制  | `no-llm-review.md`：hook **不得**回傳 `additionalContext`；送進 PTY 的字只能來自清單上的來源；`--allowedTools` 放寬到派工工具以外、hook 改用 prompt 型都會「打破保證」，必須重新審查並更新 `scripts/check-no-llm.mjs`                                                                                                                                              | `docs/no-llm-review.md`                                                                  |
| 終端機畫面        | daemon 每個**活著的** session 有一個 headless xterm（scrollback 5,000 行，只在記憶體）；session 結束或 daemon 重啟就沒了。hub **不存終端機資料**（CONTRACTS §2），只存 `sessions.last_lines`（最後 4 行純文字）                                                                                                                                                    | `daemon/src/session.ts` `SCROLLBACK_LINES`、`protocol` `Session.lastLines`               |
| 對話紀錄          | Claude Code 的 JSONL（`<CLAUDE_CONFIG_DIR>/projects/*/<claudeSessionId>.jsonl`），**存在開那個 session 的機器上**。daemon 已能逐行串流解析、子字串搜尋（比對截斷前全文，含工具呼叫參數）；同時只讀一份、20 秒 deadline。REST `GET /api/sessions/:id/transcript?q=`（auth user）一次只搜**一個** session；機器離線或檔案找不到回 `missing`                          | `daemon/src/transcript.ts`、`protocol/src/rest.ts` `sessionTranscript`                   |
| hub 存的可搜資料  | `session_events`：`hook` 事件（Stop 帶 `last_assistant_message` 前 8,000 字）、`file.changed`（**只有 Edit／Write／MultiEdit／NotebookEdit 的路徑**，Bash 改的檔案沒有）、`handoff.*`、`dispatch.*`、`task.*`。保留 30 天、最多 200 萬筆（`retention.ts`）。只有 `(session_id, at)` 索引。`audit_log` 有 GM 送出的 `terminal.input`（已遮蔽密碼提示）、保留 180 天 | `hub/src/store.ts`、`hub/src/retention.ts`、`hub/src/config.ts`                          |
| 遮蔽              | 遮蔽模式 `maskMode` 只在**瀏覽器端**（localStorage `agent-board.mask-mode`），`useMaskText()` 在顯示前過 `maskSecrets`；hub 另有 `redactSecrets`（寫 audit 時用）                                                                                                                                                                                                  | `web/src/security/maskMode.ts`、`mask.ts`、`hub/src/audit.ts`                            |
| 底部指令列        | `[＋ 新增 session] [群組] │ [⏸ 全部暫停 ▾] [▶ 全部繼續]`，註解寫「Presets、Memory 本輪不顯示（Q9）」。手機沒有底部列                                                                                                                                                                                                                                               | `web/src/views/pause.tsx` `CommandBar`                                                   |
| 右側面板          | 收件匣、團隊面板互斥；設定是置中模態（P2 項目一）                                                                                                                                                                                                                                                                                                                  | `web/src/views/`（overlay store）                                                        |
| Schema            | v9（zones）。升級前自動備份 `hub.db.bak-<時間>-v<舊版>`；新版資料庫舊 hub 拒絕啟動（`tooNewMessage`）                                                                                                                                                                                                                                                              | `hub/src/db.ts`                                                                          |
| 權限分工          | `protocol/`、`web/src/shared/`、`web/src/App.tsx` 只有 Lead 能改或須 Lead 審查（CONTRACTS §8）                                                                                                                                                                                                                                                                     | `CONTRACTS.md`                                                                           |

---

## 1. 項目一：畫布進度卡＋Memory

**目標：** 每個團隊（與單獨 session）有一張「進度卡」記錄目前狀態、下一步、阻礙；新開的 Claude、`/clear` 之後的 Claude 能自己讀到並寫回，GM 也能直接改。解決「CLI 進度帶不到下一次對話」。

### 1.1 使用者故事

- GM 隔天打開畫布，台股團隊框右上角的進度卡寫著「狀態：回測 2015–2020 完成，Sharpe 0.8｜下一步：補 2021–2024 資料｜阻礙：等 GM 決定手續費假設」，不用翻終端機就知道停在哪。
- 隊長 session 被 `/clear` 或重開後，GM 只說「繼續」，Claude 自己呼叫 `get_progress` 讀到卡片內容，接著做下一步；做完一段後呼叫 `update_progress` 把卡片更新。
- GM 在手機上看到卡片寫錯了下一步，直接改掉；隊長下次寫回時不會蓋掉 GM 剛改的那一欄。
- GM 在卡片上寫「GM 備註：手續費一律用 0.1425%」，agent 讀得到、改不了。
- GM 開了一個新 session 要接手舊工作，按卡片上的「帶入進度卡」，把卡片內容一次送進那個 session。
- GM 按底部列「Memory」，看到目前工作區每個團隊的卡片一覽，哪張三天沒更新一眼就知道。

### 1.2 名詞與卡片內容

- **進度卡**：屬於一個團隊，或一個**不屬於任何團隊**的單獨 session（§7.2-D1）。一個擁有者最多一張，第一次寫入時建立。
- 欄位（純文字＋簡單 Markdown，前端只渲染清單、粗體、行內 code，不渲染連結與圖片）：

| 欄位       | 中文名稱                        | 誰能寫      | 上限     |
| ---------- | ------------------------------- | ----------- | -------- |
| `status`   | 目前狀態                        | GM、agent   | 2,000 字 |
| `next`     | 下一步                          | GM、agent   | 2,000 字 |
| `blockers` | 阻礙／等 GM 決定                | GM、agent   | 2,000 字 |
| `gmNotes`  | GM 備註（固定規則、不要做的事） | **只有 GM** | 4,000 字 |

- **自動事實**（hub 從既有資料算，不存、不呼叫模型、不可編輯）：任務板「完成 x／總數 y」與進行中的任務標題；最近 24 小時改過的檔案（`file.changed`，最多 10 個，顯示相對 repo 的路徑）；研究階段（`phase`）；成員狀態代碼一列；卡片最後更新時間與更新者。
- 卡片有版本號 `revision`（每次寫入 +1）與最近 50 版的歷史。

### 1.3 Claude 怎麼讀到、怎麼寫回（核心設計）

**比較過的做法**

| 做法                                                                                                                    | 能不能做                                                                                    | 結論                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| hook 回傳 `additionalContext`（SessionStart 時把卡片塞進對話）                                                          | 技術可行，但 `no-llm-review.md` 明列為「打破保證」                                          | **不用**                                                  |
| daemon 把卡片寫成專案資料夾裡的檔案（例如被 CLAUDE.md 引用）                                                            | 會改使用者的 repo、要處理 git 與 worktree、多機器同步                                       | **不用**                                                  |
| hub 在 session 開好後自動送一段卡片內容                                                                                 | 屬於「沒有使用者動作就送字」，違反保證，也會花額度                                          | **不用**                                                  |
| **擴充既有 MCP server：加 `get_progress`、`update_progress` 兩個工具**，在 MCP 的 `instructions` 說明何時該讀、何時該寫 | 沿用派工的同一條路（daemon socket＋密鑰＋hub 判斷），跨機器自然可用；中控台不送任何字進 PTY | **採用（主要管道）**                                      |
| GM 手動按「帶入進度卡」，把卡片內容當一行字送進指定 session                                                             | 是 GM 的動作，和「請隊長拆解」同類                                                          | **採用（備援，給沒掛工具的 session 或 GM 想強制帶入時）** |
| 建立 session（含 Preset、新團隊）時，GM 勾選「第一個指令前附上進度卡」                                                  | 是 GM 填的第一個指令的一部分                                                                | **採用**                                                  |

**MCP 工具（加在 `agent-board` MCP server，工具全名 `mcp__agent-board__get_progress`／`update_progress`）**

- `get_progress`（參數：選填 `team`，名稱或 id）：回呼叫者所屬團隊的卡片——四個欄位、`revision`、更新時間與更新者，加上團隊的 `goal`、`doneCriteria`、`contextMd`（超過 8,000 字截斷並註明）、自動事實。呼叫者在多個團隊 → 沒給 `team` 時回全部（每張一段）。單獨 session → 回它自己的卡。還沒有卡 → 回空欄位＋`revision: 0`。
- `update_progress`（參數：`baseRevision` 必填；`status`、`next`、`blockers` 至少一個；選填 `team`）：
  - 只寫有帶的欄位；**不能寫 `gmNotes`**（帶了回 `invalid_arguments`）。
  - 每個欄位清控制字元、超過上限回 `invalid_arguments`（不默默截斷，讓 Claude 自己縮短）。
  - 衝突處理見 §1.4。
  - 頻率上限：同一張卡每個 session 每 10 分鐘最多 10 次寫入，超過回 `rate_limit`。
- 誰能寫（§7.2-D2）：團隊的**隊長**；團隊沒有隊長時任一成員；單獨 session 寫自己的卡。其他成員呼叫 → `not_lead`（說明「請回報給隊長，由隊長更新」）。所有成員都能讀。
- MCP `instructions` 加兩句（固定英文，跟現有 instructions 同一段）：「開始新工作、或對話被清空（/clear、compact）後，先用 get_progress 讀團隊進度卡；完成一個段落、或要停下來等使用者之前，用 update_progress 更新 status／next／blockers。gmNotes 是使用者的固定規則，必須遵守。」
- 錯誤代碼沿用 CONTRACTS §11.2 的格式 `<code>: <給 Claude 看的說明>`，新增：`memory_disabled`、`no_card_owner`（呼叫者被封存或不認得）、`not_lead`、`progress_conflict`、`card_locked`。

**掛載條件與設定**

- 新設定 `Settings.memory`（「讓 session 讀寫進度卡（MCP 工具）」），**預設開**（§7.2-D3）。理由同派工預設開：工具本身不花額度、不會自己動，是 Claude 呼叫才有作用。
- daemon 掛 MCP server 的條件從「`dispatch` 開」改成「`dispatch` 或 `memory` 開」；`--allowedTools` 只列**開著的功能**的工具全名（派工 4 個、進度卡 2 個），MCP `tools/list` 也只列這些（daemon 在 MCP 設定檔 env 放開著的工具清單，或同等做法）。
- 設定改了只影響之後開的 PTY（和派工一樣）；已掛著的，工具呼叫時 hub 回 `memory_disabled`。
- 舊版 daemon（`daemon.hello.features` 沒有新旗標）照舊只掛派工工具；hub 不需要知道每個 session 掛了什麼。

**對 no-llm 保證的影響（必須同版更新文件）**

- `--allowedTools` 從 4 個派工工具擴到 6 個 → `no-llm-review.md`「什麼會打破這個保證」那條要改寫成「放寬到 agent-board 工具以外」；`scripts/check-no-llm.mjs` 的檢查與 `CALL_SITES` 要更新；daemon 給 claude 的參數清單不變（仍是 `--mcp-config`、`--allowedTools`）。
- 新增一個送字來源：「帶入進度卡」（GM 按按鈕，內容是卡片欄位組成的一行）。寫進 §「送進 claude 的字從哪裡來」表格。
- 進度卡的寫入**不會**觸發任何送字（寫入不算交接、不算任務完成、不排進 `SafeDelivery`）。

### 1.4 衝突處理（GM 手改 vs agent 自動更新）

- 每次寫入都帶 `baseRevision`（讀到的版本號）。hub 在同一個交易內：
  1. `baseRevision == 目前 revision` → 直接寫，revision +1。
  2. 不相等 → **欄位層級三方比對**：找出 `baseRevision` 之後被別人改過的欄位。這次要寫的欄位**都沒有**被別人改過 → 合併寫入（別人改的欄位保留），回 `merged: true`。**有任何一個**要寫的欄位被別人改過 → 整筆拒絕，回 `progress_conflict`，附目前的完整卡片、每個衝突欄位「你讀到的／現在的」兩版與改的人。
- agent 收到 `progress_conflict`：MCP 回覆文字明寫「使用者或其他成員剛改過 <欄位>，請以目前內容為準重新整合後再寫」。不自動重試。
- GM 在網頁編輯：
  - 開始編輯時記住 revision；編輯中卡片被 agent 更新 → 編輯框上方一行「隊長 14:02 更新了『下一步』［看差異］」，**不**覆蓋 GM 正在打的字。
  - 存檔衝突 → 每個衝突欄位並排「你的版本｜目前版本」，按鈕「用我的」「用目前的」「兩個都留（我的在上）」，選完再存。
- **鎖定**：卡片標題列有「🔒 鎖定」開關（GM 才能切）。鎖定中 agent 的 `update_progress` 回 `card_locked`，`get_progress` 照常可讀並註明已鎖定。用途：GM 要大幅重寫時，或不想讓 agent 動。
- **歷史與還原**：保留每張卡最近 50 版（欄位快照、誰、何時、來源 web／mcp／restore）。卡片「歷史」列出版本與逐欄差異，「還原這版」= 以舊內容寫一個新版本（不刪歷史）。
- 所有寫入寫 audit：`progress.update`（user 或 session，detail：卡片、改了哪些欄位、各欄字數、merged、來源），`progress.conflict`、`progress.lock`、`progress.restore`。audit 不存欄位全文（全文在歷史表）。

### 1.5 畫面與互動（桌面）

**畫布上的進度卡**

- 位置：團隊框右上角外側，與框頂對齊、間距 16px（隨縮放換算，同 `TeamFrames` 做法），跟著團隊框移動。單獨 session 的卡貼在該 session 卡右側。不是 React Flow 節點，不參與「一鍵整理」的排列，但整理時要預留它的寬度（卡寬 280px 畫布 px），避免壓到右邊的團隊。
- 外觀：沿用 STYLE 母規範卡片（`--surface`、圓角 12、1px `--border`），**不用任何狀態色或團隊色當底**；左上一個小標籤「進度」。符合 STYLE「靜止時要安靜」。
- **收合（預設）**：一行「下一步：<第一行>」＋右側相對時間（「2 小時前・隊長」）。超過 24 小時沒更新且團隊這段時間內有回合結束（有 Stop 事件）→ 時間改成「⚠ 3 天沒更新」（`--fg-muted` 加 ⚠ 符號，不用顏色表達）。卡片還不存在 → 虛線框「＋ 進度卡」。
- **展開**（點一下）：四欄位＋自動事實＋按鈕列：編輯、帶入進度卡 ▾、請隊長更新 ◈、歷史、🔒。再點標題或 `Esc`（焦點不在輸入框時）收合。
- 縮放 < 90%（摘要模式）只顯示收合樣式；< 40% 只顯示「進度」小標籤與 ⚠（若有），避免縮小時一片字。
- 遮蔽模式開著時，卡片文字一律過 `useMaskText`。
- 只顯示目前工作區的卡（跟團隊一起篩選）。

**卡片上的按鈕**

- 編輯：四欄位變成 textarea，`⌘/Ctrl+Enter` 存、`Esc` 取消（textarea 內 `Esc` 只取消編輯，不關面板）。字數超過上限即時提示、存檔鈕停用。
- 帶入進度卡 ▾：選單列出團隊成員（預設隊長）＋「其他 session…」。選了以後把 `[Progress card: <團隊名>] Status: … | Next: … | Blockers: … | GM notes: …`（一行、清控制字元、4,000 字截斷，空欄位略過）送進該 session。**走 hub 的 `SafeDelivery`（`manual`，同群發）**：只在對象等輸入時送，忙就排隊，按鈕旁顯示「已送出／排隊中」。不受全部暫停擋（GM 親手按的，同 P2 Q6）。
- 請隊長更新 ◈ 耗額度：送固定一行 `[Board] Please update the team progress card with update_progress (status, next, blockers).` 給隊長，同樣走 `SafeDelivery manual`。沒有隊長時停用並提示。
- 🔒、歷史：見 §1.4。

**團隊面板**：名單上方加一個「進度卡」區塊（同畫布展開樣式），手機與桌面一致。

**Memory 面板（底部列新按鈕「Memory」）**

- 右側面板（和收件匣、團隊面板互斥，寬 420px，可展開 760px）。
- 列出目前工作區每張卡：團隊名（或 session 名）→「下一步」第一行 → 「阻礙」第一行（有才顯示）→ 更新時間與更新者 → ⚠ 久未更新。排序：⚠ 在前，其餘依更新時間新到舊。上方切換「目前工作區｜全部工作區」，記在本機。
- 點一列：畫布聚焦該團隊並展開卡片（目標在別的工作區就先切過去），面板不關。
- 空狀態：「還沒有進度卡。點團隊框旁的『＋ 進度卡』開始，或讓隊長呼叫 update_progress。」
- 網址：`#/memory`（桌面＝畫布＋Memory 面板；手機＝全螢幕）。
- 底部列變成：`[＋ 新增 session] [群組] [Presets] [Memory] │ [⏸ 全部暫停 ▾] [▶ 全部繼續]`（Presets 在項目二上線前不顯示）。英文較長，要檢查不撐爆（STYLE §8）。

### 1.6 畫面與互動（手機 ≤ 640px）

- 手機預設仍是收件匣。進度卡在：團隊面板（全螢幕）最上方、`#/memory` 全螢幕清單。
- 可讀、可編輯、可鎖定、可帶入、可請隊長更新（按鈕 ≥ 56px）。歷史與衝突並排比對在手機改成上下排列。
- 收件匣每列（屬於有卡片的團隊時）在呼號下加一行淡色「下一步：…」，點了展開整張卡。這是 GM 在手機上回覆 ASK 前最需要的上下文。

### 1.7 資料模型／API（**需要 schema 變更：v9 → v10，走既有升級前自動備份**）

- **新表 `progress_cards`**：id、`team_id`（REFERENCES teams ON DELETE CASCADE，可空）、`session_id`（REFERENCES sessions ON DELETE CASCADE，可空）、CHECK 兩者剛好一個非空、各自 UNIQUE；`status`、`next`、`blockers`、`gm_notes`（TEXT NOT NULL DEFAULT ''）；`revision` INTEGER；`locked` INTEGER；`updated_at`；`updated_by_kind`（user／session）；`updated_by_id`；`field_revisions`（JSON：每個欄位最後被改的 revision，三方比對用）。新表可以直接用外鍵（不受 v9 那種 ALTER 限制）。
- **新表 `progress_revisions`**：id、`card_id`（ON DELETE CASCADE）、`revision`、`fields`（JSON 快照）、`by_kind`、`by_id`、`source`（web／mcp／restore）、`at`。每張卡只留最新 50 筆（寫入時同交易刪舊的）。
- 項目二的 `team_presets` 表、項目三的索引**併在同一個 v10 migration**（見 §5），一次升級。
- 團隊刪除 → 卡片與歷史一起刪（audit 保留改動紀錄）。session 加入團隊 → 它原本的單獨卡保留但不顯示在畫布，Memory「全部」裡標「（已加入 <團隊>）」；離開團隊後重新顯示。
- 升級：hub 啟動時自動寫 `hub.db.bak-<時間>-v9`；上架前照 HANDOFF 步驟手動再備份一次。**降級**：v9 hub 拒絕 v10 資料庫（`tooNewMessage` 指出 `-v9` 備份）；回退＝停 hub → 換回 v9 版 → 還原 `-v9` 備份；升級後寫的進度卡、Presets 會遺失。
- **protocol（Lead 改或審查）**：
  - `ProgressCard`、`ProgressFields`、`ProgressRevision`、`ProgressConflict` zod 型別；`Settings.memory: z.boolean().default(true)`；`DispatchTool`（或另一個 `MemoryTool` 列舉）加兩個工具名；`daemon.hello.features` 新旗標（例如 `mcp.memory`）。
  - REST（auth user，手機一般帳號也能用）：
    - `GET /api/progress?zoneId=&all=` → 卡片清單（含自動事實）。
    - `GET /api/teams/:id/progress`、`GET /api/sessions/:id/progress` → 單張（沒有就回空卡 revision 0）。
    - `PUT /api/teams/:id/progress`、`PUT /api/sessions/:id/progress`，body `{ baseRevision, status?, next?, blockers?, gmNotes?, locked? }` → 成功回卡片（含 `merged`）；衝突 409 `progress_conflict`（`ApiError.detail` 是 `ProgressConflict`）。
    - `GET …/progress/revisions`、`POST …/progress/restore { revision }`。
    - `POST …/progress/deliver { sessionId }`（帶入進度卡）、`POST /api/teams/:id/progress/ask-update`（請隊長更新）→ 回 `sent／queued／skipped`，同群發的結果格式。
  - WS：`board.state.progress`（舊版 hub 不送＝空）；`progress.updated { card }`（任何寫入、鎖定、還原都推，所有 client 1 秒內更新）。
- **hub**：新模組（例如 `hub/src/progress.ts`）處理寫入、三方比對、頻率上限、歷史修剪；MCP 的兩個工具走既有 `dispatch.request` 路由，由 hub 分派到進度卡模組。
- **daemon**：掛載條件、`--allowedTools` 清單、MCP 設定檔 env；`features` 加旗標。
- **hook 套件（`hook/src/mcp.ts`）**：`TOOLS` 依 env 只列開著的工具；`INSTRUCTIONS` 加兩句。

### 1.8 驗收條件（可寫成 e2e／整合測試）

1. v9 資料庫（含 6 團隊、13 session）升級到 v10：產生 `-v9` 備份；`progress_cards`、`progress_revisions`、`team_presets` 存在且為空；畫布座標不變。
2. 團隊框旁出現「＋ 進度卡」；點開輸入四欄存檔 → 收合時顯示「下一步」第一行與「剛剛・<GM 名稱>」；重新整理仍在；另一個瀏覽器 1 秒內看到。
3. MCP 整合測試（模擬 MCP client 經 daemon socket 呼叫）：隊長 `get_progress` 回四欄位、goal、contextMd、自動事實、`revision`；`update_progress { baseRevision: 1, next: "X" }` 成功，畫布卡片 1 秒內變成 X，audit 有 `progress.update`（source mcp）。
4. 衝突：GM 改了「下一步」（rev 2），agent 帶 `baseRevision: 1` 寫「下一步」→ `progress_conflict`，卡片仍是 GM 的版本；agent 帶 `baseRevision: 1` 只寫「狀態」→ 成功且 `merged: true`，GM 的「下一步」保留。
5. 網頁編輯中 agent 寫入：編輯框內容不被覆蓋、出現「隊長更新了…」提示；存檔時若同欄位衝突出現並排比對，選「用我的」後存成功。
6. 鎖定後 agent 寫入回 `card_locked`、讀取正常；解鎖後可寫。
7. 非隊長成員 `update_progress` → `not_lead`；`gmNotes` 參數 → `invalid_arguments`；同一 session 10 分鐘第 11 次寫入 → `rate_limit`。
8. `Settings.memory` 關掉後新開的 session：`tools/list` 沒有進度卡工具（派工開著時仍有派工工具）；已掛著的呼叫回 `memory_disabled`。兩個都關 → 完全不掛 MCP server。
9. 「帶入進度卡」給一個 RUN 的成員：顯示排隊中；它變 ASK 後收到一行 `[Progress card: …]`，內容與卡片一致、遮蔽前原文、無換行；audit 有對應 `terminal.input`。PERM 的對象在權限處理前不收到任何字元。
10. 「請隊長更新」有 ◈ 耗額度晶片；送出內容等於固定字串。
11. 歷史：寫 3 次後列出 3 版；還原第 1 版 → 產生第 4 版、內容等於第 1 版。第 51 次寫入後歷史只剩 50 筆。
12. Memory 面板：列數＝目前工作區的卡片數；⚠ 久未更新排在最前（用 fake 時間）；點列聚焦並展開卡片，若在別的工作區會先切換。
13. 手機尺寸（390×844）：團隊面板最上方有進度卡、可編輯；收件匣某 ASK 列下方有「下一步：…」。
14. `check:no-llm` 更新後通過；`no-llm-review.md` 已列出新工具與「帶入進度卡」。
15. 手動驗證（記錄結果，未驗證前標「未驗證」）：在真的畫布 session 裡 `/clear` 後只說「繼續」，Claude 是否自己呼叫 `get_progress`。

### 1.9 不做什麼

- 不渲染自由便利貼（既有 `notes` 表維持現狀，不刪）。
- 不用 hook `additionalContext`、不寫檔案進專案資料夾、不在沒有 GM 動作時送任何字。
- 不自動摘要對話產生卡片內容（不呼叫模型）；hub 只算「自動事實」。
- 不做跨團隊共用的「全域 Memory」（例如 GM 的通用偏好）——那是 CLAUDE.md 的工作。
- 不做卡片的評論、指派、勾選清單互動。
- 不做「每回合結束自動提醒更新」（會花額度）。

### 1.10 風險

- **Claude 不一定照 instructions 去讀／寫**（未驗證；CONTRACTS §11.6 也記載 MCP 在互動模式只實測到 `claude -p`）。緩解：「帶入進度卡」與「請隊長更新」兩個手動按鈕；⚠ 久未更新提示讓 GM 看得出來。驗收 15 要實機測。
- **MCP instructions 每個 session 都佔一點 context**：只加兩句固定文字，影響很小；設定可關。
- **agent 寫入太頻繁、內容太長**：頻率上限＋欄位上限＋只有隊長能寫。
- **改 `--allowedTools` 動到 no-llm 保證文件**：必須同一個分支更新文件與檢查腳本，Lead 審查。
- 三方比對的欄位版本（`field_revisions`）寫錯會造成默默覆蓋：單元測試要涵蓋四種組合（同欄／不同欄 × GM 先／agent 先）。

### 1.11 工作量：**大**（schema＋protocol＋hub 模組＋MCP／daemon 掛載＋畫布卡片＋Memory 面板＋no-llm 文件）

---

## 2. 項目二：團隊 Presets

**目標：** 把一組設定好的團隊（角色、權限模式、機器與資料夾、目標與 TEAM.md、交接規則、隊長第一個指令、初始進度卡）存起來，下次從底部列一鍵套用；建立流程沿用既有「團隊快速建立」。

### 2.1 使用者故事

- GM 每次開「交易策略驗證」團隊都是：隊長＋2 成員＋審查、在同一個 repo、隊長 default、成員 acceptEdits、TEAM.md 有固定規則。存成 Preset「策略驗證」後，下次按底部「Presets → 策略驗證 → 建立」，4 個 session 開好並組成團隊。
- GM 在一個已經跑得很順的團隊面板按「⋯ → 存成 Preset」，把它現在的組成存起來。
- GM 在設定裡把 Preset 改名、調順序、刪掉不用的。
- GM 在手機上也能從團隊清單套用 Preset。

### 2.2 Preset 內容（`TeamPresetConfig`）

| 欄位                                | 說明                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teamType`、`phase`                 | dev／research；研究團隊的階段                                                                                                                                              |
| `color`                             | 團隊色 id                                                                                                                                                                  |
| `goal`、`doneCriteria`、`contextMd` | 團隊文字（TEAM.md）                                                                                                                                                        |
| `placement`                         | `machineId`、`cwd`、`projectId`（可空）。**不存工作區**：套用時放在目前工作區                                                                                              |
| `rows[]`                            | 每列：`kind`（角色或研究分工）、`permissionMode`、`model`（可空＝預設）、`useWorktree`（可空＝依角色規則）、`label`（可空：GM 改過的名稱後綴；空＝依 `defaultNames` 產生） |
| `handoffRules[]`                    | 以列序號表示的交接規則：`fromRow`、`toRow`、`trigger`、`filePattern?`、`marker?`、`maxRounds?`、`enabled`                                                                  |
| `taskAuto`                          | 任務自動執行開關                                                                                                                                                           |
| `leadFirstPrompt`                   | 隊長第一個指令（可空）                                                                                                                                                     |
| `attachProgressCard`                | 隊長第一個指令前附上進度卡（預設開；卡片空白時略過）                                                                                                                       |
| `initialProgress`                   | 初始進度卡內容（`status`、`next`、`blockers`、`gmNotes`，都可空）                                                                                                          |

### 2.3 畫面與互動（桌面）

**套用**

- 底部列「Presets」→ 按鈕上方彈出清單（最多顯示 8 個，超過可捲動＋頂部篩選框）。每列：名稱 → 角色縮寫串（`LD · BD · BD · RV`）→ 資料夾最後一段＋機器名 → 標記：◈（有第一個指令、有開啟的交接規則或任務自動執行時）、紅色「略過權限」（任何列是 `bypassPermissions`，STYLE 規則二）。
- 點一列 → 同一個彈出區換成**預覽**（§7 Q1）：團隊名稱（預設＝Preset 名稱，撞名自動加「 2」「 3」，可改）、目標工作區（＝目前工作區，唯讀）、每列「名稱・角色・模式晶片・worktree／唯讀」、會開啟的交接規則與任務自動執行（各附 ◈）、隊長第一個指令前 2 行。按「建立」或 Enter 執行，`Esc` 返回清單。
- 檢查（預覽時即時）：機器失聯 → 「建立」停用，顯示「<機器> 失聯，恢復後再建立」＋「換機器…」（換了要重選資料夾）；資料夾不存在（用既有資料夾瀏覽 API 檢查）→ 停用並提示；名稱規則用 `validatePlan`（一位隊長、名稱不重複、主資料夾最多一位寫入者）。
- 執行：沿用 `runPlan`（建立團隊 → 逐列 `createSession`＋加入 → 建交接規則 → 設任務自動執行 → 寫初始進度卡）。進度逐列顯示在彈出區；完成後畫布聚焦新團隊、開團隊面板。部分失敗：同 `NewTeamForm`，列出失敗的列與原因，已建的保留，不自動重試。
- 全部暫停中：照樣可建立（GM 親手按的）；同時排隊上限、限流排隊照常（session 可能是 QUE）。隊長第一個指令**不隨建立送出**（§7.2-D7）：預覽上方顯示「目前全部暫停中，隊長第一個指令不會自動送；建立後在隊長卡片上按『送出第一個指令』」，建立後隊長卡片上出現該按鈕（GM 按下才送，走 `SafeDelivery manual`）。原因：第一個指令由 daemon 在 SessionStart 後送，不經 `SafeDelivery` 閘門（見 §2.8）。

**存成 Preset**

- 團隊面板「⋯ → 存成 Preset」：從現有團隊擷取——機器與資料夾（隊長的 `cwd`，沒有隊長取第一位成員）、專案、每位成員的角色／分工／權限模式／模型／是否有 worktree、成員之間的交接規則（對應成列序號；連到團隊外的略過並提示）、goal／doneCriteria／contextMd／color／phase／taskAuto。進度卡**預設不帶**（它是狀態），對話框有勾選「把目前進度卡當初始內容」。隊長第一個指令預設空白，可填。名稱必填、不分大小寫不能重複。
- `NewTeamForm` 送出鈕旁加「存成 Preset」（不建立團隊，只存目前表單）。
- 存檔前顯示摘要（同預覽格式），按「存」。

**管理（設定次畫面新分類「Presets」，網址 `#/settings/presets`）**

- 清單：名稱、角色縮寫串、最後使用時間；每列：改名、上移／下移、編輯、複製、刪除。
- 編輯＝開 `NewTeamForm` 的「編輯 Preset」模式（同一套列編輯、檢查），另有交接規則、第一個指令、初始進度卡三個區塊；存檔只改 Preset，不影響已建的團隊。
- 刪除：按一次刪，畫面出現「已刪除『策略驗證』［復原］」10 秒（刪 Preset 不影響任何 session，不需要兩次確認）。
- 既有「範本」（單一 session）區塊不動，兩者並存；設定頁說明一句「範本＝一個 session；Preset＝整個團隊」。
- 內建組合（squad／standard／explore、研究四階段）仍在 `NewTeamForm` 裡，不搬進 Presets 清單。

### 2.4 畫面與互動（手機）

- 手機沒有底部列。入口：團隊清單（全螢幕）頂部「從 Preset 建立」→ 全螢幕清單 → 預覽 → 建立（按鈕 ≥ 56px）。
- 手機上不能編輯 Preset 內容（列、規則），只能套用、改名、刪除；編輯顯示「回電腦處理」。
- 團隊面板「存成 Preset」手機也有。

### 2.5 資料模型／API（**schema 變更併入 v10**，見 §1.7）

- **新表 `team_presets`**：id、`name`（UNIQUE COLLATE NOCASE）、`config`（JSON，`TeamPresetConfig`）、`position`、`created_at`、`updated_at`、`last_used_at`（可空）。
- 不改 `templates` 表。
- **protocol（Lead 改或審查）**：`TeamPreset`、`TeamPresetConfig` zod；REST（auth user）：
  - `GET /api/team-presets`、`POST /api/team-presets`、`PATCH /api/team-presets/:id`（name、config、position）、`DELETE /api/team-presets/:id`。名稱重複 409 `preset_name_taken`。
  - `POST /api/team-presets/:id/used` 更新 `last_used_at`（套用成功後前端呼叫；或由 hub 在建立團隊時帶 `presetId` 自動更新，實作決定）。
  - WS：`preset.list { presets }`（建立、改名、排序、刪除時整份推）。
- **前端**：`runPlan` 擴充可接受交接規則、任務自動執行、第一個指令（只給隊長列）、初始進度卡（呼叫項目一的 PUT）。`PlanRow` 與 `TeamPresetConfig.rows` 互轉的純函式放 `team/teamPlan.ts`，要有單元測試。
- audit：`preset.create`／`preset.update`／`preset.delete`／`preset.apply`（detail：presetId、新團隊 id、建立成功與失敗列數）。建立 session、團隊、規則照舊各自寫 audit。
- config 驗證：hub 存檔時用 zod 驗證；套用時若 Preset 參照的機器已被移除 → 預覽顯示「機器不存在，請換機器」。

### 2.6 驗收條件

1. 從一個「隊長＋2 成員＋審查、1 條交接規則（關）」的團隊「存成 Preset」：Preset 內容的列數 4、角色與模式一致、交接規則 1 條且 `enabled: false`、`initialProgress` 空。
2. 底部列「Presets」清單顯示該 Preset；點它 → 預覽團隊名稱自動加「 2」（原團隊還在）；按 Enter → 建出 4 個 session（名稱 `<名稱 2>-LD`、`-BD1`、`-BD2`、`-RV`）、worktree／唯讀規則與手動建立相同、交接規則 1 條且關閉；畫布聚焦新團隊、團隊面板打開。
3. Preset 有隊長第一個指令且 `attachProgressCard` 開、`initialProgress.next = "A"`：建立後隊長第一個指令以進度卡那一行開頭、接著是 Preset 的指令；新團隊的進度卡 next = A、revision 1。
4. Preset 含開啟的交接規則：清單與預覽有 ◈；建立後規則是開啟狀態。
5. Preset 的機器離線：預覽「建立」停用並顯示失聯訊息；換到另一台在線機器並選資料夾後可建立。
6. 某列建立失敗（模擬 409）：其他列照建，失敗列顯示原因；不會重複建立已成功的列。
7. 設定「Presets」：改名、上下移、刪除＋復原都即時反映到底部列清單（另一個瀏覽器 1 秒內）。名稱重複存檔回錯誤訊息。
8. 「編輯 Preset」把某列權限改成 `bypassPermissions`：清單出現紅色「略過權限」；預覽該列紅線紅框。
9. 手機尺寸：團隊清單「從 Preset 建立」可完成套用；編輯顯示「回電腦處理」。
10. audit 有 `preset.apply`，detail 的成功／失敗列數正確。
11. 全部暫停中套用含第一個指令的 Preset：隊長 session 建好後沒有收到任何字；隊長卡片出現「送出第一個指令」，按下後（隊長等輸入時）收到該指令。

### 2.7 不做什麼

- 不做 Preset 匯入匯出、不跨 hub 分享。
- 不把單一 session「範本」與 Preset 合併。
- 不做「套用 Preset 到已存在的團隊」（補成員已有既有流程）。
- 不在 hub 端做原子性建立（沿用 `runPlan` 的逐列、失敗保留）。
- 不做 Preset 的變數替換（例如 `{date}`）。

### 2.8 風險

- **機器與資料夾綁死**：同一個 repo 在兩台機器路徑不同，Preset 只存一組；換機器要重選資料夾。可接受（GM 的 repo 多在固定機器）。
- **一鍵開多個 session 會吃同時上限**：超過時會 QUE；預覽應顯示「目前 N 個在跑，上限 M，會有 K 個排隊」（資料已在前端）。
- **全部暫停與第一個指令**：第一個指令由 daemon 在 SessionStart 後送，不經 `SafeDelivery` 閘門（CONTRACTS §12 提到同類缺口）。所以暫停中套用時，隊長第一個指令改成建立後由 GM 手動送（§2.3、D7），行為才和「暫停擋自動送字」一致。
- 交接規則以列序號對應：列順序被改動後規則可能指錯人；編輯模式刪列時要同步刪掉相關規則並提示。

### 2.9 工作量：**中**（一張表＋CRUD＋從團隊擷取＋預覽＋擴充 `runPlan`＋設定頁；資料表在項目一的 v10 已建好）

---

## 3. 項目三：全域搜尋

**目標：** 一個搜尋框一次找所有 session（兩台機器、含已結束）的檔案改動、終端機與對話內容、進度卡與團隊文字，最常見的用法是「哪個 session 在改 X 檔」「我上次叫誰做 Y」。

### 3.1 使用者故事

- GM 想知道誰在改 `risk.py`：按 `⌘K` 輸入 `risk.py`，最上面一組「檔案改動」列出 2 個 session（一個 RUN、3 分鐘前改過；一個 DONE、昨天），點第一個，畫布切到它所在工作區並聚焦。
- GM 記得某個 session 講過「手續費 0.1425」，但忘了是哪個：輸入後按 Enter，「對話與終端機」一組陸續出現兩台機器上的結果，另一台機器失聯時明寫「沒搜到」。
- GM 在手機上搜某個團隊名，找到它的進度卡。
- 遮蔽模式開著時，搜尋結果裡的金鑰一樣被遮住，而且不會傳到手機上。

### 3.2 資料來源與所在位置（決定了兩段式搜尋）

| 來源                                                                                  | 在哪                           | 涵蓋                                             | 搜尋層                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------ | -------------------------------------------------------- |
| session 名稱、資料夾、分支、worktree 路徑、最後 4 行                                  | hub `sessions`                 | 全部（含封存）                                   | 快速                                                     |
| 檔案改動 `file.changed`                                                               | hub `session_events`           | 30 天；只有 Edit／Write／MultiEdit／NotebookEdit | 快速                                                     |
| 每回合最後回覆（Stop 的 `last_assistant_message`，前 8,000 字）、交接／派工／任務摘要 | hub `session_events`           | 30 天                                            | 快速                                                     |
| 團隊名稱、目標、完成條件、TEAM.md、任務標題                                           | hub `teams`、`tasks`           | 全部                                             | 快速                                                     |
| 進度卡（目前版本）                                                                    | hub `progress_cards`（項目一） | 全部                                             | 快速                                                     |
| GM 送出的指令（`terminal.input`，已遮蔽密碼提示）                                     | hub `audit_log`                | 180 天                                           | 快速（只有 owner 帳號看得到這類結果，和 audit 權限一致） |
| 終端機畫面（scrollback 5,000 行）                                                     | 各機器 daemon 記憶體           | **只有活著的 session**                           | 深層                                                     |
| Claude 對話紀錄 JSONL（含工具呼叫參數與結果）                                         | 各機器磁碟                     | 該 session 目前的 `claudeSessionId` 那一份       | 深層                                                     |

- **hub 不存終端機與對話內容**（CONTRACTS §2），本規格**不改這個原則**：深層搜尋是即時發給各台 daemon 搜，結果只回片段，不在 hub 建索引、不落地。
- 自由便利貼（`notes`）目前沒有畫面，不列入。

### 3.3 畫面與互動（桌面）

**開啟**：`⌘K`／`Ctrl+K`，或焦點不在輸入框與終端機時按 `/`；頁首加一顆搜尋鈕（放在收件匣鈕左邊）。焦點在 xterm 時快捷鍵一律交給終端機（同 P2 Esc 規則）。

**搜尋視窗**：置中模態（寬 min(760px, 視窗 − 96px)、高 min(80vh, 視窗 − 96px)，背後畫布暗化，同設定次畫面規格）。

```
┌ 🔍 [ risk.py                                   ] ✕ ┐
│ 範圍：[目前工作區｜全部]  時間：[24 小時｜7 天｜30 天]  ☐ 含封存 │
├─────────────────────────────────────────────────────┤
│ 檔案改動（2）                                         │
│ ● RUN  tw-impl-1   src/risk.py   3 分前・共 5 次        │
│ ✓ DONE tw-impl-2   src/risk.py   昨天 14:02           │
│ 進度卡與團隊（1）                                     │
│   台股・下一步：「改 risk.py 的部位上限…」             │
│ 對話與終端機（搜尋中… 機器 A 完成・機器 B 失聯）        │
│ ◇ ASK  tw-lead  對話 #182  「…已把 risk.py 的上限改成…」│
├─────────────────────────────────────────────────────┤
│ ↑↓ 選擇  Enter 前往  ⌘Enter 開對話紀錄  Esc 關閉       │
└─────────────────────────────────────────────────────┘
```

- **輸入時**（停 250ms、至少 2 字）：只跑**快速層**（hub），結果即時更新。
- **按 Enter（或「也搜對話與終端機」鈕）**：再跑**深層**，結果分機器陸續加進「對話與終端機」組；組標題顯示每台機器的進度（搜尋中／完成 N 筆／失聯沒搜到／版本太舊不支援／逾時只搜了部分）。再按一次 Enter 或改字會取消上一次深層搜尋。
- 比對：不分大小寫子字串；空白分隔的多個詞＝每個詞都要出現（AND）；雙引號包起來＝完整片語。最多 200 字。
- 分組與排序：檔案改動 → 進度卡與團隊 → session → GM 送出的指令 → 對話與終端機。組內：等你的（ASK／PERM／PLAN／ERR）與 RUN 在前，其餘依時間新到舊。每組先顯示 5 筆，「顯示全部 N 筆」展開。
- 每列：狀態燈（符號＋代碼）→ session 名稱 → 片段（命中處前後共 ≤ 160 字，命中詞粗體＋底線，不用顏色表達）→ 時間 → 機器晶片。檔案改動列顯示相對 repo 的路徑與次數。
- **檔案改動組底下固定一行淡色說明**：「只偵測 Edit／Write 改的檔案；用指令（sed、mv、產生器）改的，按 Enter 搜對話紀錄。」（事實見 §0）
- 動作：Enter／點擊＝關閉視窗、畫布聚焦該 session（必要時切工作區；封存的 session 改開封存頁該筆）；`⌘Enter`＝開該 session 的對話紀錄並捲到命中的那則（沿用既有對話紀錄檢視與 `index`）；進度卡結果＝聚焦團隊並展開卡片。
- 範圍、時間、含封存的選擇記在本機。預設：全部工作區、7 天、不含封存。
- 空狀態：「沒找到。按 Enter 也搜對話與終端機。」；hub 斷線：整個視窗淡化＋一行字（STYLE 邏輯 8）。

### 3.4 畫面與互動（手機）

- 收件匣頂部加搜尋鈕 → 全螢幕搜尋頁 `#/search`（網址帶 `?q=` 可分享深連結）。
- 快速層照常；深層要按「也搜對話與終端機」（手機不自動跑，省流量與電）。
- 點結果：有等你的動作 → 開收件匣該項；否則開團隊面板或 session 的終端機頁。

### 3.5 隱私與遮蔽

- 遮蔽模式開著時，前端在請求帶 `mask: true`，**hub 與 daemon 在回傳前就用遮蔽規則處理片段**（不是只在畫面遮），所以金鑰不會傳到裝置上；遮蔽關著時回原文，畫面照 `useMaskText` 處理（和終端機一致）。遮蔽規則以 `web/src/security/secretPatterns.ts` 與 `hub/src/secretPatterns.ts` 為準，兩邊需一致（目前是兩份，實作時確認或抽到 protocol）。
- 結果只有片段（≤ 160 字），不回整則訊息；要看全文走既有對話紀錄檢視。
- 遮蔽開著時，查詢字本身若符合金鑰格式，前端提示「遮蔽模式開著，搜尋金鑰不會顯示結果」並不送出深層搜尋。
- 深層搜尋寫 audit `search.deep`（user、查詢字經 `redactSecrets`、搜了哪些機器、各幾筆、是否逾時）。快速層不寫 audit（太頻繁）。
- 權限：auth user（同 `sessionTranscript`）；`audit_log` 來源的結果只回給 owner。

### 3.6 效能

- **快速層（hub SQLite）**：
  - 只搜 `session_events` 的 `file.changed`、`hook`（Stop）、`handoff.*`、`dispatch.*`、`task.*` 幾種 type，且在時間範圍內；v10 加索引 `session_events(type, at)`。
  - 每組最多取 50 筆、總計 200 筆；查詢逾時 2 秒就回已得到的並標「結果不完整」。
  - 目標（以 20 萬筆 events、50 個 session 的種子資料測）：p95 < 300ms。不做全文索引（FTS），驗收數字達不到再評估。
- **深層（各台 daemon）**：
  - hub 對每台在線、支援的 daemon 送一個請求，帶：查詢詞、該機器上符合範圍的 session 清單（id、`claudeSessionId`、`accountProfile`、是否活著）、上限。
  - daemon：先搜活著的 session 的 headless 畫面（快），再依「最後活動時間新到舊」逐份讀 JSONL；每個 session 最多 3 筆、每台最多 100 筆、每台讀檔總量上限 300 MB、15 秒 deadline；超過就停並回報「只搜了 N／M 個 session」。邊搜邊回（每找到一批就送）。
  - 和既有「對話紀錄檢視」**分開排隊**：搜尋不能讓 GM 打開對話紀錄要等 15 秒（既有 `readQueue` 同時只讀一份）。一個使用者同時只有一個深層搜尋；新的取消舊的（daemon 收到取消就停止讀檔）。
  - 舊版 daemon（`features` 沒有搜尋旗標）→ 該機器標「版本太舊不支援」。
  - 目標（未驗證，實作時量測並記錄每台機器的 JSONL 總量與耗時）：7 天範圍內第一批結果 < 3 秒。
- 已知限制：session 中途 `/clear` 會換 `claudeSessionId`，hub 只記最新那個，所以 `/clear` 之前的對話不在深層搜尋範圍（顯示在說明裡）。session 結束後畫面緩衝就沒了，只能搜對話紀錄。

### 3.7 資料模型／API

- **schema**：v10 加索引 `CREATE INDEX session_events_type ON session_events(type, at)`（併在 §1.7 的同一個 migration）。沒有新表。
- **protocol（Lead 改或審查）**：
  - REST `GET /api/search?q=&scope=zone|all&zoneId=&since=24h|7d|30d&archived=0|1&mask=0|1` → `SearchResults { groups: { kind, total, items[] }[], partial: boolean }`（快速層）。
  - WS（client）：`search.deep { searchId, q, scope, since, archived, mask }`、`search.cancel { searchId }`；hub 回 `search.deepResult { searchId, machineId, items[] }`、`search.deepDone { searchId, machineId, state: done|offline|unsupported|timeout, scannedSessions, totalSessions }`。只推給發起的那條連線。
  - WS（daemon）：`search.request`／`search.cancel`（hub → daemon）、`search.result`／`search.done`（daemon → hub）；`daemon.hello.features` 加 `search.v1`。
  - `SearchItem`：`kind`（file／progress／team／task／session／input／transcript／screen）、`sessionId?`、`teamId?`、`snippet`、`matchRanges`（片段內的命中位置）、`at?`、`machineId?`、`transcriptIndex?`、`count?`（檔案改動次數）。
- **hub**：新模組（例如 `hub/src/search.ts`）做快速層查詢與深層扇出、彙整、取消、audit。
- **daemon**：新模組重用 `transcript.ts` 的解析（`parseLine`／搜尋全文），加畫面緩衝搜尋、讀檔上限、取消、獨立排隊。
- **前端**：搜尋視窗元件、快捷鍵（`App.tsx` 或 overlay 層，Lead 區域）、`BoardBackend.search()`／`deepSearch()`（`shared/`，Lead 審查），fake backend 模擬兩台機器（一台慢、一台離線）。

### 3.8 驗收條件

1. 種子資料：session A（RUN）5 分鐘前 `file.changed` `src/risk.py`、session B（DONE）昨天也改過。輸入 `risk.py`：「檔案改動」組 2 列，A 在前、顯示「共 N 次」；Enter 前往 → 畫布聚焦 A（A 在別的工作區時先切換）。
2. 輸入 1 個字不搜；停 250ms 後才送快速層請求（e2e 用請求計數驗證）。
3. 多詞 AND 與雙引號片語：`手續費 0.1425` 與 `"手續費 0.1425"` 結果數符合種子資料。
4. 進度卡內容命中：出現在「進度卡與團隊」組；點擊聚焦團隊並展開卡片。
5. 深層：fake 兩台機器，一台 300ms 回 2 筆、一台離線 → 組標題顯示「完成 2 筆」與「失聯沒搜到」；結果帶機器晶片；`⌘Enter` 開對話紀錄並捲到 `transcriptIndex`。
6. 深層搜尋中改字：舊的 `searchId` 送出 `search.cancel`；舊結果不再出現。
7. daemon 單元／整合：建 3 份 JSONL（其中一份 50MB），上限設小 → 回 `timeout` 與正確的 `scannedSessions`；每 session 不超過 3 筆；搜尋期間同時讀對話紀錄檢視不被擋（兩者並行完成）。
8. 舊版 daemon（features 無 `search.v1`）→ 該機器 `unsupported`，不送請求。
9. 遮蔽開著：種子資料含 `sk-ant-…` 形式字串的片段，在**網路回應**裡已被遮蔽（e2e 攔截回應驗證，不只看畫面）；遮蔽關著時回原文。
10. 非 owner 帳號搜尋時沒有「你送出的指令」組。
11. audit：深層搜尋一次產生一筆 `search.deep`，查詢字經遮蔽；快速層不寫。
12. 效能（單元測試以種子資料量測並印出）：20 萬筆 events 快速層 p95 < 300ms。
13. 手機尺寸：收件匣頂部搜尋鈕 → `#/search`；深層要按按鈕才跑。
14. 焦點在終端機時按 `/` 與 `⌘K`：送進終端機，不開搜尋。

### 3.9 不做什麼

- 不在 hub 建對話紀錄或終端機內容的索引、不把內容存進 hub（守 CONTRACTS §2）。
- 不做正規表示式、模糊比對、語意搜尋（不呼叫模型）。
- 不搜 `/clear` 之前的舊對話檔、不搜 session 以外的任意檔案（不是 grep 整個 repo）。
- 不做搜尋結果的批次動作（例如對結果群發）。
- 不做 Raycast 式指令面板（搜尋視窗只搜內容，不執行指令）；之後要做可以沿用同一個視窗。

### 3.10 風險

- **深層搜尋吃機器資源**：JSONL 可達數十 MB，讀檔與解析佔 CPU；有讀檔總量、時間上限與取消，但兩台機器實際總量未知（未驗證）。實作第一步先量每台機器 7 天內的 JSONL 總大小並記錄。
- **檔案改動不完整**：Bash 改的檔案沒有事件，畫面已明寫；GM 仍可能誤以為「沒人在改」。
- **遮蔽規則兩份**：web 與 hub 各有 `secretPatterns.ts`，若不一致，伺服器端遮蔽會漏；實作時要對齊並加測試。
- `session_events` 最多 200 萬筆，時間範圍選 30 天時快速層可能變慢；有 2 秒逾時與「結果不完整」標示。

### 3.11 工作量：**大**（可拆成 3a 快速層＝**中**：hub 查詢＋搜尋視窗；3b 深層＝**中**：daemon 搜尋、扇出、取消、遮蔽）

---

## 4. 三項共通

- **i18n**：新增字串中英都要（STYLE §6）；「Preset」「Memory」兩種語言都用英文詞，中文介面另附說明（「Preset（團隊組合）」「Memory（進度卡）」）。
- **STYLE 檢查**：進度卡、搜尋視窗、Presets 清單都不使用狀態色當裝飾；會花額度的按鈕（請隊長更新、含第一個指令／自動規則的 Preset）一律 ◈；`bypassPermissions` 一律紅線紅框。
- **CONTRACTS**：新增 §14 進度卡與 Memory、§15 Presets、§16 全域搜尋；`CONTRACTS-summary.md` 同步加三列。
- **no-llm**：項目一動到保證文件（MCP 工具擴充、「帶入進度卡」、「請隊長更新」）。項目二的 Preset 第一個指令屬於既有「使用者建立 session 時填的第一個指令」，交接規則與任務自動執行仍是「使用者設定並啟用」，暫停中改為 GM 手動「送出第一個指令」（新的手動送字點），文件各加一句。項目三不送任何字。
- **測試**：fake backend 要能模擬進度卡衝突、Preset 套用部分失敗、兩台機器深層搜尋（一台慢、一台離線）。

---

## 5. 相依性與建議實作順序

```
① 進度卡＋Memory（含 v10 migration：三張表／索引一次建好）
      ├──> ② Presets（用 ① 的初始進度卡、附上進度卡；資料表已在 v10）
      └──> ③a 快速層搜尋（把進度卡當來源；沒有 ① 也能做，只是少一個來源）
③b 深層搜尋（daemon；和 ①、② 無關，可與 ② 並行）
```

- **v10 只升一次**：`progress_cards`、`progress_revisions`、`team_presets`、`session_events(type, at)` 索引放同一個 migration，隨 ① 上架。② 與 ③ 不再改 schema。這樣三項各自上架時只有第一次需要「停服務＋備份」的完整流程。
- ① 和 ③b 都改 daemon（MCP 掛載、搜尋），要更新**兩台機器**的 daemon；舊 daemon 用 `features` 旗標降級（不掛新工具／標「不支援」），所以 hub 可以先上、daemon 後更新。

**建議順序（依 §1 原則：先做最能推進正事的）**

1. **① 進度卡＋Memory**（大）：直接解決「進度帶不到下一次對話」，每天都用得到；也是 ② 與 ③a 的資料來源。上架時是唯一一次 schema 升級（v9 → v10）。
2. **③a 快速層搜尋**（中）：「誰在改這個檔」只靠 hub 現有資料就能回答，成本低、價值高。
3. **③b 深層搜尋**（中）：跨機器扇出，需要兩台 daemon 更新與效能量測。
4. **② Presets**（中）：GM 目前把活躍團隊壓在 2–3 個，開新團隊的頻率低，價值排最後；但它小而獨立，若 ③b 卡在效能量測，可以先做。

每一步各自一個分支、各自上架，不要三項一起上。

---

## 6. 實作備註（非規格，供派工參考）

- 進度卡三方比對：`field_revisions` 記每個欄位最後一次被改時的 revision；寫入時「要寫的欄位的 `field_revisions[f] > baseRevision`」即衝突。單元測試覆蓋：同欄／不同欄 × GM 先／agent 先、鎖定、還原後再寫。
- MCP 工具名與錯誤代碼放 protocol，`hook/src/mcp.ts` 只能用 node 內建模組（同現況），工具清單用 env 傳入。
- 「帶入進度卡」「請隊長更新」「送出第一個指令」都用 P2 群發的 `DeliveryItem.manual` 路徑，結果格式沿用 `Broadcast`，前端可共用排隊中／取消的顯示。
- Preset 的列 ↔ `PlanRow` 轉換、交接規則列序號對應寫成純函式，放 `team/teamPlan.ts` 旁並寫單元測試；「存成 Preset」擷取時 `useWorktree` 以 `worktreePath !== null` 判斷。
- 深層搜尋 daemon 端可把 `transcript.ts` 的 `parseLine` 抽成共用，搜尋版不做分頁、只記命中位置；JSONL 讀取用串流並在每 N 行檢查取消旗標與 deadline。
- 片段遮蔽：伺服器端遮蔽要在「擷取片段之後、回傳之前」做，命中位置（`matchRanges`）以遮蔽後的字串重新計算。

---

## 7. 待 GM 決定

### 7.1 要 GM 回覆的問題（只有 2 題）

| #   | 問題                                                                                                                       | 建議                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 套用 Preset 要不要經過預覽？派工單寫「一鍵開出」，但一次會開多個 session（可能碰到同時上限、機器失聯、第一個指令花額度）。 | **點 Preset 先出預覽，再按「建立」或 Enter（共兩下）**。預覽同時檢查機器在線、資料夾存在、會不會排隊，並顯示 ◈；名稱撞名自動加編號。不另做「完全不預覽」的捷徑。 |
| Q2  | agent 寫進度卡要不要經 GM 核准？                                                                                           | **不用核准，直接寫入**（隊長才能寫、GM 備註 agent 改不了、同欄位衝突時拒絕 agent、保留 50 版可還原、可鎖定）。核准制會讓「等你」又多一類，違反「不要堆待辦」。   |

### 7.2 已用預設決定（GM 不回就照做；要改再說）

| #   | 決定                                                                                                          | 理由                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D1  | 不屬於任何團隊的單獨 session 也有自己的進度卡                                                                 | GM 現有約 3 個無團隊 session，同樣有進度遺失問題；成本只是擁有者多一種              |
| D2  | 只有隊長能寫進度卡（沒有隊長的團隊任一成員可寫），所有成員可讀                                                | 避免多人輪流蓋寫；成員回報給隊長是既有流程                                          |
| D3  | `Settings.memory` 預設開，工具加進 `--allowedTools`（不用每次問）                                             | 同派工預設開：工具本身不花額度、不會自己動；不允許的話 default 模式每次跳權限對話框 |
| D4  | 不做「每回合結束自動提醒更新進度卡」，改為 ⚠ 久未更新提示＋「請隊長更新 ◈」手動按鈕                           | 自動提醒會花額度、違反 no-llm 保證的「沒有使用者動作不送字」                        |
| D5  | 進度卡畫在團隊框右上角外側、預設收合成一行「下一步」                                                          | 畫面只放當下要用的東西；縮小時不出現大片文字                                        |
| D6  | Preset 存交接規則與任務自動執行的「開／關」原狀，套用時照原狀；開著的在清單與預覽標 ◈                         | GM 存的就是 GM 要的；◈ 讓花額度的部分看得到                                         |
| D7  | 暫停中套用 Preset：隊長第一個指令不自動送，建立後隊長卡片出現「送出第一個指令」由 GM 按                       | 和「全部暫停擋自動送字」一致（見 §2.8）                                             |
| D8  | 搜尋：輸入時只搜 hub（快速層），按 Enter 才搜各機器的對話與終端機（深層）；預設範圍全部工作區、7 天、不含封存 | 深層會讀兩台機器的檔案，不該每打一個字就跑                                          |
| D9  | 遮蔽模式開著時，搜尋片段在伺服器端就遮蔽（不傳到裝置）                                                        | 搜尋把多個 session 的片段集中到一個畫面，比單看終端機更容易外洩                     |
| D10 | 不渲染自由便利貼；搜尋也不含便利貼                                                                            | 現在沒有畫面、沒有資料，進度卡取代它的用途                                          |
| D11 | v10 一次建好三項需要的表與索引，隨 ① 上架                                                                     | 只做一次停服務＋備份＋降級風險                                                      |
| D12 | 建議順序 ① → ③a → ③b → ②（§5）                                                                                | 依 §1「推進正事」排；② 若 ③b 卡在效能量測可提前                                     |
