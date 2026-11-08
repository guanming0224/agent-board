// GET /api/search（P3 §3.8 驗收 9、10、11）：真的 hub、真的 HTTP。遮蔽要在網路回應裡就生效；
// 「送出的指令」只回給 owner；快速層不寫 audit；沒登入 401。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchResults, Session } from '@agent-board/protocol';
import { startHub, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const KEY = 'sk-ant-demo03-abcdefghijklmnopqrstuvwx';

async function seeded(
  options: Parameters<typeof startHub>[0] = {},
): Promise<{ owner: string; member: string }> {
  hub = await startHub(options);
  const owner = await hub.setupOwner();
  const { machineId } = await hub.pair(owner);
  const { cookie: member } = await hub.createMember(owner);
  const store = hub.running.store;
  const now = new Date().toISOString();
  const session: Session = {
    id: 's-a',
    machineId,
    projectId: null,
    name: 'tw-impl-1',
    cwd: '/repo/tw',
    branch: null,
    worktreePath: null,
    permissionMode: 'default',
    model: null,
    accountProfile: null,
    status: 'running',
    statusDetail: null,
    claudeSessionId: null,
    lastLines: [],
    lastOutputAt: now,
    statusSince: now,
    contextTokens: null,
    contextWindow: null,
    repoRoot: '/repo/tw',
    repoCommonDir: null,
    createdAt: now,
    endedAt: null,
    archived: false,
    archivedAt: null,
    readOnly: false,
    autoContinue: null,
    dispatchedBy: null,
    zoneId: 'main',
  };
  store.insertSession(session, null);
  store.insertEvent({
    id: randomUUID(),
    sessionId: 's-a',
    type: 'hook',
    payload: { event: 'Stop', last_assistant_message: `已把 deploy 的金鑰換成 ${KEY}` },
    at: now,
  });
  const ownerId = (
    hub.running.db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }
  ).id;
  store.insertAudit({
    id: randomUUID(),
    userId: ownerId,
    sessionId: 's-a',
    action: 'terminal.input',
    detail: 'deploy to staging',
    at: now,
  });
  // delivery 代送的（自動交接、自動接續、群發）寫 user null：不算「你送出的指令」。
  store.insertAudit({
    id: randomUUID(),
    userId: null,
    sessionId: 's-a',
    action: 'terminal.input',
    detail: 'deploy automatically',
    at: now,
  });
  return { owner, member };
}

const search = (cookie: string, query: string) =>
  hub.api<SearchResults>('GET', `/api/search?${query}`, { cookie });

describe('GET /api/search', () => {
  it('遮蔽開著：回應的原始內容裡就沒有金鑰；關著回原文', async () => {
    const { owner } = await seeded();
    const masked = await search(owner, 'q=deploy&mask=1');
    expect(masked.status).toBe(200);
    expect(JSON.stringify(masked.body)).not.toContain('sk-ant');
    const reply = masked.body.groups.find((g) => g.kind === 'session')!.items[0]!;
    expect(reply.snippet).toContain('*'.repeat(KEY.length));
    const plain = await search(owner, 'q=deploy&mask=0');
    expect(JSON.stringify(plain.body)).toContain(KEY);
  });

  it('owner 有「送出的指令」組，一般帳號沒有', async () => {
    const { owner, member } = await seeded();
    const kinds = async (cookie: string) =>
      (await search(cookie, 'q=deploy')).body.groups.map((g) => g.kind);
    expect(await kinds(owner)).toEqual(['session', 'input']);
    expect(await kinds(member)).toEqual(['session']);
    const inputs = (await search(owner, 'q=deploy')).body.groups.find((g) => g.kind === 'input')!;
    expect(inputs.items.map((i) => i.snippet)).toEqual(['deploy to staging']);
  });

  it('快速層不寫 audit；沒登入 401；查詢字超過 200 字 400', async () => {
    const { owner } = await seeded();
    const before = hub.running.store.listAudit({}).length;
    await search(owner, 'q=deploy');
    expect(hub.running.store.listAudit({}).length).toBe(before);
    expect((await hub.api('GET', '/api/search?q=deploy')).status).toBe(401);
    expect((await search(owner, `q=${'x'.repeat(201)}`)).status).toBe(400);
  });
});

describe('請求日誌', () => {
  it('查詢字串不寫進日誌：搜金鑰時日誌裡沒有 sk-ant（§3.5、D9）', async () => {
    const lines: string[] = [];
    const { owner } = await seeded({ logger: { stream: { write: (line) => lines.push(line) } } });
    expect((await search(owner, `q=${encodeURIComponent(KEY)}&mask=1`)).status).toBe(200);
    const log = lines.join('');
    expect(log).toContain('/api/search');
    expect(log).not.toContain('sk-ant');
    expect(log).not.toContain('q=');
  });
});

describe('範圍參數', () => {
  it('scope=zone 沒帶 zoneId 回 400；不存在的工作區回空結果', async () => {
    const { owner } = await seeded();
    expect((await search(owner, 'q=deploy&scope=zone')).status).toBe(400);
    const none = await search(owner, 'q=deploy&scope=zone&zoneId=nope');
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ groups: [], partial: false });
  });
});
