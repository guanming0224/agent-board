# Claude Code 介面筆記

查證日期 2026-11-02，本機版本 `claude` 2.1.316。來源：`claude --help`、官方文件 `code.claude.com/docs/en/{hooks,cli-reference,env-vars,permission-modes}`（`docs.anthropic.com` 的舊網址已 301 轉到這裡）。
標「未驗證」的項目在 Phase 2 接真 `claude` 時要確認。

## CLI 旗標

| 旗標                        | 用途        | 備註                                                                                                                                                                                                                                                                                  |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--permission-mode <mode>`  | 權限模式    | 文件：`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`；`manual` 是 `default` 的別名（v2.1.200+）。`--help` 列的是 `manual` 而不是 `default`，所以一律傳 `manual`。**不可以不帶旗標**：實測（2.1.316）不帶時 claude 用使用者設定的預設模式，這台機器會進 auto |
| `--model <model>`           | 模型        | 別名或完整名稱                                                                                                                                                                                                                                                                        |
| `--session-id <uuid>`       | 指定對話 ID | 必須是合法 UUID。daemon 用它預先決定 `claudeSessionId`，不用等 hook 回報                                                                                                                                                                                                              |
| `-r, --resume [id\|name]`   | 接續對話    | daemon 重啟與「接續舊對話」用                                                                                                                                                                                                                                                         |
| `-n, --name <name>`         | 顯示名稱    | 顯示在 prompt、`/resume`、終端機標題                                                                                                                                                                                                                                                  |
| `--settings <file-or-json>` | 額外設定    | 本專案依 DISPATCH §5.1 改寫 `settings.local.json`，不用這個                                                                                                                                                                                                                           |

環境變數 `CLAUDE_CONFIG_DIR`（預設 `~/.claude`）：設定、對話紀錄、外掛都在此路徑下，官方說明可用來並存多帳號。**只能從環境變數或使用者設定指定**，專案與 local 設定檔裡的會被忽略，所以 daemon 要在開 PTY 時放進 env。憑證儲存位置見官方 authentication 文件（未驗證 macOS Keychain 下是否真能分帳號）。

## 權限模式實際行為（官方表格）

| 模式                | 不經詢問會執行                                                                |
| ------------------- | ----------------------------------------------------------------------------- |
| `default`           | 只讀                                                                          |
| `acceptEdits`       | 讀、改檔、常見檔案指令（mkdir、touch、mv、cp…）                               |
| `plan`              | 讀，auto 可用時加上分類器核可的指令                                           |
| `auto`              | 全部，有背景安全檢查                                                          |
| `dontAsk`           | 工作目錄內讀檔與事先允許的工具；**其餘自動拒絕**，明確的 `ask` 規則也會被拒絕 |
| `bypassPermissions` | 全部。Deny 規則仍有效；Allow 規則無作用                                       |

## Hooks

設定三層：事件 → matcher 群組 → handler。Notification 的 matcher 比對 notification type。

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "agent-board-hook Stop", "timeout": 600 }] }
    ]
  }
}
```

- `timeout` 單位秒；`command` 預設 600。**SessionEnd 預設只有 1.5 秒**，可用該 hook 的 `timeout` 拉長（上限 60）。
- Exit code：0 成功（stdout 若是單一 JSON 物件就套用）；2 阻擋（stderr 當原因）；**其他值是非阻擋錯誤，動作照常進行**。
- 事件全名共 33 個；本專案只裝下表。

共用 stdin 欄位：`session_id`、`prompt_id`、`transcript_path`、`cwd`、`scratchpad_dir`、`permission_mode`、`effort`、`hook_event_name`。子代理內觸發時多 `agent_id`、`agent_type`。**Notification 的文件範例沒有 `permission_mode`**，不可假設每個事件都有。Manual 模式傳 `"default"`。

| 事件                                | 專屬欄位                                                                          | 本專案用途                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`                      | `source`（startup/resume/clear/compact/fork）、`model`、`context_tokens`          | 更新 `claudeSessionId`（`/clear` 會換 id）、context 用量                                                                   |
| `UserPromptSubmit`                  | `prompt`                                                                          | → `running`                                                                                                                |
| `PreToolUse`                        | `tool_name`、`tool_input`、`tool_use_id`                                          | → `running`；危險指令比對                                                                                                  |
| `PermissionRequest`                 | `tool_name`、`tool_input`、`permission_suggestions`（沒有 `tool_use_id`）         | 網頁核准                                                                                                                   |
| `PostToolUse`、`PostToolUseFailure` | `tool_name`、`tool_input`、`tool_use_id`                                          | → `running`（核准後離開 `waiting_permission`）。`PostToolUseFailure` 的專屬欄位未逐字查證                                  |
| `Notification`                      | `message`、`title`、`notification_type`                                           | `permission_prompt` → `waiting_permission`；`idle_prompt` → `waiting_input`                                                |
| `Stop`                              | `last_assistant_message`、`stop_hook_active`、`background_tasks`、`session_crons` | → `waiting_input`，或 plan 模式 → `plan_review`；交接摘要來源（文件明說不要讀 transcript，它在 Stop 當下不保證有最後一則） |
| `StopFailure`                       | `error`、`error_details`、`last_assistant_message`                                | `error=rate_limit` → `rate_limited`，其他 → `error`                                                                        |
| `SessionEnd`                        | `reason`                                                                          | 記錄                                                                                                                       |

`Stop` 不會在使用者中斷時觸發；API 錯誤走 `StopFailure`。`StopFailure`、`SessionEnd`、`Notification` 都無法影響流程，輸出被忽略。

`notification_type` 的值：`permission_prompt`、`idle_prompt`、`auth_success`、`elicitation_dialog`、`elicitation_url_dialog`、`elicitation_complete`、`elicitation_response`、`agent_needs_input`、`agent_completed`、`quota_auto_resume_fired`、`quota_auto_resume_stale`、`quota_auto_resume_disabled`、`plugin_notification`。

### 決策輸出

`PreToolUse`（`permissionDecision`：`allow`、`deny`、`ask`、`defer`）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "..."
  }
}
```

`PermissionRequest`（`behavior`：`allow`、`deny`；deny 可帶 `message`、`interrupt`；allow 可帶 `updatedInput`、`updatedPermissions`）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

「允許並記住」＝`updatedPermissions` 帶入 `permission_suggestions` 的項目。

## 影響設計的發現

1. **限流有結構化訊號**：DISPATCH §4 寫「輸出偵測」，但 `StopFailure.error == "rate_limit"` 更可靠。以 hook 為主、輸出偵測為輔。
2. **危險指令不能靠 `ask`**：`dontAsk` 下 `ask` 會被直接拒絕，`bypassPermissions` 下未查證。所以 `PreToolUse` 命中時由 hook 自己卡住等網頁決定，再回 `allow`／`deny`，不受權限模式影響。
3. **rm/rmdir 關鍵路徑**：即使 PreToolUse 回 `allow` 也無法批准，這是 Claude Code 自己的保護，介面要能顯示被拒結果。

## 實測結果（2.1.316，真 claude，haiku）

- **`PermissionRequest` hook 卡住時，原生對話框同時顯示。** 從網頁決定後對話框自動消失，畫面寫 `Allowed by PermissionRequest hook`。網頁核准與「畫面和 CLI 一致」可以並存，不需要送按鍵。
- **直接在終端機回答時，Claude Code 不會結束卡住的 hook**，工具照跑。要從之後的 `PostToolUse`、`Stop` 推得已回答，否則網頁卡片會一直留著（`ApprovalManager.settleAnsweredInTerminal`）。
- **`PostToolUse` 要等工具跑完**，所以網頁決定當下就要離開 `waiting_permission`，否則長指令全程顯示「等你允許」。
- **不帶 `--permission-mode` 時用使用者設定的預設模式**（這台是 auto）。一律明確帶，`default` 傳 `manual`。
- **信任對話框**：新資料夾第一次開時出現，預設選項是 `No, exit`；回答前 hook 不會跑。從輸出偵測 `Yes, I trust this folder` 轉 `waiting_input`，字串可能隨版本變。
- **長指令期間每秒重畫**（計時器、spinner、提示輪換、工具行前的 `⏺` 每 0.6 秒閃爍），所以不能用「有沒有輸出」判斷卡住，要比對排除動畫後的畫面（`screenFingerprint`）。
- **從 Claude Code 裡啟動 daemon 時會繼承 session 標記**（`CLAUDE_CODE_CHILD_SESSION` 等，含憑證 `CLAUDE_CODE_MESSAGING_TOKEN`）：子 session 不存對話紀錄。daemon 開 PTY 前要濾掉。
- 閒置時畫面也可能出現新對話框（例如 `Teach auto mode about your environment?`），狀態仍是 `waiting_input`。
- **計畫走 `PermissionRequest`，`tool_name` 是 `ExitPlanMode`。** plan 模式下的 `Stop` 不代表交出計畫。
- **提問走 `PermissionRequest`，`tool_name` 是 `AskUserQuestion`**，`tool_input.questions[].question` 是問題原文。回 `allow` + `updatedInput.answers = { 問題原文: 答案 }`，模型就拿得到答案。
- **`bypassPermissions` 下 `PreToolUse` 回 `deny` 有效**，指令不會執行。
- `firstPrompt` 分開送 Enter 可行；`--resume` 接回同一段對話，舊內容還在；對話紀錄的 `message.usage`、`message.id` 欄位和實作一致。
- **交接在真 claude 上可行**：`on_file` 觸發後，目標收到 `[Handoff] Summary: … | Detected file edits: … | Branch: …`，模型會接手工作。
- **`!` 模式沒有定論**：輸入 `!git push --force origin main` 後，畫面出現一段別的指令、沒有 `UserPromptSubmit`、也沒有命中危險規則。指令實際怎麼執行還不清楚，視為未驗證。
- `SessionStart` 在 `startup` 時沒有 `context_tokens`，所以 context 用量一開始是 null。
- 這台機器上 `.claude/settings.local.json` 沒有顯示在 `git status`（原因未查，可能是全域 gitignore）。

## 未驗證（Phase 2 要測）

- [ ] `PermissionRequest` hook 卡住等待時，終端機的原生權限對話框會不會顯示、使用者直接在終端機回答時 hook 會怎樣。**這決定「網頁核准」和「畫面與 CLI 一致」能否並存**；若衝突，退路是只用 `Notification` 偵測，核准時對 PTY 送按鍵。
- [ ] `CLAUDE_CONFIG_DIR` 在 macOS 是否真能隔離帳號。
