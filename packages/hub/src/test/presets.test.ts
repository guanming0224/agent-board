// 團隊 Presets（P3 項目二，docs/p3-spec.md §2.5–2.6）：schema v10 升級、REST CRUD、排序、名稱不分大小寫不重複、
// WS preset.list、audit preset.*、套用回報 used。真的 hub；套用本身（逐列建立）在前端，見 web 的 runPlan 測試與 e2e。
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  leadFirstPrompt,
  progressCardLine,
  TeamPresetConfig,
  TeamPresetConfigFields,
  teamPresetProblem,
  type TeamPreset,
  type TeamPresetConfigInput,
} from '@agent-board/protocol';
import { MIGRATIONS, openDatabase, SCHEMA_VERSION } from '../db';
import { Store } from '../store';
import { connect, startHub, type TestHub } from './helpers';

const NOW = () => new Date(2026, 10, 8, 9, 5, 7);
const STAMP = '20261108-090507';

describe('schema v10：team_presets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-board-presets-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** 只跑到 v9 的真實結構（不是從新版倒退），放 6 團隊、13 session（同 P3 §1.8-1 的規模）。 */
  function makeV9(path: string): void {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const sql of MIGRATIONS.slice(0, 9)) db.exec(sql);
    db.pragma('user_version = 9');
    const T = '2026-11-08T00:00:00.000Z';
    db.exec(`
      INSERT INTO users (id, name, password_hash, role, locale) VALUES ('u', 'gm', 'h', 'owner', 'zh-TW');
      INSERT INTO machines (id, name, os, token_hash, capabilities) VALUES ('m', 'm', 'darwin', 'h', '{}');
      INSERT INTO zones (id, name, created_at, position) VALUES ('z2', '交易', '${T}', 1);
      INSERT INTO templates (id, name, config) VALUES ('tpl', 'single', '{}');
    `);
    const session = db.prepare(
      `INSERT INTO sessions (id, machine_id, name, cwd, permission_mode, status, status_since, created_at, archived, zone_id)
       VALUES (?, 'm', ?, '/r', 'default', 'waiting_input', ?, ?, 0, ?)`,
    );
    const layout = db.prepare(
      `INSERT INTO layouts (id, user_id, workspace, session_id, x, y, w, h) VALUES (?, 'u', 'default', ?, ?, ?, 680, 640)`,
    );
    for (let i = 1; i <= 13; i++) {
      session.run(`s${i}`, `name-${i}`, T, T, i > 10 ? 'z2' : 'main');
      layout.run(`l${i}`, `s${i}`, i * 820, (i % 3) * 712);
    }
    const team = db.prepare(
      `INSERT INTO teams (id, name, goal, done_criteria, color, context_md, zone_id) VALUES (?, ?, 'g', '', 'teal', '# md', 'main')`,
    );
    const member = db.prepare(
      'INSERT INTO team_members (team_id, session_id, role) VALUES (?, ?, ?)',
    );
    for (let t = 1; t <= 6; t++) {
      team.run(`t${t}`, `team-${t}`);
      member.run(`t${t}`, `s${t * 2 - 1}`, 'lead');
      member.run(`t${t}`, `s${t * 2}`, 'worker');
    }
    db.close();
  }

  it('v9 升級：寫 -v9 備份；team_presets 存在且為空；舊資料（團隊、session、工作區、範本、座標）原封不動', () => {
    expect(SCHEMA_VERSION).toBe(11);
    const path = join(dir, 'hub.db');
    makeV9(path);
    const before = new Database(path, { readonly: true });
    const layoutsBefore = before.prepare('SELECT * FROM layouts ORDER BY id').all();
    const teamsBefore = before.prepare('SELECT * FROM teams ORDER BY id').all();
    before.close();

    const db = openDatabase(path, { log: () => undefined, now: NOW });
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toEqual([`hub.db.bak-${STAMP}-v9`]);
    const columns = (db.prepare('PRAGMA table_info(team_presets)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual([
      'id',
      'name',
      'config',
      'position',
      'created_at',
      'updated_at',
      'last_used_at',
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM team_presets').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT * FROM layouts ORDER BY id').all()).toEqual(layoutsBefore);
    expect(db.prepare('SELECT * FROM teams ORDER BY id').all()).toEqual(teamsBefore);
    const store = new Store(db, '127.0.0.1');
    expect(store.listSessions()).toHaveLength(13);
    expect(store.listZones().map((z) => z.id)).toEqual(['main', 'z2']);
    expect(store.listTemplates().map((t) => t.id)).toEqual(['tpl']);
    expect(store.listTeamMembers('t4').map((m) => m.sessionId)).toEqual(['s7', 's8']);
    // 名稱不分大小寫唯一（COLLATE NOCASE）。
    const insert = db.prepare(
      `INSERT INTO team_presets (id, name, config, position, created_at, updated_at) VALUES (?, ?, '{}', 0, 'x', 'x')`,
    );
    insert.run('a', 'Alpha');
    expect(() => insert.run('b', 'alpha')).toThrow(/UNIQUE/);
    db.close();

    // 降級演練：-v9 備份還是 v9、沒有 team_presets。
    const saved = new Database(join(dir, `hub.db.bak-${STAMP}-v9`), { readonly: true });
    expect(saved.pragma('user_version', { simple: true })).toBe(9);
    expect(
      saved.prepare("SELECT name FROM sqlite_master WHERE name = 'team_presets'").all(),
    ).toEqual([]);
    saved.close();
  });
});

const config = (over: Partial<TeamPresetConfigInput> = {}): TeamPresetConfigInput => ({
  teamType: 'dev',
  color: 'teal',
  goal: 'Validate strategies',
  contextMd: '# rules',
  placement: { machineId: 'm1', cwd: '/repo' },
  rows: [
    { kind: 'lead', permissionMode: 'default' },
    { kind: 'worker', permissionMode: 'acceptEdits', useWorktree: true },
    { kind: 'worker', permissionMode: 'acceptEdits', useWorktree: true },
    { kind: 'reviewer', permissionMode: 'plan' },
  ],
  handoffRules: [{ fromRow: 1, toRow: 3, trigger: 'on_done', enabled: false }],
  ...over,
});

describe('TeamPresetConfig 與第一個指令（純函式）', () => {
  it('補預設值；欄位之間的關係不對時說出原因', () => {
    const parsed = TeamPresetConfig.parse(config());
    expect(parsed).toMatchObject({
      phase: null,
      doneCriteria: '',
      taskAuto: false,
      leadFirstPrompt: null,
      attachProgressCard: true,
      initialProgress: { status: '', next: '', blockers: '', gmNotes: '' },
    });
    expect(parsed.rows[0]).toEqual({
      kind: 'lead',
      permissionMode: 'default',
      model: null,
      useWorktree: null,
      label: null,
    });
    const problem = (over: Partial<TeamPresetConfigInput>) =>
      teamPresetProblem(TeamPresetConfigFields.parse(config(over)));
    expect(problem({})).toBeNull();
    expect(problem({ rows: [{ kind: 'worker', permissionMode: 'default' }] })).toBe('lead_count');
    expect(problem({ rows: [{ kind: 'ld', permissionMode: 'default' }] })).toBe('kind_mismatch');
    expect(
      problem({
        teamType: 'research',
        phase: null,
        rows: [{ kind: 'ld', permissionMode: 'default' }],
        handoffRules: [],
      }),
    ).toBe('phase_mismatch');
    expect(
      problem({ handoffRules: [{ fromRow: 1, toRow: 9, trigger: 'on_done', enabled: true }] }),
    ).toBe('rule_row');
    expect(
      problem({ handoffRules: [{ fromRow: 1, toRow: 1, trigger: 'on_done', enabled: true }] }),
    ).toBe('rule_self');
    expect(
      problem({ handoffRules: [{ fromRow: 1, toRow: 0, trigger: 'on_marker', enabled: true }] }),
    ).toBe('marker_required');
    expect(TeamPresetConfig.safeParse(config({ rows: [] })).success).toBe(false);
  });

  it('隊長第一個指令以進度卡那一行開頭、接著是 Preset 的指令；空欄位略過、一行、整段不超過 4000 字', () => {
    const base = TeamPresetConfig.parse(
      config({
        leadFirstPrompt: 'Start with the 2021 data.',
        initialProgress: { next: 'A', blockers: 'wait\nfor GM' },
      }),
    );
    expect(leadFirstPrompt('策略驗證 2', base)).toBe(
      '[Progress card: 策略驗證 2] Next: A | Blockers: wait for GM Start with the 2021 data.',
    );
    // 不附上、卡片空白、沒有指令。
    expect(leadFirstPrompt('X', { ...base, attachProgressCard: false })).toBe(
      'Start with the 2021 data.',
    );
    expect(
      leadFirstPrompt('X', {
        ...base,
        initialProgress: { status: ' ', next: '', blockers: '', gmNotes: '' },
      }),
    ).toBe('Start with the 2021 data.');
    expect(leadFirstPrompt('X', { ...base, leadFirstPrompt: null })).toBeNull();
    const long = leadFirstPrompt('X', {
      ...base,
      leadFirstPrompt: 'p'.repeat(3000),
      initialProgress: { status: 's'.repeat(2000), next: '', blockers: '', gmNotes: '' },
    })!;
    expect(long.length).toBeLessThanOrEqual(4000);
    expect(long.endsWith(` ${'p'.repeat(3000)}`)).toBe(true);
    expect(long).not.toMatch(/[\r\n]/);
    expect(progressCardLine('T', { status: 'a', next: '', blockers: '', gmNotes: 'b\tc' })).toBe(
      '[Progress card: T] Status: a | GM notes: b c',
    );
  });
});

describe('REST /api/team-presets', () => {
  let hub: TestHub;
  afterEach(async () => {
    await hub?.stop();
  });

  const auditRows = (action: string) =>
    hub.running.db
      .prepare('SELECT user_id, detail FROM audit_log WHERE action = ? ORDER BY rowid')
      .all(action) as { user_id: string | null; detail: string }[];

  it('建立、清單排序、改名、移動、刪除；名稱不分大小寫重複回 409；每次都推 preset.list；audit', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const client = await hub.client(cookie);
    const create = (name: string, over: Partial<TeamPresetConfigInput> = {}, position?: number) =>
      hub.api('POST', '/api/team-presets', {
        cookie,
        body: { name, config: config(over), ...(position !== undefined ? { position } : {}) },
      });

    const a = await create(' 策略驗證 ');
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ name: '策略驗證', position: 0, lastUsedAt: null });
    expect(a.body.config.rows).toHaveLength(4);
    let pushed = await client.next('preset.list');
    expect((pushed.presets as TeamPreset[]).map((p) => p.name)).toEqual(['策略驗證']);

    expect((await create('Explore')).body.position).toBe(1);
    expect((await create('Third')).body.position).toBe(2);
    const dup = await create('explore');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('preset_name_taken');
    // 內容不合法（兩位隊長）：400，不存。
    const bad = await create('Bad', {
      rows: [
        { kind: 'lead', permissionMode: 'default' },
        { kind: 'lead', permissionMode: 'default' },
      ],
      handoffRules: [],
    });
    expect(bad.status).toBe(400);

    const list = async () =>
      ((await hub.api('GET', '/api/team-presets', { cookie })).body as TeamPreset[]).map(
        (p) => `${p.position}:${p.name}`,
      );
    expect(await list()).toEqual(['0:策略驗證', '1:Explore', '2:Third']);

    // 下移第一個、改名撞名、改名成功。
    client.clear();
    const moved = await hub.api('PATCH', `/api/team-presets/${a.body.id}`, {
      cookie,
      body: { position: 1 },
    });
    expect(moved.body.position).toBe(1);
    expect(await list()).toEqual(['0:Explore', '1:策略驗證', '2:Third']);
    pushed = await client.next('preset.list');
    expect((pushed.presets as TeamPreset[]).map((p) => p.name)).toEqual([
      'Explore',
      '策略驗證',
      'Third',
    ]);
    const clash = await hub.api('PATCH', `/api/team-presets/${a.body.id}`, {
      cookie,
      body: { name: 'THIRD' },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('preset_name_taken');
    const renamed = await hub.api('PATCH', `/api/team-presets/${a.body.id}`, {
      cookie,
      body: { name: '策略驗證 v2', config: config({ taskAuto: true }) },
    });
    expect(renamed.body).toMatchObject({ name: '策略驗證 v2', position: 1 });
    expect(renamed.body.config.taskAuto).toBe(true);

    // 刪除後補位；「復原」＝帶 position 重新建立，插回原位。
    const removed = await hub.api('DELETE', `/api/team-presets/${a.body.id}`, { cookie });
    expect(removed.status).toBe(200);
    expect(await list()).toEqual(['0:Explore', '1:Third']);
    const restored = await create('策略驗證 v2', {}, 1);
    expect(restored.body.position).toBe(1);
    expect(await list()).toEqual(['0:Explore', '1:策略驗證 v2', '2:Third']);
    expect((await hub.api('DELETE', '/api/team-presets/nope', { cookie })).status).toBe(404);

    expect(auditRows('preset.create')).toHaveLength(4);
    expect(JSON.parse(auditRows('preset.create')[0]!.detail)).toMatchObject({
      name: '策略驗證',
      rows: 4,
      rules: 1,
      rulesEnabled: 0,
      firstPrompt: false,
    });
    expect(auditRows('preset.update').map((r) => JSON.parse(r.detail))).toEqual([
      expect.objectContaining({ position: { from: 0, to: 1 } }),
      expect.objectContaining({ from: '策略驗證', to: '策略驗證 v2', taskAuto: true }),
    ]);
    expect(JSON.parse(auditRows('preset.delete')[0]!.detail)).toMatchObject({
      name: '策略驗證 v2',
      position: 1,
    });
  });

  it('套用回報：更新最後使用時間，audit preset.apply 記成功與失敗列數；一般帳號也能用', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    const created = await hub.api('POST', '/api/team-presets', {
      cookie: member.cookie,
      body: { name: 'P', config: config({ leadFirstPrompt: 'go' }) },
    });
    expect(created.status).toBe(200);
    const used = await hub.api('POST', `/api/team-presets/${created.body.id}/used`, {
      cookie: member.cookie,
      body: { teamId: 't-new', created: 3, failed: 1, rulesCreated: 1, firstPromptHeld: true },
    });
    expect(used.status).toBe(200);
    expect(used.body.lastUsedAt).not.toBeNull();
    const rows = auditRows('preset.apply');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(member.id);
    expect(JSON.parse(rows[0]!.detail)).toEqual({
      presetId: created.body.id,
      name: 'P',
      teamId: 't-new',
      created: 3,
      failed: 1,
      rulesCreated: 1,
      rulesFailed: 0,
      firstPromptHeld: true,
    });
    // 一列都沒建成：不算用過。
    const other = await hub.api('POST', '/api/team-presets', {
      cookie: owner,
      body: { name: 'Q', config: config() },
    });
    const none = await hub.api('POST', `/api/team-presets/${other.body.id}/used`, {
      cookie: owner,
      body: { teamId: 't2', created: 0, failed: 4 },
    });
    expect(none.body.lastUsedAt).toBeNull();
    // 沒登入：401。
    expect((await hub.api('GET', '/api/team-presets')).status).toBe(401);
  });

  it('board.state 帶 presets（重連後清單照樣在）', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    await hub.api('POST', '/api/team-presets', { cookie, body: { name: 'P', config: config() } });
    const peer = await connect(`ws://127.0.0.1:${hub.port}/ws/client`, {
      cookie,
      origin: hub.url,
    });
    try {
      const state = await peer.next('board.state');
      expect((state.presets as TeamPreset[]).map((p) => p.name)).toEqual(['P']);
    } finally {
      peer.ws.close();
    }
  });
});
