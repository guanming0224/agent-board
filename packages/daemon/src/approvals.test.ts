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

describe('matchDangerRule 變形', () => {
  const RM = ['rm -rf /'];
  const PUSH = ['git push --force'];
  const RESET = ['git reset --hard'];

  it.each([
    'git push -f',
    'git push -f origin main',
    'git push origin main --force',
    'git push -fu origin main',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc origin main',
    'git push --force-if-includes',
    'git push origin +main',
    'git push origin +refs/heads/main:refs/heads/main',
    'git -C /some/repo push -f',
    'git -c core.x=y push --force',
    '/usr/bin/git push -f',
    'sudo git push -f',
    'g=1; git push -f',
    'cd repo && git push -f',
    'git status | git push -f',
  ])('git push 強制推送：%s', (command) => {
    expect(matchDangerRule(command, PUSH)).toBe(PUSH[0]);
  });

  it.each([
    'rm -rf /',
    'rm -fr /',
    'rm -r -f /',
    'rm -f -r /',
    'rm -R -f /',
    'rm -Rf /',
    'rm --recursive --force /',
    'rm -rf -- /',
    'rm -rf "/"',
    "rm -rf '/'",
    'r"m" -rf /',
    '\\rm -rf /',
    '/bin/rm -rf /',
    '/usr/bin/rm -rf /',
    'rm -rf //',
    'rm -rf /.',
    'rm -rf /*',
    'rm -rf "/*"',
    'rm -rf --no-preserve-root /',
    'rm -rf foo /',
    'rm -rf /etc',
    'rm -rf /tmp/x',
    'rm -rf ~',
    'rm -rf ~/projects',
    'rm -rf "$HOME"',
    'rm -rf $HOME/x',
    'rm -rf ${TARGET}',
    'rm -rf $(pwd)',
    'rm -rf `pwd`',
    'rm -rf .',
    'rm -rf ./',
    'rm -rf *',
    'rm -rf ./*',
    'rm -rf ..',
    'rm -rf ../sibling',
    'rm -rf a/../..',
    // 前綴
    'sudo rm -rf /',
    'sudo -u root rm -rf /',
    'sudo -E -- rm -rf /',
    'doas rm -rf /',
    'env rm -rf /',
    'env -i A=1 rm -rf /',
    "env -S 'rm -rf /'",
    'FOO=bar rm -rf /',
    'command rm -rf /',
    'exec rm -rf /',
    'nohup rm -rf / &',
    'time rm -rf /',
    'nice -n 5 rm -rf /',
    'timeout 5 rm -rf /',
    'timeout -k 1 5 rm -rf /',
    'busybox rm -rf /',
    // 包在另一層 shell
    'bash -c "rm -rf /"',
    "sh -c 'rm -rf /'",
    'bash -lc "rm -rf /"',
    'zsh -ec "cd /; rm -r -f /"',
    '/bin/bash -c "sudo rm -fr /"',
    'bash -c "bash -c \\"rm -rf /\\""',
    'eval "rm -rf /"',
    'eval rm -rf /',
    'watch -n 1 "rm -rf /"',
    "ssh host 'rm -r -f /'",
    'python3 -c "import os; os.system(\'rm -rf /\')"',
    'bash <<EOF\nrm -rf /\nEOF',
    'sudo bash <<< "rm -rf /"',
    'echo "rm -rf /" | sh',
    'printf "rm -rf /" | sudo bash',
    // 串接
    'ls; rm -rf /',
    'ls;rm -rf /',
    'ls && rm -rf /',
    'ls&&rm -rf /',
    'ls || rm -rf /',
    'ls | rm -rf /',
    'ls & rm -rf /',
    'ls\nrm -rf /',
    '(rm -rf /)',
    '{ rm -rf /; }',
    'if true; then rm -rf /; fi',
    'for x in a; do rm -rf /; done',
    'f() { rm -rf /; }; f',
    'rm \\\n  -rf \\\n  /',
    // 命令替換不管外層是什麼都會跑
    'echo "$(rm -rf /)"',
    'echo `rm -rf /`',
    'X=$(rm -rf /)',
    'cat <(rm -rf /)',
    // 間接執行
    'find / -exec rm -rf {} +',
    'find . -exec rm -rf {} \\;',
    'ls | xargs rm -rf',
    'xargs -n 1 rm -rf',
  ])('rm -rf / 變形：%s', (command) => {
    expect(matchDangerRule(command, RM)).toBe(RM[0]);
  });

  it.each([
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git reset HEAD --hard',
    'git -C x reset --hard',
  ])('git reset --hard：%s', (command) => {
    expect(matchDangerRule(command, RESET)).toBe(RESET[0]);
  });

  // 誤報：決定寫在 docs/security-checklist.md「危險指令判定」，改這裡要一起改文件。
  it.each([
    // 只是文字
    'echo "rm -rf /"',
    "echo 'rm -rf /'",
    'echo rm -rf /',
    'printf "%s" "rm -rf /"',
    'grep -r "rm -rf /" .',
    'rg "rm -rf /" src',
    'git commit -m "remove rm -rf / from script"',
    'git commit -am "rm -rf /"',
    'git commit --message="rm -rf /"',
    'gh pr create --title "x" --body "rm -rf /"',
    'git log --grep "rm -rf /"',
    'cat <<EOF\nrm -rf /\nEOF',
    'cat <<-EOF\n\trm -rf /\n\tEOF\nls',
    '# rm -rf /',
    'ls # rm -rf /',
    // 工作目錄裡的相對路徑
    'rm -rf ./node_modules',
    'rm -rf node_modules',
    'rm -rf node_modules dist',
    'rm -rf build/',
    'rm -rf build/*',
    'rm -rf ./a/../b',
    'find ./build -exec rm -rf {} +',
    // 少了旗標
    'rm -f /tmp/x',
    'rm /etc/hosts',
    'rm -r build',
    'ls /',
    'rmdir /tmp/x',
    'farm -rf /',
    'rm-tool -rf /',
  ])('rm -rf / 不誤報：%s', (command) => {
    expect(matchDangerRule(command, RM)).toBeNull();
  });

  it.each([
    'git push',
    'git push origin main',
    'git push -u origin main',
    'git push --tags',
    'git push --no-force',
    'git push origin main:main',
    'git stash push -f',
    'git log --force',
    'echo git push --force',
    'git commit -m "git push --force"',
    'git-push --force',
  ])('git push --force 不誤報：%s', (command) => {
    expect(matchDangerRule(command, PUSH)).toBeNull();
  });

  it.each(['git reset', 'git reset --soft HEAD~1', 'git checkout --hard', 'echo git reset --hard'])(
    'git reset --hard 不誤報：%s',
    (command) => {
      expect(matchDangerRule(command, RESET)).toBeNull();
    },
  );

  it('回傳清單裡第一條命中的規則原文', () => {
    expect(matchDangerRule('git push -f; rm -rf /', ['rm -rf /', 'git push --force'])).toBe(
      'rm -rf /',
    );
    expect(matchDangerRule('ls', ['rm -rf /', 'git push --force'])).toBeNull();
  });
});

describe('matchDangerRule 使用者自訂規則', () => {
  it.each([
    ['kubectl delete', 'kubectl delete pod x'],
    ['kubectl delete', 'kubectl -n prod delete pod x'],
    ['kubectl delete', 'sudo /usr/local/bin/kubectl delete pod x'],
    ['terraform destroy', 'terraform destroy -auto-approve'],
    ['terraform destroy', 'cd infra && terraform destroy'],
    ['npm publish', 'npm publish --access public'],
    ['git clean -fd', 'git clean -df'],
    ['git clean -fd', 'git clean -f -d -x'],
    ['chmod -R 777', 'chmod 777 -R .'],
    ['docker system prune', 'docker system prune -a'],
    ['mkfs', 'mkfs.ext4 /dev/sda1'],
    ['shutdown', 'sudo shutdown -h now'],
    ['sudo', 'sudo ls'],
    ['sudo rm', 'sudo rm x'],
    ['rm -rf /etc', 'rm -rf /etc/nginx'],
    ['rm -rf /etc', 'rm -rf /'],
    ['dd if=', 'dd if=/dev/zero of=/dev/sda'],
    // 含管線的規則比對相鄰的指令
    ['curl | sh', 'curl https://x | sh'],
    ['curl | sh', 'curl -fsSL https://x | sudo bash -s'.replace('bash -s', 'sh')],
    // 引號裡交給別的程式執行的文字
    ['DROP TABLE', 'psql -c "DROP TABLE users"'],
    ['DROP TABLE', 'psql -c "select 1; DROP TABLE users;"'],
    // 解析不了結構的規則退回子字串
    ['> /dev/sda', 'cat x > /dev/sda'],
    [':(){ :|:& };:', 'x; :(){ :|:& };:'],
    // text: 連引號裡的也算
    ['text:rm -rf /', 'echo "rm -rf /"'],
    ['text:secret-word', 'cat secret-word.txt'],
  ])('規則 %j 命中 %j', (rule, command) => {
    expect(matchDangerRule(command, [rule])).toBe(rule);
  });

  it.each([
    ['kubectl delete', 'kubectl get pods'],
    ['kubectl delete', 'echo kubectl delete'],
    ['npm publish', 'npm test'],
    ['git clean -fd', 'git clean -n'],
    ['git push', 'git stash push'],
    ['rm', 'firmware update'],
    ['rm', 'npm rm x'],
    ['rm -rf /etc', 'rm -rf /var/log'],
    ['rm -rf /etc', 'rm -rf ./etc'],
    ['curl | sh', 'curl https://x | grep y'],
    ['curl | sh', 'curl https://x; sh'],
    ['DROP TABLE', 'grep "DROP TABLE" schema.sql'],
    ['text:', 'anything'],
  ])('規則 %j 不命中 %j', (rule, command) => {
    expect(matchDangerRule(command, [rule])).toBeNull();
  });

  it('引號沒收好時退回子字串，不會因為解析失敗就放行', () => {
    expect(matchDangerRule('echo "unterminated; rm -rf /', ['rm -rf /'])).toBe('rm -rf /');
  });

  it('巢狀超過上限時退回子字串，不會爆堆疊也不會放行', () => {
    let command = 'rm -rf /';
    for (let i = 0; i < 2000; i += 1) command = `echo $(${command})`;
    expect(matchDangerRule(command, ['rm -rf /'])).toBe('rm -rf /');
  });

  it('已知看不到的變形（文件有列，測試釘住現況）', () => {
    for (const command of [
      'bash ./cleanup.sh',
      'RM=rm; $RM -rf /',
      'rm${IFS}-rf${IFS}/',
      'echo cm0gLXJmIC8K | base64 -d | sh',
      'rm -r /',
    ]) {
      expect(matchDangerRule(command, ['rm -rf /'])).toBeNull();
    }
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

  it('answer 放進 updatedInput.answers，鍵是問題原文', async () => {
    const { manager, requested, signal, sent } = setup();
    const result = manager.handleHook(
      'PermissionRequest',
      's1',
      payload({
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: '哪個？' }] },
      }),
      signal,
    );
    expect(requested().kind).toBe('question');
    manager.decide(requested().id, 's1', { behavior: 'answer', text: '選 A' });
    expect(decisionOf(await result)?.decision).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [{ question: '哪個？' }], answers: { '哪個？': '選 A' } },
    });
    expect(sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'web' });
  });

  it('超時回 null（交回原生對話框）並送 by:timeout', async () => {
    const { manager, signal, sent } = setup(20);
    expect(await manager.handleHook('PermissionRequest', 's1', request, signal)).toBeNull();
    expect(sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'timeout' });
    expect(manager.pending()).toEqual([]);
  });

  it('hook 連線斷掉（使用者在終端機回答了）：收掉 approval 並送 by:terminal', async () => {
    const { manager, sent } = setup();
    const abort = new AbortController();
    const result = manager.handleHook('PermissionRequest', 's1', request, abort.signal);
    abort.abort();
    expect(await result).toBeNull();
    expect(sent.at(-1)).toMatchObject({ type: 'approval.resolved', by: 'terminal' });
    expect(manager.pending()).toEqual([]);
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
