# CONTRACTS 摘要

`../CONTRACTS.md`（約 71KB）的一頁索引，2026-11-08 整理。以原檔為準；型別唯一來源是 `packages/protocol`（zod），只有 Lead 能改。

| § | 標題 | 重點 |
|---|---|---|
| 1 | 共通約定 | 用 `corepack pnpm`；時間 ISO 8601、ID 用 randomUUID；API camelCase、SQLite snake_case；不寫死使用者資料；中控台不得呼叫 LLM。 |
| 2 | 架構與資料歸屬 | PTY／快照／approval 歸 daemon，hub 不存終端機資料；中繼資料、layout、團隊、audit 歸 hub SQLite。含團隊事件、權限與提問。 |
| 3 | Session 生命週期 | POST → hub 寫入（限流或超量則 queued）→ daemon 建 worktree、合併 hook、開 PTY。3.1–3.5：開 PTY、daemon 重啟、斷線、排隊、額度恢復後自動接續。 |
| 4 | Hook 協定 | 開 session 時寫入 `.claude/settings.local.json`；`agent-board-hook` CLI；危險指令攔截（不是安全邊界）；網頁核准。 |
| 5 | 狀態機 | Hook 事件到狀態的對照表；SessionStart 標 `waiting_input` + `idle:start`（剛開好，不算等你）。5.1 daemon 內部介面。 |
| 6 | WebSocket | `/ws/daemon`（Bearer token）、`/ws/client`（cookie＋Origin）；未登入一律 401；zod 驗證失敗回 error 不斷線。6.1 終端機串流、6.2 資源、6.3 資料夾瀏覽與 repo。 |
| 7 | REST | 路由在 `protocol/src/rest.ts`；auth 分 public／user／owner；錯誤用 `ApiError`；argon2＋httpOnly、SameSite=Strict cookie。 |
| 8 | 前端 | 依賴方向 canvas、flows → terminal → shared；`shared/` 與 `App.tsx` 只有 Lead 能改；畫面只透過 `BoardBackend`。 |
| 9 | 封存、刪除、看舊資料 | 先封存才能刪；刪除不碰使用者專案檔、audit_log 保留；schema v3 加 `archived_at`。9.1–9.6：封存／還原、檢查、對話紀錄、刪除（owner）、前端、並行防護。 |
| 10 | 通知與「等你」 | `protocol/src/attention.ts` 的 `sessionWaitsForUser` 定義等你（排除 `idle:start`）；10.2 合併通知、10.3 同時等你上限（預設 3）、10.4 設定頁。 |
| 11 | session 派工（MCP） | GM 只跟一個 session 講話，它自己開成員、派工、收結果；不呼叫模型。11.1–11.6：架構、工具、`spawn_member` 規則、結果自動送回、紀錄與畫面、已知限制。 |
