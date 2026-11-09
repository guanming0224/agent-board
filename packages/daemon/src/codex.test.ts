// Codex 節點（CONTRACTS §19）：參數組合、hook 回答格式、找對話紀錄、daemon 開 Codex／接回。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODEX_HOOK_EVENTS,
  DAEMON_FEATURES,
  codexHookOverrides,
  type PermissionMode,
} from '@agent-board/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCodexArgs, codexHookOutput, codexThreadExists } from './codex';
import {
  FAKE_CAPABILITIES,
  Harness,
  HookClient,
  makeTempDir,
  waitUntil,
} from './test-support/harness';

const THREAD = '0199a3c2-1111-7000-8000-000000000abc';

describe('buildCodexArgs', () => {
  const hooks = codexHookOverrides().flatMap((value) => ['-c', value]);

  it('新對話：權限、--dangerously-bypass-hook-trust、每個 hook 一個 -c', () => {
    expect(buildCodexArgs({ permissionMode: 'default', model: null })).toEqual([
      '-s',
      'read-only',
      '-a',
      'on-request',
      '--dangerously-bypass-hook-trust',
      ...hooks,
    ]);
  });

  it('接續：resume <id> 在最前面，不帶第一句', () => {
    const args = buildCodexArgs({
      resumeId: THREAD,
      permissionMode: 'acceptEdits',
      model: 'gpt-test',
      firstPrompt: '不該出現',
    });
    expect(args.slice(0, 2)).toEqual(['resume', THREAD]);
    expect(args.slice(2, 8)).toEqual([
      '-s',
      'workspace-write',
      '-a',
      'on-request',
      '-m',
      'gpt-test',
    ]);
    expect(args).not.toContain('不該出現');
  });

  it('第一句放在 -- 之後（以 - 開頭也不會被當成參數）', () => {
    const args = buildCodexArgs({ permissionMode: 'plan', model: null, firstPrompt: '-v 回答 ok' });
    expect(args.slice(-2)).toEqual(['--', '-v 回答 ok']);
  });

  it('bypassPermissions 用 --dangerously-bypass-approvals-and-sandbox；唯讀時改成 read-only＋never', () => {
    expect(buildCodexArgs({ permissionMode: 'bypassPermissions', model: null })[0]).toBe(
      '--dangerously-bypass-approvals-and-sandbox',
    );
    const readOnly = buildCodexArgs({
      permissionMode: 'bypassPermissions',
      model: null,
      readOnly: true,
    });
    expect(readOnly.slice(0, 4)).toEqual(['-s', 'read-only', '-a', 'never']);
    expect(readOnly).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('權限對應表（不比 Claude 的模式寬）', () => {
    const table: Record<PermissionMode, string[]> = {
      plan: ['-s', 'read-only', '-a', 'on-request'],
      default: ['-s', 'read-only', '-a', 'on-request'],
      acceptEdits: ['-s', 'workspace-write', '-a', 'on-request'],
      auto: ['-s', 'workspace-write', '-a', 'on-request'],
      dontAsk: ['-s', 'read-only', '-a', 'never'],
      bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
    };
    for (const [mode, expected] of Object.entries(table)) {
      const args = buildCodexArgs({ permissionMode: mode as PermissionMode, model: null });
      expect(args.slice(0, expected.length)).toEqual(expected);
    }
    // 唯讀 session：可寫的模式也降成 read-only 沙盒。
    expect(
      buildCodexArgs({ permissionMode: 'acceptEdits', model: null, readOnly: true }).slice(0, 2),
    ).toEqual(['-s', 'read-only']);
  });

  it('只用互動模式：沒有 exec、review、--json', () => {
    const args = buildCodexArgs({ resumeId: THREAD, permissionMode: 'auto', model: 'm' });
    for (const banned of ['exec', 'e', 'review', '--json']) expect(args).not.toContain(banned);
  });

  it('hook 設定：每個事件一行 TOML，command 是 agent-board-hook --agent codex <Event>', () => {
    const overrides = codexHookOverrides();
    expect(overrides).toHaveLength(CODEX_HOOK_EVENTS.length);
    for (const [i, event] of CODEX_HOOK_EVENTS.entries()) {
      expect(overrides[i]).toBe(
        `hooks.${event}=[{hooks=[{type="command",command="agent-board-hook --agent codex ${event}",timeout=${
          event === 'PreToolUse' || event === 'PermissionRequest'
            ? 600
            : event === 'SessionEnd' || event === 'Interrupt'
              ? 3
              : 30
        }}]}]`,
      );
    }
  });
});

describe('codexHookOutput', () => {
  const permission = (decision: Record<string, unknown>) => ({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  });

  it('PermissionRequest allow：拿掉 updatedPermissions（記住對 Codex 無效）', () => {
    expect(
      codexHookOutput(
        'PermissionRequest',
        permission({ behavior: 'allow', updatedPermissions: [{ rule: 'x' }] }),
      ),
    ).toEqual(permission({ behavior: 'allow' }));
  });

  it('PermissionRequest deny：保留原因', () => {
    expect(
      codexHookOutput('PermissionRequest', permission({ behavior: 'deny', message: '不行' })),
    ).toEqual(permission({ behavior: 'deny', message: '不行' }));
  });

  it('提問的回答（allow＋updatedInput）Codex 收不下：改成 deny 帶說明', () => {
    const out = codexHookOutput(
      'PermissionRequest',
      permission({ behavior: 'allow', updatedInput: { answers: {} } }),
    ) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('PreToolUse：allow 不輸出（照常執行），deny 保留', () => {
    const pre = (decision: string) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: 'r',
      },
    });
    expect(codexHookOutput('PreToolUse', pre('allow'))).toBeNull();
    expect(codexHookOutput('PreToolUse', pre('ask'))).toBeNull();
    expect(codexHookOutput('PreToolUse', pre('deny'))).toEqual(pre('deny'));
  });

  it('null 與其他事件：null', () => {
    expect(codexHookOutput('PermissionRequest', null)).toBeNull();
    expect(codexHookOutput('Stop', { anything: 1 })).toBeNull();
  });
});

describe('codexThreadExists', () => {
  it('只比對 sessions 底下的檔名', async () => {
    const home = makeTempDir();
    expect(await codexThreadExists(home, THREAD)).toBe(false);
    const day = join(home, 'sessions', '2026', '11', '10');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-11-10T07-00-00-${THREAD}.jsonl`), '{}\n');
    expect(await codexThreadExists(home, THREAD)).toBe(true);
    expect(await codexThreadExists(home, THREAD.toUpperCase())).toBe(true);
    expect(await codexThreadExists(home, '0199a3c2-1111-7000-8000-000000000000')).toBe(false);
  });
});

describe('daemon 開 Codex', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });
  afterEach(async () => {
    await h.cleanup();
    expect(h.hub.invalid).toEqual([]);
  });

  const codexCaps = { ...FAKE_CAPABILITIES, codexVersion: '0.167.0' };
  const persisted = () =>
    JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')) as {
      sessions: {
        sessionId: string;
        claudeSessionId: string | null;
        pendingFirstPrompt: string | null;
      }[];
    };

  it('hello：有 codexVersion 才宣告 agent.codex', async () => {
    await h.start();
    expect(h.hellos()[0]?.features).not.toContain(DAEMON_FEATURES.codex);
    await h.restartDaemon({ capabilities: codexCaps });
    expect(h.hellos().at(-1)?.features).toContain(DAEMON_FEATURES.codex);
    expect(h.hellos().at(-1)?.capabilities.codexVersion).toBe('0.167.0');
  });

  it('開 Codex：參數照對應表、不寫 hook 設定檔、不設 CLAUDE_CONFIG_DIR、thread id 等 SessionStart', async () => {
    await h.start();
    await h.restartDaemon({ capabilities: codexCaps });
    await h.createAndSubscribe('x1', {
      agent: 'codex',
      permissionMode: 'acceptEdits',
      model: 'gpt-test',
      accountProfile: join(h.root, 'profile'),
      firstPrompt: '回答 ok',
    });
    const run = h.runs().at(-1);
    expect(run?.argv.slice(0, 7)).toEqual([
      '-s',
      'workspace-write',
      '-a',
      'on-request',
      '-m',
      'gpt-test',
      '--dangerously-bypass-hook-trust',
    ]);
    expect(run?.argv.slice(-2)).toEqual(['--', '回答 ok']);
    expect(run?.env.CLAUDE_CONFIG_DIR).toBeNull();
    expect(run?.env.AGENT_BOARD_SESSION_ID).toBe('x1');
    expect(h.installHookCalls).toEqual([]);
    const created = await h.hub.waitFor('session.created', (m) => m.requestId === 'req-x1');
    expect(created.session.claudeSessionId).toBeNull();
    // 第一句已經在參數裡：重啟不能再送一次。
    expect(persisted().sessions[0]).toMatchObject({
      claudeSessionId: null,
      pendingFirstPrompt: null,
    });

    const client = await HookClient.connect(h.daemons.at(-1)!.hookSocketPath);
    await client.request('x1', 'SessionStart', { session_id: THREAD, source: 'startup' }, 'codex');
    client.close();
    await waitUntil(() => persisted().sessions[0]?.claudeSessionId === THREAD, 'thread id 存檔');
  });

  it('daemon 重啟：有對話紀錄用 codex resume <id>，沒有就重新開始', async () => {
    await h.start();
    await h.restartDaemon({ capabilities: codexCaps });
    await h.createAndSubscribe('x2', { agent: 'codex' });
    const client = await HookClient.connect(h.daemons.at(-1)!.hookSocketPath);
    await client.request('x2', 'SessionStart', { session_id: THREAD, source: 'startup' }, 'codex');
    client.close();
    await waitUntil(() => persisted().sessions[0]?.claudeSessionId === THREAD, 'thread id 存檔');

    // 沒有對話紀錄（一句話都沒說）：重新開始，不帶 resume。
    await h.restartDaemon({ capabilities: codexCaps });
    await waitUntil(() => h.runs().length === 2, '重新開始');
    expect(h.runs().at(-1)?.argv[0]).toBe('-s');

    // 有對話紀錄：codex resume <id>（HOME 是測試的暫存資料夾，不會讀到真的 ~/.codex）。
    const day = join(h.root, '.codex', 'sessions', '2026', '11', '10');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-11-10T07-00-00-${THREAD}.jsonl`), '{}\n');
    await h.restartDaemon({ capabilities: codexCaps });
    await waitUntil(() => h.runs().length === 3, '接回');
    expect(h.runs().at(-1)?.argv.slice(0, 2)).toEqual(['resume', THREAD]);
  });

  it('核准：web 允許（含記住）→ Codex 格式；危險指令 allow 不輸出、deny 回 deny', async () => {
    await h.start();
    await h.restartDaemon({ capabilities: codexCaps });
    await h.createAndSubscribe('x3', { agent: 'codex' });
    const client = await HookClient.connect(h.daemons.at(-1)!.hookSocketPath);

    const permission = client.request(
      'x3',
      'PermissionRequest',
      { tool_name: 'Bash', tool_input: { command: 'touch a.txt' } },
      'codex',
    );
    const first = await h.hub.waitFor('approval.requested');
    h.hub.send({
      type: 'approval.decide',
      approvalId: first.approval.id,
      sessionId: 'x3',
      decision: { behavior: 'allow', remember: true },
    });
    expect((await permission).output).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });

    const danger = (decision: 'allow' | 'deny') => async () => {
      const before = h.hub.received.filter((m) => m.type === 'approval.requested').length;
      const reply = client.request(
        'x3',
        'PreToolUse',
        { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
        'codex',
      );
      const requested = await waitUntil(
        () => h.hub.received.filter((m) => m.type === 'approval.requested')[before],
        'danger approval',
      );
      if (requested.type !== 'approval.requested') throw new Error('型別');
      expect(requested.approval.kind).toBe('danger');
      h.hub.send({
        type: 'approval.decide',
        approvalId: requested.approval.id,
        sessionId: 'x3',
        decision:
          decision === 'allow'
            ? { behavior: 'allow', remember: false }
            : { behavior: 'deny', reason: '不行' },
      });
      return (await reply).output;
    };
    expect(await danger('allow')()).toBeNull();
    expect(await danger('deny')()).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '不行',
      },
    });
    client.close();
  });

  it('找不到 codex：session.createFailed，不開', async () => {
    await h.start();
    await h.restartDaemon({ capabilities: codexCaps });
    h.daemons.at(-1)!['deps'].config.codexBin = join(h.root, 'no-such-codex');
    h.hub.send({
      type: 'session.create',
      requestId: 'req-x4',
      sessionId: 'x4',
      spec: h.spec({ agent: 'codex' }),
    });
    const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'req-x4');
    expect(failed.error).toContain('no-such-codex');
  });
});
