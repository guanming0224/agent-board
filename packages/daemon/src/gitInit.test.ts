// 一鍵 git init（CONTRACTS §24）：只在暫存資料夾建 repo，測完清掉。家目錄、暫存資料夾用參數假裝，不碰真的。
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GITIGNORE_LINES,
  GIT_INIT_COMMIT_MESSAGE,
  GIT_INIT_FALLBACK_EMAIL,
  GIT_INIT_FALLBACK_NAME,
} from '@agent-board/protocol';
import { excludeLine, gitInitFolder, isInside, tooBroadReason } from './gitInit';
import { gitEnv as cleanGitEnv } from './worktree';

let base: string;
let home: string;
let fakeTmp: string;
let gitEnv: Record<string, string | undefined>;

const gitOut = (dir: string, args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ab-gitinit-')));
  home = join(base, 'home');
  fakeTmp = join(base, 'faketmp');
  mkdirSync(home);
  mkdirSync(fakeTmp);
  // 讓 git 讀不到使用者的全域設定（身分、template），測試結果才固定。不改任何設定檔。
  gitEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
  };
  process.env.GIT_CONFIG_GLOBAL = join(base, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  // 暫存資料夾可能剛好在某個 repo 底下：不往 base 以上找。
  process.env.GIT_CEILING_DIRECTORIES = base;
  writeFileSync(join(base, 'gitconfig'), '');
});

afterEach(() => {
  for (const [key, value] of Object.entries(gitEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

const opts = () => ({ home, tmp: fakeTmp });

function project(name = 'proj'): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('gitInitFolder：成功', () => {
  it('git init（分支 main）、建 .gitignore、第一個 commit；沒設定身分只對這次用固定身分', async () => {
    const dir = project();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, '.env'), 'SECRET=sk-ant-demo-xyz');
    writeFileSync(join(dir, '.env.example'), 'SECRET=');
    writeFileSync(join(dir, '.npmrc'), '//registry/:_authToken=sk-ant-demo-npm');
    writeFileSync(join(dir, 'client_secret_1.json'), '{}');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'x.js'), '1');
    const result = await gitInitFolder(dir, opts());
    expect(result).toMatchObject({
      ok: true,
      path: dir,
      branch: 'main',
      gitignoreCreated: true,
      identity: 'fallback',
      skipped: [],
      skippedMore: 0,
    });
    if (!result.ok) return;
    // a.txt、.gitignore、.env.example（.env、.npmrc、client_secret、node_modules 被忽略）
    expect(result.files).toBe(3);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(
      `${DEFAULT_GITIGNORE_LINES.join('\n')}\n`,
    );
    expect(gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(gitOut(dir, ['log', '-1', '--format=%s|%an|%ae'])).toBe(
      `${GIT_INIT_COMMIT_MESSAGE}|${GIT_INIT_FALLBACK_NAME}|${GIT_INIT_FALLBACK_EMAIL}`,
    );
    expect(gitOut(dir, ['rev-parse', 'HEAD'])).toBe(result.commit);
    expect(gitOut(dir, ['ls-files']).split('\n').sort()).toEqual([
      '.env.example',
      '.gitignore',
      'a.txt',
    ]);
    // 身分只對單次指令：repo 與「全域」設定檔都沒有被寫入 user.*。
    expect(readFileSync(join(base, 'gitconfig'), 'utf8')).toBe('');
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toMatch(/\[user\]|Agent Board/);
    // 不設 remote。
    expect(gitOut(dir, ['remote'])).toBe('');
  });

  it('已有 .gitignore 不動；有設定身分就用使用者的', async () => {
    const dir = project();
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(dir, 'secret.txt'), 'x');
    writeFileSync(join(dir, 'keep.txt'), 'x');
    writeFileSync(
      join(base, 'gitconfig'),
      '[user]\n\tname = Demo User\n\temail = demo@example.com\n',
    );
    const result = await gitInitFolder(dir, opts());
    expect(result).toMatchObject({ ok: true, gitignoreCreated: false, identity: 'user', files: 2 });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('secret.txt\n');
    expect(gitOut(dir, ['log', '-1', '--format=%an|%ae'])).toBe('Demo User|demo@example.com');
    expect(gitOut(dir, ['ls-files']).split('\n').sort()).toEqual(['.gitignore', 'keep.txt']);
  });

  it('超過上限的檔案不 commit：寫進 .git/info/exclude、列在結果裡', async () => {
    const dir = project();
    writeFileSync(join(dir, 'small.txt'), 'x');
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'big #1 [x].bin'), '');
    truncateSync(join(dir, 'data', 'big #1 [x].bin'), 2048);
    const result = await gitInitFolder(dir, { ...opts(), maxFileBytes: 1024 });
    expect(result).toMatchObject({
      ok: true,
      skipped: [{ path: 'data/big #1 [x].bin', bytes: 2048 }],
      skippedMore: 0,
    });
    expect(gitOut(dir, ['ls-files']).split('\n').sort()).toEqual(['.gitignore', 'small.txt']);
    // 之後 add -A 也不會收進來（status 看不到它）。
    expect(gitOut(dir, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '/data/big \\#1 \\[x\\].bin',
    );
  });

  it('空資料夾也有第一個 commit（開 worktree 需要）；hook 設定不進版控', async () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.local.json'), '{}');
    const result = await gitInitFolder(dir, opts());
    expect(result).toMatchObject({ ok: true, files: 1 });
    expect(gitOut(dir, ['ls-files'])).toBe('.gitignore');
    // 能開 worktree。
    execFileSync('git', ['-C', dir, 'worktree', 'add', join(base, 'wt'), '-b', 'ab/x']);
    expect(gitOut(join(base, 'wt'), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('ab/x');
  });

  it('不跑任何 hook：使用者全域 core.hooksPath 與 init.templateDir 範本的 hook 都不執行', async () => {
    const dir = project();
    writeFileSync(join(dir, 'a.txt'), 'x');
    const marker = join(base, 'hook-ran');
    const hook = `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\n`;
    for (const hooksDir of [join(base, 'hooks'), join(base, 'tmpl', 'hooks')]) {
      mkdirSync(hooksDir, { recursive: true });
      for (const name of ['post-commit', 'pre-commit', 'reference-transaction', 'post-checkout']) {
        writeFileSync(join(hooksDir, name), hook);
        chmodSync(join(hooksDir, name), 0o755);
      }
    }
    writeFileSync(
      join(base, 'gitconfig'),
      `[core]\n\thooksPath = ${join(base, 'hooks').replaceAll('\\', '/')}\n[init]\n\ttemplateDir = ${join(base, 'tmpl').replaceAll('\\', '/')}\n`,
    );
    const result = await gitInitFolder(dir, opts());
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
    // 範本沒被複製；repo 自己的設定也沒有寫進 hooksPath。
    expect(existsSync(join(dir, '.git', 'hooks', 'post-commit'))).toBe(false);
    expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toMatch(/hooksPath|fsmonitor/);
  });

  it('`~/` 開頭展開成家目錄', async () => {
    project('tilde');
    const result = await gitInitFolder('~/tilde', opts());
    expect(result).toMatchObject({ ok: true, path: join(home, 'tilde') });
  });
});

describe('gitInitFolder：拒絕', () => {
  it('不是絕對路徑', async () => {
    expect(await gitInitFolder('relative/dir', opts())).toMatchObject({
      ok: false,
      code: 'not_absolute',
    });
  });

  it('資料夾不存在、是檔案', async () => {
    expect(await gitInitFolder(join(home, 'nope'), opts())).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    writeFileSync(join(home, 'file.txt'), 'x');
    expect(await gitInitFolder(join(home, 'file.txt'), opts())).toMatchObject({
      ok: false,
      code: 'not_directory',
    });
  });

  it('已經是 repo，或上層是 repo：不動', async () => {
    const outer = project('outer');
    execFileSync('git', ['-C', outer, 'init', '-q']);
    expect(await gitInitFolder(outer, opts())).toMatchObject({ ok: false, code: 'already_repo' });
    const inner = join(outer, 'sub', 'deeper');
    mkdirSync(inner, { recursive: true });
    const result = await gitInitFolder(inner, opts());
    expect(result).toMatchObject({ ok: false, code: 'already_repo' });
    expect(() => readFileSync(join(inner, '.gitignore'))).toThrow();
    expect(() => readFileSync(join(inner, '.git', 'HEAD'))).toThrow();
  });

  it('路徑在 .git 裡面：直接拒絕', async () => {
    const outer = project('outer2');
    execFileSync('git', ['-C', outer, 'init', '-q']);
    const inside = join(outer, '.git', 'objects');
    expect(await gitInitFolder(inside, opts())).toMatchObject({ ok: false, code: 'already_repo' });
  });

  it('git 判斷失敗但不是「不是 repo」（例如設定壞了、dubious ownership）：git_failed，不 init', async () => {
    const dir = project();
    writeFileSync(join(base, 'gitconfig'), '[core\n');
    const result = await gitInitFolder(dir, opts());
    expect(result).toMatchObject({ ok: false, code: 'git_failed' });
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('已經有（空的）.git：already_repo，而且不刪掉它', async () => {
    const dir = project();
    mkdirSync(join(dir, '.git'));
    expect(await gitInitFolder(dir, opts())).toMatchObject({ ok: false, code: 'already_repo' });
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('同一個資料夾同時按兩次：一個成功、另一個 busy（沒有做任何事）', async () => {
    const dir = project();
    writeFileSync(join(dir, 'a.txt'), 'x');
    const results = await Promise.all([gitInitFolder(dir, opts()), gitInitFolder(dir, opts())]);
    expect(results.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['busy', 'ok']);
    expect(gitOut(dir, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it.skipIf(process.platform === 'win32')(
    '超過上限的大檔名稱有換行（寫不進排除清單）：整次失敗並還原，不會 commit',
    async () => {
      const dir = project();
      writeFileSync(join(dir, 'ok.txt'), 'x');
      writeFileSync(join(dir, 'bad\nname.bin'), '');
      truncateSync(join(dir, 'bad\nname.bin'), 2048);
      const result = await gitInitFolder(dir, { ...opts(), maxFileBytes: 1024 });
      expect(result).toMatchObject({ ok: false, code: 'git_failed' });
      if (!result.ok) expect(result.message).toMatch(/line break/);
      expect(existsSync(join(dir, '.git'))).toBe(false);
      expect(existsSync(join(dir, '.gitignore'))).toBe(false);
    },
  );

  it('磁碟或網路碟的根目錄（掛載點）拒絕，裡面的資料夾可以；家目錄的隱藏資料夾、iCloud／CloudStorage 根目錄拒絕', async () => {
    const disk = join(base, 'disk');
    // 掛載的碟：disk 本身與裡面都在裝置 2，上層在裝置 1。
    const devOf = async (p: string) => (p === disk || p.startsWith(`${disk}${sep}`) ? 2 : 1);
    expect(await tooBroadReason(disk, { ...opts(), devOf })).toMatch(/disk or network drive/);
    expect(await tooBroadReason(join(disk, 'proj'), { ...opts(), devOf })).toBeNull();
    expect(await tooBroadReason(join(home, '.config'), opts())).toMatch(/hidden/);
    expect(await tooBroadReason(join(home, '.config', 'app'), opts())).toMatch(/hidden/);
    const lib = join(home, 'Library');
    expect(
      await tooBroadReason(join(lib, 'Mobile Documents', 'com~apple~CloudDocs'), opts()),
    ).toMatch(/iCloud/);
    expect(await tooBroadReason(join(lib, 'CloudStorage', 'GoogleDrive-x'), opts())).toMatch(
      /cloud storage/,
    );
    expect(
      await tooBroadReason(join(lib, 'CloudStorage', 'GoogleDrive-x', 'proj'), opts()),
    ).toBeNull();
  });

  it('家目錄、家目錄的上層、家目錄底下的 Desktop 等、暫存資料夾本身、根目錄', async () => {
    mkdirSync(join(home, 'Desktop'));
    mkdirSync(join(home, 'Desktop', 'proj'));
    for (const dir of [home, base, join(home, 'Desktop'), fakeTmp]) {
      const result = await gitInitFolder(dir, opts());
      expect(result, dir).toMatchObject({ ok: false, code: 'too_broad' });
    }
    expect(await tooBroadReason('/', opts())).toMatch(/root/);
    expect(await tooBroadReason('/usr', { ...opts(), platform: 'linux' })).toMatch(/system/);
    expect(await tooBroadReason('C:\\', { ...opts(), platform: 'win32' })).toMatch(/root/);
    expect(await tooBroadReason('C:\\Program Files', { ...opts(), platform: 'win32' })).toMatch(
      /system/,
    );
    // Desktop 底下的專案資料夾可以。
    expect(await tooBroadReason(join(home, 'Desktop', 'proj'), opts())).toBeNull();
    expect(() => readFileSync(join(home, '.gitignore'))).toThrow();
  });
});

describe('小工具', () => {
  it('excludeLine 跳脫萬用字元與開頭符號，換行的檔名不寫', () => {
    expect(excludeLine('a/b*.bin')).toBe('/a/b\\*.bin');
    expect(excludeLine('!x')).toBe('/\\!x');
    expect(excludeLine('trail  ')).toBe('/trail\\ \\ ');
    expect(excludeLine('a\nb')).toBeNull();
  });

  it('git 的環境變數拿掉 GIT_DIR／GIT_WORK_TREE／GIT_INDEX_FILE，不會被帶到別的 repo', () => {
    const env = cleanGitEnv({
      PATH: '/bin',
      GIT_DIR: '/x/.git',
      GIT_WORK_TREE: '/x',
      GIT_INDEX_FILE: '/x/i',
    });
    expect(env).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0' });
  });

  it('isInside：同一個或子資料夾；Windows 不分大小寫', () => {
    expect(isInside('/a/b', '/a', 'linux')).toBe(true);
    expect(isInside('/a', '/a', 'linux')).toBe(true);
    expect(isInside('/ab', '/a', 'linux')).toBe(false);
    expect(isInside('C:\\Work\\Proj\\sub', 'c:\\work\\proj', 'win32')).toBe(true);
  });
});
