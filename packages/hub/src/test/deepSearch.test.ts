// 深層搜尋（P3 ③b，§3.5–§3.8 驗收 6、8、9、11）：真的 hub、假 daemon（WebSocket）、真的瀏覽器連線協定。
// hub 只轉送片段：不存、不建索引；舊版 daemon 不送請求；結果只推給發起的連線；一次搜尋一筆 audit。
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_FEATURES, type Session } from '@agent-board/protocol';
import { startHub, until, type Peer, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const KEY = 'sk-ant-demo03-deepHubKEY00000000000';
const CLAUDE_A = '0a1b2c3d-0000-0000-0000-00000000000a';
const CLAUDE_B = '0a1b2c3d-0000-0000-0000-00000000000b';
const NEW = [DAEMON_FEATURES.signalGuard, DAEMON_FEATURES.search];

function session(id: string, machineId: string, over: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id,
    machineId,
    projectId: null,
    name: id,
    cwd: '/repo',
    branch: null,
    worktreePath: null,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    status: 'waiting_input',
    statusDetail: null,
    claudeSessionId: null,
    lastLines: [],
    lastOutputAt: now,
    statusSince: now,
    contextTokens: null,
    contextWindow: null,
    repoRoot: null,
    repoCommonDir: null,
    createdAt: now,
    endedAt: null,
    archived: false,
    archivedAt: null,
    readOnly: false,
    autoContinue: null,
    dispatchedBy: null,
    zoneId: 'main',
    ...over,
  };
}

interface Setup {
  owner: string;
  client: Peer;
  /** 新版 daemon（search.v1）。 */
  a: { daemon: Peer; machineId: string };
  /** 舊版 daemon（features 沒有 search.v1）。 */
  b: { daemon: Peer; machineId: string };
  /** 配對過但沒連上（失聯）。 */
  offline: string;
}

async function setup(timing: Partial<Record<string, number>> = {}): Promise<Setup> {
  hub = await startHub({ timing: timing as never });
  const owner = await hub.setupOwner();
  const a = await hub.onlineDaemon(owner, { features: NEW });
  const b = await hub.onlineDaemon(owner, { features: [DAEMON_FEATURES.signalGuard] });
  const { machineId: offline } = await hub.pair(owner);
  const store = hub.running.store;
  const old = new Date(Date.now() - 20 * 24 * 3_600_000).toISOString();
  store.insertSession(session('s-a1', a.machineId, { claudeSessionId: CLAUDE_A }), null);
  // 已結束、但 7 天內有活動：搜對話紀錄。
  store.insertSession(
    session('s-a2', a.machineId, {
      claudeSessionId: CLAUDE_B,
      status: 'done',
      endedAt: new Date().toISOString(),
    }),
    null,
  );
  // 已結束且 20 天沒動：7 天範圍外，不叫 daemon 去找。
  store.insertSession(
    session('s-a3', a.machineId, {
      claudeSessionId: '0a1b2c3d-0000-0000-0000-00000000000c',
      status: 'done',
      endedAt: old,
      lastOutputAt: old,
      statusSince: old,
    }),
    null,
  );
  // 封存的：預設不含封存。
  store.insertSession(session('s-a4', a.machineId, { archived: true }), null);
  store.insertSession(session('s-b1', b.machineId), null);
  store.insertSession(session('s-c1', offline), null);
  const client = await hub.client(owner);
  return { owner, client, a: { ...a }, b: { ...b }, offline };
}

const auditRows = () =>
  hub.running.db
    .prepare("SELECT user_id AS userId, detail FROM audit_log WHERE action = 'search.deep'")
    .all() as { userId: string; detail: string }[];

describe('深層搜尋：扇出、串流、狀態', () => {
  it('新版收到請求、舊版標 unsupported 不送、失聯標 offline；結果帶 machineId 只給發起的連線；一筆 audit（驗收 8、11）', async () => {
    const { owner, client, a, b, offline } = await setup();
    const other = await hub.client(owner);
    client.send({ type: 'search.deep', searchId: 'd1', q: `手續費 ${KEY}` });

    const started = await client.next('search.deepStarted');
    expect(started.machines).toEqual(
      expect.arrayContaining([
        { machineId: a.machineId, totalSessions: 2 },
        { machineId: b.machineId, totalSessions: 1 },
        { machineId: offline, totalSessions: 1 },
      ]),
    );
    expect(await client.next('search.deepDone', (m) => m.machineId === b.machineId)).toMatchObject({
      state: 'unsupported',
      scannedSessions: 0,
      totalSessions: 1,
    });
    expect(await client.next('search.deepDone', (m) => m.machineId === offline)).toMatchObject({
      state: 'offline',
    });

    const request = await a.daemon.next('search.request');
    // hub 和 daemon 之間用 hub 自己產生的 id，不是瀏覽器的 searchId。
    const did = request.searchId as string;
    expect(did).not.toBe('d1');
    expect(request).toMatchObject({
      mask: false,
      terms: ['手續費', KEY.toLowerCase()],
    });
    const targets = (request.sessions as { sessionId: string; claudeSessionId: string }[]).map(
      (t) => `${t.sessionId}:${t.claudeSessionId}`,
    );
    expect(targets.sort()).toEqual([`s-a1:${CLAUDE_A}`, `s-a2:${CLAUDE_B}`]);
    expect(request.limits).toMatchObject({ perSession: 3, perMachine: 100 });
    // 舊版 daemon 什麼都沒收到。
    await new Promise((r) => setTimeout(r, 50));
    expect(b.daemon.of('search.request')).toEqual([]);

    a.daemon.send({
      type: 'search.result',
      searchId: did,
      items: [
        {
          kind: 'transcript',
          sessionId: 's-a1',
          snippet: '手續費 改好了',
          matchRanges: [[0, 3]],
          transcriptIndex: 7,
        },
        // 不是這台、不在範圍內的 session：丟掉。
        { kind: 'transcript', sessionId: 's-b1', snippet: '手續費', matchRanges: [[0, 3]] },
        // 深層只會有 transcript／screen。
        { kind: 'file', sessionId: 's-a1', snippet: '手續費', matchRanges: [[0, 3]] },
      ],
    });
    const result = await client.next('search.deepResult');
    expect(result).toEqual({
      type: 'search.deepResult',
      searchId: 'd1',
      machineId: a.machineId,
      items: [
        {
          kind: 'transcript',
          sessionId: 's-a1',
          snippet: '手續費 改好了',
          matchRanges: [[0, 3]],
          transcriptIndex: 7,
          machineId: a.machineId,
        },
      ],
    });
    a.daemon.send({
      type: 'search.done',
      searchId: did,
      state: 'done',
      scannedSessions: 2,
      totalSessions: 2,
    });
    expect(await client.next('search.deepDone', (m) => m.machineId === a.machineId)).toMatchObject({
      state: 'done',
      scannedSessions: 2,
      totalSessions: 2,
    });
    // 只推給發起的連線。
    expect(other.of('search.deepResult')).toEqual([]);
    expect(other.of('search.deepStarted')).toEqual([]);

    await until(() => auditRows().length === 1, 'audit');
    const row = auditRows()[0]!;
    const detail = JSON.parse(row.detail) as {
      q: string;
      machines: { machineId: string; state: string; items: number }[];
      timedOut: boolean;
      cancelled: boolean;
    };
    expect(row.detail).not.toContain('sk-ant-demo03-deep');
    expect(detail.q).toContain('手續費');
    expect(detail.machines).toEqual(
      expect.arrayContaining([
        { machineId: a.machineId, state: 'done', items: 1 },
        { machineId: b.machineId, state: 'unsupported', items: 0 },
        { machineId: offline, state: 'offline', items: 0 },
      ]),
    );
    expect(detail).toMatchObject({ timedOut: false, cancelled: false });
    // 片段不落地：hub 的資料庫裡找不到 daemon 回的片段。
    const dump = JSON.stringify(hub.running.db.prepare('SELECT * FROM session_events').all());
    expect(dump).not.toContain('改好了');
  });

  it('取消：daemon 收到 search.cancel；之後晚到的結果不再轉送（驗收 6）；同一個人開新的會取消舊的', async () => {
    const { client, a } = await setup();
    client.send({ type: 'search.deep', searchId: 'd1', q: 'risk.py' });
    const d1 = (await a.daemon.next('search.request')).searchId as string;
    client.send({ type: 'search.cancel', searchId: 'd1' });
    expect(await a.daemon.next('search.cancel')).toMatchObject({ searchId: d1 });
    a.daemon.send({
      type: 'search.result',
      searchId: d1,
      items: [{ kind: 'screen', sessionId: 's-a1', snippet: 'risk.py', matchRanges: [[0, 7]] }],
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.of('search.deepResult')).toEqual([]);
    // 晚到的結果：hub 再叫它停一次（daemon 可能還在搜）。
    expect(await a.daemon.next('search.cancel')).toMatchObject({ searchId: d1 });

    client.send({ type: 'search.deep', searchId: 'd2', q: 'risk.py' });
    const d2 = (await a.daemon.next('search.request', (m) => m.searchId !== d1)).searchId as string;
    client.send({ type: 'search.deep', searchId: 'd3', q: 'risk.py 2' });
    expect(await a.daemon.next('search.cancel', (m) => m.searchId === d2)).toMatchObject({
      searchId: d2,
    });
    await a.daemon.next('search.request', (m) => m.searchId !== d1 && m.searchId !== d2);
    await until(() => auditRows().length === 2, 'audit');
    expect(
      auditRows().map((r) => (JSON.parse(r.detail) as { cancelled: boolean }).cancelled),
    ).toEqual([true, true]);
  });

  it('遮蔽：hub 轉送前再遮一次（daemon 沒遮好也不會把金鑰帶到裝置上）（驗收 9）', async () => {
    const { client, a } = await setup();
    client.send({ type: 'search.deep', searchId: 'd1', q: 'deploy', mask: true });
    const request = await a.daemon.next('search.request');
    expect(request).toMatchObject({ mask: true });
    a.daemon.send({
      type: 'search.result',
      searchId: request.searchId as string,
      items: [
        {
          kind: 'transcript',
          sessionId: 's-a1',
          snippet: `deploy ${KEY}`,
          matchRanges: [[0, 6]],
        },
      ],
    });
    const result = await client.next('search.deepResult');
    const raw = JSON.stringify(result);
    expect(raw).not.toContain('sk-ant');
    expect((result.items as { matchRanges: number[][] }[])[0]!.matchRanges).toEqual([[0, 6]]);
  });

  it('daemon 過了 deadline 沒回 → timeout 並叫它停；搜到一半斷線 → offline', async () => {
    const { client, a } = await setup({ deepSearchDeadlineMs: 50, deepSearchGraceMs: 20 });
    client.send({ type: 'search.deep', searchId: 'd1', q: 'risk.py' });
    const first = await a.daemon.next('search.request');
    expect(first).toMatchObject({ limits: expect.objectContaining({ deadlineMs: 50 }) });
    expect(await client.next('search.deepDone', (m) => m.machineId === a.machineId)).toMatchObject({
      state: 'timeout',
    });
    expect(await a.daemon.next('search.cancel')).toMatchObject({ searchId: first.searchId });

    client.send({ type: 'search.deep', searchId: 'd2', q: 'risk.py' });
    await a.daemon.next('search.request', (m) => m.searchId !== first.searchId);
    a.daemon.ws.terminate();
    expect(
      await client.next(
        'search.deepDone',
        (m) => m.machineId === a.machineId && m.searchId === 'd2',
      ),
    ).toMatchObject({ state: 'offline' });
  });

  it('連線關掉：它的搜尋取消；查詢字不到 2 字：沒有機器、不送', async () => {
    const { client, a } = await setup();
    client.send({ type: 'search.deep', searchId: 'd1', q: 'x' });
    expect(await client.next('search.deepStarted')).toMatchObject({ machines: [] });
    client.send({ type: 'search.deep', searchId: 'd2', q: 'risk.py' });
    const request = await a.daemon.next('search.request');
    client.close();
    expect(await a.daemon.next('search.cancel')).toMatchObject({ searchId: request.searchId });
  });

  it('別的使用者送一樣的 searchId：碰不到這次搜尋（各自用 hub 產生的 id），也取消不了', async () => {
    const { owner, client, a } = await setup();
    client.send({ type: 'search.deep', searchId: 'same', q: 'risk.py' });
    const mine = (await a.daemon.next('search.request')).searchId as string;
    const member = await hub.createMember(owner);
    const intruder = await hub.client(member.cookie);
    intruder.send({ type: 'search.cancel', searchId: 'same' });
    intruder.send({ type: 'search.deep', searchId: 'same', q: 'risk.py' });
    await intruder.next('search.deepStarted');
    await new Promise((r) => setTimeout(r, 50));
    // 送給 daemon 的（若有）是另一個 id。
    for (const m of a.daemon.of('search.request')) expect(m.searchId).not.toBe(mine);
    // 我的搜尋沒被取消：daemon 沒收到我的 cancel，結果照樣送到我這裡。
    expect(a.daemon.of('search.cancel')).toEqual([]);
    a.daemon.send({
      type: 'search.result',
      searchId: mine,
      items: [{ kind: 'screen', sessionId: 's-a1', snippet: 'risk.py', matchRanges: [[0, 7]] }],
    });
    expect(await client.next('search.deepResult')).toMatchObject({ searchId: 'same' });
    expect(intruder.of('search.deepResult')).toEqual([]);
  });

  it('daemon 回的片段超過 160 字截掉、命中位置超出片段的丟掉', async () => {
    const { client, a } = await setup();
    client.send({ type: 'search.deep', searchId: 'd1', q: 'risk.py' });
    const request = await a.daemon.next('search.request');
    a.daemon.send({
      type: 'search.result',
      searchId: request.searchId as string,
      items: [
        {
          kind: 'transcript',
          sessionId: 's-a1',
          snippet: `risk.py ${'整段原文'.repeat(500)}`,
          matchRanges: [[0, 7]],
        },
        {
          kind: 'screen',
          sessionId: 's-a1',
          snippet: 'risk.py',
          matchRanges: [
            [0, 7],
            [5, 99],
            [6, 3],
          ],
        },
      ],
    });
    const result = await client.next('search.deepResult');
    const items = result.items as { snippet: string; matchRanges: number[][] }[];
    expect(items[0]!.snippet.length).toBeLessThanOrEqual(160);
    expect(items[0]!.snippet.endsWith('…')).toBe(true);
    expect(items[0]!.matchRanges).toEqual([[0, 7]]);
    expect(items[1]!.matchRanges).toEqual([[0, 7]]);
  });
});
