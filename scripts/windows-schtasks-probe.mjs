// 診斷（只在 Windows、只給 CI 或手動跑）：工作排程器的 `schtasks /End` 會不會收掉 cmd 底下的 node（CONTRACTS §21.7）。
// 用和正式安裝一樣的模板（deploy/windows：conhost --headless cmd /c run.cmd → node）登記一個暫時的工作
// `AgentBoard-probe-<亂數>`，/Run → 等 node 起來 → /End → 3 秒後看 node 還在不在 → 收掉 node、刪掉工作。
// 結果只印出來（結束碼一律 0）；不碰 AgentBoard-daemon／session-host。
//   node scripts/windows-schtasks-probe.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { renderWindowsCmd, renderWindowsTask } from './lib/service-templates.mjs';

if (process.platform !== 'win32') {
  console.log('只在 Windows 上跑。');
  process.exit(0);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const schtasks = (...args) => {
  const result = spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true });
  console.log(
    `schtasks ${args.join(' ')} → ${result.status} ${(result.stdout + result.stderr).trim()}`,
  );
  return result;
};

const dir = mkdtempSync(join(tmpdir(), 'ab-schtasks-probe-'));
const name = `AgentBoard-probe-${Math.random().toString(36).slice(2, 8)}`;
const pidFile = join(dir, 'node.pid');
const entry = join(dir, 'probe.mjs');
writeFileSync(
  entry,
  `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
);
const runCmd = join(dir, 'run-probe.cmd');
writeFileSync(
  runCmd,
  renderWindowsCmd({
    node: process.execPath,
    entry,
    env: {},
    workdir: dir,
    log: join(dir, 'probe.log'),
  }),
);
const xml = join(dir, 'task.xml');
writeFileSync(
  xml,
  renderWindowsTask({
    description: 'Agent Board schtasks probe',
    user: `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${userInfo().username}`,
    runCmd,
  }),
);
let pid = 0;
try {
  if (schtasks('/Create', '/TN', name, '/XML', xml, '/F').status !== 0) {
    console.log('結論：沒辦法登記排程工作（這台不准一般使用者建登入觸發的工作？），測不了。');
  } else {
    schtasks('/Run', '/TN', name);
    const deadline = Date.now() + 20_000;
    while (!pid && Date.now() < deadline) {
      try {
        pid = Number(readFileSync(pidFile, 'utf8'));
      } catch {
        await sleep(200);
      }
    }
    if (!pid) {
      console.log(
        '結論：/Run 之後 20 秒內 node 沒有起來（工作排程器沒在這個工作階段執行工作？），測不了。',
      );
      schtasks('/Query', '/TN', name, '/V', '/FO', 'LIST');
    } else {
      console.log(`node 起來了（pid ${pid}）`);
      schtasks('/End', '/TN', name);
      await sleep(3_000);
      console.log(
        alive(pid)
          ? `結論：/End 之後 node（pid ${pid}）還活著——工作排程器只收它自己啟動的程序（conhost），安裝程式必須自己結束服務的 node。`
          : `結論：/End 之後 node（pid ${pid}）也被收掉了。`,
      );
      schtasks('/Query', '/TN', name, '/FO', 'LIST');
    }
  }
} finally {
  if (pid && alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已經不在
    }
  }
  schtasks('/End', '/TN', name);
  schtasks('/Delete', '/TN', name, '/F');
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
