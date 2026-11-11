// Codex 節點（CONTRACTS §19）：參數組合、hook 回答格式、找對話紀錄、daemon 開 Codex／接回。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODEX_HOOK_EVENTS,
  DAEMON_FEATURES,
  DEFAULT_DANGER_RULES,
  codexHookOverrides,
  type PermissionMode,
} from '@agent-board/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchDangerRule } from './approvals';
import {
  buildCodexArgs,
  codexHookOutput,
  codexProjectHookFiles,
  codexThreadIds,
  type CodexArgsInput,
} from './codex';
import {
  FAKE_CAPABILITIES,
  Harness,
  HookClient,
  makeTempDir,
  waitUntil,
} from './test-support/harness';

const THREAD = '0199a3c2-1111-7000-8000-000000000abc';

const TARGET = { sessionId: 's-1', socketPath: '/tmp/ab test/daemon.sock' };
const build = (input: Omit<CodexArgsInput, 'hookTarget'>) =>
  buildCodexArgs({ ...input, hookTarget: TARGET });

describe('buildCodexArgs', () => {
  const hooks = codexHookOverrides(TARGET).flatMap((value) => ['-c', value]);

  it('新對話：權限、--dangerously-bypass-hook-trust、每個 hook 一個 -c', () => {
    expect(build({ permissionMode: 'default', model: null })).toEqual([
      '-s',
      'read-only',
      '-a',
      'on-request',
      '--dangerously-bypass-hook-trust',
      ...hooks,
    ]);
  });

  it('接續：resume <id> 在最前面，不帶第一句', () => {
    const args = build({
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
    const args = build({ permissionMode: 'plan', model: null, firstPrompt: '-v 回答 ok' });
    expect(args.slice(-2)).toEqual(['--', '-v 回答 ok']);
  });

  it('bypassPermissions 用 --dangerously-bypass-approvals-and-sandbox；唯讀時改成 read-only＋never', () => {
    expect(build({ permissionMode: 'bypassPermissions', model: null })[0]).toBe(
      '--dangerously-bypass-approvals-and-sandbox',
    );
    const readOnly = build({
      permissionMode: 'bypassPermissions',
      model: null,
      readOnly: true,
    });
    expect(readOnly.slice(0, 4)).toEqual(['-s', 'read-only', '-a', 'never']);
    expect(readOnly).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('權限對應表（GM 2026-11-10：acceptEdits、auto 用可寫工作區；其他唯讀；唯讀 session 一律唯讀）', () => {
    const table: Record<PermissionMode, string[]> = {
      plan: ['-s', 'read-only', '-a', 'on-request'],
      default: ['-s', 'read-only', '-a', 'on-request'],
      acceptEdits: ['-s', 'workspace-write', '-a', 'on-request'],
      auto: ['-s', 'workspace-write', '-a', 'on-request'],
      dontAsk: ['-s', 'read-only', '-a', 'never'],
      bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
    };
    for (const [mode, expected] of Object.entries(table)) {
      const args = build({ permissionMode: mode as PermissionMode, model: null });
      expect(args.slice(0, expected.length)).toEqual(expected);
    }
    // 只用 codex-cli 0.167.0 收的 -a 值（on-request、never）。
    for (const mode of Object.keys(table) as PermissionMode[]) {
      const args = build({ permissionMode: mode, model: null });
      const approval = args[args.indexOf('-a') + 1];
      if (args.includes('-a')) expect(['on-request', 'never']).toContain(approval);
      // 只有 acceptEdits、auto 會用可寫工作區。
      if (mode !== 'acceptEdits' && mode !== 'auto') expect(args).not.toContain('workspace-write');
    }
    // 唯讀 session：一律 read-only 沙盒。
    expect(
      build({ permissionMode: 'acceptEdits', model: null, readOnly: true }).slice(0, 2),
    ).toEqual(['-s', 'read-only']);
  });

  it('只用互動模式：沒有 exec、review、--json', () => {
    const args = build({ resumeId: THREAD, permissionMode: 'auto', model: 'm' });
    for (const banned of ['exec', 'e', 'review', '--json']) expect(args).not.toContain(banned);
  });

  it('hook 設定：每個事件一行 TOML，command 直接帶 session 與 socket（不靠環境變數）', () => {
    const overrides = codexHookOverrides(TARGET);
    expect(overrides).toHaveLength(CODEX_HOOK_EVENTS.length);
    for (const [i, event] of CODEX_HOOK_EVENTS.entries()) {
      expect(overrides[i]).toBe(
        `hooks.${event}=[{hooks=[{type="command",command="agent-board-hook --agent codex --session s-1 --socket '/tmp/ab test/daemon.sock' ${event}",timeout=${
          event === 'PreToolUse'
            ? 600
            : event === 'PermissionRequest'
              ? 100
              : event === 'SessionEnd' || event === 'Interrupt'
                ? 3
                : 30
        }}]}]`,
      );
    }
  });

  it('hook 指令的跳脫：shell 單引號、TOML 的反斜線與雙引號', () => {
    const [first] = codexHookOverrides({ sessionId: 's-2', socketPath: `/tmp/a'b"c\\d.sock` });
    // shell：'/tmp/a'\''b"c\d.sock'；TOML 再把 \ 與 " 跳脫成 \\、\"。
    expect(first).toContain(`--socket '/tmp/a'\\\\''b\\"c\\\\d.sock' SessionStart"`);
  });

  it('W5：有密鑰檔就帶 --key-file（在事件名稱前面）', () => {
    const [first] = codexHookOverrides({
      sessionId: 's-3',
      socketPath: '/tmp/h.sock',
      keyFile: '/data dir/hook.key',
    });
    expect(first).toContain(`--socket /tmp/h.sock --key-file '/data dir/hook.key' SessionStart"`);
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

describe('Codex 的陣列指令（hook CLI 加引號接成字串）', () => {
  it('bash -lc 包起來的危險指令照樣比對得到；只用空白接就會漏掉', () => {
    expect(matchDangerRule("bash -lc 'git push --force origin main'", DEFAULT_DANGER_RULES)).toBe(
      'git push --force',
    );
    expect(matchDangerRule('bash -lc git push --force origin main', DEFAULT_DANGER_RULES)).toBe(
      null,
    );
  });
});

describe('codexThreadIds', () => {
  it('只列出 sessions 底下的檔名，id 一律小寫', async () => {
    const home = makeTempDir();
    expect(await codexThreadIds(home)).toEqual(new Set());
    const day = join(home, 'sessions', '2026', '11', '10');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-11-10T07-00-00-${THREAD.toUpperCase()}.jsonl`), '{}\n');
    writeFileSync(join(day, 'notes.txt'), 'x');
    expect(await codexThreadIds(home)).toEqual(new Set([THREAD]));
  });
});

describe('codexProjectHookFiles', () => {
  it('cwd 到 repo 根目錄之間有 .codex/hooks.json 或 config.toml 就列出來；不看 repo 外、不看家目錄', () => {
    const home = makeTempDir();
    const repo = join(home, 'repo');
    const sub = join(repo, 'packages', 'a');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    // 家目錄自己的 ~/.codex 是使用者的設定，不算。
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '');
    expect(codexProjectHookFiles(sub, home)).toEqual([]);
    expect(codexProjectHookFiles(home, home)).toEqual([]);

    mkdirSync(join(repo, '.codex'), { recursive: true });
    writeFileSync(join(repo, '.codex', 'hooks.json'), '{}');
    expect(codexProjectHookFiles(sub, home)).toEqual([join(repo, '.codex', 'hooks.json')]);
    mkdirSync(join(sub, '.codex'), { recursive: true });
    writeFileSync(join(sub, '.codex', 'config.toml'), '');
    expect(codexProjectHookFiles(sub, home)).toEqual([
      join(sub, '.codex', 'config.toml'),
      join(repo, '.codex', 'hooks.json'),
    ]);
  });

  it('不在 repo 裡：只看 cwd 自己', () => {
    const home = makeTempDir();
    const outer = join(home, 'outer');
    const cwd = join(outer, 'plain');
    mkdirSync(join(outer, '.codex'), { recursive: true });
    writeFileSync(join(outer, '.codex', 'hooks.json'), '{}');
    mkdirSync(cwd, { recursive: true });
    expect(codexProjectHookFiles(cwd, home)).toEqual([]);
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
    // hook 指令直接帶 session 與 socket（Codex 不一定把環境變數傳給 hook）。
    const socket = h.daemons.at(-1)!.hookSocketPath;
    const hookArg = run?.argv.find((arg) => arg.startsWith('hooks.PreToolUse='));
    expect(hookArg).toContain('--session x1 --socket');
    expect(hookArg).toContain(socket.replace(/\\/g, '\\\\'));
    // W5：也帶 daemon 的 hook 密鑰檔，hook CLI 先驗證對方是 daemon 才送；環境變數同樣有。
    expect(hookArg).toContain('--key-file');
    expect(hookArg).toContain('hook.key');
    expect(run?.env.AGENT_BOARD_HOOK_KEY_FILE).toMatch(/hook\.key$/);
    expect(h.installHookCalls).toEqual([]);
    const created = await h.hub.waitFor('session.created', (m) => m.requestId === 'req-x1');
    expect(created.session.claudeSessionId).toBeNull();
    // 第一句在參數裡，但 Codex 還沒回報 UserPromptSubmit：先留著（開起來就崩潰時重啟會再帶）。
    expect(persisted().sessions[0]).toMatchObject({
      claudeSessionId: null,
      pendingFirstPrompt: '回答 ok',
    });

    const client = await HookClient.connect(socket);
    await client.request('x1', 'SessionStart', { session_id: THREAD, source: 'startup' }, 'codex');
    await waitUntil(() => persisted().sessions[0]?.claudeSessionId === THREAD, 'thread id 存檔');
    expect(persisted().sessions[0]?.pendingFirstPrompt).toBe('回答 ok');
    await client.request(
      'x1',
      'UserPromptSubmit',
      { session_id: THREAD, prompt: '回答 ok' },
      'codex',
    );
    client.close();
    // 送進去了才清：重啟不能再送一次。
    await waitUntil(() => persisted().sessions[0]?.pendingFirstPrompt === null, '第一句清掉');
  });

  it('還沒送出第一句就重啟：重新開始時再帶一次', async () => {
    await h.start();
    await h.restartDaemon({ capabilities: codexCaps });
    await h.createAndSubscribe('x5', { agent: 'codex', firstPrompt: '回答 ok' });
    await h.restartDaemon({ capabilities: codexCaps });
    await waitUntil(() => h.runs().length === 2, '重新開始');
    expect(h.runs().at(-1)?.argv.slice(-2)).toEqual(['--', '回答 ok']);
  });

  it('thread id 不是 UUID：不存、runtime 仍然合法（hub 不會整則拒收）', async () => {
    await h.start();
    await h.restartDaemon({ capabilities: codexCaps });
    await h.createAndSubscribe('x6', { agent: 'codex' });
    const client = await HookClient.connect(h.daemons.at(-1)!.hookSocketPath);
    await client.request(
      'x6',
      'SessionStart',
      { session_id: 'thread_abc', source: 'startup' },
      'codex',
    );
    await client.request(
      'x6',
      'UserPromptSubmit',
      { session_id: 'thread_abc', prompt: 'x' },
      'codex',
    );
    client.close();
    await waitUntil(
      () => h.hub.received.some((m) => m.type === 'session.runtime' && m.session.id === 'x6'),
      'runtime',
    );
    expect(persisted().sessions[0]?.claudeSessionId).toBeNull();
    // afterEach 檢查 h.hub.invalid 是空的。
  });

  it('專案有自己的 .codex hook 設定：不開，session.createFailed 說明原因', async () => {
    await h.start();
    await h.restartDaemon({ capabilities: codexCaps });
    mkdirSync(join(h.workDir, '.codex'), { recursive: true });
    writeFileSync(join(h.workDir, '.codex', 'hooks.json'), '{}');
    h.hub.send({
      type: 'session.create',
      requestId: 'req-x7',
      sessionId: 'x7',
      spec: h.spec({ agent: 'codex' }),
    });
    const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'req-x7');
    expect(failed.error).toContain('hooks.json');
    expect(h.runs()).toEqual([]);
    // Claude 不受影響。
    await h.createAndSubscribe('x8');
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
