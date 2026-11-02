// 從實際安裝的執行依賴產生 THIRD_PARTY_NOTICES.md：corepack pnpm notices
// 打包會拿掉原始碼裡的授權註解，所以授權全文要收在這裡。開發依賴不會隨發布檔散布，不列。
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i;

const found = new Map();

function moduleDir(from, dep) {
  // pnpm 把依賴放在同一層 node_modules；工作區套件則在自己的 node_modules。
  const scoped = dep.split('/');
  const direct = join(from, 'node_modules', ...scoped);
  if (existsSync(direct)) return realpathSync(direct);
  let base = dirname(from);
  if (from.includes('@') && dirname(base).endsWith('node_modules')) base = dirname(base);
  const sibling = join(base, ...scoped);
  return existsSync(sibling) ? realpathSync(sibling) : null;
}

function visit(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const key = `${manifest.name}@${manifest.version}`;
  if (found.has(key)) return;
  const texts = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort()
    .map((file) => readFileSync(join(dir, file), 'utf8').trim());
  found.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? manifest.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN',
    texts,
  });
  const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const dep of Object.keys(deps)) {
    const next = moduleDir(dir, dep);
    if (next) visit(next); // 沒裝到的是其他平台的 optional 依賴
  }
}

for (const pkg of readdirSync(join(root, 'packages'))) {
  const dir = join(root, 'packages', pkg);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (String(range).startsWith('workspace:')) continue;
    visit(realpathSync(join(dir, 'node_modules', ...dep.split('/'))));
  }
}

const packages = [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
const counts = new Map();
for (const { license } of packages) counts.set(license, (counts.get(license) ?? 0) + 1);

const summary = [...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([license, count]) => `| ${license} | ${count} |`)
  .join('\n');

const sections = packages
  .map(({ name, version, license, texts }) => {
    const body = texts.length
      ? texts.map((text) => `\`\`\`text\n${text}\n\`\`\``).join('\n\n')
      : '_The package ships no license file; see the `license` field above._';
    return `### ${name}@${version}\n\nLicense: ${license}\n\n${body}`;
  })
  .join('\n\n');

const output = `# Third-party notices

Generated from the installed runtime dependencies by \`scripts/third-party-notices.mjs\`
(run \`corepack pnpm notices\`). Do not edit by hand.

## Source code copied into this repository

None. [OpenCove](https://github.com/DeadWaveWave/opencove) (MIT) was listed as a reference for
PTY and xterm integration, but no OpenCove code has been copied. If that changes, its MIT notice
must be added here.

## Runtime dependencies

These packages ship with Agent Board, bundled into its release files or installed next to them.

| License | Packages |
| --- | --- |
${summary}

Native modules (\`node-pty\`, \`better-sqlite3\`, \`argon2\`) include code from further upstream
projects; see the license files of those packages.

${sections}
`;

writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), output);
console.log(`${packages.length} packages`);
console.log([...counts.entries()].map(([license, count]) => `${license}: ${count}`).join('\n'));
const missing = packages.filter((p) => p.texts.length === 0).map((p) => `${p.name}@${p.version}`);
if (missing.length) console.log(`no license file: ${missing.join(', ')}`);
