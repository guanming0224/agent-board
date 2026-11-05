// 封存與刪除（CONTRACTS §9）：用暫存資料夾真跑 git，不碰 ~/.claude。
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SessionLocator } from '@agent-board/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  findTranscriptFiles,
  inspectSession,
  purgeSession,
  removeHookEntries,
} from './sessionFiles';
import { makeTempDir } from './test-support/harness';
import {
  entriesOfLine,
  MAX_LINE_CHARS,
  MAX_TEXT,
  readTranscript,
  TranscriptTimeoutError,
  truncate,
} from './transcript';
import { createWorktree } from './worktree';

const CLAUDE_ID = '0a1b2c3d-1111-2222-3333-444455556666';

const temps: string[] = [];
function temp(): string {
  const dir = makeTempDir();
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 不吃使用者的全域 git 設定：例如全域 ignore 了 .claude/settings.local.json，
// 未追蹤檔就不會擋 `git worktree remove`，結果會隨機器不同。
const savedEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
let gitHome = '';
beforeAll(() => {
  gitHome = makeTempDir();
  writeFileSync(join(gitHome, 'gitconfig'), '');
  process.env.GIT_CONFIG_GLOBAL = join(gitHome, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.XDG_CONFIG_HOME = gitHome;
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(gitHome, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

function makeRepo(): string {
  const repo = join(temp(), 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a');
  // 跟真的專案一樣，Claude Code 的本機設定不進版控。
  writeFileSync(join(repo, '.gitignore'), '');
  git(repo, 'init', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  return repo;
}

const locator = (over: Partial<SessionLocator> = {}): SessionLocator => ({
  sessionId: 's1',
  cwd: '/nowhere',
  worktreePath: null,
  branch: null,
  claudeSessionId: CLAUDE_ID,
  accountProfile: null,
  ...over,
});

const none = { removeWorktree: false, removeTranscript: false, removeHooks: false };

/** 假的 Claude 設定資料夾：projects/<編碼過的路徑>/<id>.jsonl 加同名資料夾。 */
function makeConfig(lines: object[] = [], project = '-Users-x-repo'): string {
  const config = temp();
  const dir = join(config, 'projects', project);
  mkdirSync(join(dir, CLAUDE_ID, 'subagents'), { recursive: true });
  writeFileSync(join(dir, `${CLAUDE_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  writeFileSync(join(dir, CLAUDE_ID, 'subagents', 'x.jsonl'), '12345');
  // 別的對話不能被動到。
  writeFileSync(join(dir, 'other-0000-1111.jsonl'), 'keep');
  return config;
}

describe('transcript 解析', () => {
  const at = '2026-11-05T01:02:03.456Z';

  it('字串 content、text／tool_use／tool_result block 各自成則；isMeta 與其他 type 略過', () => {
    expect(
      entriesOfLine(JSON.stringify({ type: 'user', timestamp: at, message: { content: 'hi' } })),
    ).toEqual([{ role: 'user', at, text: 'hi' }]);
    const assistant = {
      type: 'assistant',
      timestamp: at,
      message: {
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: '好的' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    expect(entriesOfLine(JSON.stringify(assistant))).toEqual([
      { role: 'assistant', at, text: '好的' },
      { role: 'tool', at, text: '→ Bash {"command":"ls"}' },
    ]);
    const result = {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: [{ type: 'text', text: 'out' }, { type: 'image' }] },
          { type: 'tool_result', content: 'plain' },
          { type: 'text', text: 'and you?' },
        ],
      },
    };
    expect(entriesOfLine(JSON.stringify(result))).toEqual([
      { role: 'tool', at: null, text: 'out' },
      { role: 'tool', at: null, text: 'plain' },
      { role: 'user', at: null, text: 'and you?' },
    ]);
    expect(
      entriesOfLine(JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' } })),
    ).toEqual([]);
    expect(entriesOfLine(JSON.stringify({ type: 'summary', summary: 'x' }))).toEqual([]);
    expect(entriesOfLine(JSON.stringify({ type: 'system', content: 'x' }))).toEqual([]);
    expect(entriesOfLine('{broken')).toEqual([]);
    expect(entriesOfLine('null')).toEqual([]);
    // 時間格式不對就是 null；空白訊息略過。
    expect(
      entriesOfLine(
        JSON.stringify({ type: 'user', timestamp: 'yesterday', message: { content: 'x' } }),
      ),
    ).toEqual([{ role: 'user', at: null, text: 'x' }]);
    expect(entriesOfLine(JSON.stringify({ type: 'user', message: { content: '  ' } }))).toEqual([]);
  });

  it('截斷：一般 4000、tool 1000，加 …；tool_use 參數只取前 300 字；不切開 surrogate pair', async () => {
    const config = makeConfig([
      { type: 'user', message: { content: 'x'.repeat(5000) } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'y'.repeat(5000) }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { c: 'z'.repeat(1000) } }] },
      },
    ]);
    const page = await readTranscript(config, CLAUDE_ID, { cursor: 0, limit: 100, query: null });
    expect(page.entries.map((e) => e.text.length)).toEqual([MAX_TEXT + 1, 1001, 309]);
    expect(page.entries[0]?.text.endsWith('…')).toBe(true);
    expect(page.entries[2]?.text.startsWith('→ Write {"c":"zzz')).toBe(true);
    expect(truncate('ab😀', 3)).toBe('ab…');
  });

  it('分頁、搜尋（不分大小寫、保留原 index、matched）、空白行與爛行略過', async () => {
    const lines: object[] = [];
    for (let i = 0; i < 25; i += 1) {
      lines.push({
        type: i % 2 ? 'assistant' : 'user',
        message: { content: `msg ${i} ${i % 5 === 0 ? 'Needle' : ''}` },
      });
    }
    const config = makeConfig(lines);
    const file = join(config, 'projects', '-Users-x-repo', `${CLAUDE_ID}.jsonl`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n\n{oops\n`);

    const first = await readTranscript(config, CLAUDE_ID, { cursor: 0, limit: 10, query: null });
    expect(first).toMatchObject({ total: 25, matched: null, nextCursor: 10, missing: false });
    expect(first.entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(first.entries[1]?.role).toBe('assistant');
    const last = await readTranscript(config, CLAUDE_ID, { cursor: 20, limit: 10, query: null });
    expect(last.entries.map((e) => e.index)).toEqual([20, 21, 22, 23, 24]);
    expect(last.nextCursor).toBeNull();

    const search = await readTranscript(config, CLAUDE_ID, {
      cursor: 0,
      limit: 2,
      query: 'needle',
    });
    expect(search).toMatchObject({ total: 25, matched: 5, nextCursor: 2 });
    expect(search.entries.map((e) => e.index)).toEqual([0, 5]);
    const more = await readTranscript(config, CLAUDE_ID, { cursor: 4, limit: 2, query: 'NEEDLE' });
    expect(more.entries.map((e) => e.index)).toEqual([20]);
    expect(more.nextCursor).toBeNull();
  });

  it('找不到檔案、沒有 projects、id 格式不對都是 missing', async () => {
    const missing = { entries: [], total: 0, matched: null, nextCursor: null, missing: true };
    const config = makeConfig();
    const q = { cursor: 0, limit: 10, query: null };
    expect(await readTranscript(config, 'ffffffff-0000', q)).toEqual(missing);
    expect(await readTranscript(temp(), CLAUDE_ID, q)).toEqual(missing);
    expect(await readTranscript(config, '../../etc/passwd', q)).toEqual(missing);
    expect(await findTranscriptFiles(config, '..')).toEqual({ jsonl: [], dirs: [] });
  });

  it('搜尋 tool_use 比對完整參數（顯示只到前 300 字）', async () => {
    const config = makeConfig([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { content: `${'a'.repeat(500)}DeepNeedle` } },
          ],
        },
      },
    ]);
    const page = await readTranscript(config, CLAUDE_ID, {
      cursor: 0,
      limit: 10,
      query: 'deepneedle',
    });
    expect(page.matched).toBe(1);
    expect(page.entries[0]?.text).not.toContain('DeepNeedle');
  });

  it('超過 8MB 的行與沒有 user／assistant 的行跳過', async () => {
    const config = makeConfig();
    const file = join(config, 'projects', '-Users-x-repo', `${CLAUDE_ID}.jsonl`);
    const huge = JSON.stringify({ type: 'user', message: { content: 'h'.repeat(MAX_LINE_CHARS) } });
    const spaced = '{"type": "user", "message": {"content": "spaced"}}';
    const ok = JSON.stringify({ type: 'user', message: { content: 'ok' } });
    writeFileSync(file, [huge, spaced, ok].join('\n'));
    const page = await readTranscript(config, CLAUDE_ID, { cursor: 0, limit: 10, query: null });
    expect(page.entries.map((e) => e.text)).toEqual(['ok']);
  });

  it('deadline 到了就停；同時只讀一份，排隊的時間也算進 deadline', async () => {
    const config = makeConfig();
    const file = join(config, 'projects', '-Users-x-repo', `${CLAUDE_ID}.jsonl`);
    const line = JSON.stringify({ type: 'user', message: { content: 'p'.repeat(2000) } });
    writeFileSync(file, `${line}\n`.repeat(20_000)); // 約 40MB
    const q = { cursor: 0, limit: 5, query: null };
    await expect(readTranscript(config, CLAUDE_ID, q, 5)).rejects.toThrow(TranscriptTimeoutError);
    // 第一份讀完前第二份不會開始；第二份的 deadline 比第一份要花的時間短 → 逾時。
    const first = readTranscript(config, CLAUDE_ID, q);
    const second = readTranscript(config, CLAUDE_ID, q, 30);
    await expect(second).rejects.toThrow(TranscriptTimeoutError);
    expect((await first).total).toBe(20_000);
  });

  it('讀得了大檔（逐行串流）', async () => {
    const config = makeConfig();
    const file = join(config, 'projects', '-Users-x-repo', `${CLAUDE_ID}.jsonl`);
    const line = JSON.stringify({ type: 'user', message: { content: 'p'.repeat(2000) } });
    writeFileSync(file, `${line}\n`.repeat(10_000)); // 約 20MB
    const page = await readTranscript(config, CLAUDE_ID, { cursor: 9_998, limit: 5, query: null });
    expect(page.total).toBe(10_000);
    expect(page.entries.map((e) => e.index)).toEqual([9_998, 9_999]);
  });
});

describe('accountProfile 要是絕對路徑', () => {
  it('相對路徑：inspect、purge、transcript 都拒絕，什麼都不刪', async () => {
    const config = makeConfig();
    const bad = locator({ accountProfile: 'relative/.claude' });
    await expect(inspectSession(bad, config)).rejects.toThrow('absolute');
    await expect(purgeSession(bad, { ...none, removeTranscript: true }, config)).rejects.toThrow(
      'absolute',
    );
    expect((await findTranscriptFiles(config, CLAUDE_ID)).jsonl).toHaveLength(1);
    // 不碰對話紀錄的清理不檢查 accountProfile。
    const hooksOnly = await purgeSession(bad, { ...none, removeHooks: true }, config);
    expect(hooksOnly.hooks.status).toBe('not_found');
  });
});

describe('inspect', () => {
  it('對話大小含同名資料夾；不是 git 時 git 為 null；沒有 claude id 時大小為 null', async () => {
    const config = makeConfig([{ type: 'user', message: { content: 'hi' } }]);
    const jsonl = statSync(join(config, 'projects', '-Users-x-repo', `${CLAUDE_ID}.jsonl`)).size;
    const dir = temp();
    expect(await inspectSession(locator({ cwd: dir }), config)).toEqual({
      transcriptBytes: jsonl + 5,
      git: null,
      worktreeExists: false,
    });
    // accountProfile 優先於預設設定資料夾。
    const other = await inspectSession(locator({ cwd: dir, accountProfile: temp() }), config);
    expect(other.transcriptBytes).toBeNull();
    const noId = await inspectSession(locator({ cwd: dir, claudeSessionId: null }), config);
    expect(noId.transcriptBytes).toBeNull();
    expect((await inspectSession(locator({ cwd: join(dir, 'gone') }), config)).git).toBeNull();
  });

  it('dirty、unpushed（沒 upstream 是 null）、主 repo 不算 unmerged', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a.txt'), 'changed');
    writeFileSync(join(repo, 'new.txt'), 'n');
    const result = await inspectSession(locator({ cwd: repo }), temp());
    expect(result.git).toEqual({
      dir: repo,
      dirtyFiles: 2,
      unpushedCommits: null,
      branch: 'main',
      unmergedCommits: null,
    });

    // 有 upstream：clone 一份再多一個 commit。
    const clone = join(temp(), 'clone');
    execFileSync('git', ['clone', '-q', repo, clone]);
    writeFileSync(join(clone, 'b.txt'), 'b');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'b');
    const cloned = await inspectSession(locator({ cwd: clone }), temp());
    expect(cloned.git).toMatchObject({ dirtyFiles: 0, unpushedCommits: 1 });
  });

  it('worktree：unmerged 是分支有、主 worktree HEAD 沒有的 commit 數', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'feat', 'sessA');
    const target = locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch });
    expect((await inspectSession(target, temp())).git).toMatchObject({
      dir: wt.worktreePath,
      branch: wt.branch,
      unmergedCommits: 0,
    });
    writeFileSync(join(wt.cwd, 'f.txt'), 'f');
    git(wt.cwd, 'add', '.');
    git(wt.cwd, 'commit', '-m', 'f1');
    writeFileSync(join(wt.cwd, 'g.txt'), 'g');
    git(wt.cwd, 'add', '.');
    git(wt.cwd, 'commit', '-m', 'f2');
    const result = await inspectSession(target, temp());
    expect(result.worktreeExists).toBe(true);
    expect(result.git).toMatchObject({ dirtyFiles: 0, unmergedCommits: 2 });
  });
});

describe('purge', () => {
  it('沒勾的都是 skipped，什麼都不動', async () => {
    const config = makeConfig();
    const result = await purgeSession(locator(), none, config);
    const skipped = { status: 'skipped', detail: null };
    expect(result).toEqual({ worktree: skipped, transcript: skipped, hooks: skipped });
    expect((await findTranscriptFiles(config, CLAUDE_ID)).jsonl).toHaveLength(1);
  });

  it('transcript：刪 jsonl 與同名資料夾，不動別的對話；再刪一次是 not_found', async () => {
    const config = makeConfig();
    const project = join(config, 'projects', '-Users-x-repo');
    const opts = { ...none, removeTranscript: true };
    expect((await purgeSession(locator(), opts, config)).transcript).toEqual({
      status: 'removed',
      detail: null,
    });
    expect(existsSync(join(project, `${CLAUDE_ID}.jsonl`))).toBe(false);
    expect(existsSync(join(project, CLAUDE_ID))).toBe(false);
    expect(readFileSync(join(project, 'other-0000-1111.jsonl'), 'utf8')).toBe('keep');
    expect((await purgeSession(locator(), opts, config)).transcript.status).toBe('not_found');
    expect(
      (await purgeSession(locator({ claudeSessionId: null }), opts, config)).transcript.status,
    ).toBe('not_found');
  });

  it('worktree：乾淨且分支已合併 → 都刪；沒有 worktree → not_found', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'clean', 'sessB');
    const target = locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch });
    const opts = { ...none, removeWorktree: true };
    expect((await purgeSession(target, opts, temp())).worktree).toEqual({
      status: 'removed',
      detail: null,
    });
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(git(repo, 'branch', '--list', wt.branch)).toBe('');
    expect((await purgeSession(locator(), opts, temp())).worktree.status).toBe('not_found');
    expect((await purgeSession(target, opts, temp())).worktree.status).toBe('not_found');
  });

  it('worktree 有改動 → kept，檔案原封不動', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'dirty', 'sessC');
    writeFileSync(join(wt.cwd, 'work.txt'), 'precious');
    const target = locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch });
    const result = await purgeSession(target, { ...none, removeWorktree: true }, temp());
    expect(result.worktree.status).toBe('kept');
    expect(result.worktree.detail).toContain('改動');
    expect(readFileSync(join(wt.cwd, 'work.txt'), 'utf8')).toBe('precious');
    expect(git(repo, 'branch', '--list', wt.branch)).toContain(wt.branch);
  });

  it('分支沒合併 → worktree 刪了、分支留著並說明', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'feat', 'sessD');
    writeFileSync(join(wt.cwd, 'f.txt'), 'f');
    git(wt.cwd, 'add', '.');
    git(wt.cwd, 'commit', '-m', 'f');
    const target = locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch });
    const result = await purgeSession(target, { ...none, removeWorktree: true }, temp());
    expect(result.worktree).toEqual({
      status: 'removed',
      detail: `分支 ${wt.branch} 沒合併，保留`,
    });
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(git(repo, 'branch', '--list', wt.branch)).toContain(wt.branch);
  });

  it('不是 Agent Board 建的 worktree、或是主 worktree，一律不動', async () => {
    const repo = makeRepo();
    const own = join(temp(), 'my-wt');
    git(repo, 'worktree', 'add', own, '-b', 'mine');
    const opts = { ...none, removeWorktree: true };
    const theirs = await purgeSession(
      locator({ cwd: own, worktreePath: own, branch: 'mine' }),
      opts,
      temp(),
    );
    expect(theirs.worktree.status).toBe('kept');
    expect(existsSync(own)).toBe(true);
    const main = await purgeSession(locator({ cwd: repo, worktreePath: repo }), opts, temp());
    expect(main.worktree.status).toBe('kept');
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
  });

  it('只勾 worktree：worktree 裡我們寫的 hook 設定照樣先拿掉，乾淨的 worktree → removed', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'x.txt'), 'x');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'sub');
    const wt = await createWorktree(join(repo, 'sub'), 'only-wt', 'sessF');
    expect(wt.cwd).toBe(join(wt.worktreePath, 'sub'));
    const ours = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] },
    });
    mkdirSync(join(wt.cwd, '.claude'));
    writeFileSync(join(wt.cwd, '.claude', 'settings.local.json'), ours);
    const target = locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch });
    const result = await purgeSession(target, { ...none, removeWorktree: true }, temp());
    expect(result.worktree).toEqual({ status: 'removed', detail: null });
    expect(result.hooks).toEqual({ status: 'skipped', detail: null });
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  it('只勾 worktree：設定檔裡還有使用者的設定、或有別的改動 → kept，hook 設定也不動', async () => {
    const repo = makeRepo();
    const ours = { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] };
    const mixed = await createWorktree(repo, 'mixed', 'sessG');
    const mixedFile = join(mixed.cwd, '.claude', 'settings.local.json');
    mkdirSync(join(mixed.cwd, '.claude'));
    const mixedText = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: ours });
    writeFileSync(mixedFile, mixedText);
    const target = (wt: typeof mixed) =>
      locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch });
    const opts = { ...none, removeWorktree: true };
    const result = await purgeSession(target(mixed), opts, temp());
    expect(result.worktree.status).toBe('kept');
    expect(readFileSync(mixedFile, 'utf8')).toBe(mixedText);

    // 只有我們的設定，但另外有沒 commit 的檔案：不移除，所以 hook 設定也留著。
    const dirty = await createWorktree(repo, 'dirty-hooks', 'sessH');
    const dirtyFile = join(dirty.cwd, '.claude', 'settings.local.json');
    mkdirSync(join(dirty.cwd, '.claude'));
    writeFileSync(dirtyFile, JSON.stringify({ hooks: ours }));
    writeFileSync(join(dirty.cwd, 'work.txt'), 'precious');
    const kept = await purgeSession(target(dirty), opts, temp());
    expect(kept.worktree).toEqual({ status: 'kept', detail: 'worktree 有改動，保留（1 個檔案）' });
    expect(JSON.parse(readFileSync(dirtyFile, 'utf8'))).toEqual({ hooks: ours });
  });

  it('worktree 身分檢查：.. 路徑、符號連結、相對路徑、不在清單、分支不符 → kept', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'ident', 'sessI');
    const opts = { ...none, removeWorktree: true };
    const status = async (over: Partial<SessionLocator>) =>
      (
        await purgeSession(
          locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch, ...over }),
          opts,
          temp(),
        )
      ).worktree;
    const wtParent = join(wt.worktreePath, '..');
    // 經過 .. 的路徑（解析後是同一個 worktree）。
    expect(
      await status({ worktreePath: `${wtParent}/../.agent-board-wt/ident-sessI` }),
    ).toMatchObject({
      status: 'kept',
    });
    // 經過符號連結。
    const link = join(temp(), 'link-to-wt');
    symlinkSync(wt.worktreePath, link);
    expect(await status({ worktreePath: link })).toMatchObject({ status: 'kept' });
    // 相對路徑。
    expect(await status({ worktreePath: '.agent-board-wt/ident-sessI' })).toMatchObject({
      status: 'kept',
    });
    // 分支跟紀錄不符、或不是 ab/ 分支。
    expect(await status({ branch: 'ab/other' })).toMatchObject({ status: 'kept' });
    expect(await status({ branch: 'main' })).toMatchObject({ status: 'kept' });
    expect(await status({ branch: null })).toMatchObject({ status: 'kept' });
    // 在 .agent-board-wt 底下，但不是 git 登記的 worktree（只是一個資料夾）。
    const fake = join(wtParent, 'not-a-worktree');
    mkdirSync(fake);
    expect(await status({ worktreePath: fake, cwd: fake, branch: 'ab/x' })).toMatchObject({
      status: 'kept',
    });
    expect(existsSync(fake)).toBe(true);
    // 都沒動到；最後用正確的資訊才移除。
    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(await status({})).toEqual({ status: 'removed', detail: null });
  });

  it('hook 與 worktree 一起勾：先拿掉 hook 設定，worktree 才移得掉', async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, 'hooked', 'sessE');
    mkdirSync(join(wt.cwd, '.claude'));
    writeFileSync(
      join(wt.cwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] },
      }),
    );
    const target = locator({ cwd: wt.cwd, worktreePath: wt.worktreePath, branch: wt.branch });
    const result = await purgeSession(
      target,
      { ...none, removeWorktree: true, removeHooks: true },
      temp(),
    );
    expect(result.hooks.status).toBe('removed');
    expect(result.worktree).toEqual({ status: 'removed', detail: null });
    expect(existsSync(wt.worktreePath)).toBe(false);
  });
});

describe('hook 設定移除', () => {
  const settingsPath = (cwd: string) => join(cwd, '.claude', 'settings.local.json');
  const writeSettings = (cwd: string, value: unknown) => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settingsPath(cwd), typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('只拿掉 agent-board-hook 的項目，其他設定與別人的 hook 原樣保留', async () => {
    const cwd = temp();
    writeSettings(cwd, {
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'agent-board-hook PreToolUse', timeout: 600 },
              { type: 'command', command: 'my-linter' },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'agent-board-hooker' }] }],
        Weird: 'not an array',
      },
    });
    chmodSync(settingsPath(cwd), 0o600);
    expect(await removeHookEntries(cwd)).toEqual({ status: 'removed', detail: null });
    expect(JSON.parse(readFileSync(settingsPath(cwd), 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'agent-board-hooker' }] }],
        Weird: 'not an array',
      },
    });
    // 檔案權限維持。
    expect(statSync(settingsPath(cwd)).mode & 0o777).toBe(0o600);
    // 再一次就沒東西可拿。
    expect((await removeHookEntries(cwd)).status).toBe('not_found');
  });

  it('只剩我們的設定：拿完刪檔，.claude 空了也收掉；沒有檔案是 not_found', async () => {
    const cwd = temp();
    expect((await removeHookEntries(cwd)).status).toBe('not_found');
    writeSettings(cwd, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] },
    });
    expect((await removeHookEntries(cwd)).status).toBe('removed');
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  it('壞 JSON、最外層不是物件、hooks 不是物件 → failed，檔案不動', async () => {
    for (const bad of ['{"hooks": [', '[]', '{"hooks": 3}']) {
      const cwd = temp();
      writeSettings(cwd, bad);
      const result = await removeHookEntries(cwd);
      expect(result.status, bad).toBe('failed');
      expect(result.detail).not.toBeNull();
      expect(readFileSync(settingsPath(cwd), 'utf8')).toBe(bad);
    }
  });

  it('cwd 經過符號連結（設定檔本身不是）：照樣刪檔', async () => {
    const real = temp();
    writeSettings(real, {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] },
    });
    const viaLink = join(temp(), 'cwd-link');
    symlinkSync(real, viaLink);
    expect((await removeHookEntries(viaLink)).status).toBe('removed');
    expect(existsSync(settingsPath(real))).toBe(false);
    expect(existsSync(join(real, '.claude'))).toBe(false);
  });

  it('設定檔是 symlink：改的是它指向的檔案，連結保留', async () => {
    const cwd = temp();
    const real = join(temp(), 'shared.json');
    writeFileSync(
      real,
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] },
      }),
    );
    mkdirSync(join(cwd, '.claude'));
    symlinkSync(real, settingsPath(cwd));
    expect((await removeHookEntries(cwd)).status).toBe('removed');
    expect(JSON.parse(readFileSync(settingsPath(cwd), 'utf8'))).toEqual({});
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({});
  });
});
