import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./canvas.css', import.meta.url), 'utf8');

/** 從 at-rule 開頭找出它的 { … } 內容（只處理這個檔案的簡單巢狀）。 */
function blockAfter(prelude: string): string {
  const start = css.indexOf(prelude);
  expect(start, prelude).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i).trim();
    }
  }
  throw new Error(`沒有結尾：${prelude}`);
}

describe('團隊框的退路（P2 §4.2）', () => {
  it('減少透明度和不支援背景模糊，退回同一組樣式：1px 框＋8% 底、沒有模糊、光暈、陰影', () => {
    const reduced = blockAfter('@media (prefers-reduced-transparency: reduce)');
    const unsupported = blockAfter('@supports not ((backdrop-filter');
    expect(unsupported).toBe(reduced);
    expect(reduced).toContain('background: color-mix(in srgb, var(--team) 8%, transparent);');
    expect(reduced).toContain('border-radius: calc(12px / var(--z));');
    expect(reduced.match(/box-shadow: none;/g)).toHaveLength(2);
    expect(reduced.match(/(?<!-webkit-)backdrop-filter: none;/g)).toHaveLength(2);
  });
});
