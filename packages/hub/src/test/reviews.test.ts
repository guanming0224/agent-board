// 交叉審查（Codex 第二輪，CONTRACTS §22）在 hub 這一段：schema v11（從真實 v10 結構升級、先備份）、
// GM 發起（prepare → 檔案清單 → 確認才 run → 兩邊結果 → done、推播只說完成）、Windows 只跑 Claude、取消、
// 隊長 request_review（權限、理由、頻率、團隊動態、推播、結果摘要送回隊長）。真的 hub、假 daemon。
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_FEATURES,
  pendingSide,
  type Review,
  type ReviewDiffSummary,
  type ReviewSide,
  type Session,
  type SessionSpec,
  type TeamActivity,
} from '@agent-board/protocol';
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from '../db';
import { leadSummaryMessage, verdictLine } from '../reviews';
import { type Peer, runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const CWD = '/fake/project';
const FEATURES = [DAEMON_FEATURES.signalGuard, DAEMON_FEATURES.codex, DAEMON_FEATURES.review];
const DIFF: ReviewDiffSummary = {
  files: [
    {
      path: 'a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      bytes: 120,
      truncated: false,
      omitted: false,
    },
  ],
  additions: 3,
  deletions: 1,
  totalBytes: 120,
  truncated: false,
};
const done = (agent: 'claude' | 'codex', output: string): ReviewSide => ({
  ...pendingSide(agent),
  status: 'done',
  output,
  model: null,
  inputTokens: 10,
  outputTokens: 5,
  durationMs: 1000,
});

async function setup(over: { features?: string[]; os?: string } = {}) {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie, {
    features: over.features ?? FEATURES,
    ...(over.os ? { os: over.os } : {}),
  } as never);
  await hub.api('POST', '/api/push/subscriptions', {
    cookie,
    body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
  });
  return { cookie, daemon, machineId };
}

async function startSession(
  b: { cookie: string; daemon: Peer; machineId: string },
  over: Partial<SessionSpec>,
): Promise<string> {
  const res = await hub.api<Session>('POST', '/api/sessions', {
    cookie: b.cookie,
    body: { ...spec({ cwd: CWD, ...over }), machineId: b.machineId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const create = await b.daemon.next('session.create', (m) => m.sessionId === res.body.id);
  b.daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(res.body.id, { status: 'waiting_input', cwd: CWD, repoRoot: CWD }),
  });
  await until(() => get(res.body.id)?.status === 'waiting_input', 'session started');
  return res.body.id;
}

const get = (id: string) => hub.running.store.getSession(id);
const reviews = () => hub.running.hub.reviews.list();
const pushes = () =>
  hub.push.sent
    .map((p) => JSON.parse(p.payload) as Record<string, unknown>)
    .filter((p) => p.kind === 'review');

/** 假 daemon 回 diff。 */
async function answerPrepare(
  daemon: Peer,
  diff: ReviewDiffSummary | null,
  error: string | null = null,
) {
  const request = await daemon.next('review.prepare');
  daemon.send({
    type: 'review.prepared',
    requestId: request.requestId,
    reviewId: request.reviewId,
    diff,
    error,
  });
  return request;
}

describe('schema v11：reviews', () => {
  it('從真實 v10 結構升級：先寫 -v10 備份、只加 reviews 表與索引、舊資料不動', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-board-v11-'));
    try {
      const path = join(dir, 'hub.db');
      const old = new Database(path);
      old.pragma('journal_mode = WAL');
      old.pragma('foreign_keys = ON');
      for (const sql of MIGRATIONS.slice(0, 10)) old.exec(sql);
      old.pragma('user_version = 10');
      old.exec(`
        INSERT INTO machines (id, name, os, token_hash, capabilities) VALUES ('m', 'm', 'darwin', 'h', '{}');
        INSERT INTO sessions (id, machine_id, name, cwd, permission_mode, status, status_since, created_at)
          VALUES ('s1', 'm', 'BD1', '/r', 'default', 'waiting_input', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');
        INSERT INTO team_presets (id, name, config, position, created_at, updated_at)
          VALUES ('p', 'preset', '{}', 0, '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z');
      `);
      const columnsBefore = old
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'")
        .get();
      old.close();

      expect(SCHEMA_VERSION).toBe(11);
      const db = openDatabase(path, { log: () => undefined });
      expect(db.pragma('user_version', { simple: true })).toBe(11);
      expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toEqual([
        expect.stringMatching(/^hub\.db\.bak-\d{8}-\d{6}-v10$/),
      ]);
      expect(db.prepare('SELECT count(*) AS n FROM reviews').get()).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'reviews_created'").get(),
      ).toEqual({ name: 'reviews_created' });
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get()).toEqual(
        columnsBefore,
      );
      expect(db.prepare("SELECT name FROM sessions WHERE id = 's1'").get()).toEqual({
        name: 'BD1',
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GM 發起', () => {
  it('prepare 只產生 diff（不跑）→ 確認才送 review.run → 兩邊結果 → done、推播只說完成、board 看得到', async () => {
    const b = await setup();
    const sessionId = await startSession(b, { name: 'BD1' });
    const client = await hub.client(b.cookie);
    const pending = hub.api<Review>('POST', '/api/reviews/prepare', {
      cookie: b.cookie,
      body: { target: { kind: 'session', sessionId } },
    });
    const request = await answerPrepare(b.daemon, DIFF);
    expect(request).toMatchObject({ kind: 'session', cwd: CWD, branch: null, base: null });
    const prepared = (await pending).body;
    expect(prepared).toMatchObject({
      status: 'awaiting_confirm',
      diff: DIFF,
      requestedBy: { kind: 'user', name: 'owner' },
      target: { kind: 'session', sessionId, label: 'BD1: uncommitted changes' },
    });
    // 還沒確認：daemon 沒收到 run。
    expect(b.daemon.of('review.run')).toHaveLength(0);

    const started = await hub.api<Review>('POST', `/api/reviews/${prepared.id}/start`, {
      cookie: b.cookie,
    });
    expect(started.body).toMatchObject({
      status: 'running',
      claude: { status: 'running' },
      codex: { status: 'running' },
    });
    const run = await b.daemon.next('review.run');
    expect(run).toMatchObject({
      reviewId: prepared.id,
      claude: { model: null, accountProfile: null },
      codex: { model: null, effort: null },
    });
    // 同一份不能再確認一次。
    expect(
      (await hub.api('POST', `/api/reviews/${prepared.id}/start`, { cookie: b.cookie })).status,
    ).toBe(409);

    b.daemon.send({
      type: 'review.side',
      reviewId: prepared.id,
      side: done('claude', 'Claude says ok'),
    });
    await until(
      () => reviews().find((r) => r.id === prepared.id)?.claude.status === 'done',
      'claude',
    );
    expect(reviews().find((r) => r.id === prepared.id)?.status).toBe('running');
    b.daemon.send({
      type: 'review.side',
      reviewId: prepared.id,
      side: { ...pendingSide('codex'), status: 'failed', error: 'quota' },
    });
    await until(() => reviews().find((r) => r.id === prepared.id)?.status === 'done', 'done');
    const finished = reviews().find((r) => r.id === prepared.id)!;
    expect(finished).toMatchObject({
      read: false,
      claude: { status: 'done', output: 'Claude says ok' },
      codex: { status: 'failed', error: 'quota' },
    });
    expect(finished.completedAt).not.toBeNull();
    // 晚到的結果不改。
    b.daemon.send({ type: 'review.side', reviewId: prepared.id, side: done('codex', 'late') });

    await until(() => pushes().length === 1, 'push');
    expect(pushes()[0]).toEqual({
      kind: 'review',
      event: 'done',
      reviewId: prepared.id,
      at: expect.any(String),
    });
    expect(JSON.stringify(pushes())).not.toContain('Claude says ok');
    await until(
      () => client.of('review.updated').some((m) => (m.review as Review).status === 'done'),
      'broadcast',
    );
    const listed = (await hub.api<Review[]>('GET', '/api/reviews', { cookie: b.cookie })).body;
    expect(listed[0]).toMatchObject({ id: prepared.id, codex: { status: 'failed' } });
    const read = (
      await hub.api<Review[]>('POST', '/api/reviews/read', { cookie: b.cookie, body: {} })
    ).body;
    expect(read[0]!.read).toBe(true);
    const actions = (
      await hub.api<{ action: string }[]>('GET', '/api/audit?action=review.start', {
        cookie: b.cookie,
      })
    ).body;
    expect(actions).toHaveLength(1);
  });

  it('分支對象；沒有變更 → no_changes；git 失敗 → 失敗原因；daemon 太舊 → 409 review_unsupported', async () => {
    const b = await setup();
    const branch = hub.api<Review>('POST', '/api/reviews/prepare', {
      cookie: b.cookie,
      body: {
        target: {
          kind: 'branch',
          machineId: b.machineId,
          repoPath: '/repo/app',
          branch: 'feature/x',
        },
      },
    });
    const request = await answerPrepare(b.daemon, { ...DIFF, files: [] });
    expect(request).toMatchObject({
      kind: 'branch',
      cwd: '/repo/app',
      branch: 'feature/x',
      base: 'main',
    });
    expect((await branch).body).toMatchObject({
      status: 'failed',
      error: 'no_changes',
      target: { label: 'app: feature/x vs main' },
    });
    const broken = hub.api<Review>('POST', '/api/reviews/prepare', {
      cookie: b.cookie,
      body: {
        target: {
          kind: 'branch',
          machineId: b.machineId,
          repoPath: '/x',
          branch: 'y',
          base: 'dev',
        },
      },
    });
    await answerPrepare(b.daemon, null, 'unknown_ref: Branch not found: y');
    expect((await broken).body).toMatchObject({
      status: 'failed',
      error: 'unknown_ref: Branch not found: y',
    });
    // 以 - 開頭的分支名稱：400，不送 daemon。
    const bad = await hub.api('POST', '/api/reviews/prepare', {
      cookie: b.cookie,
      body: {
        target: { kind: 'branch', machineId: b.machineId, repoPath: '/x', branch: '--output=x' },
      },
    });
    expect(bad.status).toBe(400);
    await hub.stop();

    const old = await setup({ features: [DAEMON_FEATURES.signalGuard] });
    const res = await hub.api<{ code: string }>('POST', '/api/reviews/prepare', {
      cookie: old.cookie,
      body: { target: { kind: 'branch', machineId: old.machineId, repoPath: '/x', branch: 'y' } },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('review_unsupported');
  });

  it('Windows 機器：只跑 Claude，Codex 標 skipped 並說明', async () => {
    const b = await setup({ os: 'win32' });
    const sessionId = await startSession(b, { name: 'BD1' });
    const pending = hub.api<Review>('POST', '/api/reviews/prepare', {
      cookie: b.cookie,
      body: { target: { kind: 'session', sessionId } },
    });
    await answerPrepare(b.daemon, DIFF);
    const prepared = (await pending).body;
    const started = (
      await hub.api<Review>('POST', `/api/reviews/${prepared.id}/start`, { cookie: b.cookie })
    ).body;
    expect(started.codex).toMatchObject({
      status: 'skipped',
      error: expect.stringMatching(/^windows:/),
    });
    expect((await b.daemon.next('review.run')).codex).toBeNull();
    b.daemon.send({ type: 'review.side', reviewId: prepared.id, side: done('claude', 'ok') });
    await until(() => reviews().find((r) => r.id === prepared.id)?.status === 'done', 'done');
  });

  it('取消：還沒確認的丟掉（daemon 收到 cancel）；跑到一半的兩邊標 cancelled', async () => {
    const b = await setup();
    const sessionId = await startSession(b, { name: 'BD1' });
    const pending = hub.api<Review>('POST', '/api/reviews/prepare', {
      cookie: b.cookie,
      body: { target: { kind: 'session', sessionId } },
    });
    await answerPrepare(b.daemon, DIFF);
    const prepared = (await pending).body;
    await hub.api('POST', `/api/reviews/${prepared.id}/start`, { cookie: b.cookie });
    const cancelled = (
      await hub.api<Review>('POST', `/api/reviews/${prepared.id}/cancel`, { cookie: b.cookie })
    ).body;
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      claude: { status: 'failed', error: 'cancelled' },
    });
    expect((await b.daemon.next('review.cancel')).reviewId).toBe(prepared.id);
  });
});

describe('隊長 request_review', () => {
  async function ask(daemon: Peer, sessionId: string, args: Record<string, unknown>) {
    const requestId = randomUUID();
    daemon.send({ type: 'dispatch.request', requestId, sessionId, tool: 'request_review', args });
    const reply = await daemon.next('dispatch.reply', (m) => m.requestId === requestId);
    return { ok: reply.ok as boolean, text: reply.text as string };
  }

  async function team() {
    const b = await setup();
    const lead = await startSession(b, { name: 'LD', permissionMode: 'acceptEdits' });
    const member = await startSession(b, { name: 'BD1', readOnly: true });
    const other = await startSession(b, { name: 'OUT' });
    const res = await hub.api<{ id: string }>('POST', '/api/teams', {
      cookie: b.cookie,
      body: {
        name: 'T',
        goal: '',
        doneCriteria: '',
        color: 'teal',
        contextMd: '',
        taskAuto: false,
      },
    });
    for (const [sessionId, role] of [
      [lead, 'lead'],
      [member, 'reviewer'],
    ] as const) {
      const put = await hub.api('PUT', `/api/teams/${res.body.id}/members/${sessionId}`, {
        cookie: b.cookie,
        body: { role },
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    }
    b.daemon.clear();
    return { ...b, lead, member, other, teamId: res.body.id };
  }

  it('理由必填、member 和 branch 只能給一個、不是隊長、不是自己團隊的成員：都擋', async () => {
    const t = await team();
    expect((await ask(t.daemon, t.lead, { member: 'BD1' })).text).toMatch(/^reason_required:/);
    expect((await ask(t.daemon, t.lead, { reason: 'x' })).text).toMatch(/^invalid_arguments:/);
    expect((await ask(t.daemon, t.lead, { member: 'BD1', branch: 'b', reason: 'x' })).text).toMatch(
      /^invalid_arguments:/,
    );
    expect((await ask(t.daemon, t.lead, { branch: '-rf', reason: 'x' })).text).toMatch(
      /^invalid_arguments:/,
    );
    expect((await ask(t.daemon, t.member, { member: 'LD', reason: 'x' })).text).toMatch(
      /^not_lead:/,
    );
    expect((await ask(t.daemon, t.lead, { member: 'OUT', reason: 'x' })).text).toMatch(
      /^not_your_member:/,
    );
    expect(t.daemon.of('review.prepare')).toHaveLength(0);
  });

  it('成功：馬上回審查 id，跳過確認自動開始；團隊動態有理由、推播只說誰要求；做完摘要送回隊長', async () => {
    const t = await team();
    const client = await hub.client(t.cookie);
    const reply = await ask(t.daemon, t.lead, { member: 'bd1', reason: 'Risky auth change.' });
    expect(reply.ok, reply.text).toBe(true);
    const body = JSON.parse(reply.text) as { reviewId: string; reviewsLeftThisHour: number };
    expect(body.reviewsLeftThisHour).toBe(2);
    const request = await answerPrepare(t.daemon, DIFF);
    expect(request.reviewId).toBe(body.reviewId);
    const run = await t.daemon.next('review.run');
    expect(run.reviewId).toBe(body.reviewId);
    const review = reviews().find((r) => r.id === body.reviewId)!;
    expect(review).toMatchObject({
      status: 'running',
      requestedBy: { kind: 'lead', id: t.lead, name: 'LD' },
      teamId: t.teamId,
      reason: 'Risky auth change.',
    });
    const activity = (client.of('team.activity').at(-1)?.items as TeamActivity[] | undefined)?.[0];
    expect(activity).toMatchObject({
      kind: 'review_requested',
      leadName: 'LD',
      memberName: 'BD1',
      reason: 'Risky auth change.',
      reviewId: body.reviewId,
    });
    await until(() => pushes().length === 1, 'requested push');
    expect(pushes()[0]).toMatchObject({ event: 'requested', lead: 'LD', reviewId: body.reviewId });
    expect(JSON.stringify(pushes())).not.toContain('Risky');
    const audit = (
      await hub.api<{ detail: string }[]>('GET', '/api/audit?action=dispatch.review', {
        cookie: t.cookie,
      })
    ).body;
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ reason: 'Risky auth change.' });

    t.daemon.send({
      type: 'review.side',
      reviewId: body.reviewId,
      side: done('claude', '1. 嚴重問題：無\n2. 建議：無\n3. 整體結論：可以合併。'),
    });
    t.daemon.send({
      type: 'review.side',
      reviewId: body.reviewId,
      side: done('codex', 'Looks fine overall.\nVerdict: needs one more test.'),
    });
    const typed = await t.daemon.next(
      'terminal.input',
      (m) => m.sessionId === t.lead && String(m.data).startsWith('[Review from Agent Board]'),
    );
    expect(String(typed.data)).toBe(
      '[Review from Agent Board] BD1: uncommitted changes | Claude: 可以合併。 | Codex: needs one more test. | Full review is in the Agent Board inbox.',
    );
  });

  it('每隊每小時上限（設定可改）：用完回 review_rate_limit；設成 0 回 review_disabled', async () => {
    const t = await team();
    await hub.api('PATCH', '/api/settings', {
      cookie: t.cookie,
      body: { review: { leadPerHour: 2, claudeModel: null, codexModel: null, codexEffort: null } },
    });
    for (let i = 0; i < 2; i += 1) {
      expect((await ask(t.daemon, t.lead, { branch: 'feature/x', reason: `r${i}` })).ok).toBe(true);
    }
    expect((await ask(t.daemon, t.lead, { branch: 'feature/x', reason: 'again' })).text).toMatch(
      /^review_rate_limit:/,
    );
    await hub.api('PATCH', '/api/settings', {
      cookie: t.cookie,
      body: { review: { leadPerHour: 0, claudeModel: null, codexModel: null, codexEffort: null } },
    });
    expect((await ask(t.daemon, t.lead, { branch: 'feature/x', reason: 'x' })).text).toMatch(
      /^review_disabled:/,
    );
    // 分支審查預設用隊長的 repo、base main。
    expect(await t.daemon.next('review.prepare')).toMatchObject({
      kind: 'branch',
      cwd: CWD,
      branch: 'feature/x',
      base: 'main',
    });
  });
});

describe('摘要（固定規則，不解讀內容）', () => {
  it('取「整體結論」那段第一句；沒有就最後一行；失敗、略過寫原因', () => {
    expect(verdictLine(done('claude', 'a\nb\n3. 整體結論：可以合併。\n'))).toBe('可以合併。');
    expect(verdictLine(done('codex', 'line one\nlast line'))).toBe('last line');
    expect(verdictLine({ ...pendingSide('codex'), status: 'skipped', error: 'windows: x' })).toBe(
      'skipped (windows: x)',
    );
    expect(verdictLine({ ...pendingSide('codex'), status: 'timeout', error: 'timed out' })).toBe(
      'timeout (timed out)',
    );
    const review = {
      target: { label: 'X\x1b[31m' },
      claude: done('claude', '整體結論：ok'),
      codex: done('codex', 'ok'),
    } as Review;
    expect(leadSummaryMessage(review)).not.toContain('\x1b');
  });
});
