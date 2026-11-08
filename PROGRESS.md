# 開發進度

## Phase 0 — 骨架與合約

### 做了什麼

- pnpm monorepo、TypeScript、ESLint、Prettier、CI 設定。
- `packages/protocol`：所有資料模型、hook、WebSocket、REST 的 zod schema，8 個測試。
- `CONTRACTS.md`、`docs/claude-code-notes.md`、`docs/design/STYLE.md`（新風格「塔台 × 放手線」）。
- `packages/web/src/shared`：後端介面、假資料、狀態視覺、i18n、token。
- `packages/daemon/src/status/types.ts`：Agent A 與 B 的介面。

### 卡在哪

- `PermissionRequest` hook 卡住時原生對話框的行為未驗證，要接真 `claude` 才知道（`docs/claude-code-notes.md`）。
- 派工單 §5.3 的設計稿尚未放進 `docs/design/`。

### 下一步

Phase 1 平行派工。

## Phase 1 — 平行開發

六個分支（A daemon、B hooks 與狀態、C hub、D 畫布、E 終端機、F 流程畫面）都由 Lead 重跑驗收後合併進 main。

## Phase 2 — 整合

### 做了什麼

- 接線：daemon 接真狀態機與 hook 安裝；`shared/hubBackend.ts` 接真 hub；`App.tsx` 加登入閘門、頁首、PWA。
- `packages/web/e2e/integration.spec.ts`：真 hub、daemon、hook CLI、瀏覽器，只有 claude 是假的。
- 接真 `claude`（haiku）驗證，結果記在 `docs/claude-code-notes.md`。

### 真 claude 抓到、假 CLI 測不出來的問題（都已修）

- 不帶 `--permission-mode` 時用使用者的預設模式：畫面寫每步問你，實際是 auto。
- 在終端機回答後，網頁核准卡片不會消失。
- 網頁允許後，長指令全程顯示「等你允許」。
- 計時器每秒重畫，卡住偵測永遠不觸發。
- 信任對話框期間一直顯示啟動中。
- 從 Claude Code 裡啟動 daemon 會繼承 session 標記與憑證，對話紀錄不存。
- 摘要卡顯示輸入框與狀態列，不是對話。
- plan 模式的 `Stop` 被當成交出計畫。

### 卡在哪

- 只用一台機器跑兩個 daemon，沒有實體第二台。macOS 以外沒測過。
- 真實注音、拼音未驗證（只有 CDP 模擬）；手機實機、真實 Web Push、PWA 安裝未驗證。
- 額度顯示沒有資料來源；context 百分比暫以 200k 計算，且 `startup` 時沒有數值。（2026-11-03 已改，見下方「額度排隊、context 上限、同 repo」）
- `CLAUDE_CONFIG_DIR` 多帳號未驗證。

## Phase 3 — 團隊、安全、安裝

三個分支由 Lead 重跑驗收後合併進 main。

### 做了什麼

- G：團隊工作台、任務板、請隊長拆解、交接規則引擎、`file.changed` 事件、worktree 檢查。
- H：危險指令改解析實際執行的指令、遮蔽模式、監聽位址只接受私有 IP、Host 白名單（防 DNS rebinding）、收緊 CSP、audit 密碼遮蔽、資料保留、移除機器時停掉 session、`docs/security-checklist.md`。
- I：打包（`corepack pnpm build:release`）、安裝腳本、launchd／systemd／工作排程器模板、中英 README、截圖、`THIRD_PARTY_NOTICES.md`。
- 真 claude 驗過交接（`on_file`）。

### 卡在哪

- `!` 模式的危險指令行為沒有定論；agent 自己改 hook 設定、使用者層 hook 搶先允許都未驗證。
- 真 launchd、Linux、Windows、實體第二台機器、真人照 README 走完 10 分鐘，都未驗證。
- 同 repo 兩個不相干子資料夾（`repo/a`、`repo/b`）擋不到，hub 不知道 repo 根目錄。（2026-11-03 已改，daemon 回報 `repoRoot`）
- 測試資料含金鑰形狀的假字串，轉公開時可能觸發 GitHub secret scanning。

### 下一步

Phase 4 需要 GM 決定：公開 repo 位置、LICENSE、版本號；實機測試環境。

## 上架到 Mac mini（2026-11-02）

GM 決定先自用，尚未公開發布。步驟、驗證結果與缺口在上層的 `HANDOFF.md`。

- 真 launchd 下的 hub、daemon、`claude`、hook、網頁核准、wss、`Secure` cookie 都通過。
- 新缺口：沒有改密碼介面；回答信任對話框後 `statusDetail` 留在 `trust`（無可見影響）；登入後語言不套用帳號設定。
- 未驗證：別台裝置、重開機。

## 補齊 DISPATCH 漏做的項目（2026-11-03）

- 手機推播：service worker、設定頁開關、點通知開收件匣（§5.2、§10）。
- 用量：daemon 統計的 token 顯示在頁首與側欄（§5.1）。
- 操作紀錄查詢與匯出（§7）、改密碼。
- 全尺寸終端機頁 `#/terminal/<id>`（§5.3 畫面 5）、完成時提示 `/clear` 或封存（§8.6）。
- hub：使用者標記完成後同一個行程又開始工作時，取消完成狀態。
- 測試：單元 1072、端對端 175、打包冒煙 21、安裝 6，全過。已重新上架。

## 終端機尺寸、摘要卡輸入、畫布字級（2026-11-03）

- 摘要卡輸入框：原生對話框在等決定（`waiting_permission`、`plan_review`、提問、危險指令）時停用，不再把 `1`、Enter 送進 PTY；說明改按核准按鈕或放大進 xterm（`canvas/dialogBlock.ts`）。xterm 內照原生操作。
- 畫布 54%–89%：摘要條在螢幕上的倍率封頂 1.15（`canvas.css` 的 `.strip`），70% 字從 17.9px 降到 13.8px。
- 多瀏覽器尺寸：改成尺寸擁有者制（CONTRACTS §6.1 第 6 點），新增 `terminal.size`、`terminal.resize.claim`；沒人看 30 秒後 PTY 回預設尺寸。
- 未驗證：真 claude 在跟隨端縮放顯示時的滑鼠選取位置；手機實機。

## 額度排隊、context 上限、同 repo（2026-11-03）

- §8-5：同帳號（同機器＋同 `accountProfile`）有 session 限流時，新建與接續的 session 排隊，`statusDetail` 為 `queue:rate_limited`，卡片寫「等帳號額度恢復」；限流 session 離開 `rate_limited` 或訊息裡的重置時間過了就自動開始。設定 `quotaGuards.queueWhenRateLimited`（預設開），設定頁可關，新 session 預覽會說明會排隊。規則見 CONTRACTS §3.4。
- context：daemon 依模型 id 推上限（`[1m]` 或內建模型目錄表），回報 `contextWindow`；不知道就不畫百分比。`Stop` 時從對話紀錄更新用量，新對話不再一直沒有數值。來源見 `docs/claude-code-notes.md`「Context 上限」。
- 同 repo：daemon 回報 `repoRoot`、`repoCommonDir`（session 與資料夾瀏覽），新 session 頁與團隊成員檢查改用 working tree 根目錄判斷；同 repo 但各自在 linked worktree 的不算衝突，新 session 頁只告知。
- 未驗證：真實限流訊息與重置時間格式、`SessionStart.model` 是否帶 `[1m]`、`CLAUDE_CODE_DISABLE_1M_CONTEXT`。

## P2 項目二：工作區＋團隊名單面板（2026-11-08，分支 `feat/p2-workspaces`，未合併、未上架）

- schema v9：`zones` 表（預設「主要」id `main`）、`teams.zone_id`、`sessions.zone_id`、`notes.workspace` 改名 `zone_id`；外鍵用觸發器（理由見 CONTRACTS §13）。舊資料全部歸「主要」，`layouts` 不動。升級時照舊自動備份 `-v8`。
- 程式內工作區叫 zone，和 `layouts.workspace`（版面組）分開。
- 頁首工作區分頁（等你數、+、右鍵／長按改名刪除、超過 6 個收「更多」、手機下拉）；畫布只畫目前工作區；團隊框標籤拖到分頁、團隊面板下拉、卡片選單都能移；跨工作區的「下一個」與連結會先切過去。
- 團隊面板：名單（狀態代碼、角色可改、時間、點列聚焦）、原工作台區塊收合、寬版、底部群發（不確認、@ 點名、每列結果、排隊可取消、全部暫停中照送並提示）。群發走 hub 的 `SafeDelivery`（`manual`，不受暫停擋）。
- 角色加「測試」（tester）：可寫、預設 `default`、開 worktree、可被派任務、不當審查、MCP 可開。
- 測試：單元 1601（protocol 42、web 356、hub 469、hook 91、daemon 643）；e2e canvas 94、flows 146、team 49（含新的 workspaces 13）、expanded 7、integration 15、team-integration 9、account-integration 5、resize-integration 2、push 4、security 14、terminal 18，全過。
- 未驗證：真 claude、手機實機、iPhone 拖曳（不支援，手機用下拉）、多個使用者各自版面下的「移入時排右側」（只在移動當下開著畫布的裝置上排）。
