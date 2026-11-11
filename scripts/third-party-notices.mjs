// 從實際散布的第三方套件產生 THIRD_PARTY_NOTICES.md：corepack pnpm notices
// 打包會拿掉原始碼裡的授權註解，所以授權全文要收在這裡。清單怎麼算見 release-shipped.mjs；
// build-release 會用同一份清單檢查，漏列就打包失敗。開發依賴不會隨發布檔散布，不列。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as prettier from 'prettier';
import { collectShipped } from './release-shipped.mjs';

const root = join(import.meta.dirname, '..');
const target = join(root, 'THIRD_PARTY_NOTICES.md');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\..*)?$/i;

/** 沒附授權檔、但和同一個 repo 發布的其他套件共用授權的。 */
const SAME_REPO_LICENSE = {
  '@xterm/headless': '@xterm/xterm',
  '@xterm/addon-serialize': '@xterm/xterm',
};

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const mitLicense = (holder) => `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_TEXT}`;

const fence = (text) => {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}text\n${text.trim()}\n${ticks}`;
};

const authorName = (author) =>
  typeof author === 'string' ? author.replace(/\s*[<(].*$/, '').trim() : author?.name;

/** 套件根目錄的授權檔；npm ci 整包安裝的，子資料夾裡隨附的上游授權也一起收（不含 node_modules）。 */
function licenseFiles(dir, nested) {
  const files = [];
  const walk = (current, depth) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (nested && depth < 3 && entry.name !== 'node_modules') walk(path, depth + 1);
      } else if (LICENSE_FILE.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(dir, 0);
  return files.map((path) => ({
    label: relative(dir, path).replaceAll('\\', '/'),
    text: readFileSync(path, 'utf8'),
  }));
}

const { found, unknownWebSources } = await collectShipped(root);
if (unknownWebSources.length) {
  throw new Error(`網頁打包裡有不在 node_modules 的來源，無法判斷授權：${unknownWebSources}`);
}

const byName = new Map([...found.values()].map((pkg) => [pkg.name, pkg]));
const packages = [...found.values()]
  .map((pkg) => {
    const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'));
    const license =
      manifest.license ?? manifest.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
    const installed = pkg.via.has('npm ci');
    const files = licenseFiles(pkg.dir, installed);
    let body;
    if (files.length) {
      body = files
        .map(({ label, text }, i) =>
          i === 0 && files.length === 1 ? fence(text) : `\`${label}\`:\n\n${fence(text)}`,
        )
        .join('\n\n');
    } else if (SAME_REPO_LICENSE[pkg.name] && byName.has(SAME_REPO_LICENSE[pkg.name])) {
      const source = byName.get(SAME_REPO_LICENSE[pkg.name]);
      const text = licenseFiles(source.dir, false)[0]?.text;
      body = `_The package ships no license file. This is the license of ${source.name}, published from the same repository:_\n\n${fence(text)}`;
    } else if (license === 'MIT' && authorName(manifest.author)) {
      body = `_The package ships no license file. Standard MIT license text, with the author named in its package.json:_\n\n${fence(mitLicense(authorName(manifest.author)))}`;
    } else {
      body = '_No license text found._';
    }
    const repo =
      typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    return { ...pkg, license, repo, body };
  })
  .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));

const counts = new Map();
for (const { license } of packages) counts.set(license, (counts.get(license) ?? 0) + 1);
const summary = [...counts.entries()]
  .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  .map(([license, count]) => `| ${license} | ${count} |`)
  .join('\n');

const mpl = packages
  .filter((p) => p.license.includes('MPL'))
  .map(
    (p) =>
      `- \`${p.name}@${p.version}\` (${[...p.via].join(', ')}), unmodified. Source: ${(p.repo ?? '').replace(/^git\+/, '')} and https://www.npmjs.com/package/${p.name}/v/${p.version}`,
  )
  .join('\n');

// node-pty 在 Windows 附帶 microsoft/terminal 的 conpty.dll 與 OpenConsole.exe，套件裡沒有授權檔。
const nodePty = byName.get('node-pty');
const conpty =
  nodePty && existsSync(join(nodePty.dir, 'third_party/conpty'))
    ? `

### microsoft/terminal (conpty.dll, OpenConsole.exe in node-pty/third_party/conpty)

License: MIT. Installed with \`node-pty@${nodePty.version}\` and used on Windows. node-pty ships these
binaries without a license file; this is the license of https://github.com/microsoft/terminal:

${fence(mitLicense('Microsoft Corporation. All rights reserved.'))}`
    : '';

const sections = packages
  .map(
    ({ name, version, license, via, body }) =>
      `### ${name}@${version}\n\nLicense: ${license}\n\nShipped as: ${[...via].join(', ')}\n\n${body}`,
  )
  .join('\n\n');

const output = `# Third-party notices

Generated by \`scripts/third-party-notices.mjs\` (run \`corepack pnpm notices\`). Do not edit by hand.
\`corepack pnpm build:release\` fails if a package that ships is missing here.

## Source code copied into this repository

None. [OpenCove](https://github.com/DeadWaveWave/opencove) (MIT) was listed as a reference for
PTY and xterm integration, but no OpenCove code has been copied. If that changes, its MIT notice
must be added here.

## Node.js runtime

Release archives include the official Node.js executable from https://nodejs.org/dist/ (version
pinned by \`bundledNode\` in the root \`package.json\`, checked against the official
\`SHASUMS256.txt\` at build time) in \`runtime/node/\`, together with its own \`LICENSE\` file, which
covers Node.js and the third-party code built into it. The executable is shipped unmodified.

## Third-party packages that ship with Agent Board

"Shipped as" says how each package reaches users:

- \`hub bundle\`, \`daemon bundle\`, \`hook bundle\`: inlined by esbuild into \`hub/dist/main.mjs\`,
  \`daemon/dist/index.mjs\` or \`daemon/dist/agent-board-hook.cjs\`.
- \`web bundle\`: inlined by vite into \`web/dist/assets/*.js\`.
- \`dependency of …\`: declared dependency of a bundled package. Some packages publish their own
  pre-bundled code (for example \`glob\` inlines \`minimatch\` and \`lru-cache\`), so these are listed
  even when the bundler does not see them separately.
- \`npm ci\`: installed next to the release from \`package-lock.json\` (native modules and packages
  loaded at run time).

| License | Packages |
| --- | --- |
${summary}

### MPL-2.0 source code

${mpl || 'None.'}

### Native code inside installed packages

\`better-sqlite3\` compiles the SQLite amalgamation, which is in the public domain. Upstream license
files inside \`argon2\` and \`node-pty\` are reproduced in their sections below.${conpty}

## Package licenses

${sections}
`;

const config = await prettier.resolveConfig(target);
writeFileSync(target, await prettier.format(output, { ...config, filepath: target }));

console.log(`${packages.length} packages`);
console.log([...counts.entries()].map(([license, count]) => `${license}: ${count}`).join('\n'));
const noText = packages.filter((p) => !p.body.includes('```text'));
if (noText.length) {
  console.log(`沒有授權全文：${noText.map((p) => `${p.name}@${p.version}`).join(', ')}`);
  process.exitCode = 1;
}
