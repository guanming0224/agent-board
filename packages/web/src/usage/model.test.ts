// @vitest-environment node
// 用量詳情的計算：期間、前一期比較、每日堆疊、排行（團隊／session／專案）、分布。
import { describe, expect, it } from 'vitest';
import type { UsageReport, UsageReportMachine, UsageReportSession } from '@agent-board/protocol';
import {
  byMachine,
  byModel,
  change,
  daily,
  niceTicks,
  overview,
  periodEnding,
  previousPeriod,
  ranking,
  shortPath,
  sortRows,
} from './model';

const machine = (
  machineId: string,
  over: Partial<UsageReportMachine> = {},
): UsageReportMachine => ({
  machineId,
  name: `name-${machineId}`,
  online: true,
  state: 'detail',
  summary: null,
  countedAt: '2026-11-09T02:00:00.000Z',
  restored: false,
  timeZone: 'Asia/Taipei',
  earliestAt: '2026-08-01T00:00:00.000Z',
  otherSessions: 0,
  ...over,
});

const ses = (over: Partial<UsageReportSession>): UsageReportSession => ({
  machineId: 'm1',
  claudeSessionId: 'c',
  cwd: null,
  boardSessionId: null,
  name: null,
  archived: false,
  teamId: null,
  teamName: null,
  zoneId: null,
  zoneName: null,
  projectId: null,
  projectName: null,
  ...over,
});

const TODAY = '2026-11-09';

/** 兩台機器；session：0 看板＋團隊、1 看板沒團隊、2 中控台外、3 m1 的其他、4 m2 看板同團隊。 */
const report: UsageReport = {
  generatedAt: '2026-11-09T03:00:00.000Z',
  days: ['2026-09-11', '2026-11-02', '2026-11-03', '2026-11-08', '2026-11-09'],
  models: ['opus', ''],
  machines: [machine('m1'), machine('m2'), machine('m3', { state: 'old_daemon' })],
  sessions: [
    ses({
      claudeSessionId: 'a',
      boardSessionId: 's-a',
      name: 'Alpha',
      teamId: 't1',
      teamName: 'Team One',
      cwd: '/w/alpha',
    }),
    ses({ claudeSessionId: 'b', boardSessionId: 's-b', name: 'Beta', cwd: '/w/beta' }),
    ses({ claudeSessionId: 'x', cwd: '/w/alpha' }),
    ses({ claudeSessionId: null }),
    ses({
      machineId: 'm2',
      claudeSessionId: 'd',
      boardSessionId: 's-d',
      name: 'Delta',
      teamId: 't1',
      teamName: 'Team One',
      cwd: '/w/delta',
      archived: true,
    }),
  ],
  rows: [
    // [機器, 日, 模型, session, 輸入, 輸出, 快取讀, 快取寫]
    [0, 4, 0, 0, 10, 20, 1000, 50],
    [0, 3, 0, 1, 5, 5, 0, 0],
    [0, 3, 1, 2, 1, 2, 3, 4],
    [0, 2, 0, 3, 7, 0, 0, 0],
    [1, 4, 0, 4, 100, 0, 0, 0],
    [1, 1, 0, 4, 40, 0, 0, 0],
    // 前 30 天那一期
    [0, 0, 0, 0, 1000, 0, 0, 0],
  ],
};

describe('期間', () => {
  it('含今天往前 n 天；前一期緊接在前', () => {
    const p = periodEnding(TODAY, 7);
    expect(p).toEqual({ from: '2026-11-03', to: '2026-11-09', days: 7 });
    expect(previousPeriod(p)).toEqual({ from: '2026-10-27', to: '2026-11-02', days: 7 });
  });

  it('總覽：今天、7 天、30 天各自和前一期比', () => {
    const [today, week, month] = overview(report, TODAY);
    expect(today!.current).toEqual({ input: 110, output: 20, cacheRead: 1000, cacheCreation: 50 });
    expect(today!.previous).toEqual({ input: 6, output: 7, cacheRead: 3, cacheCreation: 4 });
    expect(week!.current.input).toBe(10 + 5 + 1 + 7 + 100);
    expect(week!.previous.input).toBe(40);
    expect(month!.previous.input).toBe(1000);
    // 最早紀錄 8/1，前 30 天那一期（10/11 起）完整。
    expect(month!.previousPartial).toBe(false);
  });

  it('某台最早的紀錄比前一期晚：標成不完整', () => {
    const partial = {
      ...report,
      machines: [machine('m1', { earliestAt: '2026-10-20T00:00:00.000Z' })],
    };
    const [today, , month] = overview(partial, TODAY);
    expect(today!.previousPartial).toBe(false);
    expect(month!.previousPartial).toBe(true);
  });

  it('change：前一期是 0 沒有百分比', () => {
    expect(change(150, 100)).toBe(50);
    expect(change(50, 100)).toBe(-50);
    expect(change(5, 0)).toBeNull();
  });
});

describe('每日趨勢', () => {
  it('依 token 類型：輸入＋輸出只有兩層，四項合計四層', () => {
    const p = periodEnding(TODAY, 2);
    const two = daily(report, p, 'type', 'conversation');
    expect(two.days).toEqual(['2026-11-08', '2026-11-09']);
    expect(two.series.map((s) => [s.key, s.slot])).toEqual([
      ['input', 1],
      ['output', 2],
    ]);
    expect(two.values).toEqual([
      [6, 7],
      [110, 20],
    ]);
    const four = daily(report, p, 'type', 'all');
    expect(four.series.map((s) => s.key)).toEqual([
      'input',
      'output',
      'cacheCreation',
      'cacheRead',
    ]);
    expect(four.max).toBe(110 + 20 + 1000 + 50);
  });

  it('依機器：只有有細項的機器；超過 4 台併成其他機器，顏色跟著機器不跟排名', () => {
    const p = periodEnding(TODAY, 1);
    const byM = daily(report, p, 'machine', 'conversation');
    expect(byM.series).toEqual([
      { key: 'm1', slot: 1 },
      { key: 'm2', slot: 2 },
    ]);
    expect(byM.values).toEqual([[30, 100]]);
    const many = {
      ...report,
      machines: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => machine(id)),
      rows: [[5, 4, 0, 0, 9, 0, 0, 0]] as UsageReport['rows'],
    };
    const folded = daily(many, p, 'machine', 'conversation');
    expect(folded.series.map((s) => [s.key, s.slot])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
      ['other-machines', 0],
    ]);
    expect(folded.values).toEqual([[0, 0, 0, 0, 9]]);
  });

  it('沒資料的日子是 0；刻度是 1／2／5 的倍數', () => {
    const empty = daily({ ...report, rows: [] }, periodEnding(TODAY, 7), 'type', 'all');
    expect(empty.values.every((v) => v.every((x) => x === 0))).toBe(true);
    expect(empty.max).toBe(0);
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(95)).toEqual([0, 50, 100]);
    expect(niceTicks(1_234_567)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });
});

describe('排行', () => {
  const p = periodEnding(TODAY, 7);

  it('團隊：同團隊跨機器合併；不在團隊、中控台外、其他各一列；團隊列點了開團隊', () => {
    const rows = sortRows(ranking(report, p, 'team'), 'conversation', true);
    expect(rows.map((r) => [r.key, r.kind, r.label, r.sessions, r.counts.input, r.target])).toEqual(
      [
        ['team:t1', 'board', 'Team One', 2, 110, { type: 'team', teamId: 't1' }],
        [
          ':noTeam',
          'noTeam',
          null,
          1,
          5,
          { type: 'session', sessionId: 's-b', archived: false, teamId: null },
        ],
        [':other', 'other', null, 1, 7, null],
        [':outside', 'outside', null, 1, 1, null],
      ],
    );
    expect(rows[0]!.machines).toEqual(['name-m1', 'name-m2']);
  });

  it('session：每個 Claude session 一列；看板的可以聚焦，封存的帶 archived，中控台外沒有目標', () => {
    const rows = sortRows(ranking(report, p, 'session'), 'input', true);
    expect(rows.map((r) => [r.key, r.kind, r.label, r.cwd, r.target?.type ?? null])).toEqual([
      ['m2:d', 'board', 'Delta', '/w/delta', 'session'],
      ['m1:a', 'board', 'Alpha', '/w/alpha', 'session'],
      ['m1:other', 'other', null, null, null],
      ['m1:b', 'board', 'Beta', '/w/beta', 'session'],
      ['m1:x', 'outside', null, '/w/alpha', null],
    ]);
    expect(rows[0]!.target).toEqual({
      type: 'session',
      sessionId: 's-d',
      archived: true,
      teamId: 't1',
    });
    // 反向排序
    expect(sortRows(rows, 'input', false)[0]!.key).toBe('m1:x');
  });

  it('專案：依資料夾合併（看板內外都算），點了聚焦用最多的看板 session', () => {
    const rows = sortRows(ranking(report, p, 'project'), 'all', true);
    const alpha = rows.find((r) => r.key === 'cwd:/w/alpha')!;
    expect(alpha.sessions).toBe(2);
    expect(alpha.counts).toEqual({ input: 11, output: 22, cacheRead: 1003, cacheCreation: 54 });
    expect(alpha.target).toMatchObject({ type: 'session', sessionId: 's-a' });
    expect(rows.find((r) => r.key === ':other')!.target).toBeNull();
  });

  it('期間外的不算', () => {
    const rows = ranking(report, periodEnding(TODAY, 1), 'session');
    expect(rows.map((r) => r.key).sort()).toEqual(['m1:a', 'm2:d']);
  });
});

describe('分布', () => {
  it('依模型（空字串是沒寫模型）、依機器（只列有細項的）', () => {
    const p = periodEnding(TODAY, 7);
    expect(byModel(report, p, 'conversation')).toEqual([
      { key: 'model:0', label: 'opus', value: 30 + 10 + 7 + 100 },
      { key: 'model:1', label: '', value: 3 },
    ]);
    expect(byMachine(report, p, 'conversation').map((s) => [s.key, s.value])).toEqual([
      ['m2', 100],
      ['m1', 50],
    ]);
  });

  it('shortPath 留最後兩層', () => {
    expect(shortPath('/home/demo/work/api')).toBe('…/work/api');
    expect(shortPath('/w/a')).toBe('/w/a');
  });
});
