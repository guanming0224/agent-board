// 測試用假 claude：不連網、不呼叫 LLM。啟動時把 argv 與關鍵 env 寫進 FAKE_CLAUDE_LOG，
// 之後逐行讀輸入，依指令印輸出或結束。
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('9.9.9 (Fake Claude)');
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    `${JSON.stringify({
      argv,
      cwd: process.cwd(),
      env: {
        AGENT_BOARD_SESSION_ID: process.env.AGENT_BOARD_SESSION_ID ?? null,
        AGENT_BOARD_SOCKET: process.env.AGENT_BOARD_SOCKET ?? null,
        AGENT_BOARD_MACHINE_TOKEN: process.env.AGENT_BOARD_MACHINE_TOKEN ?? null,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
        TERM: process.env.TERM ?? null,
      },
    })}\n`,
  );
}

if (process.env.FAKE_CLAUDE_IGNORE_TERM) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('FAKE READY\r\n');
const exitOnStart = process.env.FAKE_CLAUDE_EXIT_ON_START;
if (exitOnStart) process.exit(Number(exitOnStart));

let line = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\x1b') process.stdout.write('GOT:ESC\r\n');
    else if (ch === '\x03') process.stdout.write('GOT:CTRL_C\r\n');
    else if (ch === '\r' || ch === '\n') {
      run(line);
      line = '';
    } else line += ch;
  }
});

function run(command) {
  const [name, arg] = command.split(' ');
  if (name === 'exit') process.exit(Number(arg ?? 0));
  if (name === 'paint') {
    // 顏色、游標定位與覆寫，驗證快照能還原的不只是純文字。
    process.stdout.write(
      '\x1b[2J\x1b[H\x1b[31mred\x1b[0m plain\r\n\x1b[1;44mbold-on-blue\x1b[0m\r\n' +
        'overwrite-me\x1b[12D-rewritten-\r\n\x1b[5;10Hpositioned\x1b[7;1H',
    );
    return;
  }
  if (name === 'flood') {
    // 分批印，讓訂閱有機會落在輸出途中。
    const total = Number(arg ?? 100);
    let i = 0;
    const batch = () => {
      for (let n = 0; n < 10 && i < total; n += 1, i += 1) {
        process.stdout.write(`flood line ${i}\r\n`);
      }
      if (i < total) setTimeout(batch, 1);
      else process.stdout.write('FLOOD DONE\r\n');
    };
    batch();
    return;
  }
  if (name === 'size') {
    process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
    return;
  }
  process.stdout.write(`INPUT:${command}\r\n`);
}
