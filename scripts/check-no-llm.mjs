// 中控台本身不呼叫任何 LLM（DISPATCH §1.3-2、§10）：corepack pnpm check:no-llm
// 審查紀錄與每一項的理由在 docs/no-llm-review.md。這支把審查變成可重跑的檢查：
//   1. 原始碼（packages/*/src、會進發布檔的安裝腳本）和所有散布的第三方套件、release/agent-board
//      裡不得出現 LLM 服務的網址或 SDK。
//   2. 原始碼裡每個對外連線、開行程、把字送進終端機的位置都要在 CALL_SITES 清單裡。
//      出現新的位置就失敗：先審查，確認不是呼叫 LLM、不是自動送 prompt，再加進清單與審查文件。
//   3. daemon 給 claude 的參數只能是互動模式用的那幾個，不能有 -p／--print（非互動，直接耗用模型）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { collectShipped } from './release-shipped.mjs';

const root = join(import.meta.dirname, '..');

/** LLM 服務的網址與 SDK。比對時不分大小寫。 */
const LLM_PATTERNS = [
  /api\.anthropic\.com/i,
  /@anthropic-ai\//i,
  /anthropic-version/i,
  /\/v1\/messages\b/i,
  /\/v1\/complete\b/i,
  /\/v1\/chat\/completions/i,
  /\/v1\/responses\b/i,
  /\/v1\/embeddings/i,
  /api\.openai\.com/i,
  /openai\.azure\.com/i,
  /from ['"]openai['"]/i,
  /generativelanguage\.googleapis\.com/i,
  /aiplatform\.googleapis\.com/i,
  /bedrock-runtime/i,
  /api\.mistral\.ai/i,
  /api\.cohere\.(ai|com)/i,
  /api\.groq\.com/i,
  /openrouter\.ai/i,
  /api\.deepseek\.com/i,
  /api\.x\.ai/i,
  /api\.together\.(xyz|ai)/i,
  /api-inference\.huggingface\.co/i,
  /localhost:11434/i, // ollama
];

/** 對外連線、開行程、送字進終端機的寫法。 */
const KINDS = {
  fetch: /\bfetch\(/,
  websocket: /new WebSocket\(/,
  'child-process': /from ['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)/,
  'node-pty': /from ['"]node-pty['"]/,
  'node-network': /^import (?!type )[^;]*from ['"](node:)?(http|https|http2|net|tls|dgram)['"]/m,
  'require-network': /require\(['"](node:)?(http|https|http2|net|tls|dgram)['"]\)/,
  'web-push': /sendNotification\(/,
  systeminformation: /from ['"]systeminformation['"]/,
  'browser-network': /XMLHttpRequest|sendBeacon|new EventSource\(/,
  'dynamic-import': /(?<!typeof )\bimport\(\s*['"`](?!\.)/,
  'pty-write': /\.pty\.write\(/,
  'terminal-input': /type: 'terminal\.input',/,
  'send-prompt': /\.sendPrompt\(/,
};

/**
 * 審查過的位置：`檔案 種類`。理由見 docs/no-llm-review.md 的同名項目。
 * 少了某一項只是警告（程式碼可能已經移除），多出來的一律失敗。
 */
const CALL_SITES = new Set([
  // daemon：配對、連 hub、開 claude、本機探測
  'packages/daemon/src/pair.ts fetch',
  'packages/daemon/src/hubClient.ts websocket',
  'packages/daemon/src/session.ts node-pty',
  'packages/daemon/src/session.ts pty-write',
  'packages/daemon/src/resources.ts child-process',
  'packages/daemon/src/resources.ts systeminformation',
  'packages/daemon/src/worktree.ts child-process',
  'packages/daemon/src/sessionFiles.ts child-process',
  'packages/daemon/src/hookServer.ts node-network',
  // hook：只連 daemon 的本機 socket
  'packages/hook/src/cli.ts node-network',
  // 派工 MCP server：只連 daemon 的本機 socket，把 Claude 的工具呼叫原樣轉過去（2026-11-06 審查）
  'packages/hook/src/mcp.ts node-network',
  // hub：推播、交接規則、IP 判斷
  'packages/hub/src/push.ts web-push',
  'packages/hub/src/hub.ts terminal-input',
  'packages/hub/src/config.ts node-network',
  'packages/hub/src/auth.ts node-network',
  // web：同源 API 與 WebSocket；使用者按下送出的 prompt
  'packages/web/src/shared/hubBackend.ts fetch',
  'packages/web/src/shared/hubBackend.ts websocket',
  'packages/web/src/shared/hubBackend.ts terminal-input',
  'packages/web/src/terminal/controller.ts terminal-input',
  'packages/web/src/canvas/CommandInput.tsx send-prompt',
  'packages/web/src/canvas/DoneHint.tsx send-prompt',
  'packages/web/src/team/TaskBoard.tsx send-prompt',
  'packages/web/src/flows/InboxPage.tsx send-prompt',
  'packages/web/src/flows/ReviewPage.tsx send-prompt',
  'packages/web/src/flows/QueueBoard.tsx send-prompt',
  // 會進發布檔的安裝程式：npm ci、launchctl／systemctl／schtasks、等 hub 起來
  'scripts/installer.mjs child-process',
  'scripts/installer.mjs fetch',
  'scripts/installer.mjs node-network',
  // 在 Agent Board session 裡執行時，用 node spawn 把 install.sh 自己移到背景（2026-11-06 Lead 審查）
  'scripts/install.sh child-process',
]);

/** daemon 開 claude 時可以帶的參數（全部是互動模式）。 */
const CLAUDE_FLAGS = new Set([
  '--resume',
  '--session-id',
  '--permission-mode',
  // 唯讀 session 拿掉改檔工具；只會減少 claude 能做的事（2026-11-06 Lead 決策）。
  '--disallowedTools',
  '--model',
  '--name',
  // 派工工具（2026-11-06 審查）：掛 daemon 產生的 MCP 設定檔（本機 MCP server，只連 daemon 的 socket），
  // 並事先允許那四個工具；不加 --strict-mcp-config，也不放寬其他工具。仍是互動模式。
  '--mcp-config',
  '--allowedTools',
  '--version',
]);

const isTest = (path) =>
  /\.test\.[cm]?[jt]sx?$|[\\/](test|test-support|e2e|__tests__)[\\/]/.test(path);
const CODE = /\.(ts|tsx|mjs|cjs|js|sh|ps1)$/;

function* walk(dir, filter, skip = ['node_modules', 'dist']) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.includes(entry.name)) yield* walk(path, filter, skip);
    } else if (filter(path)) {
      yield path;
    }
  }
}

function sourceFiles() {
  const files = [];
  for (const pkg of readdirSync(join(root, 'packages'))) {
    files.push(...walk(join(root, 'packages', pkg, 'src'), (p) => CODE.test(p) && !isTest(p)));
  }
  // 安裝程式會隨發布檔散布並在使用者電腦上執行。
  for (const file of ['installer.mjs', 'install.sh', 'install.ps1', 'fix-node-pty.mjs']) {
    files.push(join(root, 'scripts', file));
  }
  files.push(...walk(join(root, 'scripts/lib'), (p) => CODE.test(p) && !isTest(p)));
  return files;
}

const rel = (path) => relative(root, path).split(sep).join('/');
const problems = [];
const warnings = [];

function scanLlm(file, label = rel(file)) {
  const text = readFileSync(file, 'utf8');
  for (const pattern of LLM_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const line = text.slice(0, match.index).split('\n').length;
      problems.push(`${label}:${line} 出現 LLM 服務特徵 ${pattern}`);
    }
  }
}

// 1+2. 自己的原始碼
const seen = new Set();
const sources = sourceFiles();
for (const file of sources) {
  scanLlm(file);
  const text = readFileSync(file, 'utf8');
  for (const [kind, pattern] of Object.entries(KINDS)) {
    if (!pattern.test(text)) continue;
    const key = `${rel(file)} ${kind}`;
    seen.add(key);
    if (!CALL_SITES.has(key)) {
      problems.push(`${key}：沒審查過的對外連線／行程／終端機輸入，審查後加進 CALL_SITES`);
    }
  }
}
for (const key of CALL_SITES) {
  if (!seen.has(key)) warnings.push(`CALL_SITES 的 ${key} 已找不到，可以從清單移除`);
}

// 3. claude 的參數
for (const file of ['packages/daemon/src/session.ts', 'packages/daemon/src/resources.ts']) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const [, flag] of text.matchAll(/'(--?[a-z][\w-]*)'/g)) {
    if (file.endsWith('session.ts') || flag === '--version') {
      if (!CLAUDE_FLAGS.has(flag)) problems.push(`${file}：claude 參數 ${flag} 不在允許清單`);
    }
  }
}
for (const file of sources.filter((f) => rel(f).startsWith('packages/daemon/'))) {
  if (/'(-p|--print)'/.test(readFileSync(file, 'utf8'))) {
    problems.push(`${rel(file)}：出現 -p／--print，daemon 不能用非互動模式跑 claude`);
  }
}

// 1. 所有散布的第三方套件（打包進去的、npm ci 會裝的）
const { found } = await collectShipped(root);
let packageFiles = 0;
for (const pkg of found.values()) {
  for (const file of walk(pkg.dir, (p) => /\.(c|m)?js$|\.json$/.test(p), ['node_modules'])) {
    if (statSync(file).size > 20 * 1024 * 1024) continue;
    packageFiles += 1;
    scanLlm(file, `${pkg.name}@${pkg.version}/${relative(pkg.dir, file).split(sep).join('/')}`);
  }
}

// 1. 打包好的發布檔（有的話）
const release = join(root, 'release/agent-board');
let releaseFiles = 0;
if (existsSync(release)) {
  // 發布檔裡的 node_modules 只有 daemon/node_modules/.bin 的 hook；npm ci 裝的套件上面已掃過。
  for (const file of walk(release, (p) => !/\.(png|gz|node)$/.test(p), [])) {
    if (rel(file).includes('/node_modules/') && !rel(file).includes('/node_modules/.bin/'))
      continue;
    releaseFiles += 1;
    scanLlm(file);
  }
} else {
  warnings.push('沒有 release/agent-board，略過發布檔掃描（先跑 corepack pnpm build:release）');
}

for (const warning of warnings) console.warn(`注意：${warning}`);
console.log(
  `原始碼 ${sources.length} 檔、第三方套件 ${found.size} 個（${packageFiles} 檔）、發布檔 ${releaseFiles} 檔`,
);
if (problems.length) {
  console.error(`沒有通過：\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`通過：沒有 LLM 呼叫；對外連線與終端機輸入共 ${seen.size} 處，都在審查清單內。`);
