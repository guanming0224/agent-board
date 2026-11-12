# Codex 第二輪規格（2026-11-12）

來源：外層 `docs/dispatch/2026-11-09_派工補充_AI接口與多機部署.md` §13.4 第 3 步（腳本任務模式，第一個用例是交叉審查）與 Codex 第一版留下的範圍（CONTRACTS §19「不在第一版範圍」）。

## 0. GM 決定（2026-11-12）

| 項目 | 決定 |
| --- | --- |
| 範圍 | 三項都做：**交叉審查**、**Codex 也能派工**、**Codex 用量統計** |
| 交叉審查的對象 | 兩種都要：某個 session 工作目錄裡**還沒 commit 的變更**；某個 repo 的**分支相對 main 的差異** |
| 誰能發起 | GM 在畫布手動發起；**隊長也能用派工工具要求**（推播通知 GM、每隊有頻率上限） |

## 1. 不變的原則

- **中控台不呼叫 LLM**：hub、daemon、網頁都不直接呼叫任何模型 API。交叉審查是 daemon 在 GM 或隊長明確要求時，於那台機器上啟動**已登入的官方 CLI**（`claude -p`、`codex exec`），吃使用者自己的訂閱額度——性質和開一個 session 相同。`docs/no-llm-review.md` 與 `scripts/check-no-llm.mjs` 要把這兩個新呼叫點列入審查清單，並寫明界線：只能由使用者動作或隊長的派工工具觸發，不能由排程、規則或任何自動流程觸發。
- 不讀、不複製 `~/.claude` 與 `~/.codex/auth.json` 的憑證（§13.3）。Codex 用量統計讀的是 Codex 自己的對話紀錄（`~/.codex/sessions/**/*.jsonl`），不碰 `auth.json`。
- 不改 GM 的 `~/.codex` 設定、不建專案 `.codex`；需要的設定一律用 `-c key=value` 在啟動時帶入（沿用第一版做法）。
- Windows 上 Codex 仍然擋掉（v0.1.7 起的規則不變）；交叉審查在 Windows 機器上只跑 Claude 那一半，並在結果標明。

## 2. 交叉審查

### 2-1. 輸入

- **session 變更**：該 session 的工作目錄（worktree 或 cwd）`git diff HEAD`（含 staged）＋未追蹤檔案清單與內容（大小上限，例如單檔 200 KB、總共 1 MB，超過就截斷並標明）。
- **分支差異**：指定機器上的 repo 路徑＋分支，`git diff <base>...<branch>`（base 預設 `main`，可選）。
- daemon 先產生 diff，GM 在網頁上看得到要送審的檔案清單與大小，**按確認才送出**（隊長發起的則跳過確認，但推播通知 GM）。

### 2-2. 執行

- 在該機器上、該 repo 目錄，兩邊並行：
  - Claude：`claude -p --output-format json` 唯讀（`--disallowedTools Edit Write NotebookEdit` 加上 `--permission-mode plan` 或等效的唯讀設定），prompt＝固定的審查指示＋diff。
  - Codex：`codex exec --json -s read-only -a never`（沿用第一版的權限換算），prompt 同上。模型、推理強度用使用者在設定頁選的值（預設用各 CLI 自己的預設）。
- 逾時（例如 10 分鐘）就結束該邊並標記逾時；一邊失敗不影響另一邊。
- 審查指示寫在 `packages/protocol`（固定文字，版本化），要求輸出：嚴重問題、建議、整體結論；不要求特定 JSON，以免某家格式不穩就整份失敗。

### 2-3. 結果

- hub 新表 `reviews`（schema v11，**只加表、不改既有欄位**，遵守「先加後刪」）：id、發起者（GM 或隊長 session）、機器、對象類型與描述、diff 摘要（檔案清單、行數，不存整份 diff）、兩邊各自的狀態／輸出文字／用量（token、耗時）、建立與完成時間。
- 網頁：審查結果疊加面板，左右並排兩家的意見；從卡片、團隊面板、收件匣都能開；完成時進收件匣（不推播審查內容本身，只推播「審查完成」）。
- 保留期限：跟現有事件一樣的保留規則。

### 2-4. 隊長發起

- 新 MCP 工具 `request_review`（隊長才能用）：參數＝對象（自己團隊成員的 session，或 repo＋分支）與一句理由（必填，進 audit 與團隊動態，不進推播）。
- 頻率上限：同一隊每小時最多 3 次（設定頁可改）；超過回錯誤要隊長稍後再試。
- 完成後結果摘要自動送回發起的隊長（沿用派工結果送回的 SafeDelivery 路徑），GM 也在收件匣看得到。

## 3. Codex 也能派工

- Codex session 啟動時用 `-c mcp_servers.agent-board.command=…` 等參數帶入 agent-board MCP server（和 Claude session 同一支、同一套密鑰與 hook socket 驗證；W5 的 `AGENT_BOARD_HOOK_KEY_FILE` 一樣傳）。
- Codex 可以當隊長或成員：隊長是 Codex 時能 `spawn_member`（可選 agent：claude／codex）、`send_task`、`get_result`、`release_member`、`get_progress`／`update_progress`、`request_review`。
- 結果送回：Codex 成員的回合結束（Codex `Stop` hook）時，照 Claude 的路徑把結果送回隊長；「等隊長／等成員結果」狀態規則同樣適用。
- `spawn_member` 預設開和隊長同一種 agent；隊長可以指定另一種（例如 Claude 隊長開 Codex 審查員）。
- MCP 工具的權限在 Codex 那邊要確認不會被 approval 擋（實測確認 `-c` 帶入的 MCP 是否需要信任／核准）。

## 4. Codex 用量統計

- daemon 的用量掃描（現有 Claude 那套）加讀 `~/.codex/sessions/**/*.jsonl` 的 token 統計事件（格式先用本機實際檔案確認），依日期×模型×session 彙總，和 Claude 的資料一起送 hub。
- 用量頁加「代理」維度（Claude／Codex），圖表可以分開或合計看。
- 只讀檔、不呼叫任何 API；讀不懂的行略過、不中斷整次掃描。

## 5. 測試與實測

- 單元與 e2e 一律用假 claude、假 codex（第一版已有 `fake-codex.mjs`）。
- **真 CLI 實測要 GM 另外同意**：第一版 GM 給的 10 次短指令已用 5 次；交叉審查與 Codex 派工的實測需要額度時，先列出要跑幾次、用哪個模型，再問 GM。

## 6. 實作順序

1. Codex 用量統計（最獨立、風險最低）。
2. Codex 派工（MCP 帶入、結果送回）。
3. 交叉審查（schema v11、daemon 執行、網頁並排、隊長 `request_review`）。
