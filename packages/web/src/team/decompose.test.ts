import { describe, expect, it } from 'vitest';
import { decomposePrompt, parseTaskList } from './decompose';

describe('parseTaskList', () => {
  it('reads a bare array, a fenced block and text around it', () => {
    expect(parseTaskList('[{"title":"A"},{"title":"B"}]')).toEqual({
      ok: true,
      titles: ['A', 'B'],
    });
    expect(parseTaskList('Here:\n```json\n[{"title":"A]"}]\n```\nDone [ok]')).toEqual({
      ok: true,
      titles: ['A]'],
    });
    expect(parseTaskList('[注意] 清單如下 ["甲","乙"]')).toEqual({
      ok: true,
      titles: ['甲', '乙'],
    });
  });

  it('drops blanks and duplicates, flattens newlines and caps the size', () => {
    expect(parseTaskList('[{"title":" A\\nB "},{"title":""},{"title":"A B"},{"x":1},3]')).toEqual({
      ok: true,
      titles: ['A B'],
    });
    const many = JSON.stringify(Array.from({ length: 80 }, (_, i) => `t${i}`));
    const result = parseTaskList(many);
    expect(result.ok && result.titles.length).toBe(50);
    const long = parseTaskList(JSON.stringify(['x'.repeat(500)]));
    expect(long.ok && long.titles[0]!.length).toBe(200);
  });

  it('explains what went wrong instead of throwing', () => {
    expect(parseTaskList('I cannot do that.')).toEqual({ ok: false, reason: 'no_json' });
    expect(parseTaskList('[{"title":"cut off')).toEqual({ ok: false, reason: 'bad_json' });
    expect(parseTaskList('[not json]')).toEqual({ ok: false, reason: 'bad_json' });
    expect(parseTaskList('[1, 2]')).toEqual({ ok: false, reason: 'no_titles' });
    expect(parseTaskList('[]')).toEqual({ ok: false, reason: 'no_titles' });
    expect(parseTaskList('[null]')).toEqual({ ok: false, reason: 'no_titles' });
    expect(parseTaskList('['.repeat(5000))).toEqual({ ok: false, reason: 'bad_json' });
  });
});

describe('decomposePrompt', () => {
  it('stays on one line and asks for JSON only', () => {
    const prompt = decomposePrompt({
      goal: 'line one\nline two\r',
      doneCriteria: '',
      contextMd: '# Notes\n\nkeep\x1b[0m',
    });
    expect(prompt).not.toMatch(/[\r\n\x1b]/);
    expect(prompt).toContain('Goal: line one line two');
    expect(prompt).toContain('Team notes: # Notes keep');
    expect(prompt).not.toContain('Done when');
    expect(prompt).toContain('JSON array');
    expect(prompt.startsWith('Break this team goal into tasks.')).toBe(true);
  });
});
