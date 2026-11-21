// 用量歷史（GM 2026-11-21，CONTRACTS §27）：保存規則（舊日不被歸零）、回填、舊 daemon 格式寫入歷史、
// 機器移除後仍可看、migration v11 → v12（含舊資料的資料庫）。
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUsageHistoryReport,
  shouldReplaceHistory,
  type UsageDetail,
  type UsageHistory,
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

/** `機器|日期|來源|模型` → input（測試只用 input 也夠看出規則）。 */
const flatReport = (r: UsageHistoryReport) =>
  Object.fromEntries(
    r.rows.map(([m, d, mo, s, i]) => [
      `${r.machines[m]!.machineId}|${r.days[d]}|${s === 1 ? 'codex' : 'claude'}|${r.models[mo]}`,
      i,
    ]),
  );

describe('保存規則 shouldReplaceHistory', () => {
  it('沒存過寫；最近幾天以新值為準（可變小）；更早的只在不變小時換', () => {
    const recentFrom = '2026-11-20';
    expect(shouldReplaceHistory(null, counts(0), '2020-01-01', recentFrom)).toBe(true);
    expect(shouldReplaceHistory(counts(10), counts(3), '2026-11-20', recentFrom)).toBe(true);
    expect(shouldReplaceHistory(counts(10), counts(3), '2026-11-19', recentFrom)).toBe(false);
    expect(shouldReplaceHistory(counts(10), counts(0), '2026-01-01', recentFrom)).toBe(false);
    // 比的是四項合計，整列一起換。
    expect(shouldReplaceHistory(counts(10, 0), counts(1, 9), '2026-01-01', recentFrom)).toBe(true);
    expect(shouldReplaceHistory(counts(10, 0), counts(1, 8), '2026-01-01', recentFrom)).toBe(false);
  });
});

describe('store.upsertUsageHistory', () => {
  const open = () => {
    const db = openDatabase(tempDb(), { log: () => undefined });
    return { db, store: new Store(db, '127.0.0.1') };
  };
  const machine = { machineId: 'm1', name: 'Mac', timeZone: 'Asia/Taipei', today: '2026-11-21' };
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
      true,
    );
    // Claude Code 清掉 7 月的紀錄：daemon 掃到的變小或沒了。
    const written = store.upsertUsageHistory(
      machine,
      [cell('2026-07-01', 30), cell('2026-07-02', 0), cell('2026-11-21', 6)],
      '2026-11-21T01:00:00.000Z',
      false,
    );
    expect(written).toBe(1);
    expect(read(store)).toEqual({
      '2026-07-01|claude|claude-opus': 100,
      '2026-07-02|claude|claude-opus': 50,
      '2026-11-21|claude|claude-opus': 6,
    });
    // 舊日子變大（例如舊對話被 resume 補了紀錄）：換掉。
    store.upsertUsageHistory(machine, [cell('2026-07-01', 120)], '2026-11-21T02:00:00.000Z', false);
    expect(read(store)['2026-07-01|claude|claude-opus']).toBe(120);
    db.close();
  });

  it('最近 2 天（含今天）以最新為準，可以變小；第 3 天前就不行', () => {
    const { db, store } = open();
    store.upsertUsageHistory(
      machine,
      [cell('2026-11-19', 10), cell('2026-11-20', 10), cell('2026-11-21', 10)],
      '2026-11-21T00:00:00.000Z',
      false,
    );
    store.upsertUsageHistory(
      machine,
      [cell('2026-11-19', 1), cell('2026-11-20', 2), cell('2026-11-21', 3)],
      '2026-11-21T01:00:00.000Z',
      false,
    );
    expect(read(store)).toEqual({
      '2026-11-19|claude|claude-opus': 10,
      '2026-11-20|claude|claude-opus': 2,
      '2026-11-21|claude|claude-opus': 3,
    });
    db.close();
  });

  it('機器資訊：名稱跟著更新；complete 只在完整回填時記，之後的增量不清掉', () => {
    const { db, store } = open();
    store.upsertUsageHistory(machine, [], '2026-11-21T00:00:00.000Z', true);
    store.upsertUsageHistory(
      { ...machine, name: 'Mac mini', timeZone: null },
      [],
      '2026-11-21T01:00:00.000Z',
      false,
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
  it('hub 歷史 ∪ 機器目前的掃描，每格取較大；已移除的機器排後面、用存下的名稱', () => {
    const report = buildUsageHistoryReport({
      now: new Date('2026-11-21T00:00:00Z'),
      machines: [
        {
          id: 'm1',
          name: 'Mac',
          os: 'darwin',
          online: true,
          lastSeenAt: null,
          capabilities: {
            hasGpu: false,
            gpuName: null,
            cpuCores: 1,
            memoryBytes: 1,
            claudeVersion: null,
          },
        },
      ],
      stored: [
        { machineId: 'm1', ...cell('2026-07-01', 100) },
        { machineId: 'm1', ...cell('2026-11-20', 5) },
        { machineId: 'gone', ...cell('2026-06-01', 7, 'codex', 'gpt-5') },
      ],
      storedMachines: [
        {
          machineId: 'gone',
          name: 'Old laptop',
          timeZone: 'UTC',
          updatedAt: '2026-08-01T00:00:00.000Z',
          completeAt: null,
        },
      ],
      current: new Map([['m1', [cell('2026-11-20', 9), cell('2026-07-01', 1)]]]),
    });
    expect(flatReport(report)).toEqual({
      'm1|2026-07-01|claude|claude-opus': 100,
      'm1|2026-11-20|claude|claude-opus': 9,
      'gone|2026-06-01|codex|gpt-5': 7,
    });
    expect(report.days).toEqual(['2026-06-01', '2026-07-01', '2026-11-20']);
    expect(
      report.machines.map((m) => [m.machineId, m.name, m.removed, m.firstDay, m.lastDay]),
    ).toEqual([
      ['m1', 'Mac', false, '2026-07-01', '2026-11-20'],
      ['gone', 'Old laptop', true, '2026-06-01', '2026-06-01'],
    ]);
  });
});

describe('GET /api/usage/history', () => {
  let hub: TestHub;
  afterEach(async () => {
    await hub?.stop();
  });

  const summary = {
    from: '2026-10-22T00:00:00.000Z',
    to: '2026-11-21T00:00:00.000Z',
    inputTokens: 1,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const SID = 'aaaaaaaa-0000-4000-8000-000000000001';
  /** 舊 daemon 的 90 天細項（含 session）：同一天同模型兩個 session 要加起來。 */
  const detail = (rows: UsageDetail['rows']): UsageDetail => ({
    version: 1,
    timeZone: 'Asia/Taipei',
    days: ['2026-11-20', '2026-11-21'],
    models: ['claude-opus'],
    sessions: [{ id: SID, cwd: '/w' }],
    otherSessions: 0,
    earliestAt: null,
    rows,
  });
  const history = (over: Partial<UsageHistory>): UsageHistory => ({
    version: 1,
    timeZone: 'Asia/Taipei',
    today: '2026-11-21',
    complete: true,
    days: ['2025-03-01', '2026-11-21'],
    models: ['claude-opus', 'gpt-5.5'],
    rows: [
      [0, 0, 0, 500, 1, 2, 3],
      [1, 1, 1, 40, 0, 0, 0],
    ],
    ...over,
  });

  it('舊 daemon 只送細項：壓成日期 × 模型寫進歷史；新 daemon 回填全部；機器上清掉後舊日不歸零；移除機器後仍可看', async () => {
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
    expect(flatReport(res.body)).toEqual({ [`${machineId}|2026-11-20|claude|claude-opus`]: 15 });
    expect(res.body.machines[0]).toMatchObject({ machineId, completeAt: null, removed: false });

    // 新 daemon：回填全部（含一年多前、Codex）。
    daemon.send({ type: 'usage', summary, detail: detail([]), history: history({}) });
    await until(() => hub.running.store.listUsageHistory().length === 3, 'backfill');
    res = await hub.api<UsageHistoryReport>('GET', '/api/usage/history', { cookie });
    expect(flatReport(res.body)).toEqual({
      [`${machineId}|2025-03-01|claude|claude-opus`]: 500,
      [`${machineId}|2026-11-20|claude|claude-opus`]: 15,
      [`${machineId}|2026-11-21|codex|gpt-5.5`]: 40,
    });
    expect(res.body.machines[0]!.completeAt).not.toBeNull();
    expect(res.body.machines[0]!.firstDay).toBe('2025-03-01');

    // Claude Code 把 2025 的紀錄清掉了：daemon 那天送 0（或不送），hub 留著。
    daemon.send({
      type: 'usage',
      summary,
      history: history({ complete: false, rows: [[0, 0, 0, 0, 0, 0, 0]] }),
    });
    daemon.send({ type: 'usage', summary: { ...summary, inputTokens: 2 } });
    await until(() => hub.running.hub.latestUsage(machineId)?.inputTokens === 2, 'processed');
    res = await hub.api<UsageHistoryReport>('GET', '/api/usage/history', { cookie });
    expect(flatReport(res.body)[`${machineId}|2025-03-01|claude|claude-opus`]).toBe(500);

    // 未登入不行。
    expect((await hub.api('GET', '/api/usage/history')).status).toBe(401);

    // 移除機器：歷史照留，標「已移除」、用最後記下的名稱。
    await hub.api('DELETE', `/api/machines/${machineId}`, { cookie });
    res = await hub.api<UsageHistoryReport>('GET', '/api/usage/history', { cookie });
    const gone = res.body.machines.find((m) => m.machineId === machineId)!;
    expect(gone).toMatchObject({ removed: true, online: false });
    expect(flatReport(res.body)[`${machineId}|2025-03-01|claude|claude-opus`]).toBe(500);
  });

  it('看不懂的歷史版本：不寫歷史，改用細項', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const { daemon } = await hub.onlineDaemon(cookie);
    daemon.send({
      type: 'usage',
      summary,
      detail: detail([[1, 0, 0, 7, 0, 0, 0]]),
      history: history({ version: 99 }),
    });
    await until(() => hub.running.store.listUsageHistory().length === 1, 'fallback');
    expect(hub.running.store.listUsageHistory()[0]).toMatchObject({
      day: '2026-11-21',
      inputTokens: 7,
    });
  });
});
