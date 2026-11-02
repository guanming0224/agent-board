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
- 額度顯示沒有資料來源；context 百分比暫以 200k 計算，且 `startup` 時沒有數值。
- `CLAUDE_CONFIG_DIR` 多帳號未驗證。

### 下一步

Phase 3：G 團隊、H 安全、I 安裝與文件。
