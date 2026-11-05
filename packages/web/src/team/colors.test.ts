import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEAM_COLORS, teamColorVar } from './colors';

const css = readFileSync(new URL('./team.css', import.meta.url), 'utf8');
const messages = readFileSync(new URL('./messages.ts', import.meta.url), 'utf8');

describe('團隊框色', () => {
  it('8 色，最早的四個名稱照舊（資料庫裡存的是名稱）', () => {
    expect(TEAM_COLORS).toHaveLength(8);
    expect(TEAM_COLORS.slice(0, 4)).toEqual(['teal', 'lime', 'indigo', 'apricot']);
    expect(new Set(TEAM_COLORS).size).toBe(TEAM_COLORS.length);
  });

  it('每個顏色都有 CSS 變數與兩種語言的名稱', () => {
    for (const color of TEAM_COLORS) {
      expect(css).toMatch(new RegExp(`--team-${color}: #[0-9a-f]{6};`));
      expect(messages.split(`'team.color.${color}':`).length - 1).toBe(2);
    }
  });

  it('不認得的名稱退回 teal，不把任意字串放進 CSS', () => {
    expect(teamColorVar('violet')).toBe('var(--team-violet)');
    expect(teamColorVar('apricot')).toBe('var(--team-apricot)');
    expect(teamColorVar('red); background: url(x')).toBe('var(--team-teal)');
    expect(teamColorVar('')).toBe('var(--team-teal)');
  });
});
