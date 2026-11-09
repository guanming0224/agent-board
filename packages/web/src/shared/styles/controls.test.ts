import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHONE_QUERY, TOUCH_QUERY } from '../breakpoints';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const tokens = read('tokens.css');
const controls = read('controls.css');
const srcDir = fileURLToPath(new URL('../../', import.meta.url));

function filesIn(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesIn(path, ext);
    return ext.test(name) ? [path] : [];
  });
}
const allCss = filesIn(srcDir, /\.css$/).map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));
const allTsx = filesIn(srcDir, /\.tsx$/).map((path) => ({
  path,
  text: readFileSync(path, 'utf8'),
}));

/** 某個選擇器（整行、後面接 `{`）在全部 CSS 裡出現在哪些檔案。 */
const definedIn = (selector: RegExp) =>
  allCss.filter((f) => selector.test(f.text)).map((f) => f.path.slice(srcDir.length));

/** 找出 `selector {` 的宣告內容（只取第一個）。 */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
}

describe('尺寸 token（GM 2026-11-09 Q1）', () => {
  it.each([
    ['--ctl-h-xs', '24px'],
    ['--ctl-h-sm', '32px'],
    ['--ctl-h', '36px'],
    ['--ctl-h-touch', '44px'],
    ['--ctl-h-thumb', '56px'],
    ['--ctl-h-act', 'var(--ctl-h-thumb)'],
    ['--fs-ctl-sm', '13px'],
    ['--fs-base', '14px'],
    ['--fs-lg', '16px'],
    ['--space-2', '8px'],
    ['--radius-control', '8px'],
    ['--radius-card', '12px'],
    ['--radius-pill', '999px'],
    ['--bp-phone', '640px'],
  ])('%s 是 %s', (name, value) => {
    expect(tokens).toMatch(new RegExp(`\\n\\s*${name}: ${value.replace(/[()]/g, '\\$&')};`));
  });

  it('全域 button＝次要・標準：高度與內距用 token', () => {
    const button = block(tokens, '\nbutton');
    expect(button).toContain('min-height: var(--ctl-h);');
    expect(button).toContain('padding: 0 var(--ctl-px);');
    expect(button).toContain('background: var(--surface-2);');
  });
});

describe('危險按鈕有自己的 hover 與 focus（以前被 button:hover 蓋成灰）', () => {
  it('hover 的權重高於 button:hover:not(:disabled)，底色仍是紅', () => {
    const hover = block(tokens, 'button.danger:hover:not(:disabled)');
    expect(hover).toContain('var(--fault) 20%');
  });
  it('焦點外框用紅色', () => {
    expect(block(tokens, 'button.danger:focus-visible')).toContain('outline-color: var(--fault);');
  });
});

describe('收斂重複定義', () => {
  it('.chip、.chip.bypass、.chip.cost 全站只定義一次，在 controls.css', () => {
    expect(definedIn(/(^|\n)(\.\S+ )?\.chip \{/)).toEqual(['shared/styles/controls.css']);
    expect(definedIn(/(^|\n)(\.\S+ )?\.chip\.bypass \{/)).toEqual(['shared/styles/controls.css']);
    const costColor = allCss.filter((f) =>
      /\.chip\.cost \{[^}]*color: var\(--quota\)/.test(f.text),
    );
    expect(costColor.map((f) => f.path.slice(srcDir.length))).toEqual([
      'shared/styles/controls.css',
    ]);
  });
  it('分段切換 .seg 只在 controls.css', () => {
    expect(definedIn(/(^|\n)\.seg \{/)).toEqual(['shared/styles/controls.css']);
  });
  it('模式晶片元件只有一份（views/session.tsx；flows/common.tsx 只轉出）', () => {
    const defs = allTsx.filter((f) => /function ModeChip\b/.test(f.text));
    expect(defs.map((f) => f.path.slice(srcDir.length))).toEqual(['views/session.tsx']);
    const common = allTsx.find((f) => f.path.endsWith('flows/common.tsx'))!;
    expect(common.text).toContain("export { ModeChip } from '../views/session';");
  });
});

describe('按下／選中', () => {
  it('沒有 CSS 選 aria-checked（元件都給 aria-pressed；暫停選單以前選錯）', () => {
    expect(allCss.filter((f) => f.text.includes('aria-checked')).map((f) => f.path)).toEqual([]);
  });
  it('全域按下樣式：--accent-bg 底＋--accent 框，hover 時也維持', () => {
    const rule = controls.slice(controls.indexOf("button[aria-pressed='true'],"));
    const body = rule.slice(rule.indexOf('{') + 1, rule.indexOf('}'));
    expect(rule.slice(0, rule.indexOf('{'))).toContain(
      "button[aria-pressed='true']:hover:not(:disabled)",
    );
    expect(body).toContain('border-color: var(--accent);');
    expect(body).toContain('background: var(--accent-bg);');
  });
});

describe('手機斷點只有一個', () => {
  it('CSS 的 @media 和 JS 的 TOUCH_QUERY 一樣；PHONE_QUERY 是 640', () => {
    expect(PHONE_QUERY).toBe('(max-width: 640px)');
    expect(controls).toContain(`@media ${TOUCH_QUERY} {`);
    expect(controls.match(/@media /g)).toHaveLength(1);
  });
  it('手機輸入框字級 16、可點元素至少 44', () => {
    const phone = controls.slice(controls.indexOf(`@media ${TOUCH_QUERY}`));
    expect(phone).toContain('font-size: var(--fs-lg);');
    expect(phone).toContain('min-height: var(--ctl-h-touch);');
  });
  it('手機輸入框字級下限 16 一定贏過各區規則（!important，審查 foundation #1）', () => {
    const phone = controls.slice(controls.indexOf(`@media ${TOUCH_QUERY}`));
    expect(phone).toContain('font-size: max(var(--fs-lg), 1em) !important;');
    // 下限的選擇器不能包在 :where() 裡（權重 0）。
    const rule = phone.slice(0, phone.indexOf('font-size: max(var(--fs-lg), 1em) !important;'));
    expect(rule.slice(rule.lastIndexOf('}') + 1)).toMatch(/\n\s*input:not\(/);
  });
  it('.touch／.act 只在手機生效：桌面只有 36／32 兩級（Q1）', () => {
    const desktop = controls.slice(0, controls.indexOf(`@media ${TOUCH_QUERY}`));
    expect(desktop).not.toMatch(/button\.(touch|act)\b/);
  });
  it('.cue（代碼色框＋淡底）全站只定義在 controls.css', () => {
    const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(
      allCss
        .filter((f) => /button\.cue\b[^{}]*\{/.test(noComments(f.text)))
        .map((f) => f.path.slice(srcDir.length)),
    ).toEqual(['shared/styles/controls.css']);
    expect(allCss.filter((f) => /button\.cta\b/.test(f.text)).map((f) => f.path)).toEqual([]);
  });
  it('核取方塊選中是白色（accent-color）', () => {
    expect(controls).toMatch(
      /:where\(input\[type='checkbox'\], input\[type='radio'\]\) \{\s*accent-color: var\(--accent\);/,
    );
  });
});

/**
 * 寫死 px 的字級與最小高度不能再變多（審查 foundation #4；沒有 stylelint，用這個測試擋）。
 * 新的 CSS 用 tokens.css 的 --fs-*／--ctl-h-*；下面是整合時（2026-11-09）還留著的數量，只能往下修。
 */
describe('寫死的 px 字級／最小高度', () => {
  const BASELINE: Record<string, number> = {
    'canvas/canvas.css': 1,
    'canvas/expanded.css': 3,
    'flows/flows.css': 17,
    'progress/progress.css': 4,
    'shared/styles/error.css': 3,
    'team/presets.css': 1,
    'views/views.css': 3,
  };
  const PX = /^\s*(font-size|min-height|font)\s*:\s*([a-z0-9-]+\s+)*[0-9.]+px/gm;
  it.each(
    allCss
      .map((f) => [f.path.slice(srcDir.length), f.text] as const)
      .filter(([path]) => !/shared\/styles\/(tokens|controls)\.css$/.test(path)),
  )('%s 沒有新增', (path, text) => {
    expect((text.match(PX) ?? []).length).toBeLessThanOrEqual(BASELINE[path] ?? 0);
  });
});
