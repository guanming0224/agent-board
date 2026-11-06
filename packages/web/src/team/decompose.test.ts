import { describe, expect, it } from 'vitest';
import type { Session, TeamMember } from '@agent-board/protocol';
import { assignOwners, decomposePrompt, parseTaskList, presentAbbrs, roleRefs } from './decompose';

/** 舊格式的結果只看標題。 */
const titles = (text: string) => {
  const result = parseTaskList(text);
  return result.ok ? { ok: true, titles: result.tasks.map((task) => task.title) } : result;
};

describe('parseTaskList', () => {
  it('reads a bare array, a fenced block and text around it', () => {
    expect(titles('[{"title":"A"},{"title":"B"}]')).toEqual({
      ok: true,
      titles: ['A', 'B'],
    });
    expect(titles('Here:\n```json\n[{"title":"A]"}]\n```\nDone [ok]')).toEqual({
      ok: true,
      titles: ['A]'],
    });
    expect(titles('[注意] 清單如下 ["甲","乙"]')).toEqual({
      ok: true,
      titles: ['甲', '乙'],
    });
  });

  it('drops blanks and duplicates, flattens newlines and caps the size', () => {
    expect(titles('[{"title":" A\\nB "},{"title":""},{"title":"A B"},{"x":1},3]')).toEqual({
      ok: true,
      titles: ['A B'],
    });
    const many = JSON.stringify(Array.from({ length: 80 }, (_, i) => `t${i}`));
    const result = parseTaskList(many);
    expect(result.ok && result.tasks.length).toBe(50);
    const long = parseTaskList(JSON.stringify(['x'.repeat(500)]));
    expect(long.ok && long.tasks[0]!.title.length).toBe(200);
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

describe('roles and auto-assign', () => {
  const session = (id: string, name: string, archived = false) =>
    ({ id, name, archived }) as Session;
  const member = (sessionId: string, role: TeamMember['role'], kind?: TeamMember['kind']) =>
    ({ teamId: 't', sessionId, role, ...(kind ? { kind } : {}) }) as TeamMember;

  const devSessions = [
    session('ld', 'T-LD'),
    session('bd2', 'T-BD2'),
    session('bd1', 'T-BD1'),
    session('rv', 'T-RV'),
    session('old', 'T-BD3', true),
  ];
  const devMembers = [
    member('ld', 'lead'),
    member('bd2', 'worker'),
    member('bd1', 'worker'),
    member('rv', 'reviewer'),
    member('old', 'worker'),
  ];

  it('reads role next to the title, and plain strings or objects without role still work', () => {
    expect(
      parseTaskList('[{"title":"A","role":"BD"},"B",{"title":"C"},{"title":"D","role":3}]'),
    ).toEqual({
      ok: true,
      tasks: [
        { title: 'A', role: 'BD' },
        { title: 'B', role: null },
        { title: 'C', role: null },
        { title: 'D', role: null },
      ],
    });
    // 重複的標題留第一個，連同它的 role。
    expect(parseTaskList('[{"title":"A","role":"RV"},{"title":"A","role":"BD"}]')).toEqual({
      ok: true,
      tasks: [{ title: 'A', role: 'RV' }],
    });
  });

  it('round-robins among members with the same abbreviation, skips archived ones', () => {
    const refs = roleRefs({}, devMembers, devSessions);
    expect(refs.map((r) => [r.name, r.abbr])).toEqual([
      ['T-BD1', 'BD'],
      ['T-BD2', 'BD'],
      ['T-LD', 'LD'],
      ['T-RV', 'RV'],
    ]);
    const tasks = [
      { title: '1', role: 'BD' },
      { title: '2', role: 'bd' },
      { title: '3', role: 'BD' },
      { title: '4', role: 'RV' },
      { title: '5', role: 'XX' },
      { title: '6', role: null },
      { title: '7', role: 'worker' },
      { title: '8', role: 'EX' },
    ];
    expect(assignOwners(tasks, refs)).toEqual(['bd1', 'bd2', 'bd1', 'rv', null, null, 'bd2', null]);
    expect(assignOwners(tasks, [])).toEqual(tasks.map(() => null));
  });

  it('research teams use the kind abbreviations', () => {
    const sessions = [session('a', 'P-LD'), session('e', 'P-EX1'), session('w', 'P-WR')];
    const members = [
      member('a', 'lead', 'ld'),
      member('e', 'worker', 'ex'),
      member('w', 'worker', 'wr'),
    ];
    const refs = roleRefs({ phase: 'writing' }, members, sessions);
    expect(presentAbbrs(refs)).toEqual(['EX', 'LD', 'WR']);
    expect(
      assignOwners(
        [
          { title: 'x', role: 'WR' },
          { title: 'y', role: 'EX' },
          { title: 'z', role: 'BD' },
        ],
        refs,
      ),
    ).toEqual(['w', 'e', null]);
  });

  it('the prompt lists only the abbreviations present in the team', () => {
    const team = { goal: 'g', doneCriteria: '', contextMd: '' };
    const prompt = decomposePrompt(team, ['BD', 'LD', 'RV']);
    expect(prompt).toContain('[{"title":"...","role":"BD"}]');
    expect(prompt).toContain('one of: BD (builder), LD (lead), RV (reviewer).');
    expect(prompt).not.toContain('EX');
    expect(prompt).not.toMatch(/[\r\n]/);
    expect(decomposePrompt(team)).toContain('like [{"title":"..."}]');
  });
});
