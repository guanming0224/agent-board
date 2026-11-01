# Claude Code 介面筆記

查證日期 2026-11-02，本機版本 `claude` 2.1.316。來源：`claude --help`、官方文件 `code.claude.com/docs/en/{hooks,cli-reference,env-vars,permission-modes}`（`docs.anthropic.com` 的舊網址已 301 轉到這裡）。
標「未驗證」的項目在 Phase 2 接真 `claude` 時要確認。

## CLI 旗標

| 旗標                        | 用途        | 備註                                                                                                                                                                                                                      |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--permission-mode <mode>`  | 權限模式    | 文件：`default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`；`manual` 是 `default` 的別名（v2.1.200+）。`--help` 列的是 `manual` 而不是 `default`，所以傳 `manual` 較保險，或 `default` 時乾脆不帶旗標 |
| `--model <model>`           | 模型        | 別名或完整名稱                                                                                                                                                                                                            |
| `--session-id <uuid>`       | 指定對話 ID | 必須是合法 UUID。daemon 用它預先決定 `claudeSessionId`，不用等 hook 回報                                                                                                                                                  |
| `-r, --resume [id\|name]`   | 接續對話    | daemon 重啟與「接續舊對話」用                                                                                                                                                                                             |
| `-n, --name <name>`         | 顯示名稱    | 顯示在 prompt、`/resume`、終端機標題                                                                                                                                                                                      |
| `--settings <file-or-json>` | 額外設定    | 本專案依 DISPATCH §5.1 改寫 `settings.local.json`，不用這個                                                                                                                                                               |

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

| 事件                | 專屬欄位                                                                          | 本專案用途                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`      | `source`（startup/resume/clear/compact/fork）、`model`、`context_tokens`          | 更新 `claudeSessionId`（`/clear` 會換 id）、context 用量                                                                   |
| `UserPromptSubmit`  | `prompt`                                                                          | → `running`                                                                                                                |
| `PreToolUse`        | `tool_name`、`tool_input`、`tool_use_id`                                          | → `running`；危險指令比對                                                                                                  |
| `PermissionRequest` | `tool_name`、`tool_input`、`permission_suggestions`（沒有 `tool_use_id`）         | 網頁核准                                                                                                                   |
| `Notification`      | `message`、`title`、`notification_type`                                           | `permission_prompt` → `waiting_permission`；`idle_prompt` → `waiting_input`                                                |
| `Stop`              | `last_assistant_message`、`stop_hook_active`、`background_tasks`、`session_crons` | → `waiting_input`，或 plan 模式 → `plan_review`；交接摘要來源（文件明說不要讀 transcript，它在 Stop 當下不保證有最後一則） |
| `StopFailure`       | `error`、`error_details`、`last_assistant_message`                                | `error=rate_limit` → `rate_limited`，其他 → `error`                                                                        |
| `SessionEnd`        | `reason`                                                                          | 記錄                                                                                                                       |

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

## 未驗證（Phase 2 要測）

- [ ] `PermissionRequest` hook 卡住等待時，終端機的原生權限對話框會不會顯示、使用者直接在終端機回答時 hook 會怎樣。**這決定「網頁核准」和「畫面與 CLI 一致」能否並存**；若衝突，退路是只用 `Notification` 偵測，核准時對 PTY 送按鍵。
- [ ] plan 模式交出計畫時，是走 `Stop` 還是 `PermissionRequest`（`tool_name` 是否為 `ExitPlanMode`）。
- [ ] `bypassPermissions` 下 PreToolUse 回 `deny` 是否生效。
- [ ] 新 worktree 的信任對話框會擋住 hook 多久（`settings.local.json` 的 hook 在信任前不會跑）。
- [ ] `CLAUDE_CONFIG_DIR` 在 macOS 是否真能隔離帳號。
- [ ] 對話紀錄 JSONL 內的 usage 欄位（用量統計要讀）。
