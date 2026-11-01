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
