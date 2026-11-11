// 面板與表單區（團隊、Presets、Memory、設定、新增 session、舊資料、對話框）套用共用控制項後的靜態檢查。
// 規則：STYLE.md §5.1、docs/design/controls-migration.md；畫面上的實際尺寸在 e2e（team.spec、flows-archive.spec）。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** 讀檔並把 CRLF 換成 LF（Windows 上 git 可能轉成 CRLF）。 */
const src = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const team = src('team/team.css');
const presets = src('team/presets.css');
const flows = src('flows/flows.css');
const progress = src('progress/progress.css');
const controls = src('shared/styles/controls.css');

/** 某個選擇器（行首、後面接 `{`）的宣告內容；沒有就回傳 null。 */
function block(css: string, selector: string): string | null {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`);
  return re.exec(css)?.[2] ?? null;
}

describe('團隊面板（team.css）', () => {
  it('輸入框不再自己寫高度、底色、內距（用全站預設，手機才會 44／16）', () => {
    expect(team).not.toMatch(/\.team-page input,\s*\n\.team-page select/);
    expect(team).not.toMatch(
      /background: var\(--bg\);\s*\n\s*color: var\(--fg\);\s*\n\s*font: inherit/,
    );
  });

  it('不再定義自己的 .row、button.link、button.move（全站 .row／.link／.sm）', () => {
    expect(block(team, '.team-page .row')).toBeNull();
    expect(block(team, '.team-page button.link')).toBeNull();
    expect(block(team, '.team-page button.move')).toBeNull();
    expect(block(team, '.roster-result .link')).toBeNull();
  });

  it('交接規則的開關不是實心白（GM Q2：實心白只給主按鈕）', () => {
    expect(team).not.toMatch(/\.rule button\[aria-pressed='true'\]/);
  });

  it('沒有寫死的 px 字級', () => {
    expect(team).not.toMatch(/font-size: \d/);
  });
});

describe('Presets（presets.css）', () => {
  it('手機按鈕跟全站一樣 44，只有「送出第一個指令」（會動到 session）是 56', () => {
    expect(presets).not.toMatch(/min-height: 56px/);
    expect(presets).toMatch(/\.held-first button \{\s*min-height: var\(--ctl-h-thumb\);/);
  });

  it('「⋯」選單只管位置，外觀用共用的 .menu', () => {
    const menu = block(presets, '.team-more-menu');
    expect(menu).not.toBeNull();
    expect(menu).not.toMatch(/background|border|box-shadow/);
  });

  it('陰影用 token', () => {
    expect(presets).not.toMatch(/box-shadow: 0 /);
  });
});

describe('流程頁表單（flows.css）', () => {
  it('設定 → 資料：已封存、操作紀錄不另加 margin-top（區塊間距只有 .settings-group 的 16，報告 D2）', () => {
    expect(block(flows, '.flows .form-card.audit')).toBeNull();
    expect(block(flows, '.flows .form-card.archived')).toBeNull();
  });

  it('輸入框的高度、底色、字級交給 controls.css', () => {
    const input = block(
      flows,
      ".flows input:not([type='radio'], [type='checkbox'], .sm),\n.flows select:not(.sm),\n.flows textarea",
    );
    expect(input).not.toBeNull();
    expect(input).not.toMatch(/min-height|background|font:|font-size/);
  });

  it('單選的分段切換和 .seg 同一個長相：相連（-1px）、選中＝--accent-bg＋--accent 框', () => {
    expect(block(flows, '.flows .segmented label + label')).toMatch(/margin-left: -1px/);
    const on = block(flows, '.flows .segmented label.on');
    expect(on).toMatch(/border-color: var\(--accent\)/);
    expect(on).toMatch(/background: var\(--accent-bg\)/);
  });

  it('資料夾瀏覽器、已封存列、快速建立不再自己寫按鈕高度', () => {
    for (const sel of [
      '.flows .browser-quick button',
      '.flows .crumbs button',
      '.flows .browser-list .pick',
      '.flows .browser-list .enter',
      '.flows .quick-create .quick-close',
    ]) {
      expect(block(flows, sel) ?? '', sel).not.toMatch(/min-height/);
    }
    expect(block(flows, '.flows .browser-start button')).toBeNull();
  });
});

describe('Memory（progress.css）', () => {
  it('分段切換用全站 .seg，不再有 .memory-scope 的按下樣式', () => {
    expect(progress).not.toMatch(/\.memory-scope button\[aria-pressed/);
    expect(src('progress/MemoryPanel.tsx')).toMatch(/className="seg sm memory-scope"/);
  });

  it('清單列圓角 8（可點的清單列，和團隊清單、Preset 同一種）', () => {
    expect(block(progress, '.memory-row')).toMatch(/border-radius: var\(--radius-control\)/);
  });
});

describe('元件', () => {
  it('對話框有 ✕（觸控沒有 Esc，報告 B4）', () => {
    expect(src('flows/Dialog.tsx')).toMatch(/<CloseButton/);
  });

  it('三個右側面板之中，團隊與 Memory 用同一個 PanelHead', () => {
    expect(src('team/TeamPage.tsx')).toMatch(/<PanelHead/);
    expect(src('team/TeamWorkbench.tsx')).toMatch(/<PanelHead/);
    expect(src('progress/MemoryPanel.tsx')).toMatch(/<PanelHead/);
  });

  it('手機上精簡輸入框（.sm）也是 44／16', () => {
    const phone = controls.slice(controls.indexOf('@media (max-width: 640px), (pointer: coarse)'));
    expect(phone).toMatch(
      /:where\(input, select, textarea\)\.sm:where\(:not\(\.react-flow__node \*\)\) \{\s*min-height: var\(--ctl-h-touch\);/,
    );
    // 字級 16 由同一個媒體查詢裡、權重比 .sm 高的 !important 下限負責（整合時改，審查 foundation #1）。
    expect(phone).toContain('font-size: max(var(--fs-lg), 1em) !important;');
  });
});
