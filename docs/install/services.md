# 開機自動啟動與發布

[English](services.en.md)

安裝腳本會依平台產生服務設定，模板在 `deploy/`，填值與跳脫在 `scripts/lib/service-templates.mjs`。一般使用者不用看這份。

## 各平台做法

| 平台    | 機制                                                 | 什麼時候啟動 | 當掉時       | 驗證狀態                       |
| ------- | ---------------------------------------------------- | ------------ | ------------ | ------------------------------ |
| macOS   | LaunchAgent（`~/Library/LaunchAgents`）              | 登入桌面時   | 10 秒後重啟  | 設定檔與環境已驗證，未真的載入 |
| Linux   | systemd `--user`（`~/.config/systemd/user`）+ linger | 開機時       | 10 秒後重啟  | **未驗證**，只檢查過設定檔內容 |
| Windows | 工作排程器（`AgentBoard-hub`、`AgentBoard-daemon`）  | 登入時       | 1 分鐘後重啟 | **未驗證**，只檢查過設定檔內容 |

`launchctl`、`systemctl`、`schtasks` 只有安裝與解除安裝時會呼叫。正常結束（exit 0，例如停止服務）不會被重啟。還沒配對的 daemon 會以 exit 1 結束，服務反覆重試，所以配對完不用手動啟動。

## 環境變數

服務的環境不是你的 shell 環境，尤其 launchd 的 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`。安裝腳本會在設定檔明確寫入：

- `PATH`：node 所在資料夾、claude 所在資料夾、安裝當下的 `PATH`、常見位置，依序去重。`claude` 工作時要用到的工具也靠它。**之後才裝的工具若不在這些資料夾，要重跑安裝腳本。**
- `AGENT_BOARD_CLAUDE_BIN`：`claude` 的絕對路徑。
- `LANG`、`SHELL`、`HOME`：launchd 不帶語系，少了 `LANG` 中文會變亂碼。
- 安裝時有設 `CLAUDE_CONFIG_DIR` 或 `AGENT_BOARD_DATA_DIR` 就一起帶入。

機器 token 不會寫進去，只在 `machine.json`。

## 在 Agent Board session 裡更新

安裝程式更新程式時會重啟 daemon，而 Agent Board 開的 session 都跑在 daemon 底下，所以在這種 session 裡直接跑 `install.sh`，安裝程式會和 session 一起被結束，daemon 就起不來。`install.sh` 看到 `AGENT_BOARD_SESSION_ID` 時會自動改在背景執行（新的 process session、沒有終端機），輸出寫到 `~/.agent-board/logs/install-<時間>.log`，最後一行是「安裝結束，結束碼 N」。要強制在前景跑，設 `AGENT_BOARD_INSTALL_DETACHED=1`。Windows 的 `install.ps1` 沒有這個處理。

## hook 怎麼被找到

daemon 開 session 前會確認找得到 `agent-board-hook`，找不到就拒絕開（否則危險指令檢查會被靜默跳過）。發布檔的 `daemon/dist/index.mjs` 用相對路徑找 `daemon/node_modules/.bin/agent-board-hook`，daemon 再把這個資料夾加進 PTY 的 `PATH`，所以那個資料夾只放 hook，不放別的執行檔。

`~/.local/bin/agent-board-hook` 是另一條路：你自己開 `claude` 時，專案設定裡的 hook 一樣會被呼叫，它沒有 session 標記會立刻 exit 0，不會出現 exit 127 的錯誤。

## Windows 為什麼用工作排程器，不用服務

|          | 工作排程器（採用）                       | Windows 服務                      |
| -------- | ---------------------------------------- | --------------------------------- |
| 權限     | 一般使用者即可                           | 安裝要系統管理員                  |
| 身分     | 登入的使用者，讀得到 `claude` 的登入狀態 | 預設 SYSTEM，要另外設帳密才讀得到 |
| 工作階段 | 互動式工作階段                           | Session 0，沒有桌面               |
| 啟動時機 | **登入後**                               | 開機後，不用登入                  |
| 當掉重啟 | 1 分鐘後，最多 999 次                    | 可設定                            |

代價是 Windows 重開機後要登入才會跑。需要開機就跑的話，可以開啟 Windows 自動登入。

部分公司環境不准一般使用者建立登入觸發的工作。這時安裝腳本會退回放在啟動資料夾：登入會啟動，但當掉不會重啟，安裝時會印出提醒。

背景執行靠 `conhost.exe --headless`，不會多出終端機視窗（Windows 10 1809 以上）。

## 發布（維護者）

```sh
corepack pnpm build:release   # 產生 release/
corepack pnpm smoke:release   # 僅 macOS：裝到臨時 HOME，用假 claude 走完配對與開 session
corepack pnpm test:install    # 服務模板跳脫
corepack pnpm notices         # 依賴有變時更新 THIRD_PARTY_NOTICES.md
corepack pnpm screenshots     # 畫面有變時更新 docs/screenshots/（demo 假資料）
```

正式發版改成打 tag（CONTRACTS §21）：`package.json` 的 `version` 改好、commit、`git tag v<版本>`、push tag，
`.github/workflows/release.yml` 會在 macos-14 與 windows-latest 各建 `agent-board-<版本>-<平台>` 成品、合併 `SHA256SUMS` 放到 Release；
hub 每 10 分鐘用已登入的 `gh` 查到後設為 canary，各機 daemon 經 hub 自動更新。本機 `build:release` 只產生這台平台的成品，
給第一次安裝與緊急修復（`install.sh --from`）用。

`corepack pnpm e2e:update`（先 `build:release`）用本機成品當假 Release，走一次 canary 自動更新與壞版回滾。

**第一次發布前：** 把 `README.md`、`README.zh-TW.md`、`scripts/install.sh`、`scripts/install.ps1` 裡的 `OWNER` 換成實際的 GitHub 帳號或組織。還是 `OWNER` 時，安裝腳本會要求用 `--from`，不會去下載。

`smoke:release` 把 `launchctl`、`systemctl`、`loginctl` 換成只會記錄參數的假程式，不會動到這台機器的系統服務。
