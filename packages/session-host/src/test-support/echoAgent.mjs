// 測試用的假 agent：不連網、不呼叫 LLM。印 READY，之後逐行讀輸入：
// `flood N` 印 N 行、`exit N` 用結束碼 N 離開、`size` 印目前尺寸，其他原樣回 `ECHO:<字>`。
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.on('SIGHUP', () => process.exit(0));
process.stdout.write('READY\r\n');
let line = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const ch of chunk) {
    if (ch === '\r' || ch === '\n') {
      run(line);
      line = '';
    } else line += ch;
  }
});

function run(command) {
  const [name, arg] = command.split(' ');
  if (name === 'exit') process.exit(Number(arg ?? 0));
  if (name === 'flood') {
    for (let i = 0; i < Number(arg ?? 10); i += 1) process.stdout.write(`flood ${i}\r\n`);
    process.stdout.write('FLOOD DONE\r\n');
    return;
  }
  if (name === 'size') {
    process.stdout.write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
    return;
  }
  process.stdout.write(`ECHO:${command}\r\n`);
}
