# 發版與自動更新規格（2026-11-11）

來源：`docs/dispatch/2026-11-09_派工補充_AI接口與多機部署.md` §14.3–14.7（外層 repo）。session host 已上架（CONTRACTS §20），daemon 重啟不會中斷 agent，這份規格建立在它上面。

## 0. GM 決定（2026-11-11）

| 項目 | 決定 |
| --- | --- |
| 成品在哪 build | GitHub Actions：打 tag `v0.x.y` 後依平台建 `darwin-arm64`、`win-x64`，附 SHA-256 放到私人 repo 的 Releases |
| 各機從哪下載 | **hub 代轉**：只有 Mac mini 的 hub 用已登入的 `gh` 從 Releases 下載；各機 daemon 用既有機器權杖經 tailnet 向 hub 下載。其他機器不放 GitHub 權杖 |
| hub 自己的更新 | 跟 stable 自動更新：先備份資料庫，健康檢查失敗自動回滾 |
| dev 實例（§14.6） | 這輪一起做 |

## 1. 現況（main `fb08cb7`）

- 上架方式：在 Mac mini 本機 `corepack pnpm build:release` → `release/agent-board.tar.gz`，`scripts/install.sh hub|daemon --from <dir>` 裝到 `~/.local/share/agent-board/app`（單一資料夾，沒有版本），MacBook 用 Taildrop 手動傳。
- 版本只有 `app/BUILD_ID`（內容雜湊），沒有語意版本、沒有 tag、沒有 Releases。`.github/workflows/ci.yml` 只在 ubuntu 跑測試。
- hello 用 `features` 旗標判斷新舊，沒有 `protocolVersion`。
- session host 有自己的資料夾 `~/.local/share/agent-board/session-host/`，安裝程式只在協定或 node-pty 變了才換（換時要求沒有 RUN／PERM／PLAN／starting）。

## 2. 版本與成品

- 版本號：根目錄 `package.json` 的 `version`，tag `v<version>`；`BUILD_ID` 保留。daemon 與 hub 在 hello／`/api/health` 回報 `version` 與 `buildId`。
- 成品：`agent-board-<version>-darwin-arm64.tar.gz`、`agent-board-<version>-win-x64.zip`、`SHA256SUMS`。內容和現在 `build:release` 一樣（含 node-pty 對應平台的原生檔、session host、hub、daemon、web dist、安裝程式）。
- Workflow `.github/workflows/release.yml`：`on: push: tags: ['v*']`；`macos-14`（arm64）與 `windows-latest` 各跑 install → test（只跑單元，e2e 留在本機）→ build:release → 上傳到該 tag 的 Release（`gh release create/upload`，用 `GITHUB_TOKEN`）。ubuntu CI 不變。

## 3. 安裝配置（各機）

```
~/.local/share/agent-board/
  releases/<version>/      # 每版一個資料夾，保留最近 3 版
  current -> releases/<version>   # Mac 用 symlink；Windows 用目錄連接（junction）
  session-host/            # 不變（§20）
  install.json             # 加 currentVersion、previousVersion、channel 不放這裡
```

- launchd plist、Windows 工作排程器改指向 `current/…`，換版只換 `current`。
- 第一次升級：安裝程式把現有 `app/` 搬成 `releases/<目前版本或 0.0.0-legacy>/`、建立 `current`，再裝新版。
- 回滾＝把 `current` 指回上一版並重啟 hub／daemon。

## 4. 通道與目標版本（hub）

- hub settings：`release.canary`、`release.stable`（版本字串）；每台機器的通道存 settings `machineChannel:<machineId>`（`canary`／`stable`，預設 stable；MacBook 設 canary）。派工單原文寫在各機 `machine.toml`，改放 hub 是為了在機器面板直接切換，不用登進各機。
- 新 tag 出現時（hub 每 10 分鐘用 `gh release list` 查，或面板按「檢查新版」）：hub 下載成品到 `~/.agent-board/release-cache/<version>/`、驗 SHA-256，成功後設為 canary 目標。
- 「升為 stable」：面板按鈕；按鈕旁顯示 canary 已跑多久、期間 canary 機器的 ERR／崩潰／更新失敗次數（派工單：用滿 24 小時無錯誤再升）。不到 24 小時也能按，但要再確認一次。

## 5. daemon 更新流程

1. daemon 每次連上 hub，hello 帶 `version`、`platform`。hub 回應裡帶「這台的目標版本」。
2. 目標版本和自己不同 → 檢查延後條件：有 session 在 PERM（`waiting_permission`）就延後；這次更新需要換 session host 而有 RUN／PERM／PLAN／starting 也延後。延後時每 5 分鐘再檢查，hub 面板顯示「延後：原因」。
3. 開始更新：daemon 啟動**獨立的更新程式**（`agent-board-updater`，從新版裡跑，detached，不是 daemon 的子程序，避免 daemon 重啟時被一起收掉）：
   - 從 hub `GET /api/releases/<version>/<platform>`（機器權杖驗證）下載 → 驗 SHA-256 → 解壓到 `releases/<version>`。
   - 這台有 hub（Mac mini）：先 `sqlite3 .backup` 備份 hub.db（600）。
   - 執行新版的安裝程式（等同現在的 `install.sh hub/daemon --from releases/<version>`，但只換 `current` 與服務定義）。
4. 健康檢查（60 秒內）：新 daemon 連上 hub 並回報新版本；有 hub 的機器另外要 `/api/health` 回 200。更新程式輪詢本機狀態檔與 health。
5. 失敗 → 自動回滾：`current` 指回舊版、重啟服務；若這次升級改了 hub.db schema，用第 3 步的備份還原（回滾窗口只有 60 秒，損失極小）。結果寫到 `~/.agent-board/update-state.json`，daemon 下次連上 hub 時回報，hub 面板標「更新失敗：原因」，推播通知 GM（不帶 Claude 寫的內容）。
6. 保留最近 3 版，舊的刪掉（不刪 `current` 與上一版）。

hub 的更新也走第 3–5 步（hub 和 daemon 在同一台，由那台 daemon 啟動更新程式）。hub 重啟期間 daemon 斷線重連，session host 讓 agent 不中斷。

## 6. 版本相容（§14.4）

- hello 增加 `protocolVersion`（整數，從 1 開始）；hub 接受目前版與前一版。差太多：hub 回 `daemon.rejected{reason:'needs_update'}`，daemon 不斷線重試轟炸，改成每 5 分鐘試一次，hub 面板顯示「需要更新」。既有 `features` 旗標保留。
- schema：從 v11 起採「先加欄位、下一版才刪」，寫進 CONTRACTS。

## 7. 機器面板（§14.4）

疊加面板（不另開分頁，沿用 P2 的面板元件）：各機名稱、平台、版本、通道（可切換）、最後連線、更新狀態（最新／更新中／延後：原因／失敗：原因）、按鈕「立即更新」「回滾到上一版」。上方：canary／stable 目前版本、「檢查新版」、「升為 stable」。

## 8. dev 實例（§14.6）

- `scripts/dev-instance.sh start|stop|status`：從工作目錄（不是 release）跑一套獨立的 hub＋daemon＋session host：連接埠 8024、資料夾 `~/.agent-board-dev`、機器名稱加 `-dev`、不建 launchd、不推播。
- dev 只綁 127.0.0.1；要從別台看就自己 `tailscale serve` 另一個埠（不自動做）。
- 正式版只從 tag 的 Release 更新；不從畫布裡的 session 部署自己（派工單 §14.6）。現有 `install.sh --from` 保留給第一次安裝與緊急修復。

## 9. 完成條件（§14.7 第 1 點）

打 tag 發版 → canary（MacBook）自動更新 → 升 stable → Mac mini 自動更新（hub＋daemon）→ 故意發一個壞版（只給 canary）確認自動回滾 → 兩台重開機後自動上線（Mac mini 重開機要 GM 在家）。

## 10. 不在這輪

Windows 實機安裝（`install.ps1` 一行安裝、i7／4060，見 §14.2、§14.7 第 2–4 點）。win-x64 成品這輪要建得出來，但不實測安裝。
