// 交叉審查（Codex 第二輪）在 daemon 這一段：diff 產生與上限、兩邊並行執行（假 claude／假 codex：成功、失敗、逾時、
// 一邊失敗另一邊照常）、唯讀參數、輸出解析。真的 git、假的 CLI（web/e2e/fixtures），不呼叫任何模型。
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEW_INSTRUCTIONS, type ReviewSide } from '@agent-board/protocol';
import {
  claudeReviewArgs,
  codexReviewArgs,
  parseClaudeOutput,
  parseCodexOutput,
  resolveReviewBin,
  ReviewRunner,
} from './review';
import {
  assemble,
  branchDiff,
  isSensitivePath,
  readUntracked,
  sessionDiff,
  splitDiff,
} from './reviewDiff';
import { makeTempDir, waitUntil } from './test-support/harness';

const FAKE_CLAUDE = fileURLToPath(
  new URL('../../web/e2e/fixtures/fake-claude.mjs', import.meta.url),
);
const FAKE_CODEX = fileURLToPath(new URL('../../web/e2e/fixtures/fake-codex.mjs', import.meta.url));
chmodSync(FAKE_CLAUDE, 0o755);
chmodSync(FAKE_CODEX, 0o755);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  });

function repo(): string {
  const dir = makeTempDir();
  temps.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'gone.ts'), 'old\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe.skipIf(process.platform === 'win32')('reviewDiff', () => {
  it('session：git diff HEAD（含 staged）＋未追蹤檔內容；.gitignore 的與 hook 設定檔不算；二進位不送內容', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\nexport const b = 3;\n');
    writeFileSync(join(dir, 'staged.ts'), 'staged\n');
    git(dir, 'add', 'staged.ts');
    rmSync(join(dir, 'gone.ts'));
    mkdirSync(join(dir, 'new'));
    writeFileSync(join(dir, 'new', 'file.ts'), 'line1\nline2\n');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
    writeFileSync(join(dir, 'ignored.log'), 'secret\n');
    // Agent Board 自己裝的 hook 設定不送審。
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"hooks":{}}\n');
    const { text, summary } = await sessionDiff(join(dir, 'new'));
    expect(summary.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['a.ts', 'modified', 2, 1],
      ['gone.ts', 'deleted', 0, 1],
      ['staged.ts', 'added', 1, 0],
      ['.gitignore', 'untracked', 1, 0],
      ['blob.bin', 'untracked', 1, 0],
      ['new/file.ts', 'untracked', 2, 0],
    ]);
    expect(summary).toMatchObject({ additions: 7, deletions: 2, truncated: false });
    expect(text).toContain('+export const b = 3;');
    expect(text).toContain('+++ b/new/file.ts\n+line1\n+line2');
    expect(text).toContain('(binary file, content not included)');
    expect(text).not.toContain('secret');
    expect(summary.totalBytes).toBe(Buffer.byteLength(text));
  });

  it('S1：指向 repo 外的符號連結只列目標不讀內容；FIFO 略過不卡住', async () => {
    const dir = repo();
    const outside = makeTempDir();
    temps.push(outside);
    writeFileSync(join(outside, 'auth.json'), '{"token":"sk-ant-demo-secret"}\n');
    symlinkSync(join(outside, 'auth.json'), join(dir, 'link.json'));
    symlinkSync(outside, join(dir, 'linkdir'));
    execFileSync('mkfifo', [join(dir, 'pipe')]);
    const started = Date.now();
    const { text, summary } = await sessionDiff(dir);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text).not.toContain('sk-ant-demo-secret');
    expect(text).toContain(`(symlink -> ${join(outside, 'auth.json')}; content not included)`);
    expect(summary.files.map((f) => f.path)).not.toContain('pipe');
    // readUntracked 本身：FIFO、資料夾回 null；repo 外的真實路徑不讀。
    expect(await readUntracked(dir, 'pipe', 1000)).toBeNull();
  });

  it('S1 TOCTOU：檢查後中間的資料夾被換成指向 repo 外的連結 → 開到的不是同一個檔，略過不讀', async () => {
    const dir = repo();
    const outside = makeTempDir();
    temps.push(outside);
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'inside\n');
    writeFileSync(join(outside, 'a.txt'), 'sk-ant-demo-outside\n');
    const read = await readUntracked(dir, 'sub/a.txt', 1000, {
      beforeOpen: () => {
        rmSync(join(dir, 'sub'), { recursive: true });
        symlinkSync(outside, join(dir, 'sub'));
      },
    });
    expect(read).toBeNull();
    // 沒被換掉時照常讀。
    rmSync(join(dir, 'sub'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.txt'), 'inside\n');
    expect((await readUntracked(dir, 'sub/a.txt', 1000))?.text).toBe('inside\n');
  });

  it('W2：檔名像機密的（追蹤中或未追蹤）只列名稱、不送內容，摘要標 sensitive', async () => {
    const dir = repo();
    writeFileSync(join(dir, '.env'), 'OLD=1\n');
    git(dir, 'add', '.env');
    git(dir, 'commit', '-q', '-m', 'env');
    writeFileSync(join(dir, '.env'), 'API_KEY=sk-ant-demo-tracked\n');
    writeFileSync(join(dir, 'server.pem'), 'PRIVATE-untracked\n');
    mkdirSync(join(dir, '.ssh'));
    writeFileSync(join(dir, '.ssh', 'config'), 'Host secret-host\n');
    writeFileSync(join(dir, 'id_utils.ts'), 'export const ok = 1;\n');
    const { text, summary } = await sessionDiff(dir);
    for (const secret of ['sk-ant-demo-tracked', 'PRIVATE-untracked', 'secret-host']) {
      expect(text).not.toContain(secret);
    }
    const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f.omitted]));
    expect(byPath).toMatchObject({
      '.env': 'sensitive',
      'server.pem': 'sensitive',
      '.ssh/config': 'sensitive',
      'id_utils.ts': false,
    });
    expect(text).toContain('look like secrets and were not included: ');
    expect(isSensitivePath('a/b/id_ed25519')).toBe(true);
    expect(isSensitivePath('config/credentials.prod.json')).toBe(true);
    expect(isSensitivePath('src/key.ts')).toBe(false);
  });

  it('還沒有 commit 的 repo：和空樹比，照樣列得出來', async () => {
    const dir = makeTempDir();
    temps.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x.ts'), 'x\n');
    const { summary } = await sessionDiff(dir);
    expect(summary.files.map((f) => [f.path, f.status])).toEqual([['x.ts', 'untracked']]);
  });

  it('單檔超過上限截斷並標明；整份超過上限，後面的檔案只列名稱', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'big.ts'), `${'x'.repeat(5000)}\n`);
    writeFileSync(join(dir, 'c.ts'), 'c\n'.repeat(50));
    writeFileSync(join(dir, 'd.ts'), 'd\n'.repeat(50));
    const { text, summary } = await sessionDiff(dir, { fileMaxBytes: 1000, totalMaxBytes: 1300 });
    const big = summary.files.find((f) => f.path === 'big.ts')!;
    expect(big).toMatchObject({ truncated: true, omitted: false });
    expect(text).toContain('[... truncated: this file is larger than the review limit ...]');
    expect(summary.files.filter((f) => f.omitted).map((f) => f.path)).toEqual(['d.ts']);
    expect(text).toContain('1 more changed file(s) not included');
    expect(summary.truncated).toBe(true);
    expect(summary.totalBytes).toBeLessThanOrEqual(1300);
  });

  it('branch：base...branch；不存在的分支、以 - 開頭的名稱拒絕（不會被當成 git 參數）', async () => {
    const dir = repo();
    git(dir, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 42;\n');
    git(dir, 'commit', '-q', '-am', 'change');
    git(dir, 'checkout', '-q', 'main');
    const { summary } = await branchDiff(dir, 'feature/x', 'main');
    expect(summary.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([['a.ts', 1, 1]]);
    await expect(branchDiff(dir, 'nope', 'main')).rejects.toMatchObject({ code: 'unknown_ref' });
    await expect(branchDiff(dir, '--output=/tmp/x', 'main')).rejects.toMatchObject({
      code: 'invalid_ref',
    });
    await expect(branchDiff(dir, 'a..b', 'main')).rejects.toMatchObject({ code: 'invalid_ref' });
  });

  it('不是 git：git_failed', async () => {
    const dir = makeTempDir();
    temps.push(dir);
    await expect(sessionDiff(dir)).rejects.toMatchObject({ code: 'git_failed' });
  });

  it('splitDiff／assemble：rename 與行數', () => {
    const chunks = splitDiff(
      'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(chunks.map((c) => [c.path, c.status])).toEqual([['new.ts', 'renamed']]);
    expect(assemble(chunks, { fileMaxBytes: 1000, totalMaxBytes: 1000 }).summary).toMatchObject({
      additions: 1,
      deletions: 1,
    });
  });
});

describe('resolveReviewBin（W9）', () => {
  it('Windows 只找 .exe，不用 .cmd；有路徑照用；其他平台原樣', () => {
    const dir = makeTempDir();
    temps.push(dir);
    writeFileSync(join(dir, 'claude.cmd'), '');
    expect(resolveReviewBin('claude', { PATH: dir }, 'win32')).toBeNull();
    writeFileSync(join(dir, 'claude.exe'), '');
    expect(resolveReviewBin('claude', { Path: dir }, 'win32')).toBe(join(dir, 'claude.exe'));
    expect(resolveReviewBin(join(dir, 'claude.cmd'), {}, 'win32')).toBeNull();
    expect(resolveReviewBin(join(dir, 'claude'), {}, 'win32')).toBe(join(dir, 'claude.exe'));
    expect(resolveReviewBin('claude', {}, 'darwin')).toBe('claude');
  });
});

describe('審查參數與輸出解析', () => {
  it('參數快照（完全相等，S2）：Claude 只讀三工具＋restricted＋不載 MCP＋plan；Codex 唯讀沙盒、從不詢問、不留紀錄', () => {
    expect(claudeReviewArgs('opus')).toEqual([
      '-p',
      '--output-format',
      'json',
      '--restricted',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      '--disallowedTools',
      'Bash',
      'Edit',
      'MultiEdit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Task',
      'mcp__*',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--permission-mode',
      'plan',
      '--no-session-persistence',
      '--model',
      'opus',
    ]);
    expect(claudeReviewArgs(null).slice(-2)).toEqual(['plan', '--no-session-persistence']);
    expect(codexReviewArgs(null, 'low')).toEqual([
      'exec',
      '--json',
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--skip-git-repo-check',
      '--ephemeral',
      '-c',
      'model_reasoning_effort="low"',
      '-',
    ]);
    expect(codexReviewArgs('gpt-x', null)).toEqual([
      'exec',
      '--json',
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--skip-git-repo-check',
      '--ephemeral',
      '-m',
      'gpt-x',
      '-',
    ]);
    // 推理強度只收固定的幾個字（不會被拿來注入其他設定）。
    expect(codexReviewArgs(null, 'x" ; sandbox_mode="danger').join(' ')).not.toContain(
      'model_reasoning_effort',
    );
    expect(codexReviewArgs(null, 'xhigh').join(' ')).not.toContain('model_reasoning_effort');
  });

  it('Claude JSON：成功、is_error、讀不懂', () => {
    expect(
      parseClaudeOutput(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 },
        }),
      ),
    ).toEqual({ output: 'ok', error: null, inputTokens: 3, outputTokens: 3 });
    expect(parseClaudeOutput('{"is_error":true,"result":"boom"}')).toMatchObject({
      output: null,
      error: 'boom',
    });
    expect(parseClaudeOutput('not json').error).toBe('unreadable output');
  });

  it('Codex JSONL：最後一則 agent_message、turn.completed 用量；turn.failed；讀不懂的行略過', () => {
    const lines = [
      '{"type":"thread.started","thread_id":"t"}',
      'garbage',
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":5}}',
    ];
    expect(parseCodexOutput(lines.join('\n'))).toEqual({
      output: 'final',
      error: null,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(parseCodexOutput('{"type":"turn.failed","error":{"message":"quota"}}')).toMatchObject({
      output: null,
      error: 'quota',
    });
    expect(parseCodexOutput('').error).toBe('no review text in output');
  });
});

describe.skipIf(process.platform === 'win32')('ReviewRunner（假 claude／假 codex）', () => {
  function runner(options: { timeoutMs?: number; platform?: NodeJS.Platform } = {}) {
    const dir = makeTempDir();
    temps.push(dir);
    const log = join(dir, 'review.log');
    const sides: ReviewSide[] = [];
    const sent: boolean[] = [];
    let connected = true;
    // Windows 只認 .exe（W9）：做一個叫 claude.exe 的包裝（在 macOS／Linux 上是 shell 腳本，照樣執行得起來）。
    let claudeBin = FAKE_CLAUDE;
    if (options.platform === 'win32') {
      claudeBin = join(dir, 'claude.exe');
      writeFileSync(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
      chmodSync(claudeBin, 0o755);
    }
    const r = new ReviewRunner({
      claudeBin,
      codexBin: FAKE_CODEX,
      env: () => ({ PATH: process.env.PATH ?? '', AB_FAKE_REVIEW_LOG: log }),
      send: (message, onResult) => {
        sent.push(connected);
        if (connected) sides.push(message.side);
        onResult(connected);
      },
      timeoutMs: options.timeoutMs ?? 20_000,
      platform: options.platform,
    });
    const calls = () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { cli: string; args: string[]; cwd: string; prompt: string });
    return { r, sides, calls, disconnect: (v: boolean) => (connected = !v) };
  }

  async function prepared(r: ReviewRunner, id: string) {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 99;\n');
    const reply = await r.prepare({
      type: 'review.prepare',
      requestId: `req-${id}`,
      reviewId: id,
      kind: 'session',
      cwd: dir,
      branch: null,
      base: null,
    });
    expect(reply.error).toBeNull();
    return dir;
  }

  it('兩邊並行成功：意見、用量、模型；prompt 是固定指示＋diff，經 stdin；cwd 是 repo', async () => {
    const t = runner();
    const dir = await prepared(t.r, 'r1');
    t.r.run({
      type: 'review.run',
      reviewId: 'r1',
      claude: { model: null, accountProfile: null },
      codex: { model: 'gpt-x', effort: null },
    });
    await waitUntil(() => t.sides.length === 2, 'two sides', 20_000);
    const claude = t.sides.find((s) => s.agent === 'claude')!;
    const codex = t.sides.find((s) => s.agent === 'codex')!;
    expect(claude).toMatchObject({ status: 'done', inputTokens: 150, outputTokens: 45 });
    expect(claude.output).toContain('Claude 假審查');
    expect(codex).toMatchObject({
      status: 'done',
      model: 'gpt-x',
      inputTokens: 200,
      outputTokens: 60,
    });
    expect(codex.output).toContain('Codex 假審查');
    const calls = t.calls();
    for (const call of calls) {
      expect(call.prompt.startsWith(REVIEW_INSTRUCTIONS)).toBe(true);
      expect(call.prompt).toContain('+export const a = 99;');
      expect(call.args.join(' ')).not.toContain('export const a');
      expect(call.cwd).toBe(dir);
    }
    expect(calls.find((c) => c.cli === 'codex')!.args).toContain('read-only');
    expect(calls.find((c) => c.cli === 'claude')!.args).toContain('plan');
    // 跑過一次就丟掉 diff：同一個 id 再跑一次是 prepared_diff_missing。
    t.r.run({
      type: 'review.run',
      reviewId: 'r1',
      claude: { model: null, accountProfile: null },
      codex: null,
    });
    await waitUntil(() => t.sides.length === 3, 'missing');
    expect(t.sides[2]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^prepared_diff_missing/),
    });
  });

  it('一邊失敗不影響另一邊', async () => {
    const t = runner();
    await prepared(t.r, 'r2');
    t.r.run({
      type: 'review.run',
      reviewId: 'r2',
      claude: { model: 'fake-review-fail', accountProfile: null },
      codex: { model: null, effort: null },
    });
    await waitUntil(() => t.sides.length === 2, 'two sides', 20_000);
    expect(t.sides.find((s) => s.agent === 'claude')).toMatchObject({
      status: 'failed',
      error: 'fake failure',
    });
    expect(t.sides.find((s) => s.agent === 'codex')).toMatchObject({ status: 'done' });

    const u = runner();
    await prepared(u.r, 'r3');
    u.r.run({
      type: 'review.run',
      reviewId: 'r3',
      claude: { model: null, accountProfile: null },
      codex: { model: 'fake-review-fail', effort: null },
    });
    await waitUntil(() => u.sides.length === 2, 'two sides', 20_000);
    expect(u.sides.find((s) => s.agent === 'codex')).toMatchObject({
      status: 'failed',
      error: 'fake codex failure',
    });
    expect(u.sides.find((s) => s.agent === 'claude')).toMatchObject({ status: 'done' });
  });

  it('逾時：那一邊結束並標記 timeout，另一邊照常完成', async () => {
    const t = runner({ timeoutMs: 1_500 });
    await prepared(t.r, 'r4');
    t.r.run({
      type: 'review.run',
      reviewId: 'r4',
      claude: { model: null, accountProfile: null },
      codex: { model: 'fake-review-slow', effort: null },
    });
    await waitUntil(() => t.sides.length === 2, 'two sides', 20_000);
    expect(t.sides.find((s) => s.agent === 'codex')).toMatchObject({
      status: 'timeout',
      error: 'timed out after 2 s',
    });
    expect(t.sides.find((s) => s.agent === 'claude')).toMatchObject({ status: 'done' });
    expect(t.r.activeCount).toBe(0);
  });

  it('Windows：Codex 那邊略過並標明，只跑 Claude；找不到 CLI 是 failed', async () => {
    const t = runner({ platform: 'win32' });
    await prepared(t.r, 'r5');
    t.r.run({
      type: 'review.run',
      reviewId: 'r5',
      claude: { model: null, accountProfile: null },
      codex: { model: null, effort: null },
    });
    await waitUntil(() => t.sides.length === 2, 'two sides', 20_000);
    expect(t.sides.find((s) => s.agent === 'codex')).toMatchObject({
      status: 'skipped',
      error: expect.stringMatching(/^windows:/),
    });
    expect(t.sides.find((s) => s.agent === 'claude')).toMatchObject({ status: 'done' });

    const missing = new ReviewRunner({
      claudeBin: '/nonexistent/claude',
      codexBin: null,
      env: () => ({ PATH: '' }),
      send: (message, onResult) => {
        t.sides.push(message.side);
        onResult(true);
      },
    });
    await prepared(missing, 'r6');
    missing.run({
      type: 'review.run',
      reviewId: 'r6',
      claude: { model: null, accountProfile: null },
      codex: null,
    });
    await waitUntil(() => t.sides.length === 3, 'missing cli');
    expect(t.sides[2]).toMatchObject({ status: 'failed', error: 'claude CLI not found' });
  });

  it('W5：同時 2 份，再來的排隊（最多 2 份）、輪到才開 CLI；排不下的直接拒絕（沒開 CLI、不吃額度）', async () => {
    const t = runner({ timeoutMs: 1_200 });
    const ids = ['q1', 'q2', 'q3', 'q4', 'q5'];
    for (const id of ids) await prepared(t.r, id);
    for (const id of ids) {
      t.r.run({
        type: 'review.run',
        reviewId: id,
        claude: { model: 'fake-review-slow', accountProfile: null },
        codex: null,
      });
    }
    // 第 5 份馬上被拒絕；前 4 份之後各自逾時回報。
    await waitUntil(() => t.sides.length >= 1, 'busy');
    expect(t.sides[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^busy:/) });
    await waitUntil(() => t.sides.length === 5, 'all sides', 20_000);
    expect(t.sides.slice(1).every((s) => s.status === 'timeout')).toBe(true);
    // 實際開過 CLI 的只有 4 次。
    expect(t.calls().filter((c) => c.cli === 'claude')).toHaveLength(4);
  });

  it('repo 有自己的 .codex hook 設定：Codex 那邊略過（codex exec 可能執行它們），Claude 照跑', async () => {
    const t = runner();
    const dir = await prepared(t.r, 'r8');
    mkdirSync(join(dir, '.codex'));
    writeFileSync(join(dir, '.codex', 'hooks.json'), '{}');
    t.r.run({
      type: 'review.run',
      reviewId: 'r8',
      claude: { model: null, accountProfile: null },
      codex: { model: null, effort: null },
    });
    await waitUntil(() => t.sides.length === 2, 'two sides', 20_000);
    expect(t.sides.find((s) => s.agent === 'codex')).toMatchObject({
      status: 'skipped',
      error: expect.stringMatching(/^project_codex_hooks:/),
    });
    expect(t.sides.find((s) => s.agent === 'claude')).toMatchObject({ status: 'done' });
  });

  it('取消：跑到一半的結束；斷線時的結果連回來再送（flush）', async () => {
    const t = runner();
    await prepared(t.r, 'r7');
    t.disconnect(true);
    t.r.run({
      type: 'review.run',
      reviewId: 'r7',
      claude: { model: null, accountProfile: null },
      codex: { model: 'fake-review-slow', effort: null },
    });
    await waitUntil(() => t.r.activeCount === 1, 'running');
    await new Promise((done) => setTimeout(done, 1_500));
    t.r.cancel('r7');
    await waitUntil(() => t.r.activeCount === 0, 'cancelled', 10_000);
    expect(t.sides).toEqual([]);
    t.disconnect(false);
    t.r.flush();
    expect(t.sides.map((s) => [s.agent, s.status, s.error]).sort()).toEqual([
      ['claude', 'done', null],
      ['codex', 'failed', 'cancelled'],
    ]);
    // 送到了就不再補送。
    t.r.flush();
    expect(t.sides).toHaveLength(2);
  });
});
