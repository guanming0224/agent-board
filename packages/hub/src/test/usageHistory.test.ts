// 用量歷史（GM 2026-11-21，CONTRACTS §28）：保存規則（舊日不被歸零）、daemon 的今天與日期用 hub 時鐘把關、
// 每台列數上限、回填、ack、舊 daemon 格式寫入歷史、新 daemon 不退回細項、換時區的回填、機器移除後仍可看、
// 「全部」在 SQL 端按月加總、migration v11 → v12（含舊資料的資料庫）。
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUsageHistoryReport,
  shiftUsageDay,
  shouldReplaceHistory,
  trustedHistoryToday,
  UsageDay,
  UsageHistory,
  type UsageDetail,
  type UsageHistoryCell,
  type UsageHistoryReport,
} from '@agent-board/protocol';
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from '../db';
import { Store } from '../store';
import { startHub, until, type TestHub } from './helpers';

const counts = (input: number, output = 0, read = 0, write = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheCreationTokens: write,
});
const cell = (
  day: string,
  input: number,
  source: 'claude' | 'codex' = 'claude',
  model = 'claude-opus',
): UsageHistoryCell => ({ day, source, model, ...counts(input) });

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-history-'));
  temps.push(dir);
  return join(dir, 'hub.db');
}

/** `機器|月份|來源|模型` → input（測試只用 input 也夠看出規則）。 */
const flatReport = (r: UsageHistoryReport) =>
  Object.fromEntries(
    r.rows.map(([m, mo, model, s, i]) => [
      `${r.machines[m]!.machineId}|${r.months[mo]}|${s === 1 ? 'codex' : 'claude'}|${r.models[model]}`,
      i,
    ]),
  );

describe('日期把關', () => {
  it('UsageDay 只收真的日曆日', () => {
    for (const bad of ['9999-99-99', '2026-02-30', '0000-01-01', '2026-13-01']) {
      expect(UsageDay.safeParse(bad).success, bad).toBe(false);
    }
    expect(UsageDay.safeParse('2024-02-29').success).toBe(true);
  });

  it('daemon 的今天要在 hub UTC 今天 ±1 天內才可信', () => {
    const hubToday = '2026-11-21';
    expect(trustedHistoryToday('2026-11-20', hubToday)).toBe('2026-11-20');
    expect(trustedHistoryToday('2026-11-22', hubToday)).toBe('2026-11-22');
    for (const bad of ['2026-11-19', '2026-11-23', '2000-01-01', '9999-12-31', '9999-99-99']) {
      expect(trustedHistoryToday(bad, hubToday), bad).toBeNull();
    }
    expect(trustedHistoryToday(null, hubToday)).toBeNull();
  });
});

describe('保存規則 shouldReplaceHistory', () => {
  it('沒存過寫；最近兩天（recentFrom ≤ 日 ≤ 今天）以新值為準；其他只在不變小時換', () => {
    const today = '2026-11-21';
    expect(shouldReplaceHistory(null, counts(0), '2020-01-01', today)).toBe(true);
    expect(shouldReplaceHistory(counts(10), counts(3), '2026-11-21', today)).toBe(true);
    expect(shouldReplaceHistory(counts(10), counts(3), '2026-11-20', today)).toBe(true);
    expect(shouldReplaceHistory(counts(10), counts(3), '2026-11-19', today)).toBe(false);
    // 比今天晚的日子不算「最近」。
    expect(shouldReplaceHistory(counts(10), counts(3), '2026-11-22', today)).toBe(false);
    // 今天不可信（null）：什麼都不能變小。
    expect(shouldReplaceHistory(counts(10), counts(3), '2026-11-21', null)).toBe(false);
    expect(shouldReplaceHistory(counts(10), counts(0), '2026-01-01', today)).toBe(false);
    // 比的是四項合計，整列一起換；force 不比。
    expect(shouldReplaceHistory(counts(10, 0), counts(1, 9), '2026-01-01', today)).toBe(true);
    expect(shouldReplaceHistory(counts(10, 0), counts(1, 8), '2026-01-01', today)).toBe(false);
    expect(shouldReplaceHistory(counts(10), counts(1), '2026-01-01', today, true)).toBe(true);
  });
});

describe('store.upsertUsageHistory', () => {
  const open = () => {
    const db = openDatabase(tempDb(), { log: () => undefined });
    return { db, store: new Store(db, '127.0.0.1') };
  };
  const hubToday = '2026-11-21';
  const machine = { machineId: 'm1', name: 'Mac', timeZone: 'Asia/Taipei', today: '2026-11-21' };
  const opts = (complete = false) => ({ complete, hubToday });
  const read = (store: Store) =>
    Object.fromEntries(
      store.listUsageHistory().map((c) => [`${c.day}|${c.source}|${c.model}`, c.inputTokens]),
    );

  it('舊日子：紀錄被清掉（變小、送 0、整列沒送）都不會歸零或刪掉；變大照寫', () => {
    const { db, store } = open();
    store.upsertUsageHistory(
      machine,
      [cell('2026-07-01', 100), cell('2026-07-02', 50), cell('2026-11-21', 5)],
      '2026-11-21T00:00:00.000Z',
      opts(true),
    );
    // Claude Code 清掉 7 月的紀錄：daemon 掃到的變小或沒了。
    const result = store.upsertUsageHistory(
      machine,
      [cell('2026-07-01', 30), cell('2026-07-02', 0), cell('2026-11-21', 6)],
      '2026-11-21T01:00:00.000Z',
      opts(),
    );
    expect(result.written).toBe(1);
    expect(read(store)).toEqual({
      '2026-07-01|claude|claude-opus': 100,
      '2026-07-02|claude|claude-opus': 50,
      '2026-11-21|claude|claude-opus': 6,
    });
    // 舊日子變大（例如舊對話被 resume 補了紀錄）：換掉。
    store.upsertUsageHistory(
      machine,
      [cell('2026-07-01', 120)],
      '2026-11-21T02:00:00.000Z',
      opts(),
    );
    expect(read(store)['2026-07-01|claude|claude-opus']).toBe(120);
    db.close();
  });

  it('最近 2 天（含今天）以最新為準，可以變小；第 3 天前就不行', () => {
    const { db, store } = open();
    store.upsertUsageHistory(
      machine,
      [cell('2026-11-19', 10), cell('2026-11-20', 10), cell('2026-11-21', 10)],
      '2026-11-21T00:00:00.000Z',
      opts(),
    );
    store.upsertUsageHistory(
      machine,
      [cell('2026-11-19', 1), cell('2026-11-20', 2), cell('2026-11-21', 3)],
      '2026-11-21T01:00:00.000Z',
      opts(),
    );
    expect(read(store)).toEqual({
      '2026-11-19|claude|claude-opus': 10,
      '2026-11-20|claude|claude-opus': 2,
      '2026-11-21|claude|claude-opus': 3,
    });
    db.close();
  });

  it('daemon 的今天不可信（亂寫、時鐘落後或超前）：舊日子一律不變小；未來與 2020 以前的日子丟掉', () => {
    const { db, store } = open();
    store.upsertUsageHistory(
      machine,
      [cell('2026-07-01', 100), cell('2026-11-20', 10), cell('2026-11-21', 10)],
      '2026-11-21T00:00:00.000Z',
      opts(),
    );
    for (const today of ['9999-12-31', '2020-01-01', '2000-01-01', '2026-11-25', '9999-99-99']) {
      store.upsertUsageHistory(
        { ...machine, today },
        [cell('2026-07-01', 1), cell('2026-11-20', 1), cell('2026-11-21', 1)],
        '2026-11-21T01:00:00.000Z',
        opts(),
      );
    }
    expect(read(store)).toEqual({
      '2026-07-01|claude|claude-opus': 100,
      '2026-11-20|claude|claude-opus': 10,
      '2026-11-21|claude|claude-opus': 10,
    });
    const result = store.upsertUsageHistory(
      machine,
      [cell('2026-11-22', 5), cell('2026-11-23', 5), cell('3000-01-01', 5), cell('2019-12-31', 5)],
      '2026-11-21T02:00:00.000Z',
      opts(),
    );
    // hub 的明天（時區差）照收；後天以後、2020 以前的丟掉。
    expect(result).toMatchObject({ written: 1, dropped: 3 });
    expect(read(store)['2026-11-22|claude|claude-opus']).toBe(5);
    db.close();
  });

  it('每台列數上限：滿了只更新已有的列，不新增', () => {
    const { db, store } = open();
    store.upsertUsageHistory(
      machine,
      [cell('2026-01-01', 1), cell('2026-01-02', 1)],
      '2026-11-21T00:00:00.000Z',
      { ...opts(), rowLimit: 2 },
    );
    const result = store.upsertUsageHistory(
      machine,
      [cell('2026-01-01', 9), cell('2026-01-03', 9)],
      '2026-11-21T01:00:00.000Z',
      { ...opts(), rowLimit: 2 },
    );
    expect(result).toMatchObject({ written: 1, skipped: 1 });
    expect(read(store)).toEqual({
      '2026-01-01|claude|claude-opus': 9,
      '2026-01-02|claude|claude-opus': 1,
    });
    // 別台不受影響。
    store.upsertUsageHistory(
      { ...machine, machineId: 'm2' },
      [cell('2026-01-03', 1)],
      '2026-11-21T02:00:00.000Z',
      { ...opts(), rowLimit: 2 },
    );
    expect(store.listUsageHistory()).toHaveLength(3);
    db.close();
  });

  it('force（換時區後的完整回填）：送來的格直接換掉，不比大小', () => {
    const { db, store } = open();
    store.upsertUsageHistory(
      machine,
      [cell('2026-07-01', 100)],
      '2026-11-21T00:00:00.000Z',
      opts(),
    );
    store.upsertUsageHistory(machine, [cell('2026-07-01', 60)], '2026-11-21T01:00:00.000Z', {
      ...opts(true),
      force: true,
    });
    expect(read(store)['2026-07-01|claude|claude-opus']).toBe(60);
    db.close();
  });

  it('機器資訊：名稱跟著更新；complete 只在完整回填時記，之後的增量不清掉', () => {
    const { db, store } = open();
    store.upsertUsageHistory(machine, [], '2026-11-21T00:00:00.000Z', opts(true));
    store.upsertUsageHistory(
      { ...machine, name: 'Mac mini', timeZone: null },
      [],
      '2026-11-21T01:00:00.000Z',
      opts(),
    );
    expect(store.listUsageHistoryMachines()).toEqual([
      {
        machineId: 'm1',
        name: 'Mac mini',
        timeZone: 'Asia/Taipei',
        updatedAt: '2026-11-21T01:00:00.000Z',
        completeAt: '2026-11-21T00:00:00.000Z',
      },
    ]);
    db.close();
  });

  it('SQL 端按月加總：月份、範圍', () => {
    const { db, store } = open();
    store.upsertUsageHistory(
      machine,
      [
        cell('2026-07-01', 1),
        cell('2026-07-31', 2),
        cell('2026-08-01', 4),
        cell('2026-08-02', 8, 'codex'),
      ],
      '2026-11-21T00:00:00.000Z',
      opts(),
    );
    expect(
      store
        .listUsageHistoryMonthly('2026-08-02')
        .map((m) => [m.month, m.source, m.inputTokens])
        .sort(),
    ).toEqual([
      ['2026-07', 'claude', 3],
      ['2026-08', 'claude', 4],
    ]);
    expect(store.listUsageHistory('2026-08-02').map((c) => c.day)).toEqual(['2026-08-02']);
    expect(
      store
        .listUsageHistoryRanges()
        .map((r) => [r.source, r.first, r.last])
        .sort(),
    ).toEqual([
      ['claude', '2026-07-01', '2026-08-01'],
      ['codex', '2026-08-02', '2026-08-02'],
    ]);
    db.close();
  });
});

describe('migration v11 → v12', () => {
  it('含舊資料的 v11 資料庫：先備份、加兩張表、舊資料不動', () => {
    expect(SCHEMA_VERSION).toBe(12);
    const path = tempDb();
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    for (const sql of MIGRATIONS.slice(0, 11)) old.exec(sql);
    old.pragma('user_version = 11');
    old.exec(
      `INSERT INTO machines (id, name, os, token_hash, capabilities) VALUES ('m', 'Mac', 'darwin', 'h', '{}')`,
    );
    old
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('usage:m', JSON.stringify({ summary: { inputTokens: 1 } }));
    old.close();

    const db = openDatabase(path, { log: () => undefined });
    expect(db.pragma('user_version', { simple: true })).toBe(12);
    expect(db.prepare('SELECT id, name FROM machines').all()).toEqual([{ id: 'm', name: 'Mac' }]);
    expect(
      (db.prepare("SELECT value FROM settings WHERE key = 'usage:m'").get() as { value: string })
        .value,
    ).toContain('inputTokens');
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_history').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_history_machines').get()).toEqual({ n: 0 });
    db.close();
    const dir = join(path, '..');
    const backups = readdirSync(dir).filter((n) => n.includes('.bak-'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/-v11$/);
    const saved = new Database(join(dir, backups[0]!), { readonly: true });
    expect(saved.pragma('user_version', { simple: true })).toBe(11);
    saved.close();
  });
});

describe('buildUsageHistoryReport', () => {
  const mac = {
    id: 'm1',
    name: 'Mac',
    os: 'darwin' as const,
    online: true,
    lastSeenAt: null,
    capabilities: {
      hasGpu: false,
      gpuName: null,
      cpuCores: 1,
      memoryBytes: 1,
      claudeVersion: null,
    },
  };

  it('逐日：歷史 ∪ 目前掃描每天取大，再按月加；SQL 的月份直接加；已移除的機器排後面', () => {
    const report = buildUsageHistoryReport({
      now: new Date('2026-11-21T00:00:00Z'),
      machines: [mac],
      monthly: [
        {
          machineId: 'gone',
          month: '2026-06',
          source: 'codex',
          model: 'gpt-5',
          ...counts(7),
        },
      ],
      daily: [
        { machineId: 'm1', ...cell('2026-11-01', 100) },
        { machineId: 'm1', ...cell('2026-11-20', 5) },
      ],
      ranges: [{ machineId: 'gone', source: 'codex', first: '2026-06-03', last: '2026-06-09' }],
      storedMachines: [
        {
          machineId: 'gone',
          name: 'Old laptop',
          timeZone: 'UTC',
          updatedAt: '2026-08-01T00:00:00.000Z',
          completeAt: null,
        },
      ],
      current: new Map([['m1', [cell('2026-11-20', 9), cell('2026-11-01', 1)]]]),
    });
    expect(flatReport(report)).toEqual({
      'm1|2026-11|claude|claude-opus': 109,
      'gone|2026-06|codex|gpt-5': 7,
    });
    expect(report.months).toEqual(['2026-06', '2026-11']);
    expect(
      report.machines.map((m) => [m.machineId, m.name, m.removed, m.firstDay, m.lastDay]),
    ).toEqual([
      ['m1', 'Mac', false, '2026-11-01', '2026-11-20'],
      ['gone', 'Old laptop', true, '2026-06-03', '2026-06-09'],
    ]);
    expect(report.ranges).toEqual([
      [0, 0, '2026-11-01', '2026-11-20'],
      [1, 1, '2026-06-03', '2026-06-09'],
    ]);
  });

  it('未來與 2020 以前的日子、月份不進報表（月份數不會爆）', () => {
    const report = buildUsageHistoryReport({
      now: new Date('2026-11-21T00:00:00Z'),
      machines: [mac],
      monthly: [
        { machineId: 'm1', month: '9999-12', source: 'claude', model: 'x', ...counts(1) },
        { machineId: 'm1', month: '1999-01', source: 'claude', model: 'x', ...counts(1) },
      ],
      daily: [{ machineId: 'm1', ...cell('2099-01-01', 5) }],
      ranges: [{ machineId: 'm1', source: 'claude', first: '1999-01-01', last: '9999-12-31' }],
      storedMachines: [],
    });
    expect(report.months).toEqual([]);
    expect(report.rows).toEqual([]);
    expect(report.ranges).toEqual([[0, 0, '2020-01-01', '2026-11-22']]);
  });
});

describe('GET /api/usage/history', () => {
  let hub: TestHub;
  afterEach(async () => {
    await hub?.stop();
  });

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = shiftUsageDay(today, -1);
  const summary = {
    from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    to: new Date().toISOString(),
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
  /** 舊 daemon 的 90 天細項（含 session）：同一天同模型兩個 session 要加起來。 */
  const detail = (rows: UsageDetail['rows']): UsageDetail => ({
    version: 1,
    timeZone: 'UTC',
    days: [yesterday, today],
    models: ['claude-opus'],
    sessions: [{ id: SID, cwd: '/w' }],
    otherSessions: 0,
    earliestAt: null,
    rows,
  });
  const history = (over: Partial<UsageHistory>): UsageHistory => ({
    version: 1,
    timeZone: 'UTC',
    today,
    complete: true,
    days: ['2025-03-01', today],
    models: ['claude-opus', 'gpt-5.5'],
    rows: [
      [0, 0, 0, 500, 1, 2, 3],
      [1, 1, 1, 40, 0, 0, 0],
    ],
    ...over,
  });
  const month = (day: string) => day.slice(0, 7);
  const stored = () =>
    Object.fromEntries(
      hub.running.store.listUsageHistory().map((c) => [`${c.day}|${c.source}`, c.inputTokens]),
    );

  it('舊 daemon 只送細項：寫進歷史；新 daemon 回填並收到 ack；清掉後舊日不歸零；移除機器後仍可看', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon, machineId } = await hub.onlineDaemon(cookie);

    // 舊 daemon：只有 90 天細項。
    daemon.send({
      type: 'usage',
      summary,
      detail: detail([
        [0, 0, 0, 10, 0, 0, 0],
        [0, 0, -1, 5, 0, 0, 0],
      ]),
    });
    await until(() => hub.running.store.listUsageHistory().length === 1, 'old daemon history');
    let res = await hub.api<UsageHistoryReport>('GET', '/api/usage/history', { cookie });
    expect(res.status).toBe(200);
    expect(res.body.machines[0]).toMatchObject({ machineId, completeAt: null, removed: false });
    expect(stored()).toEqual({ [`${yesterday}|claude`]: 15 });

    // 新 daemon：回填全部（含一年多前、Codex），寫完回 ack。
    daemon.send({
      type: 'usage',
      summary,
      detail: detail([]),
      history: history({ id: 'h1' }),
    });
    const ack = await daemon.next('usage.historyAck');
    expect(ack).toMatchObject({ id: 'h1', ok: true });
    expect(stored()).toEqual({
      '2025-03-01|claude': 500,
      [`${yesterday}|claude`]: 15,
      [`${today}|codex`]: 40,
    });
    res = await hub.api<UsageHistoryReport>('GET', '/api/usage/history', { cookie });
    expect(flatReport(res.body)[`${machineId}|2025-03|claude|claude-opus`]).toBe(500);
    expect(res.body.machines[0]!.completeAt).not.toBeNull();
    expect(res.body.machines[0]!.firstDay).toBe('2025-03-01');

    // 這條連線送過歷史：之後只帶細項（沒帶歷史）也不拿細項寫歷史（細項的數字不會蓋掉昨天）。
    daemon.send({ type: 'usage', summary, detail: detail([[0, 0, 0, 1, 0, 0, 0]]) });
    // Claude Code 把 2025 的紀錄清掉了：daemon 那天送 0（或不送），hub 留著。
    daemon.send({
      type: 'usage',
      summary: { ...summary, inputTokens: 2 },
      history: history({ complete: false, rows: [[0, 0, 0, 0, 0, 0, 0]], id: 'h2' }),
    });
    expect(await daemon.next('usage.historyAck')).toMatchObject({ id: 'h2', ok: true });
    expect(stored()[`${yesterday}|claude`]).toBe(15);
    expect(stored()['2025-03-01|claude']).toBe(500);

    // 未登入不行。
    expect((await hub.api('GET', '/api/usage/history')).status).toBe(401);

    // 移除機器：歷史照留，標「已移除」、用最後記下的名稱。
    await hub.api('DELETE', `/api/machines/${machineId}`, { cookie });
    res = await hub.api<UsageHistoryReport>('GET', '/api/usage/history', { cookie });
    const gone = res.body.machines.find((m) => m.machineId === machineId)!;
    expect(gone).toMatchObject({ removed: true, online: false });
    expect(flatReport(res.body)[`${machineId}|2025-03|claude|claude-opus`]).toBe(500);
    expect(res.body.months).toContain(month(today));
  });

  it('daemon 亂送的今天（9999-12-31、2000-01-01）與未來日期：舊日不變小、未來不進表', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon } = await hub.onlineDaemon(cookie);
    daemon.send({ type: 'usage', summary, history: history({ id: 'a' }) });
    await daemon.next('usage.historyAck');
    // 9999-99-99 不是日曆日：整份歷史被 schema 丟掉（.catch），總數照收。
    expect(UsageHistory.safeParse(history({ today: '9999-99-99' })).success).toBe(false);
    for (const [i, bad] of ['9999-12-31', '2000-01-01', '2020-01-01'].entries()) {
      daemon.send({
        type: 'usage',
        summary,
        history: history({
          today: bad,
          complete: false,
          days: ['2025-03-01', today, '2099-01-01'],
          rows: [
            [0, 0, 0, 1, 0, 0, 0],
            [1, 1, 1, 1, 0, 0, 0],
            [2, 0, 0, 9, 0, 0, 0],
          ],
          id: `bad${i}`,
        }),
      });
      expect(await daemon.next('usage.historyAck')).toMatchObject({ id: `bad${i}`, ok: true });
    }
    expect(stored()).toEqual({ '2025-03-01|claude': 500, [`${today}|codex`]: 40 });
  });

  it('換了時區的完整回填：送來的格直接換掉（不比大小）', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon } = await hub.onlineDaemon(cookie);
    daemon.send({ type: 'usage', summary, history: history({ id: 'a' }) });
    await daemon.next('usage.historyAck');
    daemon.send({
      type: 'usage',
      summary,
      history: history({
        timeZone: 'Asia/Taipei',
        id: 'b',
        rows: [[0, 0, 0, 300, 0, 0, 0]],
      }),
    });
    await daemon.next('usage.historyAck');
    expect(stored()['2025-03-01|claude']).toBe(300);
    // 同時區的回填照舊不變小。
    daemon.send({
      type: 'usage',
      summary,
      history: history({ timeZone: 'Asia/Taipei', id: 'c', rows: [[0, 0, 0, 100, 0, 0, 0]] }),
    });
    await daemon.next('usage.historyAck');
    expect(stored()['2025-03-01|claude']).toBe(300);
  });

  it('看不懂的歷史版本：不寫歷史（回 ok:false），改用細項', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon } = await hub.onlineDaemon(cookie);
    daemon.send({
      type: 'usage',
      summary,
      detail: detail([[1, 0, 0, 7, 0, 0, 0]]),
      history: history({ version: 99, id: 'v99' }),
    });
    expect(await daemon.next('usage.historyAck')).toMatchObject({ id: 'v99', ok: false });
    await until(() => hub.running.store.listUsageHistory().length === 1, 'fallback');
    expect(hub.running.store.listUsageHistory()[0]).toMatchObject({ day: today, inputTokens: 7 });
  });
});
