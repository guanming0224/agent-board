// Windows 停服務時找出還活著的服務程序（scripts/lib/service-processes.mjs，CONTRACTS §21.7）。
// 最後一則真的開一個 node 程序再用程序清單找到、結束它：Windows CI 上走真的 PowerShell（Get-CimInstance），
// Mac／Linux 走 ps。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { windowsPowerShell } from './lib/process-start.mjs';
import {
  listProcesses,
  LIST_TIMEOUT_MS,
  parseProcessList,
  serviceProcessIds,
  stopProcesses,
  WINDOWS_LIST_ARGS,
} from './lib/service-processes.mjs';

describe('service-processes', () => {
  it('解析 PowerShell（tab）與 ps（空白、前面有空格）的輸出；沒有指令列的也收', () => {
    assert.deepEqual(
      parseProcessList(
        '4\t\r\n1200\t"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\王\\AppData\\Local\\agent-board\\current\\daemon\\dist\\index.mjs"\r\n\r\n',
      ),
      [
        { pid: 4, command: '' },
        {
          pid: 1200,
          command:
            '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\王\\AppData\\Local\\agent-board\\current\\daemon\\dist\\index.mjs"',
        },
      ],
    );
    assert.deepEqual(parseProcessList('  301 /usr/bin/node /a/b.mjs\n 1 /sbin/launchd\n'), [
      { pid: 301, command: '/usr/bin/node /a/b.mjs' },
      { pid: 1, command: '/sbin/launchd' },
    ]);
  });

  it('Windows：絕對路徑的 powershell.exe、UTF-8 輸出、不用雙引號；Mac／Linux 用 ps；查不了回 null', () => {
    const calls = [];
    const list = listProcesses({
      platform: 'win32',
      run: (file, args, timeout) => {
        calls.push({ file, args, timeout });
        return '7\tnode x\r\n';
      },
    });
    assert.deepEqual(list, [{ pid: 7, command: 'node x' }]);
    assert.deepEqual(calls, [
      { file: windowsPowerShell(), args: WINDOWS_LIST_ARGS, timeout: LIST_TIMEOUT_MS },
    ]);
    assert.match(WINDOWS_LIST_ARGS.at(-1), /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
    assert.doesNotMatch(WINDOWS_LIST_ARGS.at(-1), /"/);
    const ps = [];
    listProcesses({ platform: 'darwin', run: (file, args) => (ps.push([file, args]), '') });
    assert.deepEqual(ps, [['ps', ['-axww', '-o', 'pid=,args=']]]);
    assert.equal(listProcesses({ platform: 'win32', run: () => null }), null);
  });

  it('只認入口檔的完整路徑：cmd、conhost、更新程式、安裝程式、session-host.new 都不算；Windows 不分大小寫與斜線方向；不含自己', () => {
    const entry = 'C:\\Users\\alice\\AppData\\Local\\agent-board\\current\\daemon\\dist\\index.mjs';
    const list = [
      { pid: 10, command: 'conhost.exe --headless cmd.exe /c "C:\\…\\services\\run-daemon.cmd"' },
      { pid: 11, command: 'cmd.exe /c "C:\\…\\services\\run-daemon.cmd"' },
      { pid: 12, command: `"C:\\Program Files\\nodejs\\node.exe" "${entry}"` },
      {
        pid: 13,
        command:
          'node C:\\Users\\alice\\AppData\\Local\\agent-board\\releases\\.incoming\\0.1.14\\agent-board\\scripts\\updater.mjs update --root C:\\Users\\alice\\AppData\\Local\\agent-board',
      },
      { pid: 14, command: `node ${entry.toLowerCase().replaceAll('\\', '/')}` },
      { pid: 15, command: `node "${entry}"` },
    ];
    assert.deepEqual(serviceProcessIds(list, entry, { windows: true, self: 15 }), [12, 14]);
    const host = 'C:\\x\\agent-board\\session-host\\dist\\main.mjs';
    assert.deepEqual(
      serviceProcessIds(
        [
          { pid: 20, command: 'node C:\\x\\agent-board\\session-host.new\\dist\\main.mjs' },
          { pid: 21, command: `node ${host}` },
        ],
        host,
        { windows: true },
      ),
      [21],
    );
    // Mac／Linux 分大小寫。
    assert.deepEqual(
      serviceProcessIds([{ pid: 30, command: 'node /A/b.mjs' }], '/a/b.mjs', { windows: false }),
      [],
    );
  });

  it('stopProcesses：只對還活著的動手；等到都不在；逾時回傳還活著的', () => {
    const living = new Set([1, 2]);
    const killed = [];
    const left = stopProcesses([1, 2, 3], {
      kill: (pid) => {
        killed.push(pid);
        living.delete(pid);
      },
      isAlive: (pid) => living.has(pid),
    });
    assert.deepEqual(killed, [1, 2]);
    assert.deepEqual(left, []);
    const stubborn = stopProcesses([9], { kill: () => {}, isAlive: () => true, timeoutMs: 200 });
    assert.deepEqual(stubborn, [9]);
  });

  it('真的程序：用程序清單找到入口檔對得上的 node 並結束它', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ab-service-proc-'));
    try {
      const entry = join(dir, '服務 entry', 'index.mjs');
      mkdirSync(join(dir, '服務 entry'), { recursive: true });
      writeFileSync(entry, 'setInterval(() => {}, 1000);\n');
      // 孫程序（中間那層馬上結束）：和安裝程式要停的服務一樣不是自己的子程序（Mac／Linux 上自己的子程序被結束後
      // 會變成殭屍、kill(pid, 0) 照樣成功，要等 wait 收掉）。
      const launcher = spawn(
        process.execPath,
        [
          '-e',
          `const c = require('node:child_process').spawn(process.execPath, [process.argv[1]], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid);`,
          entry,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let out = '';
      launcher.stdout.on('data', (chunk) => (out += chunk));
      await new Promise((done) => launcher.once('exit', done));
      const pid = Number(out.trim());
      assert.ok(pid > 0);
      let found = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const list = listProcesses();
        assert.ok(list, '查得到程序清單');
        found = serviceProcessIds(list, entry);
        if (found.length > 0) break;
        await new Promise((done) => setTimeout(done, 200));
      }
      assert.deepEqual(found, [pid]);
      assert.deepEqual(stopProcesses(found), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
