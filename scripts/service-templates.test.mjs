// 服務模板的跳脫測試。Linux、Windows 只驗設定檔內容，沒有實際跑過 systemd 與工作排程器。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import {
  renderLaunchd,
  renderSystemd,
  renderWindowsCmd,
  renderWindowsTask,
  servicePath,
} from './lib/service-templates.mjs';

const tricky = '/Users/a b/控制 & 中心<1>/100%';
const spec = {
  label: 'com.agent-board.daemon',
  description: 'Agent Board daemon',
  node: `${tricky}/node`,
  entry: `${tricky}/daemon/dist/index.mjs`,
  env: {
    PATH: `${tricky}:/usr/bin`,
    LANG: 'en_US.UTF-8',
    AGENT_BOARD_CLAUDE_BIN: `${tricky}/claude`,
  },
  workdir: tricky,
  log: `${tricky}/logs/daemon.log`,
};

test(
  'launchd：特殊字元跳脫後，plutil 讀回來與原值相同',
  { skip: process.platform !== 'darwin' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-plist-'));
    try {
      const file = join(dir, 'a.plist');
      writeFileSync(file, renderLaunchd(spec));
      execFileSync('plutil', ['-lint', file]);
      const parsed = JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }),
      );
      assert.deepEqual(parsed.ProgramArguments, [spec.node, spec.entry]);
      assert.deepEqual(parsed.EnvironmentVariables, spec.env);
      assert.equal(parsed.RunAtLoad, true);
      assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
      assert.equal(parsed.ThrottleInterval, 10);
      assert.equal(parsed.StandardOutPath, spec.log);
      assert.equal(parsed.StandardErrorPath, spec.log);
    } finally {
      rmSync(dir, { recursive: true });
    }
  },
);

test('systemd：路徑有空格要加引號，% 與 $ 要跳脫', () => {
  const unit = renderSystemd({
    ...spec,
    node: '/opt/a b/node',
    entry: '/x/$HOME/100%/index.mjs',
    log: '/x y/100%.log',
  });
  assert.match(unit, /^ExecStart="\/opt\/a b\/node" "\/x\/\$\$HOME\/100%%\/index\.mjs"$/m);
  assert.match(unit, /^StandardOutput=append:\/x y\/100%%\.log$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.ok(unit.includes(`Environment="PATH=${tricky.replace('%', '%%')}:/usr/bin"`));
  assert.ok(!unit.includes('{{'));
});

test('systemd：log 路徑含雙引號時拒絕，不產生壞掉的設定', () => {
  assert.throws(() => renderSystemd({ ...spec, log: '/a"b/log' }), /systemd/);
});

test('Windows cmd：% 要加倍、換行是 CRLF', () => {
  const cmd = renderWindowsCmd({
    ...spec,
    node: 'C:\\Program Files\\nodejs\\node.exe',
    entry: 'C:\\Users\\a b\\100%\\index.mjs',
    log: 'C:\\Users\\a b\\daemon.log',
    workdir: 'C:\\Users\\a b',
    env: { PATH: 'C:\\x y;C:\\100%' },
  });
  assert.ok(
    cmd.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a b\\100%%\\index.mjs"'),
  );
  assert.ok(cmd.includes('set "PATH=C:\\x y;C:\\100%%"\r\n'));
  assert.ok(!/[^\r]\n/.test(cmd));
});

test('Windows 工作：UTF-16 LE 加 BOM，內容跳脫，不用系統管理員權限', () => {
  const buffer = renderWindowsTask({
    description: 'Agent Board daemon',
    user: 'PC\\a&b',
    runCmd: 'C:\\Users\\a b\\run.cmd',
  });
  assert.deepEqual([...buffer.subarray(0, 2)], [0xff, 0xfe]);
  const text = buffer.toString('utf16le');
  assert.ok(text.includes('<UserId>PC\\a&amp;b</UserId>'));
  assert.ok(text.includes('cmd.exe /c "C:\\Users\\a b\\run.cmd"'));
  assert.ok(text.includes('<RunLevel>LeastPrivilege</RunLevel>'));
  assert.ok(text.includes('<LogonType>InteractiveToken</LogonType>'));
  // macOS 內建的 XML 檢查器可以再驗一次語法。
  if (spawnSync('xmllint', ['--version']).status === 0) {
    const dir = mkdtempSync(join(tmpdir(), 'ab-task-'));
    try {
      const file = join(dir, 'task.xml');
      writeFileSync(file, buffer);
      execFileSync('xmllint', ['--noout', file]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }
});

test('服務 PATH：node、claude 在最前面，去重，不收相對路徑與 node_modules/.bin', () => {
  const path = servicePath({
    first: ['/n', '/c'],
    current: '.:/usr/bin:/n:relative:/repo/node_modules/.bin:/tool',
    delimiter: ':',
    extra: ['/usr/bin', '/bin'],
    absolute: isAbsolute,
  });
  assert.equal(path, '/n:/c:/usr/bin:/tool:/bin');
});
