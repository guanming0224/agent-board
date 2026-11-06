import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, normalizeHubUrl } from './config';
import { listDirectory, makeDirectory } from './fsList';
import { parseNvidiaSmi, ResourceMonitor } from './resources';
import { buildClaudeArgs, inputBoxVisible, screenFingerprint, withoutPromptBox } from './session';
import { SessionStore, type PersistedSession } from './store';
import { makeTempDir, waitUntil } from './test-support/harness';
import { summarizeUsage } from './usage';
import { createWorktree, currentBranch, makeSlug, removeWorktree, repoInfo } from './worktree';
import type { DaemonToHub } from '@agent-board/protocol';

const temps: string[] = [];
function temp(): string {
  const dir = makeTempDir();
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config', () => {
  it('轉換 hub 網址，缺路徑補 /ws/daemon', () => {
    expect(normalizeHubUrl('http://host:8787')).toBe('ws://host:8787/ws/daemon');
    expect(normalizeHubUrl('https://host.ts.net/')).toBe('wss://host.ts.net/ws/daemon');
    expect(normalizeHubUrl('ws://h:1/ws/daemon')).toBe('ws://h:1/ws/daemon');
    expect(() => normalizeHubUrl('ftp://h')).toThrow('協定');
  });

  it('必要變數缺少就報錯；可覆寫項目生效', () => {
    const AGENT_BOARD_DATA_DIR = temp(); // 不碰 ~/.agent-board
    expect(() => loadConfig({ AGENT_BOARD_DATA_DIR })).toThrow('AGENT_BOARD_HUB_URL');
    expect(() => loadConfig({ AGENT_BOARD_DATA_DIR, AGENT_BOARD_HUB_URL: 'http://h' })).toThrow(
      'AGENT_BOARD_MACHINE_TOKEN',
    );
    expect(
      loadConfig({
        AGENT_BOARD_DATA_DIR,
        AGENT_BOARD_HUB_URL: 'http://h',
        AGENT_BOARD_MACHINE_TOKEN: 't',
      }).hookBin,
    ).toBe('agent-board-hook');
    const config = loadConfig({
      AGENT_BOARD_HUB_URL: 'http://h',
      AGENT_BOARD_MACHINE_TOKEN: 't',
      AGENT_BOARD_HOOK_BIN: '/bin/agent-board-hook',
      AGENT_BOARD_DATA_DIR: '/d',
      AGENT_BOARD_CLAUDE_BIN: '/bin/c',
      CLAUDE_CONFIG_DIR: '/c',
    });
    expect(config).toMatchObject({
      dataDir: '/d',
      claudeBin: '/bin/c',
      hookBin: '/bin/agent-board-hook',
      claudeConfigDir: '/c',
    });
  });
});

describe('withoutPromptBox', () => {
  const box = ['────────────── real ─', '❯ git status', '──────', '  ⏵⏵ manual mode on'];

  it('切掉 claude 的輸入框與狀態列，留下對話', () => {
    expect(withoutPromptBox(['⏺ done', '', '✻ Brewed for 5s', '', ...box])).toEqual([
      '⏺ done',
      '',
      '✻ Brewed for 5s',
    ]);
  });

  it('權限對話框的 ❯ 上面不是橫線，選項要留著', () => {
    const dialog = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];
    expect(withoutPromptBox(dialog)).toEqual(dialog);
  });

  it('一般程式輸出原樣回傳', () => {
    expect(withoutPromptBox(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('inputBoxVisible（自動接續只在平常的輸入框出現時送）', () => {
  const box = ['────────────── real ─', '❯ ', '──────', '  ⏵⏵ manual mode on'];

  it('輸入框在最下面', () => {
    expect(inputBoxVisible(['⏺ You have hit your limit', '', ...box, '', ''])).toBe(true);
    expect(inputBoxVisible(['⏺ x', '───', '❯'])).toBe(true);
  });

  it('對話框（權限、額度選單）蓋住時不算', () => {
    expect(
      inputBoxVisible([
        'What do you want to do?',
        '',
        '❯ 1. Wait here, then continue automatically at 3pm',
        '  2. Upgrade your plan',
        'Enter to confirm · Esc to cancel',
      ]),
    ).toBe(false);
    // 選項上面剛好是一條橫線也不算。
    expect(
      inputBoxVisible(['────────', '❯ 1. Stop and wait for limit to reset', '  2. Upgrade']),
    ).toBe(false);
  });

  it('輸入框離底下太遠（舊畫面）或沒有橫線都不算', () => {
    expect(inputBoxVisible([...box, ...Array.from({ length: 10 }, (_, i) => `output ${i}`)])).toBe(
      false,
    );
    expect(inputBoxVisible(['some text', '❯ '])).toBe(false);
    expect(inputBoxVisible([])).toBe(false);
  });
});

describe('screenFingerprint', () => {
  const screen = (seconds: string, spinner: string, tip: string) => [
    '⏺ Bash(python3 -c "sleep")',
    `  ⎿  $ python3 -c "sleep" (${seconds})`,
    `${spinner} (${seconds} · ↓ 98 tokens)`,
    `  ⎿  Tip: ${tip}`,
  ];

  it('計時、spinner 文字、提示變了都不算進展（取自實測 2.1.316 的畫面）', () => {
    expect(screenFingerprint(screen('59s', '✳ Contemplating…', 'a'))).toBe(
      screenFingerprint(screen('1m 18s', '✽ Osmosing…', 'b')),
    );
  });

  it('提示輪換、長提示折行都不算進展', () => {
    const wrapped = [
      ...screen('5s', '✳ Thinking…', 'Control this session from the Claude'),
      '     app on your phone',
    ];
    expect(screenFingerprint(wrapped)).toBe(screenFingerprint(screen('6s', '✳ Thinking…', 'x')));
  });

  it('執行中工具行前的 ⏺ 閃爍、時間跨過一分鐘，都不算進展（實測 2.1.316）', () => {
    expect(screenFingerprint(['⏺ Sleeping 85 seconds via python · 59s'])).toBe(
      screenFingerprint(['  Sleeping 85 seconds via python · 1m 0s']),
    );
  });

  it('多了真的內容就算進展', () => {
    const before = screen('5s', '✳ Thinking…', 'a');
    expect(screenFingerprint(['⏺ done', ...before])).not.toBe(screenFingerprint(before));
  });
});

describe('buildClaudeArgs', () => {
  it('default 也明確帶 manual，否則 claude 會用使用者設定的預設模式；--resume 優先', () => {
    expect(
      buildClaudeArgs({ newSessionId: 'u', permissionMode: 'default', model: null, name: 'n' }),
    ).toEqual(['--session-id', 'u', '--permission-mode', 'manual', '--name', 'n']);
    expect(
      buildClaudeArgs({
        newSessionId: 'u',
        resumeId: 'r',
        permissionMode: 'plan',
        model: 'opus',
        name: 'n',
      }),
    ).toEqual(['--resume', 'r', '--permission-mode', 'plan', '--model', 'opus', '--name', 'n']);
  });

  it('唯讀：每個工具一個 argv，後面接著別的選項，可變長度參數才不會吞掉 --name', () => {
    const args = buildClaudeArgs({
      newSessionId: 'u',
      permissionMode: 'plan',
      model: null,
      name: 'n',
      readOnly: true,
    });
    expect(args).toEqual([
      '--session-id',
      'u',
      '--permission-mode',
      'plan',
      '--disallowedTools',
      'Edit',
      'Write',
      'NotebookEdit',
      '--name',
      'n',
    ]);
    expect(args[args.indexOf('NotebookEdit') + 1]?.startsWith('--')).toBe(true);
    expect(
      buildClaudeArgs({ permissionMode: 'default', model: null, name: 'n', readOnly: false }),
    ).not.toContain('--disallowedTools');
  });

  it('派工工具：--mcp-config 與 --allowedTools 只在給了 mcp 時才帶，後面一定接 --name', () => {
    const args = buildClaudeArgs({
      newSessionId: 'u',
      permissionMode: 'acceptEdits',
      model: null,
      name: 'n',
      mcp: { configPath: '/d/mcp/s.json', allowedTools: ['mcp__agent-board__list_members', 'x'] },
    });
    expect(args).toEqual([
      '--session-id',
      'u',
      '--permission-mode',
      'acceptEdits',
      '--mcp-config',
      '/d/mcp/s.json',
      '--allowedTools',
      'mcp__agent-board__list_members',
      'x',
      '--name',
      'n',
    ]);
    // 沒有 --strict-mcp-config：使用者自己的 MCP server 照常載入。
    expect(args).not.toContain('--strict-mcp-config');
    for (const mcp of [undefined, null]) {
      const plain = buildClaudeArgs({ permissionMode: 'default', model: null, name: 'n', mcp });
      expect(plain).not.toContain('--mcp-config');
      expect(plain).not.toContain('--allowedTools');
    }
  });
});

describe('SessionStore', () => {
  const entry = (sessionId: string): PersistedSession => ({
    sessionId,
    spec: {
      name: 'n',
      projectId: null,
      cwd: '/w',
      useWorktree: false,
      permissionMode: 'default',
      model: null,
      accountProfile: null,
      resumeClaudeSessionId: null,
      firstPrompt: null,
      readOnly: false,
    },
    claudeSessionId: 'c',
    cwd: '/w',
    branch: null,
    worktreePath: null,
    pendingFirstPrompt: null,
    createdAt: new Date().toISOString(),
  });

  it('endedRuntimes 跨重新載入保留；舊格式的檔案也讀得進來', () => {
    const dir = temp();
    const runtime = {
      id: 'a',
      cwd: '/w',
      branch: null,
      worktreePath: null,
      status: 'done' as const,
      statusDetail: null,
      claudeSessionId: 'c',
      lastLines: [],
      lastOutputAt: null,
      statusSince: new Date().toISOString(),
      contextTokens: null,
      contextWindow: null,
      repoRoot: null,
      repoCommonDir: null,
      endedAt: new Date().toISOString(),
    };
    const store = new SessionStore(dir);
    store.setEnded(runtime);
    expect(new SessionStore(dir).endedRuntimes).toEqual([runtime]);
    store.removeEnded('a');
    expect(new SessionStore(dir).endedRuntimes).toEqual([]);

    const old = temp();
    writeFileSync(
      join(old, 'sessions.json'),
      JSON.stringify({ version: 1, dangerRules: null, stuckMinutes: null, sessions: [] }),
    );
    const loaded = new SessionStore(old);
    expect(loaded.endedRuntimes).toEqual([]);
    // 舊檔沒有 dispatch：和 hub 預設一樣當開，升級後第一次接回的 session 才會掛上派工工具。
    expect(loaded.dispatch).toBe(true);
    expect(new SessionStore(temp()).dispatch).toBe(true);
    expect(readdirSync(old).some((name) => name.includes('corrupt'))).toBe(false);
  });

  it('寫入後重新載入內容相同；不留暫存檔', () => {
    const dir = temp();
    const store = new SessionStore(dir);
    store.upsert(entry('a'));
    store.upsert(entry('b'));
    store.patch('a', { claudeSessionId: 'new' });
    store.remove('b');
    store.setHubSettings(['x'], 3, true);
    const reloaded = new SessionStore(dir);
    expect(reloaded.sessions.map((s) => [s.sessionId, s.claudeSessionId])).toEqual([['a', 'new']]);
    expect(reloaded.dangerRules).toEqual(['x']);
    expect(reloaded.stuckMinutes).toBe(3);
    expect(reloaded.dispatch).toBe(true);
    expect(readdirSync(dir)).toEqual(['sessions.json']);
  });

  it('寫不進去時只記錄，不丟例外（正在跑的 session 不受影響）', () => {
    const dir = temp();
    const store = new SessionStore(dir);
    rmSync(dir, { recursive: true });
    expect(() => store.upsert(entry('a'))).not.toThrow();
    expect(store.sessions.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('壞檔不 crash，移到旁邊保留', () => {
    const dir = temp();
    writeFileSync(join(dir, 'sessions.json'), '{ broken');
    expect(new SessionStore(dir).sessions).toEqual([]);
    const aside = readdirSync(dir).find((name) => name.includes('corrupt'));
    expect(aside).toBeDefined();
    expect(readFileSync(join(dir, aside as string), 'utf8')).toBe('{ broken');
  });
});

describe('worktree', () => {
  function makeRepo(): string {
    const repo = join(temp(), '我的 repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'file.txt'), 'x');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        stdio: 'ignore',
      });
    git('init', '-b', 'main');
    git('add', '.');
    git('commit', '-m', 'init');
    return repo;
  }

  it('slug 處理中文、符號、過長名稱與路徑穿越', () => {
    expect(makeSlug('修 Bug #12!', 'abcd1234-ef')).toBe('修-bug-12-abcd1234');
    expect(makeSlug('../../etc', 'id')).toBe('etc-id');
    expect(makeSlug('!!!', 'id')).toBe('session-id');
    expect(makeSlug('a'.repeat(100), 'id').length).toBeLessThanOrEqual(43);
  });

  it('依合約建立 <repo>/../.agent-board-wt/<slug> 與 ab/<slug>，子資料夾位置對應', async () => {
    const repo = makeRepo();
    const info = await createWorktree(join(repo, 'sub'), 'feat', 'sess1');
    expect(info.worktreePath).toBe(join(repo, '..', '.agent-board-wt', 'feat-sess1'));
    expect(info.branch).toBe('ab/feat-sess1');
    expect(info.cwd).toBe(join(info.worktreePath, 'sub'));
    expect(readFileSync(join(info.cwd, 'file.txt'), 'utf8')).toBe('x');
    expect(await currentBranch(info.cwd)).toBe('ab/feat-sess1');

    await removeWorktree(info);
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(await currentBranch(repo)).toBe('main');
  });

  it('removeWorktree 不動有變更的 worktree', async () => {
    const repo = makeRepo();
    const info = await createWorktree(repo, 'keep', 'sess2');
    writeFileSync(join(info.cwd, 'new.txt'), 'data');
    await expect(removeWorktree(info)).rejects.toThrow();
    expect(readFileSync(join(info.cwd, 'new.txt'), 'utf8')).toBe('data');
  });

  it('不是 git repo 時報錯；currentBranch 回 null', async () => {
    const dir = temp();
    await expect(createWorktree(dir, 'x', 'y')).rejects.toThrow();
    expect(await currentBranch(dir)).toBeNull();
  });

  it('repoInfo：子資料夾回 repo 根目錄；linked worktree 有自己的根目錄、共用 commonDir；非 repo 回 null', async () => {
    const repo = makeRepo();
    const real = realpathSync(repo);
    const main = await repoInfo(join(repo, 'sub'));
    expect(main).toEqual({ root: real, commonDir: join(real, '.git') });

    const linked = await createWorktree(repo, 'wt', 'sess3');
    const other = await repoInfo(join(linked.worktreePath, 'sub'));
    expect(other?.root).toBe(realpathSync(linked.worktreePath));
    expect(other?.commonDir).toBe(main?.commonDir);

    expect(await repoInfo(temp())).toBeNull();
    expect(await repoInfo(join(temp(), 'missing'))).toBeNull();
  });
});

describe('fs.list', () => {
  it('列出資料夾、標 isGitRepo，資料夾排前面，符號連結跟隨', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'plain'));
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    writeFileSync(join(dir, 'a-file.txt'), '');
    symlinkSync(join(dir, 'repo'), join(dir, 'link'));
    symlinkSync(join(dir, 'missing'), join(dir, 'broken'));
    const result = await listDirectory('r1', dir);
    expect(result).toMatchObject({
      type: 'fs.listResult',
      requestId: 'r1',
      path: dir,
      repo: null,
      error: null,
    });
    expect(result.entries).toEqual([
      { name: 'link', isDir: true, isGitRepo: true },
      { name: 'plain', isDir: true, isGitRepo: false },
      { name: 'repo', isDir: true, isGitRepo: true },
      { name: 'a-file.txt', isDir: false, isGitRepo: false },
      { name: 'broken', isDir: false, isGitRepo: false },
    ]);
  });

  it('列的是 repo 裡的子資料夾：帶上 repo 根目錄（新 session 判斷同 repo 用）', async () => {
    const repo = temp();
    mkdirSync(join(repo, 'a', 'deep'), { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'ignore' });
    const result = await listDirectory('r2', join(repo, 'a'));
    const real = realpathSync(repo);
    expect(result.repo).toEqual({ root: real, commonDir: join(real, '.git') });
    expect(result.entries.map((e) => e.name)).toEqual(['deep']);
  });

  it('不存在的路徑回 error，不丟例外', async () => {
    const result = await listDirectory('r2', join(temp(), 'nope'));
    expect(result.entries).toEqual([]);
    expect(result.error).toContain('ENOENT');
  });

  it('../ 會先正規化，回傳的是實際路徑；只有名稱與類型，沒有檔案內容；NUL 不會讓 daemon 掛掉', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'secret.txt'), 'CONTENT_MARKER');
    const result = await listDirectory('r3', join(dir, 'a', '..', 'a', '..'));
    expect(result.path).toBe(dir);
    expect(JSON.stringify(result)).not.toContain('CONTENT_MARKER');
    expect(Object.keys(result.entries[0]!).sort()).toEqual(['isDir', 'isGitRepo', 'name']);

    const nul = await listDirectory('r4', `${dir}\0/x`);
    expect(nul.entries).toEqual([]);
    expect(nul.error).toBeTruthy();
    // 指向檔案：回錯誤，不是內容。
    const file = await listDirectory('r5', join(dir, 'secret.txt'));
    expect(file.entries).toEqual([]);
    expect(JSON.stringify(file)).not.toContain('CONTENT_MARKER');
  });
});

describe('fs.mkdir', () => {
  it('建一層新資料夾並回它的列表；已存在就回錯誤、不覆蓋', async () => {
    const dir = temp();
    const made = await makeDirectory('m1', dir, '記帳 App');
    expect(made).toMatchObject({
      type: 'fs.listResult',
      requestId: 'm1',
      path: join(dir, '記帳 App'),
      entries: [],
      error: null,
    });
    expect(statSync(join(dir, '記帳 App')).isDirectory()).toBe(true);

    writeFileSync(join(dir, '記帳 App', 'keep.txt'), 'x');
    const again = await makeDirectory('m2', dir, '記帳 App');
    expect(again.error).toContain('EEXIST');
    expect(readFileSync(join(dir, '記帳 App', 'keep.txt'), 'utf8')).toBe('x');
  });

  it('parent 不存在不會一路建上去；名稱跑出 parent 一律拒絕', async () => {
    const dir = temp();
    const missing = await makeDirectory('m3', join(dir, 'nope'), 'a');
    expect(missing.error).toContain('ENOENT');
    expect(existsSync(join(dir, 'nope'))).toBe(false);

    for (const name of ['..', '.', '../escape', 'a/b']) {
      const bad = await makeDirectory('m4', join(dir, 'p'), name);
      expect(bad.error, name).toBeTruthy();
    }
    expect(existsSync(join(dir, 'escape'))).toBe(false);
    expect(existsSync(join(dir, 'p'))).toBe(false);
  });
});

describe('usage', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  const to = new Date('2026-11-01T00:00:00Z');
  const line = (fields: Record<string, unknown>) => JSON.stringify(fields);

  it('彙總 usage、同一則回應不重複算、區間外不算、爛資料略過', async () => {
    const config = temp();
    const project = join(config, 'projects', 'p', 'nested');
    mkdirSync(project, { recursive: true });
    const inRange = '2026-10-15T00:00:00Z';
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    };
    writeFileSync(
      join(project, 'a.jsonl'),
      [
        line({ timestamp: inRange, requestId: 'r1', message: { id: 'm1', usage } }),
        // 串流的同一則回應，輸出變多：取最大，不相加。
        line({
          timestamp: inRange,
          requestId: 'r1',
          message: { id: 'm1', usage: { ...usage, output_tokens: 50 } },
        }),
        line({ timestamp: inRange, requestId: 'r2', message: { id: 'm2', usage } }),
        line({ timestamp: '2020-01-01T00:00:00Z', message: { id: 'old', usage } }),
        line({ timestamp: inRange, usage: { input_tokens: 1, output_tokens: 'x' } }),
        '{"usage": broken json',
        'plain garbage',
        line({ usage: null }),
        line({ type: 'user', message: { content: 'hello' } }),
        line({
          timestamp: inRange,
          message: { id: 'm3', usage: { input_tokens: -5, output_tokens: 1.5 } },
        }),
      ].join('\n'),
    );
    writeFileSync(join(project, 'ignored.txt'), line({ usage }));
    const summary = await summarizeUsage([config, join(config, 'missing')], from, to);
    expect(summary).toEqual({
      from: from.toISOString(),
      to: to.toISOString(),
      inputTokens: 21,
      outputTokens: 56,
      cacheReadTokens: 200,
      cacheCreationTokens: 40,
    });
  });

  it('比區間舊的檔案不讀；同一個資料夾列兩次不重複算', async () => {
    const config = temp();
    const project = join(config, 'projects', 'p');
    mkdirSync(project, { recursive: true });
    const usage = { input_tokens: 1 };
    const stale = join(project, 'stale.jsonl');
    writeFileSync(stale, line({ usage }));
    utimesSync(stale, new Date('2020-01-01'), new Date('2020-01-01'));
    writeFileSync(join(project, 'fresh.jsonl'), line({ usage }));
    const summary = await summarizeUsage([config, config], from, new Date());
    expect(summary.inputTokens).toBe(1);
  });

  it('設定資料夾不存在時回全 0', async () => {
    const summary = await summarizeUsage([join(temp(), 'none')], from, to);
    expect(summary.inputTokens + summary.outputTokens).toBe(0);
  });
});

describe('resources', () => {
  it('解析 nvidia-smi 輸出，壞資料回 null', () => {
    expect(parseNvidiaSmi('NVIDIA RTX 4090, 37, 1024, 24564\n')).toEqual({
      name: 'NVIDIA RTX 4090',
      utilizationPercent: 37,
      memoryUsedBytes: 1024 * 1024 * 1024,
      memoryTotalBytes: 24564 * 1024 * 1024,
    });
    expect(parseNvidiaSmi('')).toBeNull();
    expect(parseNvidiaSmi('name, [N/A], 1, 2')).toBeNull();
  });

  it('只在 watching 時回報，GPU 與 CPU 週期分開；關掉就停', async () => {
    const sent: DaemonToHub[] = [];
    let cpuCalls = 0;
    let gpuCalls = 0;
    const monitor = new ResourceMonitor({
      send: (message) => sent.push(message),
      sampleCpuMem: async () => {
        cpuCalls += 1;
        return { cpuPercent: 12, memoryUsedBytes: 1, memoryTotalBytes: 2 };
      },
      sampleGpu: async () => {
        gpuCalls += 1;
        return {
          name: 'G',
          utilizationPercent: 1,
          memoryUsedBytes: 1,
          memoryTotalBytes: 2,
        };
      },
      cpuIntervalMs: 10,
      gpuIntervalMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sent).toEqual([]);

    monitor.setWatching(true);
    monitor.setWatching(true); // 重複打開不會多開計時器
    await waitUntil(() => sent.length >= 8, '多筆樣本');
    const cpuBefore = cpuCalls;
    monitor.setWatching(false);
    expect(gpuCalls).toBeLessThan(cpuBefore);
    expect(sent[0]).toMatchObject({
      type: 'resources',
      sample: { cpuPercent: 12, gpu: { name: 'G' } },
    });

    const count = sent.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent.length).toBe(count);
  });

  it('取樣失敗不會 crash，下一輪繼續', async () => {
    const sent: DaemonToHub[] = [];
    let calls = 0;
    const monitor = new ResourceMonitor({
      send: (message) => sent.push(message),
      sampleCpuMem: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { cpuPercent: 1, memoryUsedBytes: 1, memoryTotalBytes: 1 };
      },
      sampleGpu: async () => {
        throw new Error('no gpu');
      },
      cpuIntervalMs: 10,
    });
    monitor.setWatching(true);
    await waitUntil(() => sent.length > 0, '第二輪成功');
    monitor.stop();
    expect(sent[0]).toMatchObject({ sample: { gpu: null } });
  });
});
