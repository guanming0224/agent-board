import { HOOK_WAIT_MS, type DaemonToHub, type HookPayload } from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import { APPROVAL_WAIT_MS, ApprovalManager, matchDangerRule } from './approvals';
import type { HookOutput } from './hookServer';

const payload = (fields: Record<string, unknown>): HookPayload => ({
  session_id: 'c1',
  hook_event_name: 'x',
  ...fields,
});

function setup(waitMs = 10_000) {
  const sent: DaemonToHub[] = [];
  const dangerPending: string[] = [];
  const manager = new ApprovalManager({
    send: (message) => sent.push(message),
    dangerRules: () => ['rm -rf /', 'git push --force'],
    waitMs,
    onDangerPending: (sessionId) => dangerPending.push(sessionId),
  });
  const requested = () => {
    const message = sent.find((m) => m.type === 'approval.requested');
    if (message?.type !== 'approval.requested') throw new Error('沒有 approval.requested');
    return message.approval;
  };
  return { sent, dangerPending, manager, requested, signal: new AbortController().signal };
}

const decisionOf = (output: HookOutput) =>
  (output?.hookSpecificOutput as Record<string, unknown> | undefined) ?? null;

describe('matchDangerRule', () => {
  it('空白正規化後比對子字串', () => {
    expect(matchDangerRule('git   push\t--force origin main', ['git push --force'])).toBe(
      'git push --force',
    );
    expect(matchDangerRule('cd x &&  rm  -rf   /', ['rm -rf /'])).toBe('rm -rf /');
  });

  it('規則本身的多餘空白也會正規化；空規則不會全部命中', () => {
    expect(matchDangerRule('git push --force', ['  git  push   --force '])).toBe(
      '  git  push   --force ',
    );
    expect(matchDangerRule('ls', ['', '   '])).toBeNull();
  });

  it('未命中回 null', () => {
    expect(matchDangerRule('git push origin main', ['git push --force'])).toBeNull();
  });
});

describe('PermissionRequest', () => {
  const request = payload({
    tool_name: 'Edit',
    tool_input: { file_path: 'a.ts' },
    permission_suggestions: [{ type: 'addRules', rule: 'Edit' }],
  });

  it('allow 的官方格式，不記住時不帶 updatedPermissions', async () => {
    const { manager, requested, signal, sent } = setup();
    const result = manager.handleHook('PermissionRequest', 's1', request, signal);
    const approval = requested();
    expect(approval).toMatchObject({
      sessionId: 's1',
      kind: 'permission',
      toolName: 'Edit',
      toolInput: { file_path: 'a.ts' },
      suggestions: [{ type: 'addRules', rule: 'Edit' }],
      matchedRule: null,
    });
    expect(manager.pending()).toEqual([approval]);
    expect(manager.decide(approval.id, 's1', { behavior: 'allow', remember: false })).toBe(true);
    expect(await result).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(manager.pending()).toEqual([]);
    expect(sent.at(-1)).toEqual({
      type: 'approval.resolved',
      approvalId: approval.id,
      sessionId: 's1',
      by: 'web',
    });
  });

  it('allow + remember 帶入 suggestions', async () => {
    const { manager, requested, signal } = setup();
    const result = manager.handleHook('PermissionRequest', 's1', request, signal);
    manager.decide(requested().id, 's1', { behavior: 'allow', remember: true });
    expect(decisionOf(await result)?.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addRules', rule: 'Edit' }],
    });
  });

  it('deny 帶 message', async () => {
    const { manager, requested, signal } = setup();
    const result = manager.handleHook('PermissionRequest', 's1', request, signal);
    manager.decide(requested().id, 's1', { behavior: 'deny', reason: '不要改' });
    expect(decisionOf(await result)?.decision).toEqual({ behavior: 'deny', message: '不要改' });
  });

  it('answer 暫時轉成 deny + message，內容寫明是使用者的回答', async () => {
    const { manager, requested, signal, sent } = setup();
    const result = manager.handleHook(
      'PermissionRequest',
      's1',
      payload({ tool_name: 'AskUserQuestion', tool_input: { question: '哪個？' } }),
      signal,
    );
    expect(requested().kind).toBe('question');
    manager.decide(requested().id, 's1', { behavior: 'answer', text: '選 A' });
    const decision = decisionOf(await result)?.decision as Record<string, string>;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('使用者');
    expect(decision.message).toContain('選 A');
    expect(sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'web' });
  });

  it('超時回 null（交回原生對話框）並送 by:timeout', async () => {
    const { manager, signal, sent } = setup(20);
    expect(await manager.handleHook('PermissionRequest', 's1', request, signal)).toBeNull();
    expect(sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'timeout' });
    expect(manager.pending()).toEqual([]);
  });

  it('hook 連線斷掉：hook 已不在，收掉 approval 並送 by:timeout', async () => {
    const { manager, sent } = setup();
    const abort = new AbortController();
    const result = manager.handleHook('PermissionRequest', 's1', request, abort.signal);
    abort.abort();
    expect(await result).toBeNull();
    expect(sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'timeout' });
  });

  it('重複決定或 sessionId 不符都不生效', async () => {
    const { manager, requested, signal } = setup();
    const result = manager.handleHook('PermissionRequest', 's1', request, signal);
    const { id } = requested();
    expect(manager.decide(id, 'other', { behavior: 'allow', remember: false })).toBe(false);
    expect(manager.pending()).toHaveLength(1);
    expect(manager.decide(id, 's1', { behavior: 'deny', reason: '不要' })).toBe(true);
    expect(manager.decide(id, 's1', { behavior: 'allow', remember: false })).toBe(false);
    expect(decisionOf(await result)?.decision).toEqual({ behavior: 'deny', message: '不要' });
  });

  it('容錯：欄位缺漏不會壞', async () => {
    const { manager, requested, signal } = setup();
    const result = manager.handleHook('PermissionRequest', 's1', payload({}), signal);
    expect(requested()).toMatchObject({ toolName: null, toolInput: null, suggestions: [] });
    manager.decide(requested().id, 's1', { behavior: 'allow', remember: true });
    expect(decisionOf(await result)?.decision).toEqual({ behavior: 'allow' });
  });
});

describe('使用者改在終端機回答', () => {
  const input = { command: 'touch a' };
  const request = payload({ tool_name: 'Bash', tool_input: input });
  const resolved = (sent: DaemonToHub[]) =>
    sent.flatMap((m) => (m.type === 'approval.resolved' ? [m.by] : []));

  it('同工具同輸入的 PostToolUse：收掉 approval，hook 不輸出', async () => {
    const { manager, signal, sent } = setup();
    const result = manager.handleHook('PermissionRequest', 's1', request, signal);
    manager.settleAnsweredInTerminal('PostToolUse', 's1', request);
    expect(await result).toBeNull();
    expect(manager.pending()).toEqual([]);
    expect(resolved(sent)).toEqual(['terminal']);
  });

  it('別的工具結束、別的 session 的事件，都不算', () => {
    const { manager, signal } = setup();
    void manager.handleHook('PermissionRequest', 's1', request, signal);
    manager.settleAnsweredInTerminal(
      'PostToolUse',
      's1',
      payload({ tool_name: 'Bash', tool_input: { command: 'other' } }),
    );
    manager.settleAnsweredInTerminal('PostToolUse', 's2', request);
    manager.settleAnsweredInTerminal('Stop', 's2', payload({}));
    expect(manager.pending()).toHaveLength(1);
    manager.dispose();
  });

  it('在終端機拒絕不會有 PostToolUse，輪次結束時收掉', async () => {
    const { manager, signal, sent } = setup();
    const result = manager.handleHook('PermissionRequest', 's1', request, signal);
    manager.settleAnsweredInTerminal('Stop', 's1', payload({}));
    expect(await result).toBeNull();
    expect(resolved(sent)).toEqual(['terminal']);
  });

  it('危險指令不受影響：工具還沒開始，只能由網頁決定', () => {
    const { manager, signal } = setup();
    void manager.handleHook(
      'PreToolUse',
      's1',
      payload({ tool_name: 'Bash', tool_input: { command: 'git push --force' } }),
      signal,
    );
    manager.settleAnsweredInTerminal('Stop', 's1', payload({}));
    expect(manager.pending()).toHaveLength(1);
    manager.dispose();
  });

  it('網頁決定時通知 daemon，讓長指令不會一直顯示等你允許', () => {
    const decided: string[] = [];
    const manager = new ApprovalManager({
      send: () => {},
      dangerRules: () => [],
      onDecided: (approval) => decided.push(approval.sessionId),
    });
    let id = '';
    void manager.handleHook('PermissionRequest', 's1', request, new AbortController().signal);
    id = manager.pending()[0]!.id;
    manager.decide(id, 's1', { behavior: 'allow', remember: false });
    expect(decided).toEqual(['s1']);
  });
});

describe('PreToolUse 危險指令', () => {
  const danger = payload({ tool_name: 'Bash', tool_input: { command: 'git  push  --force' } });

  it('daemon 的等待上限短於 CLI，danger 的 deny 才來得及送達', () => {
    expect(APPROVAL_WAIT_MS).toBeLessThan(HOOK_WAIT_MS);
  });

  it('未命中、非 Bash、缺 command 都回 null 且不建 approval', async () => {
    const { manager, signal, sent } = setup();
    const safe = payload({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    const edit = payload({ tool_name: 'Edit', tool_input: { command: 'rm -rf /' } });
    const missing = payload({ tool_name: 'Bash', tool_input: {} });
    expect(await manager.handleHook('PreToolUse', 's1', safe, signal)).toBeNull();
    expect(await manager.handleHook('PreToolUse', 's1', edit, signal)).toBeNull();
    expect(await manager.handleHook('PreToolUse', 's1', missing, signal)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('命中建 danger approval，allow 回 permissionDecision:allow（不是 ask）', async () => {
    const { manager, requested, signal } = setup();
    const result = manager.handleHook('PreToolUse', 's1', danger, signal);
    expect(requested()).toMatchObject({
      kind: 'danger',
      matchedRule: 'git push --force',
      toolName: 'Bash',
    });
    manager.decide(requested().id, 's1', { behavior: 'allow', remember: false });
    const output = decisionOf(await result);
    expect(output?.hookEventName).toBe('PreToolUse');
    expect(output?.permissionDecision).toBe('allow');
  });

  it('deny 帶原因', async () => {
    const { manager, requested, signal } = setup();
    const result = manager.handleHook('PreToolUse', 's1', danger, signal);
    manager.decide(requested().id, 's1', { behavior: 'deny', reason: '會蓋掉別人的 commit' });
    expect(decisionOf(await result)).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '會蓋掉別人的 commit',
    });
  });

  it('只有命中才通知等人，且在 approval 建立之後；權限請求不觸發', async () => {
    const hit = setup();
    void hit.manager.handleHook('PreToolUse', 's1', danger, hit.signal);
    expect(hit.dangerPending).toEqual(['s1']);
    expect(hit.manager.pending()).toHaveLength(1);

    const miss = setup();
    const safe = payload({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    await miss.manager.handleHook('PreToolUse', 's1', safe, miss.signal);
    void miss.manager.handleHook('PermissionRequest', 's1', payload({}), miss.signal);
    expect(miss.dangerPending).toEqual([]);
  });

  it('對危險指令送 answer 也不會放行', async () => {
    const { manager, requested, signal } = setup();
    const result = manager.handleHook('PreToolUse', 's1', danger, signal);
    manager.decide(requested().id, 's1', { behavior: 'answer', text: '可以' });
    expect(decisionOf(await result)?.permissionDecision).toBe('deny');
  });

  it('超時回 deny', async () => {
    const { manager, signal, sent } = setup(20);
    const output = decisionOf(await manager.handleHook('PreToolUse', 's1', danger, signal));
    expect(output?.permissionDecision).toBe('deny');
    expect(sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'timeout' });
  });

  it('session 結束或 daemon 關閉時也往安全方向回 deny', async () => {
    const a = setup();
    const canceled = a.manager.handleHook('PreToolUse', 's1', danger, a.signal);
    a.manager.cancelSession('s1');
    expect(decisionOf(await canceled)?.permissionDecision).toBe('deny');
    expect(a.sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'terminal' });

    const b = setup();
    const disposed = b.manager.handleHook('PreToolUse', 's1', danger, b.signal);
    b.manager.dispose();
    expect(decisionOf(await disposed)?.permissionDecision).toBe('deny');
  });
});
