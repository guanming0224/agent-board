# 共用控制項：舊寫法 → 新寫法對照表

> 給接下來三個區域（畫布、收件匣、面板）替換寫死數值用。規則見 `STYLE.md` §5.1，token 在 `packages/web/src/shared/styles/tokens.css`，共用樣式在 `packages/web/src/shared/styles/controls.css`。
> 基礎層（`feat/ui-foundation`，2026-11-09）**只**新增 token 與共用樣式、修了確認過的 bug，各區寫死的數值都還在。

## 怎麼接

1. 元素加上共用 class（`.sm`、`.ghost`、`.icon`、`.act`…），再**刪掉**各區 CSS 裡重複的高度、內距、字級、底色、框色。各區 CSS 只留位置（margin、gap、grid、對齊）。
2. 寫死的數字換 token（下表）。找不到對應 token 的值，先往最近的一級靠，真的不行再提出來，不要新增一次性的數字。
3. `controls.css` 裡元素層的預設值（輸入框、`.row`、`.menu`、`.panel-head`、`.empty`）包在 `:where()`，權重 0；各區有寫就以各區為準。所以**沒刪掉各區的舊樣式，新樣式不會生效**。
4. 手機的 44px 規則只有元素權重，各區寫了 `min-height: 28px` 之類就會蓋掉它，要刪掉。輸入框 16px 字級下限是 `!important`（整合時改，iOS 聚焦放大不再受各區 `font:` 影響）。會動到 session 的動作加 `.act`。
5. 手機斷點：CSS 只用 `@media (max-width: 640px), (pointer: coarse)`（控制項尺寸在 controls.css 已處理，各區通常不用再寫）；版面切換的 JS 用 `shared/breakpoints.ts` 的 `PHONE_QUERY`。

## 數值 → token

| 舊值 | 新 token | 備註 |
|---|---|---|
| `min-height` 36、38、40 | `var(--ctl-h)` 36 | 標準 |
| `min-height` 28、30、32、34 | `var(--ctl-h-sm)` 32，或加 `.sm` | 精簡 |
| `min-height` 22、24（畫布反向縮放的小標籤） | `var(--ctl-h-xs)` 24 | 只給整理團隊、往來次數 |
| 手機 `min-height` 40、44、48 | `var(--ctl-h-touch)` 44（手機已自動套用，通常直接刪） | |
| 手機 `min-height` 52、56 | `.act`（`var(--ctl-h-thumb)` 56；`--ctl-h-act` 是同值別名） | 允許、拒絕、暫停、繼續、送出回答 |
| 按鈕 `padding: 0 12px／14px` | `0 var(--ctl-px)` | |
| 按鈕 `padding: 0 6px～10px` | `0 var(--ctl-px-sm)` | |
| `font-size` 11、11.5（線標籤） | `var(--fs-xs)` 11 | 只給畫布線標籤 |
| `font-size` 12、12.5 | `var(--fs-sm)` 12 | 晶片、徽章、呼號、說明 |
| `font-size` 13、13.5 | `var(--fs-ctl-sm)` 13 | 精簡按鈕、表單標籤 |
| `font-size` 14、14.5、15 | `var(--fs-base)` 14 | |
| `font-size` 16（手機輸入框、手機大按鈕、對話框標題、圖示） | `var(--fs-lg)` 16 | |
| `font-size` 18 | `var(--fs-h2)` | 面板 h1 |
| `font-size` 20 | `var(--fs-h1)` | 頁面 h1 |
| `font-size` 26 | `var(--fs-hero)` | 只給頁首「等你 N」 |
| 間距 2、4 | `var(--space-1)` 4 | |
| 間距 6 | `var(--space-1h)` 6 | |
| 間距 8、10 | `var(--space-2)` 8 | |
| 間距 12、14 | `var(--space-3)` 12 | |
| 間距 16、18、20 | `var(--space-4)` 16 | |
| 間距 22、24 | `var(--space-6)` 24 | |
| 間距 32 | `var(--space-8)` 32 | |
| 圓角 3、4、5 | `var(--radius-sm)` 4 | |
| 圓角 6、8、10 | `var(--radius-control)` 8 | |
| 圓角 12 | `var(--radius-card)` | |
| 圓角 16 | `var(--radius-team)` | 團隊框 |
| 圓角 999、25（膠囊）、50% | `var(--radius-pill)` | 正圓點仍可用 50% |
| `box-shadow: 0 12px 32px rgb(0 0 0 / 50%)` | `var(--shadow-pop)` | 選單、Presets 彈出、快速新增 |
| 指令列、toast、進度卡展開的陰影 | `var(--shadow-float)` | |
| 次畫面、對話框的陰影 | `var(--shadow-modal)` | |
| `outline: 2px solid var(--ring)` | 刪掉（全域 `:focus-visible` 已有）；畫布卡片內改 `calc(var(--focus-w) / (var(--z) * var(--strip-scale)))` | 可聚焦的容器不要 `outline: none` |
| `@media (max-width: 720px)`、`(max-width: 640px)`、`(pointer: coarse)` 分開寫 | `@media (max-width: 640px), (pointer: coarse)` | 收件匣列的 720 併進來 |

## 舊 class／寫法 → 新 class

| 舊 | 新 | 位置（審視報告編號） |
|---|---|---|
| 各區自己寫 `min-height: 28px; padding: 0 10px; font-size: 13px` 的按鈕 | `button.sm` | 畫布浮動工具列 links.css:185、canvas.css:570、766-773、views.css:789-812（#15）；卡片內 canvas.css:93、105、171、641、662（#16） |
| 卡片「⋯」24px、縮放 −／+、‹ › | `button.icon.sm` | #16、#24 |
| 各種關閉鈕（×、✕、自畫） | `button.close`（字元一律 ✕） | views.css:622、684、724；canvas.css:530、722；flows.css:1236（#24） |
| 實心白的開關：遮蔽 `.mask-chip.on`、交接規則「啟用」、終端機側欄切換 | 刪掉實心白，改靠 `aria-pressed='true'` 的全域「按下」樣式 | security.css:8-13；team.css:356-360；expanded.css:135-139（#5，Q2） |
| 等你的卡（不是聚焦那張）處理鈕 `.primary` | `button.cue`（controls.css：代碼色框＋淡底），聚焦那張才留 `.primary` | SessionNode.tsx:74-86（#5，Q2） |
| 收件匣「送出拒絕」`.primary`、展開卡「拒絕」灰色 | 原因必填 → `button.danger` 拒絕 | InboxBoard.tsx:157、209-240；ReviewCards.tsx:141-157；InboxPage.tsx:87-131（#3，Q3） |
| 提問選項（手機按了直接送出、桌面填進文字框） | 選項 `button` 加 `aria-pressed`（選中反白）→ `.primary` 送出 | InboxBoard.tsx:118-133；ReviewCards.tsx:246-276；InboxPage.tsx:179-209（#4，Q3） |
| 手機動作按鈕 `min-height: 56px` 各自寫 | `.act` | views.css:961；flows.css 收件匣列（#6、#47） |
| `.flows a.button.ghost`、`.team-page button.link`、`.progress-card button.link`、`.done-hint button.link`、`.roster-result .link` | `.ghost`／`.link`（全域），刪掉各區的版本 | flows.css:1602、1617、1981；team.css:106；progress.css:41；expanded.css:181（#22） |
| `.flows .segmented`、`.memory-scope`、`.rule button[aria-pressed]`、`.new-team .seg` | `.seg`（精簡用 `.seg.sm`） | flows.css:599-631；progress.css:381-388；team.css:174、356（#20） |
| 卡片橫排選單、`.zone-menu` 項目、`.pause-options button`、`.team-more-menu button`、`@` 提及 | 容器 `.menu`，項目 `button.menu-item`（說明文字 `.sub`） | canvas.css:655；zones.css:74；views.css:873；presets.css:199；team.css:552（#21） |
| 三個面板標題列（團隊、Memory、收件匣） | `.panel-head` ＞ `h1` ＋ `.panel-acts`（寬版 `button.sm`、`button.close`） | views.css:675；team.css:50；progress.css:372；flows.css:2047（#25） |
| `.state[data-state=empty]`（48px 左內距）、搜尋空狀態一行灰字 | `.empty`（`flows/common.tsx` 的 `Empty` 改用它） | views.css:538-546；flows/common.tsx `Empty`；SearchPanel.tsx:561（#30） |
| 各自定義的 `.row`（`.team-page .row`、`.progress-card .row`、`.member .row`） | 全域 `.row` 已有 flex＋wrap＋gap 8，刪掉重複的 | team.css:114、273；progress.css:23（#12） |
| `input.cmd` 借來給群發框、各區輸入框 `background: var(--bg)` | 全域輸入框預設（`--surface-2` 底）；精簡用 `.sm` | flows.css:509-537；team.css:71-90；progress.css:232-247；canvas.css:105（#23） |
| 核取方塊吃到 36px 高與內距、選中是藍色 | 全域已設 `accent-color`；各區別再給 checkbox 高度與內距；包在 `label.check` | team.css:71-90；NewTeamForm.tsx:289-297（#13） |
| `.zone-tab:hover` 被全域 hover 蓋掉 | 改成 `.tab`（選中 2px 底線） | zones.css:30（#50） |
| 搜尋結果、收件匣的「目前這一列」 | `.list-row[aria-current]` | #34、§3.6 |
| 兩套「按兩次」（TwoClickButton 5000ms、useTwoStep 4000+350ms） | 合併成一個 hook；上膛時加 `data-armed='true'`（實心紅） | team/common.tsx:53-89；flows/common.tsx:243-269（#10） |
| `.chip` 的各區字級、內距 | 刪掉，全站 `.chip` 只在 controls.css | — |

## 基礎層已經做完的（不用再做）

- `tokens.css`：控制項高度、字級、間距、圓角、陰影、聚焦、斷點 token；全域 `button` 用 token；`button.danger` 有自己的 hover（20% 紅底）與紅色焦點外框。
- `controls.css`：上面所有共用 class；全域 `button[aria-pressed='true']` 的按下樣式。
- 暫停選單選中的模式標得出來（選擇器改成 `aria-pressed`，views.css）。
- Presets 彈出區的篩選框、團隊名稱框有樣式（全域輸入框預設）。
- `.chip`、`.chip.bypass`、`.chip.cost` 收斂成一份；`.seg` 搬進 controls.css。
- `ModeChip` 只剩 `views/session.tsx` 一份，`flows/common.tsx` 轉出同一個元件（`.chip.mode`，略過權限 `.chip.mode.bypass`）。
- JS 的 `(max-width: 640px)` 收斂到 `shared/breakpoints.ts`（App、SearchPanel、TeamWorkbench、PresetSettings）。
