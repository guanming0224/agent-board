// Windows 安裝路徑（CONTRACTS §21.2、§21.10）：current／app 的 junction、檔案被鎖住時清舊版、hook 的 .cmd 包裝。
// 連結與清理在每個平台都跑（Mac 走 symlink）；junction、檔案鎖、cmd.exe 只在 Windows 跑（Windows CI）。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { hookWrapperCmd } from './lib/node-runtime.mjs';
import {
  cleanTrash,
  isLink,
  pointLink,
  removeLink,
  removeRelease,
  TRASH_PREFIX,
} from './lib/release-dirs.mjs';

const isWindows = process.platform === 'win32';
const temps = [];
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-winpaths-')));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function release(root, name) {
  const dir = join(root, 'releases', name);
  mkdirSync(join(dir, 'daemon', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: name }));
  writeFileSync(join(dir, 'daemon', 'dist', 'index.mjs'), `// ${name}\n`);
  return dir;
}

describe('current／app 連結（Windows 是 junction）', () => {
  it('current 換版：指到新版，舊版內容完全不動；app → current 跟著走', () => {
    const root = tempDir();
    const a = release(root, '0.1.6');
    const b = release(root, '0.1.7');
    const current = join(root, 'current');
    const app = join(root, 'app');
    pointLink(current, a);
    pointLink(app, current);
    assert.equal(realpathSync(current), realpathSync(a));
    assert.equal(realpathSync(app), realpathSync(a));
    pointLink(current, b);
    assert.ok(isLink(current));
    assert.equal(realpathSync(current), realpathSync(b));
    assert.equal(realpathSync(app), realpathSync(b));
    assert.equal(readFileSync(join(a, 'daemon', 'dist', 'index.mjs'), 'utf8'), '// 0.1.6\n');
    assert.equal(readFileSync(join(current, 'package.json'), 'utf8'), '{"version":"0.1.7"}');
    // 沒有留下暫存連結。
    assert.deepEqual(
      readdirSync(root).filter((n) => n.includes('.new-')),
      [],
    );
  });

  it('拿掉連結只拿掉連結本身，目標的檔案還在', () => {
    const root = tempDir();
    const a = release(root, '0.1.6');
    const current = join(root, 'current');
    pointLink(current, a);
    removeLink(current);
    assert.equal(existsSync(current), false);
    assert.ok(existsSync(join(a, 'daemon', 'dist', 'index.mjs')));
    removeLink(current); // 已經不在：不丟例外
  });

  it(
    'Windows 模式下 link 的位置是一般資料夾：不蓋掉它',
    { skip: !isWindows && '只在 Windows 有 junction' },
    () => {
      const root = tempDir();
      const a = release(root, '0.1.6');
      const real = join(root, 'current');
      mkdirSync(real);
      writeFileSync(join(real, 'keep.txt'), 'x');
      assert.throws(() => pointLink(real, a, { windows: true }), /不是連結/);
      assert.ok(existsSync(join(real, 'keep.txt')));
    },
  );

  it(
    'Windows：current 是 junction（lstat 看得到是連結、目標是絕對路徑）',
    { skip: !isWindows && '只在 Windows 跑' },
    () => {
      const root = tempDir();
      const a = release(root, '0.1.6');
      const current = join(root, 'current');
      pointLink(current, a);
      assert.ok(lstatSync(current).isSymbolicLink());
      // 透過 junction 寫入，實際寫到目標裡。
      writeFileSync(join(current, 'via-junction.txt'), 'ok');
      assert.equal(readFileSync(join(a, 'via-junction.txt'), 'utf8'), 'ok');
    },
  );
});

describe('清舊版（Windows：先改名成 .trash-<名稱>-<亂數> 再刪）', () => {
  it('沒被鎖住：整個刪掉，不留 trash；同名的舊 trash 不衝突', () => {
    const root = tempDir();
    const releases = join(root, 'releases');
    release(root, '0.1.4');
    release(root, '0.1.5');
    assert.equal(removeRelease(releases, '0.1.4', { windows: true }), 'removed');
    assert.equal(removeRelease(releases, '0.1.5', { windows: false }), 'removed');
    assert.deepEqual(readdirSync(releases), []);
    // 上次留下的 trash（例如 .trash-0.1.3-xxxx）：cleanTrash 清掉。
    mkdirSync(join(releases, `${TRASH_PREFIX}0.1.3-abcd1234`, 'x'), { recursive: true });
    assert.deepEqual(cleanTrash(releases), []);
    assert.deepEqual(readdirSync(releases), []);
    assert.deepEqual(cleanTrash(join(root, 'nope')), []);
  });

  it(
    'Windows：檔案被鎖住時原本名稱的版本要嘛完整、要嘛整個不見（不留半殘的）；解鎖後 cleanTrash 清乾淨',
    { skip: !isWindows && '檔案鎖只在 Windows 有' },
    async () => {
      const root = tempDir();
      const releases = join(root, 'releases');
      const dir = release(root, '0.1.4');
      const locked = join(dir, 'daemon', 'dist', 'locked.node');
      writeFileSync(locked, 'native');
      // 用 PowerShell 以 FileShare.None 開著這個檔（Node 自己開檔都帶 FILE_SHARE_DELETE，鎖不住）。
      const holder = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$f = [System.IO.File]::Open('${locked.replace(/'/g, "''")}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null; $f.Close()`,
        ],
        { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
      );
      await new Promise((resolve, reject) => {
        let out = '';
        holder.stdout.on('data', (chunk) => {
          out += chunk;
          if (out.includes('LOCKED')) resolve();
        });
        holder.once('exit', () => reject(new Error(`PowerShell 沒鎖住檔案：${out}`)));
      });
      let outcome;
      try {
        outcome = removeRelease(releases, '0.1.4', { windows: true });
      } catch (error) {
        outcome = `threw:${error.code}`;
      }
      if (outcome.startsWith('threw')) {
        // 改不了名：原本的版本完整留著。
        assert.ok(existsSync(join(dir, 'package.json')));
        assert.ok(existsSync(join(dir, 'daemon', 'dist', 'index.mjs')));
        assert.ok(existsSync(locked));
      } else {
        // 改了名：原本的名稱不在了，刪不掉的留在 trash。
        assert.equal(existsSync(dir), false);
        assert.ok(['removed', 'trashed'].includes(outcome));
      }
      holder.stdin.end('\n');
      await new Promise((resolve) => holder.once('exit', resolve));
      cleanTrash(releases);
      if (outcome.startsWith('threw')) {
        assert.equal(removeRelease(releases, '0.1.4', { windows: true }), 'removed');
      }
      assert.deepEqual(readdirSync(releases), []);
    },
  );
});

describe(
  'hook 的 .cmd 包裝（Windows 用 cmd.exe 實際執行）',
  { skip: !isWindows && '只在 Windows 跑' },
  () => {
    /** 假的發布檔：daemon/node_modules/.bin/agent-board-hook.cmd ＋ daemon/dist/agent-board-hook.cjs。 */
    function layout({ withHook = true } = {}) {
      const root = tempDir();
      const bin = join(root, 'daemon', 'node_modules', '.bin');
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, 'daemon', 'dist'), { recursive: true });
      const cmd = join(bin, 'agent-board-hook.cmd');
      writeFileSync(cmd, hookWrapperCmd());
      if (withHook) {
        // 印出參數與 stdin，結束碼取最後一個參數（數字的話）。
        writeFileSync(
          join(root, 'daemon', 'dist', 'agent-board-hook.cjs'),
          [
            "let input = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', (c) => (input += c));",
            "process.stdin.on('end', () => {",
            '  const args = process.argv.slice(2);',
            '  process.stdout.write(JSON.stringify({ args, input, node: process.execPath }));',
            '  const code = Number(args.at(-1));',
            '  process.exit(Number.isInteger(code) ? code : 0);',
            '});',
            '',
          ].join('\n'),
        );
      }
      return cmd;
    }

    /** 照 Claude Code 在 Windows 的做法用 cmd.exe 跑（/d 不讀 AutoRun、/s 去掉外層引號）。 */
    function runCmd(cmd, args, { env, input = '' } = {}) {
      const line = [`"${cmd}"`, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
      return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        input,
        encoding: 'utf8',
        windowsVerbatimArguments: true,
        windowsHide: true,
        env,
      });
    }

    const nodeDir = dirname(process.execPath);
    const baseEnv = {
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
      ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    };

    it('用 AGENT_BOARD_NODE 執行：參數（含空白）、stdin、結束碼都原樣傳', () => {
      const cmd = layout();
      const result = runCmd(cmd, ['--agent', 'codex', 'a b', '3'], {
        env: { ...baseEnv, PATH: 'C:\\Windows\\System32', AGENT_BOARD_NODE: process.execPath },
        input: '{"hook_event_name":"Stop"}',
      });
      assert.equal(result.status, 3, result.stderr);
      const out = JSON.parse(result.stdout);
      assert.deepEqual(out.args, ['--agent', 'codex', 'a b', '3']);
      assert.equal(out.input, '{"hook_event_name":"Stop"}');
      assert.equal(out.node.toLowerCase(), process.execPath.toLowerCase());
    });

    it('AGENT_BOARD_NODE 失效（node 換了位置）：退回 PATH 上的 node', () => {
      const cmd = layout();
      const result = runCmd(cmd, ['Stop', '0'], {
        env: {
          ...baseEnv,
          PATH: `${nodeDir};C:\\Windows\\System32`,
          AGENT_BOARD_NODE: 'C:\\no\\such\\node.exe',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).args, ['Stop', '0']);
    });

    it('裝壞了（.cjs 不在、或 node 找不到）：往 stderr 說明並 exit 2（Claude Code 當成擋下）', () => {
      const broken = layout({ withHook: false });
      const missingHook = runCmd(broken, ['PreToolUse'], {
        env: { ...baseEnv, PATH: nodeDir, AGENT_BOARD_NODE: process.execPath },
      });
      assert.equal(missingHook.status, 2);
      assert.match(missingHook.stderr, /agent-board-hook: node or the hook program is missing/);
      assert.equal(missingHook.stdout, '');

      const cmd = layout();
      const noNode = runCmd(cmd, ['PreToolUse'], {
        env: { ...baseEnv, PATH: 'C:\\Windows\\System32', AGENT_BOARD_NODE: 'C:\\no\\node.exe' },
      });
      assert.equal(noNode.status, 2);
      assert.match(noNode.stderr, /missing/);
    });
  },
);
