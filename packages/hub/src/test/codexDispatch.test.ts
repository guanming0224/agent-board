// Codex 也能派工（Codex 第二輪，GM 2026-11-12）：Codex 隊長開成員（預設 Codex）、Claude 隊長指定開 Codex 成員、
// 模型與帳號不跨 agent 沿用、daemon 沒有 codex 時回 codex_unavailable、Codex 成員 Stop 時結果送回隊長並適用等隊長規則。
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_FEATURES, type Session, type SessionSpec } from '@agent-board/protocol';
import { type Peer, runtime, spec, startHub, until, type TestHub } from './helpers';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const CWD = '/fake/project';
const codexFeatures = [DAEMON_FEATURES.signalGuard, DAEMON_FEATURES.codex];
const get = (id: string) => hub.running.store.getSession(id);

async function setup(lead: Partial<SessionSpec>, features: string[] = codexFeatures) {
  hub = await startHub({ timing: { handoffEnterDelayMs: 20 } });
  const cookie = await hub.setupOwner();
  const { daemon, machineId } = await hub.onlineDaemon(cookie, { features });
  const res = await hub.api<Session>('POST', '/api/sessions', {
    cookie,
    body: { ...spec({ name: 'Lead', cwd: CWD, ...lead }), machineId },
  });
  expect(res.status).toBe(200);
  const create = await daemon.next('session.create', (m) => m.sessionId === res.body.id);
  daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(res.body.id, { status: 'waiting_input', cwd: CWD, repoRoot: CWD }),
  });
  await until(() => get(res.body.id)?.status === 'waiting_input', 'lead started');
  daemon.clear();
  return { daemon, caller: res.body.id };
}

async function ask(daemon: Peer, sessionId: string, tool: string, args: Record<string, unknown>) {
  const requestId = randomUUID();
  daemon.send({ type: 'dispatch.request', requestId, sessionId, tool, args });
  const reply = await daemon.next('dispatch.reply', (m) => m.requestId === requestId);
  return { ok: reply.ok as boolean, text: reply.text as string };
}

async function spawn(daemon: Peer, caller: string, args: Record<string, unknown>) {
  const reply = await ask(daemon, caller, 'spawn_member', { reason: 'Need it.', ...args });
  expect(reply.ok, reply.text).toBe(true);
  const body = JSON.parse(reply.text) as Record<string, unknown>;
  const create = await daemon.next(
    'session.create',
    (m) => (m.spec as SessionSpec).name === body.name,
  );
  const id = create.sessionId as string;
  daemon.send({
    type: 'session.created',
    requestId: create.requestId,
    session: runtime(id, { status: 'waiting_input', cwd: CWD, repoRoot: CWD }),
  });
  await until(() => get(id)?.status === 'waiting_input', 'member started');
  return { id, spec: create.spec as SessionSpec, body };
}

describe('Codex 派工', () => {
  it('Codex 隊長開成員：預設也是 Codex、沿用模型；結果在 Codex Stop 時送回隊長，成員等隊長', async () => {
    const { daemon, caller } = await setup({
      agent: 'codex',
      model: 'gpt-5-codex',
      permissionMode: 'acceptEdits',
    });
    const member = await spawn(daemon, caller, {
      role: 'reviewer',
      prompt: 'Review the parser change.',
    });
    expect(member.body).toMatchObject({ agent: 'codex', readOnly: true });
    expect(member.spec).toMatchObject({
      agent: 'codex',
      model: 'gpt-5-codex',
      accountProfile: null,
      readOnly: true,
      firstPrompt: '[From Lead] Review the parser change.',
    });
    expect(get(member.id)?.agent).toBe('codex');
    expect(get(caller)?.awaiting).toBe('members');

    // Codex 的 Stop hook（hook CLI 帶 --agent codex；payload 一樣有 last_assistant_message）。
    daemon.send({
      type: 'session.runtime',
      session: runtime(member.id, { status: 'running', cwd: CWD, repoRoot: CWD }),
    });
    await until(() => get(member.id)?.status === 'running', 'running');
    daemon.send({
      type: 'session.event',
      event: {
        id: randomUUID(),
        sessionId: member.id,
        type: 'hook',
        payload: { event: 'Stop', last_assistant_message: 'No blocking issues. Two nits.' },
        at: new Date().toISOString(),
      },
    });
    daemon.send({
      type: 'session.runtime',
      session: runtime(member.id, { status: 'waiting_input', cwd: CWD, repoRoot: CWD }),
    });
    const typed = await daemon.next(
      'terminal.input',
      (m) => m.sessionId === caller && String(m.data).startsWith('[Result from'),
    );
    expect(String(typed.data)).toBe(
      `[Result from ${member.body.name as string}] Summary: No blocking issues. | Detected file edits: none (edits made through shell commands are not tracked) | Branch: unknown`,
    );
    await until(() => hub.running.store.dispatchWork(member.id) === null, 'work reported');
    await until(() => get(member.id)?.awaiting === 'lead', 'member awaiting lead');
  });

  it('Claude 隊長指定 agent codex：不沿用 Claude 的模型與帳號資料夾；Codex 隊長開 Claude 也一樣', async () => {
    const { daemon, caller } = await setup({
      model: 'opus',
      accountProfile: '/home/demo/.claude-2',
      permissionMode: 'acceptEdits',
    });
    const codex = await spawn(daemon, caller, {
      role: 'reviewer',
      prompt: 'Second opinion.',
      agent: 'codex',
    });
    expect(codex.spec).toMatchObject({ agent: 'codex', model: null, accountProfile: null });
    const claude = await spawn(daemon, caller, { role: 'researcher', prompt: 'Look around.' });
    expect(claude.spec.agent).toBeUndefined();
    expect(claude.spec).toMatchObject({ model: 'opus', accountProfile: '/home/demo/.claude-2' });
    // 明確指定模型時照用。
    const named = await spawn(daemon, caller, {
      role: 'reviewer',
      prompt: 'Third.',
      agent: 'codex',
      model: 'gpt-5.1',
    });
    expect(named.spec.model).toBe('gpt-5.1');
  });

  it('daemon 沒有 codex：codex_unavailable，不留空團隊；agent 值不對是 invalid_arguments', async () => {
    const { daemon, caller } = await setup({}, [DAEMON_FEATURES.signalGuard]);
    const reply = await ask(daemon, caller, 'spawn_member', {
      role: 'reviewer',
      prompt: 'x',
      reason: 'Need it.',
      agent: 'codex',
    });
    expect(reply.ok).toBe(false);
    expect(reply.text).toMatch(/^codex_unavailable:/);
    expect(hub.running.store.listTeams()).toHaveLength(0);
    const bad = await ask(daemon, caller, 'spawn_member', {
      role: 'reviewer',
      prompt: 'x',
      reason: 'Need it.',
      agent: 'gemini',
    });
    expect(bad.text).toMatch(/^invalid_arguments:/);
  });
});
