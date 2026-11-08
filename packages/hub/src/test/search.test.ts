// 全域搜尋快速層（P3 §3.8 驗收 1、3、4、9、10、12）：直接對真的 SQLite（記憶體）跑，不經 HTTP。
// HTTP 層（遮蔽在網路回應裡、owner 才有「送出的指令」）在 searchRest.test.ts。
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchItem, SearchQuery, Session, Team } from '@agent-board/protocol';
import { openDatabase, type Db } from '../db';
import { eventTextSource, QuickSearch, type QuickSearchSource } from '../search';
import { Store } from '../store';

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const OWNER = { role: 'owner' } as const;
const MEMBER = { role: 'member' } as const;
const KEY = 'sk-ant-demo03-abcdefghijklmnopqrstuvwx';

let db: Db;
let store: Store;
let search: QuickSearch;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new Store(db, '127.0.0.1');
  db.prepare(
    `INSERT INTO machines (id, name, os, token_hash, capabilities) VALUES ('m1', 'studio', 'darwin', 'h1', '{}'),
       ('m2', 'gpu', 'linux', 'h2', '{}')`,
  ).run();
  search = new QuickSearch(store, { now: () => NOW });
});
afterEach(() => db.close());

function addSession(over: Partial<Session> & Pick<Session, 'id' | 'name'>): Session {
  const session: Session = {
    machineId: 'm1',
    projectId: null,
    cwd: '/repo/tw',
    branch: null,
    worktreePath: null,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    status: 'waiting_input',
    statusDetail: null,
    claudeSessionId: null,
    lastLines: [],
    lastOutputAt: null,
    statusSince: ago(60),
    contextTokens: null,
    contextWindow: null,
    repoRoot: '/repo/tw',
    repoCommonDir: null,
    createdAt: ago(600),
    endedAt: null,
    archived: false,
    archivedAt: null,
    readOnly: false,
    autoContinue: null,
    dispatchedBy: null,
    zoneId: 'main',
    ...over,
  };
  store.insertSession(session, null);
  return session;
}

function addEvent(sessionId: string, type: string, payload: object, at: string): void {
  store.insertEvent({ id: randomUUID(), sessionId, type, payload: { ...payload }, at });
}

function addTeam(over: Partial<Team> & Pick<Team, 'id' | 'name'>): Team {
  const team: Team = {
    goal: '',
    doneCriteria: '',
    color: 'teal',
    contextMd: '',
    taskAuto: false,
    zoneId: 'main',
    ...over,
  };
  store.upsertTeam(team);
  return team;
}

const q = (text: string, over: Partial<SearchQuery> = {}): SearchQuery => ({
  q: text,
  scope: 'all',
  since: '7d',
  archived: false,
  mask: false,
  ...over,
});

const group = (results: ReturnType<QuickSearch['search']>, kind: string) =>
  results.groups.find((g) => g.kind === kind);

const hits = (item: SearchItem) => item.matchRanges.map(([a, b]) => item.snippet.slice(a, b));

describe('檔案改動（驗收 1）', () => {
  it('兩個 session 改過 risk.py：RUN 在前、顯示次數與相對路徑；DONE 的昨天那筆在後', () => {
    addSession({ id: 'a', name: 'tw-impl-1', status: 'running' });
    addSession({ id: 'b', name: 'tw-impl-2', status: 'done', endedAt: ago(600) });
    addEvent('b', 'file.changed', { path: '/repo/tw/src/risk.py' }, ago(60 * 20));
    for (const m of [5, 9, 30])
      addEvent('a', 'file.changed', { path: '/repo/tw/src/risk.py' }, ago(m));
    addEvent('a', 'file.changed', { path: '/repo/tw/src/other.py' }, ago(3));

    const files = group(search.search(q('risk.py'), OWNER), 'file')!;
    expect(files.total).toBe(2);
    expect(files.items.map((i) => i.sessionId)).toEqual(['a', 'b']);
    expect(files.items[0]).toMatchObject({
      kind: 'file',
      snippet: 'src/risk.py',
      count: 3,
      at: ago(5),
      machineId: 'm1',
    });
    expect(hits(files.items[0]!)).toEqual(['risk.py']);
    expect(files.items[1]).toMatchObject({ count: 1, at: ago(60 * 20) });
  });

  it('時間範圍：24 小時看不到兩天前的；30 天看得到', () => {
    addSession({ id: 'a', name: 'impl' });
    addEvent('a', 'file.changed', { path: '/repo/tw/old.py' }, ago(60 * 48));
    expect(group(search.search(q('old.py', { since: '24h' }), OWNER), 'file')).toBeUndefined();
    expect(group(search.search(q('old.py', { since: '30d' }), OWNER), 'file')?.total).toBe(1);
  });

  it('LIKE 的萬用字元當一般字：搜 a_b 不會找到 axb', () => {
    addSession({ id: 'a', name: 'impl' });
    addEvent('a', 'file.changed', { path: '/repo/tw/axb.py' }, ago(1));
    addEvent('a', 'file.changed', { path: '/repo/tw/100%.py' }, ago(1));
    expect(search.search(q('a_b'), OWNER).groups).toEqual([]);
    expect(group(search.search(q('100%'), OWNER), 'file')?.items[0]?.snippet).toBe('100%.py');
  });
});

describe('多詞與片語（驗收 3）', () => {
  it('手續費 0.1425 是 AND；加引號要連在一起', () => {
    addSession({ id: 'a', name: 'impl' });
    addEvent(
      'a',
      'hook',
      { event: 'Stop', last_assistant_message: '手續費 0.1425 已更新' },
      ago(1),
    );
    addEvent('a', 'hook', { event: 'Stop', last_assistant_message: '手續費改成 0.1425' }, ago(2));
    addEvent('a', 'hook', { event: 'Stop', last_assistant_message: '只提到手續費' }, ago(3));
    const and = group(search.search(q('手續費 0.1425'), OWNER), 'session')!;
    expect(and.total).toBe(2);
    expect(and.items.every((i) => i.field === 'reply')).toBe(true);
    const phrase = group(search.search(q('"手續費 0.1425"'), OWNER), 'session')!;
    expect(phrase.total).toBe(1);
    expect(hits(phrase.items[0]!)).toEqual(['手續費 0.1425']);
  });

  it('1 個字不搜', () => {
    addSession({ id: 'a', name: 'x' });
    expect(search.search(q('x'), OWNER)).toEqual({ groups: [], partial: false });
  });
});

describe('session、團隊、任務', () => {
  it('session 欄位（名稱、分支、最後幾行）與交接／派工摘要都在 session 組；等你的與 RUN 在前', () => {
    addSession({ id: 'idle', name: 'alpha-idle', status: 'done', lastOutputAt: ago(1) });
    addSession({ id: 'ask', name: 'alpha-ask', status: 'waiting_input', lastOutputAt: ago(50) });
    addSession({
      id: 'br',
      name: 'other',
      branch: 'ab/alpha',
      status: 'running',
      lastOutputAt: ago(40),
    });
    addEvent('idle', 'handoff.fired', { summary: 'alpha handed over' }, ago(2));
    addEvent('idle', 'dispatch.spawn', { summary: 'alpha spawned' }, ago(3));
    addEvent('idle', 'task.completed', { summary: 'alpha task done' }, ago(4));
    const sessions = group(search.search(q('alpha'), OWNER), 'session')!;
    expect(sessions.items.slice(0, 2).map((i) => i.sessionId)).toEqual(['br', 'ask']);
    expect(sessions.items.map((i) => i.field)).toEqual([
      'branch',
      'name',
      'name',
      'handoff',
      'dispatch',
      'taskEvent',
    ]);
  });

  it('團隊名稱、目標、TEAM.md、任務標題在「進度卡與團隊」組', () => {
    addSession({ id: 'lead', name: 'lead', status: 'done' });
    addTeam({ id: 't1', name: 'alpha 台股', goal: '改 risk 的部位上限' });
    addTeam({ id: 't2', name: 'beta 其他', contextMd: '# notes\nrisk 不要動' });
    store.upsertTask({
      id: 'k1',
      teamId: 't1',
      title: '檢查 risk 參數',
      ownerSessionId: 'lead',
      column: 'todo',
      number: 1,
      rejectCount: 0,
      needsUser: false,
      reviewerSessionId: null,
      auto: null,
    });
    const teams = group(search.search(q('risk'), OWNER), 'team')!;
    expect(teams.items.map((i) => [i.kind, i.teamId, i.field])).toEqual([
      ['team', 't1', 'goal'],
      ['task', 't1', 'title'],
      ['team', 't2', 'contextMd'],
    ]);
    expect(teams.items[1]?.sessionId).toBe('lead');
  });

  it('範圍：目前工作區只看這個工作區的團隊與 session（團隊成員跟著團隊）；不含封存', () => {
    store.insertZone({ id: 'z2', name: '交易', createdAt: ago(100) });
    addSession({ id: 'here', name: 'zz-here' });
    addSession({ id: 'member', name: 'zz-member' }); // 自己在 main，但團隊在 z2
    addSession({ id: 'old', name: 'zz-old', archived: true, archivedAt: ago(10), zoneId: 'z2' });
    addTeam({ id: 't', name: 'zz-team', zoneId: 'z2' });
    store.upsertTeamMember({ teamId: 't', sessionId: 'member', role: 'worker' });
    const inZ2 = search.search(q('zz-', { scope: 'zone', zoneId: 'z2' }), OWNER);
    expect(group(inZ2, 'session')?.items.map((i) => i.sessionId)).toEqual(['member']);
    expect(group(inZ2, 'team')?.items.map((i) => i.teamId)).toEqual(['t']);
    const withArchived = search.search(
      q('zz-', { scope: 'zone', zoneId: 'z2', archived: true }),
      OWNER,
    );
    expect(
      group(withArchived, 'session')
        ?.items.map((i) => i.sessionId)
        .sort(),
    ).toEqual(['member', 'old']);
    const all = search.search(q('zz-'), OWNER);
    expect(
      group(all, 'session')
        ?.items.map((i) => i.sessionId)
        .sort(),
    ).toEqual(['here', 'member']);
  });
});

// 整合：進度卡（P3 項目一的 progress_cards）是內建來源（驗收 4）。
describe('進度卡（驗收 4）', () => {
  function addCard(
    owner: { teamId: string } | { sessionId: string },
    fields: Partial<{ status: string; next: string; blockers: string; gmNotes: string }>,
    updatedAt: string,
    revision = 1,
  ): void {
    store.saveProgress({
      id: randomUUID(),
      teamId: 'teamId' in owner ? owner.teamId : null,
      sessionId: 'sessionId' in owner ? owner.sessionId : null,
      fields: { status: '', next: '', blockers: '', gmNotes: '', ...fields },
      revision,
      locked: false,
      updatedAt,
      updatedByKind: 'user',
      updatedById: null,
      fieldRevisions: { status: 0, next: 0, blockers: 0, gmNotes: 0 },
    });
  }

  it('團隊卡與單獨 session 的卡在「進度卡與團隊」組、排在團隊文字前面；不看時間範圍；遮蔽照套用', () => {
    addSession({ id: 'solo', name: 'solo' });
    addTeam({ id: 't1', name: 'alpha', goal: 'risk 上限' });
    addCard({ teamId: 't1' }, { next: '調 risk 參數', gmNotes: 'x' }, ago(60 * 24 * 40));
    addCard({ sessionId: 'solo' }, { blockers: `等 risk 確認 ${KEY}` }, ago(5));
    const teams = group(search.search(q('risk', { since: '24h' }), OWNER), 'team')!;
    expect(teams.items.map((i) => [i.kind, i.teamId, i.sessionId, i.field])).toEqual([
      ['progress', undefined, 'solo', 'progress'],
      ['progress', 't1', undefined, 'progress'],
      ['team', 't1', undefined, 'goal'],
    ]);
    expect(teams.items[1]).toMatchObject({ snippet: '調 risk 參數', at: ago(60 * 24 * 40) });
    const masked = group(search.search(q('risk', { mask: true }), OWNER), 'team')!;
    expect(masked.items[0]!.snippet).not.toContain('sk-ant');
  });

  it('範圍：別的工作區的團隊卡不出現；還沒寫過的卡（revision 0）不出現', () => {
    store.insertZone({ id: 'z2', name: '交易', createdAt: ago(100) });
    addTeam({ id: 'far', name: 'far', zoneId: 'z2' });
    addTeam({ id: 'near', name: 'near' });
    addCard({ teamId: 'far' }, { status: 'zz-card far' }, ago(1));
    addCard({ teamId: 'near' }, { status: 'zz-card near' }, ago(1), 0);
    expect(
      group(search.search(q('zz-card', { scope: 'zone', zoneId: 'main' }), OWNER), 'team'),
    ).toBeUndefined();
    expect(group(search.search(q('zz-card'), OWNER), 'team')?.items.map((i) => i.teamId)).toEqual([
      'far',
    ]);
  });
});

describe('GM 送出的指令（驗收 10）', () => {
  it('只有 owner 有「送出的指令」組', () => {
    addSession({ id: 'a', name: 'impl' });
    store.insertAudit({
      id: randomUUID(),
      userId: 'u',
      sessionId: 'a',
      action: 'terminal.input',
      detail: 'please fix risk.py',
      at: ago(5),
    });
    expect(group(search.search(q('fix risk'), OWNER), 'input')?.items[0]).toMatchObject({
      kind: 'input',
      sessionId: 'a',
      snippet: 'please fix risk.py',
    });
    expect(group(search.search(q('fix risk'), MEMBER), 'input')).toBeUndefined();
  });

  it('delivery 代送的（user null：自動交接、自動接續、群發）不算', () => {
    addSession({ id: 'a', name: 'impl' });
    store.insertAudit({
      id: randomUUID(),
      userId: null,
      sessionId: 'a',
      action: 'terminal.input',
      detail: 'continue fix risk.py',
      at: ago(5),
    });
    expect(group(search.search(q('fix risk'), OWNER), 'input')).toBeUndefined();
  });
});

describe('遮蔽（驗收 9）', () => {
  it('遮蔽開著：片段裡的金鑰換成 *，命中位置是遮蔽後的；關著回原文', () => {
    addSession({ id: 'a', name: 'impl' });
    addEvent(
      'a',
      'hook',
      { event: 'Stop', last_assistant_message: `deploy uses ${KEY} now` },
      ago(1),
    );
    const masked = group(search.search(q('deploy', { mask: true }), OWNER), 'session')!;
    const item = masked.items[0]!;
    expect(item.snippet).not.toContain('sk-ant');
    expect(item.snippet).toBe(`deploy uses ${'*'.repeat(KEY.length)} now`);
    expect(hits(item)).toEqual(['deploy']);
    const plain = group(search.search(q('deploy'), OWNER), 'session')!;
    expect(plain.items[0]?.snippet).toContain(KEY);
  });

  it('遮蔽開著時金鑰本身比對不到（不會透露「有這把鑰匙」）', () => {
    addSession({ id: 'a', name: 'impl' });
    addEvent('a', 'hook', { event: 'Stop', last_assistant_message: `key ${KEY}` }, ago(1));
    expect(search.search(q('abcdefghij', { mask: true }), OWNER).groups).toEqual([]);
    expect(search.search(q('abcdefghij'), OWNER).groups).toHaveLength(1);
  });
});

describe('來源可插拔、上限與逾時', () => {
  it('外加的來源（例如進度卡）放進對應的組', () => {
    addTeam({ id: 't1', name: '台股' });
    const progress: QuickSearchSource = {
      name: 'progress',
      search: (ctx) => {
        const hit = ctx.match('下一步：改 risk.py 的部位上限');
        return hit ? [{ kind: 'progress', teamId: 't1', field: 'progress', ...hit }] : [];
      },
    };
    const withProgress = new QuickSearch(store, { now: () => NOW, sources: [progress] });
    expect(group(withProgress.search(q('risk.py'), OWNER), 'team')?.items[0]).toMatchObject({
      kind: 'progress',
      teamId: 't1',
    });
  });

  it('逾時：停在已找到的部分並標 partial', () => {
    let clock = NOW;
    const slow: QuickSearchSource = {
      name: 'slow',
      search: (ctx) => {
        clock += 5_000;
        return ctx.expired() ? [] : [];
      },
    };
    const never: QuickSearchSource = {
      name: 'never',
      search: () => {
        throw new Error('should not run after the deadline');
      },
    };
    const timed = new QuickSearch(store, { now: () => clock, sources: [slow, never] });
    expect(timed.search(q('anything'), OWNER)).toEqual({ groups: [], partial: true });
  });

  it('每組最多 50 筆，來源被截斷時標 partial 與 capped', () => {
    addSession({ id: 'a', name: 'impl' });
    for (let i = 0; i < 60; i++)
      addEvent('a', 'file.changed', { path: `/repo/tw/f${i}.py` }, ago(i));
    const result = search.search(q('.py'), OWNER);
    expect(group(result, 'file')).toMatchObject({ total: 50, capped: true });
    expect(result.partial).toBe(true);
  });

  it('剛好 50 筆不算截斷', () => {
    addSession({ id: 'a', name: 'impl' });
    for (let i = 0; i < 50; i++)
      addEvent('a', 'file.changed', { path: `/repo/tw/f${i}.py` }, ago(i));
    const result = search.search(q('.py'), OWNER);
    expect(group(result, 'file')).toMatchObject({ total: 50, capped: false });
    expect(result.partial).toBe(false);
  });

  it('四種事件文字各自有額度：回覆湊滿 50 筆也不會擠掉比較新的交接摘要', () => {
    addSession({ id: 'a', name: 'impl', status: 'done' });
    for (let i = 0; i < 60; i++)
      addEvent(
        'a',
        'hook',
        { event: 'Stop', last_assistant_message: `alpha reply ${i}` },
        ago(10 + i),
      );
    addEvent('a', 'handoff.fired', { summary: 'alpha handed over' }, ago(1));
    const result = search.search(q('alpha'), OWNER);
    const sessions = group(result, 'session')!;
    expect(sessions.items[0]).toMatchObject({ field: 'handoff', at: ago(1) });
    expect(sessions).toMatchObject({ total: 50, capped: true });
    expect(result.partial).toBe(true);
  });

  it('逾時擋得住單一條 SQL：掃很多列卻都不符合時也會中止，回 partial', () => {
    addSession({ id: 'a', name: 'impl' });
    const insert = db.prepare(
      'INSERT INTO session_events (id, session_id, type, payload, at) VALUES (?, ?, ?, ?, ?)',
    );
    db.transaction(() => {
      // 原始 payload 有 stop（event: Stop），但 last_assistant_message 裡沒有：每列都通過第一層先篩，卻沒有一列符合。
      for (let i = 0; i < 20_000; i++)
        insert.run(
          `e${i}`,
          'a',
          'hook',
          JSON.stringify({ event: 'Stop', last_assistant_message: 'x' }),
          ago(1),
        );
    })();
    // 每看一次時鐘就過 1 秒、逾時 10 秒：查詢開始前（起點、時間範圍、來源前的檢查）只看 4 次，
    // 之後只有 SQL 裡的檢查（每 256 列一次）會看時鐘。SQL 沒有中止的話：2 萬列都不符合、不會逾時，partial 是 false。
    let reads = 0;
    const ticking = new QuickSearch(store, {
      now: () => NOW + 1_000 * reads++,
      timeoutMs: 10_000,
      sources: [eventTextSource],
    });
    const result = ticking.search(q('stop'), OWNER);
    expect(result).toEqual({ groups: [], partial: true });
    // 中止了：只看了十幾次時鐘（不中止會是 4 + 20000 / 256 ≈ 82 次）。
    expect(reads).toBeLessThan(20);
  });
});

describe('效能（驗收 12）', () => {
  it('20 萬筆 events、50 個 session：快速層 p95 < 300ms', () => {
    const sessions = Array.from({ length: 50 }, (_, i) =>
      addSession({ id: `s${i}`, name: `session-${i}`, machineId: i % 2 ? 'm1' : 'm2' }),
    );
    const insert = db.prepare(
      'INSERT INTO session_events (id, session_id, type, payload, at) VALUES (?, ?, ?, ?, ?)',
    );
    const filler = 'lorem ipsum dolor sit amet '.repeat(40);
    db.transaction(() => {
      for (let i = 0; i < 200_000; i++) {
        const s = sessions[i % 50]!;
        const at = ago((i * 0.2) % (60 * 24 * 30)); // 平均散在 30 天內
        const kind = i % 4;
        if (kind === 0) {
          insert.run(
            `e${i}`,
            s.id,
            'file.changed',
            JSON.stringify({ path: `/repo/tw/src/m${i % 900}.py` }),
            at,
          );
        } else if (kind === 1) {
          const reply = `${filler} turn ${i}${i % 5000 === 1 ? ' 手續費 0.1425' : ''}`;
          insert.run(
            `e${i}`,
            s.id,
            'hook',
            JSON.stringify({ event: 'Stop', last_assistant_message: reply }),
            at,
          );
        } else if (kind === 2) {
          insert.run(`e${i}`, s.id, 'status', JSON.stringify({ to: 'running' }), at);
        } else {
          insert.run(
            `e${i}`,
            s.id,
            'handoff.fired',
            JSON.stringify({ summary: `handoff ${i}` }),
            at,
          );
        }
      }
    })();
    const queries: SearchQuery[] = [
      q('m17.py'),
      q('手續費 0.1425'),
      q('沒有這個字'),
      q('src', { since: '30d' }),
      q('沒有這個字', { since: '30d', mask: true }),
      q('handoff 1999'),
    ];
    // 最壞情況（審查意見）：stop 出現在每一筆 hook 的原始 payload、但不在 last_assistant_message，
    // 通過第一層先篩後每筆都要 json_extract；zzqx 是英文字母（走 LIKE 不走 instr）又哪裡都沒有。另外量、照實記錄。
    const worst: SearchQuery[] = [q('stop', { since: '30d' }), q('zzqx', { since: '30d' })];
    const times: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (const query of queries) {
        const t0 = performance.now();
        const result = search.search(query, OWNER);
        times.push(performance.now() - t0);
        expect(result.partial === false || result.groups.length > 0).toBe(true);
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    console.log(
      `quick search over 200k events: p50 ${times[Math.floor(times.length / 2)]!.toFixed(1)}ms, ` +
        `p95 ${p95.toFixed(1)}ms, max ${times.at(-1)!.toFixed(1)}ms (${times.length} queries)`,
    );
    expect(p95).toBeLessThan(300);
    for (const query of worst) {
      const runs: number[] = [];
      for (let round = 0; round < 3; round++) {
        const t0 = performance.now();
        search.search(query, OWNER);
        runs.push(performance.now() - t0);
      }
      console.log(
        `worst case "${query.q}" (30d, 200k events): ${runs.map((t) => t.toFixed(1)).join(' / ')}ms`,
      );
      // 這個測試的時鐘是固定的（不會逾時），量的是完整掃一遍的時間；真的 hub 上 2 秒就中止。
      expect(Math.max(...runs)).toBeLessThan(2_000);
    }
  }, 60_000);
});
