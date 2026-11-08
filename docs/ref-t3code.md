# T3 Code 參考筆記

來源 pingdotgg/t3code（MIT）commit 09a54f0（2026-11-08）。本機 clone 在專案資料夾外的 `ref/t3code`
縮寫：S=apps/server/src、O=S/orchestration-v2

## 1 對話串＝worktree，一鍵 PR

- 開串：`S/vcs/GitVcsDriverCore.ts` createWorktree 跑 `git worktree add`，路徑＝worktrees根/repo名/分支名（>40字截斷＋hash）；根目錄在 `S/worktreesDirectory.ts`
- 先用暫時分支，`O/ThreadLaunchService.ts` generateBranchNameFor 拿第一則訊息叫 LLM 取名再 rename
- PR：`S/git/GitManager.ts` runStackedAction（commit / commit_push / commit_push_pr）；generatePrContent 餵 diff（上限 60KB）＋對話摘要＋repo PR 範本產標題與內文
- 借：路徑規則、暫名→改名、截斷 diff 餵 LLM 產標題後 `gh pr create`
- 不借：多 git 平台抽象、Effect 框架

## 2 手機通知與核准

- 狀態對應 `packages/shared/src/agentAwareness.ts`：starting/running/waiting_for_approval/waiting_for_input/completed/failed
- `S/relay/AgentAwarenessRelay.ts`：completed 先等 5 秒確認（避免接續 run 誤推）；只推 server 啟動後才完成的
- `infra/relay/src/agentActivity/agentActivityAlerts.ts`：只在「進入」需注意狀態時推、沒有前一份狀態不推、完成/失敗超過 2 分鐘不推、四類可各自關
- App 正在看該串就不跳通知（mobile `foregroundNotificationBehavior.ts`）；iOS 有 Live Activity
- 核准在 App 內 `apps/mobile/src/features/threads/PendingApprovalCard.tsx`：允許一次／本 session 都允許／拒絕
- 通知本身帶核准按鈕：沒找到
- 借：5 秒去抖、2 分鐘過期、正在看就不推、「本 session 都允許」、通知偏好分類
- 不借：自架 APNs/FCM relay（我們用 Web Push）

## 3 中途換模型／provider

- 介面 `packages/provider-core/src/server/ProviderAdapter.ts`：startTurn/steerTurn/interruptTurn/respondToRuntimeRequest/rollbackThread/forkThread＋events stream
- 決策 `O/ProviderSessionTransitionPolicy.ts` decideProviderSessionTransition 回 reuse / switch_model_in_session / restart_and_resume / create_with_handoff / reject；`O/ProviderSwitchService.ts` 決定釋放哪些 session
- 跨 provider 用 `O/ContextHandoffService.ts` 產摘要交接（有 token 上限）
- 借：五種轉換＋adapter 自報能力（planSelectionTransition）
- 不借：十多家 adapter；我們只有 claude CLI

## 4 多串並行不卡

- `O/Adapters/ProviderTextDeltaCoalescer.ts`：文字 delta 每 50ms 合併一次再送
- `O/LiveStreamBudget.ts`：每連線最多 1000 筆、8MB，同 key 只留最新
- 終端機是自寫 libghostty WASM＋Canvas（`apps/web/src/terminal/ghostty/`），非 xterm。surface.ts setVisible(false) 仍收資料但停畫、rAF 一幀只畫髒列、render 不碰 React state
- 借：畫布外卡片 setVisible 停畫（xterm 可用 IntersectionObserver 達成）、50ms 合併、server 端緩衝上限
- 不借：換 ghostty 渲染器，成本太高

借用程式碼時要保留 MIT 版權聲明並登記到 THIRD_PARTY_NOTICES.md
