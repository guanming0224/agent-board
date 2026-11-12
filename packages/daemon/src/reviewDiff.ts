// 交叉審查的 diff（Codex 第二輪，docs/codex-round2-spec.md §2-1）：只跑 git 讀資料，不改 repo、不呼叫任何模型。
// - session：工作資料夾 `git diff HEAD`（含 staged）＋未追蹤檔案的內容；
// - branch：`git diff <base>...<branch>`。
// 單檔超過上限截斷並標明；整份超過上限，後面的檔案只列名稱（omitted）。整份 diff 只留在 daemon 記憶體。
// 安全（審查 S1、W2）：未追蹤檔用 lstat 判斷，符號連結只列目標、不讀內容，FIFO／裝置等非一般檔案略過，
// 開檔用 O_NOFOLLOW、realpath 必須在 repo 裡；檔名像機密的（`.env*`、金鑰、憑證…）只列名稱、不送內容，
// git diff 也用 pathspec 排除它們。git 一律關掉 textconv、fsmonitor、系統設定檔。
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  REVIEW_FILE_MAX_BYTES,
  REVIEW_TOTAL_MAX_BYTES,
  type ReviewDiffSummary,
  type ReviewFile,
} from '@agent-board/protocol';

const run = promisify(execFile);
/** git diff 的輸出上限：比整份上限大很多（截斷在我們這邊做），超過就當失敗（巨大的 diff 不審）。 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
/** 未追蹤檔最多讀幾個（其餘只列名稱）。 */
const UNTRACKED_MAX_FILES = 500;
const HOOK_SETTINGS_FILE = '.claude/settings.local.json';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** 分支名稱：不能以 - 開頭（不會被當成 git 參數）、不能有空白與 `..`（同 protocol ReviewRef）。 */
const REF = /^(?!-)[A-Za-z0-9._/@^~+-]+$/;

export interface ReviewDiffLimits {
  fileMaxBytes: number;
  totalMaxBytes: number;
}

export const DEFAULT_DIFF_LIMITS: ReviewDiffLimits = {
  fileMaxBytes: REVIEW_FILE_MAX_BYTES,
  totalMaxBytes: REVIEW_TOTAL_MAX_BYTES,
};

export interface ReviewDiff {
  /** 送給模型的全文（diff＋未追蹤檔內容，已截斷）。 */
  text: string;
  summary: ReviewDiffSummary;
}

export class ReviewDiffError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 檔名像機密的（審查 W2）：只列名稱、不送內容。比對每一層資料夾名稱與檔名（不分大小寫）。
 * `id_*` 只認 SSH 金鑰的檔名（id_rsa、id_ed25519…），避免把 `id_utils.ts` 這種程式檔也擋掉。
 */
const SENSITIVE_NAME = [
  /^\.env($|\.)/i,
  /\.(pem|key|p12|pfx|keystore|jks|der|crt|cer)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials.*\.json$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|pgpass)$/i,
  /^service-account.*\.json$/i,
];
const SENSITIVE_DIR = /^\.(aws|ssh|gnupg|docker|kube)$/i;

export function isSensitivePath(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? '';
  return (
    parts.slice(0, -1).some((part) => SENSITIVE_DIR.test(part)) ||
    SENSITIVE_NAME.some((pattern) => pattern.test(name))
  );
}

/** 給 git diff 的排除 pathspec（和 isSensitivePath 同一份規則的 glob 版本）。 */
export const SENSITIVE_PATHSPECS = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  '*.jks',
  '*.der',
  '*.crt',
  '*.cer',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'credentials*.json',
  'service-account*.json',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
]
  .flatMap((p) => [`:(exclude,glob,icase)**/${p}`])
  .concat(
    ['.aws', '.ssh', '.gnupg', '.docker', '.kube'].map((d) => `:(exclude,glob,icase)**/${d}/**`),
  );

/** 所有 git 指令前面都帶：不跑 fsmonitor（會執行設定裡的程式）、不跑外部 diff。 */
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.pager=cat'];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', [...GIT_SAFE, '-C', cwd, ...args], {
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      // 不讓 git 開分頁器、不跑使用者設定的外部 diff 工具、不讀系統設定檔。
      env: { ...process.env, GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return stdout;
  } catch (error) {
    const err = error as { code?: unknown; stderr?: unknown };
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new ReviewDiffError('diff_too_large', 'The diff is too large to review.');
    }
    const detail = typeof err.stderr === 'string' ? err.stderr.trim().split('\n')[0] : '';
    throw new ReviewDiffError('git_failed', detail || 'git failed');
  }
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** 字串截到 n 個位元組以內（不切壞 UTF-8 字元）。 */
function clipBytes(text: string, max: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= max) return text;
  return buffer.subarray(0, max).toString('utf8').replace(/�$/, '');
}

interface Chunk {
  path: string;
  status: ReviewFile['status'];
  body: string;
}

/** sourceTruncated：讀檔時就只讀了前面；skip：太多檔案，只列名稱；sensitive：檔名像機密，只列名稱。 */
type SourceChunk = Chunk & { sourceTruncated?: boolean; skip?: boolean; sensitive?: boolean };

/** 把 unified diff 依 `diff --git` 拆成每個檔案一段。 */
export function splitDiff(diff: string): Chunk[] {
  const chunks: Chunk[] = [];
  const parts = diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith('diff --git '));
  for (const body of parts) {
    const header = body.slice(0, body.indexOf('\n') === -1 ? body.length : body.indexOf('\n'));
    const plus = /^\+\+\+ b\/(.+)$/m.exec(body)?.[1];
    const minus = /^--- a\/(.+)$/m.exec(body)?.[1];
    const renamed = /^rename to (.+)$/m.exec(body)?.[1];
    const fromHeader = / b\/(.+)$/.exec(header)?.[1];
    const path = plus ?? renamed ?? minus ?? fromHeader ?? '(unknown)';
    const status: ReviewFile['status'] = /^new file mode/m.test(body)
      ? 'added'
      : /^deleted file mode/m.test(body)
        ? 'deleted'
        : /^rename (from|to) /m.test(body)
          ? 'renamed'
          : 'modified';
    chunks.push({ path, status, body });
  }
  return chunks;
}

function countLines(body: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * 讀未追蹤檔（審查 S1）：先 lstat——符號連結只回目標（不跟過去讀）、不是一般檔案（FIFO、裝置、socket）略過；
 * realpath 必須在 repo 裡；開檔 O_RDONLY|O_NOFOLLOW（lstat 之後被換成連結也打不開），開完再確認是一般檔案。
 * 二進位（有 NUL）不送內容；超過上限只讀前面。回 null＝略過。
 */
export async function readUntracked(
  root: string,
  path: string,
  max: number,
): Promise<{ text: string; size: number; symlink: boolean } | null> {
  const full = join(root, path);
  const info = await lstat(full);
  if (info.isSymbolicLink()) {
    const target = await readlink(full).catch(() => '?');
    return { text: `(symlink -> ${target}; content not included)\n`, size: 0, symlink: true };
  }
  if (!info.isFile()) return null;
  const realRoot = await realpath(root);
  const real = await realpath(full);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return null;
    const size = opened.size;
    const buffer = Buffer.alloc(Math.min(size, max + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.includes(0))
      return { text: '(binary file, content not included)\n', size, symlink: false };
    return { text: head.toString('utf8'), size, symlink: false };
  } finally {
    await handle.close();
  }
}

/** 依上限組全文與摘要。chunks 已排好順序。 */
export function assemble(chunks: readonly SourceChunk[], limits: ReviewDiffLimits): ReviewDiff {
  const files: ReviewFile[] = [];
  const parts: string[] = [];
  let total = 0;
  let additions = 0;
  let deletions = 0;
  let truncatedAny = false;
  for (const chunk of chunks) {
    const counts = countLines(chunk.body);
    additions += counts.additions;
    deletions += counts.deletions;
    let body = chunk.body;
    let truncated = chunk.sourceTruncated ?? false;
    if (bytes(body) > limits.fileMaxBytes) {
      body = clipBytes(body, limits.fileMaxBytes);
      truncated = true;
    }
    if (truncated && !chunk.skip)
      body = `${body.replace(/\n?$/, '\n')}[... truncated: this file is larger than the review limit ...]\n`;
    const size = bytes(body);
    const sensitive = chunk.sensitive === true;
    const omitted = sensitive || chunk.skip === true || total + size > limits.totalMaxBytes;
    if (!omitted) {
      parts.push(body);
      total += size;
    }
    truncatedAny ||= truncated || omitted;
    files.push({
      path: chunk.path,
      status: chunk.status,
      additions: counts.additions,
      deletions: counts.deletions,
      bytes: omitted ? 0 : size,
      truncated,
      omitted: sensitive ? 'sensitive' : omitted,
    });
  }
  const sensitiveFiles = files.filter((f) => f.omitted === 'sensitive').map((f) => f.path);
  if (sensitiveFiles.length > 0) {
    parts.push(
      `[... ${sensitiveFiles.length} changed file(s) look like secrets and were not included: ${sensitiveFiles.join(', ')} ...]\n`,
    );
  }
  const omittedFiles = files.filter((f) => f.omitted === true).map((f) => f.path);
  if (omittedFiles.length > 0) {
    parts.push(
      `[... ${omittedFiles.length} more changed file(s) not included because the review size limit was reached: ${omittedFiles.join(', ')} ...]\n`,
    );
  }
  return {
    text: parts.join(''),
    summary: { files, additions, deletions, totalBytes: total, truncated: truncatedAny },
  };
}

/** session 的未 commit 變更：`git diff HEAD`（含 staged）＋未追蹤檔內容。 */
export async function sessionDiff(
  cwd: string,
  limits: ReviewDiffLimits = DEFAULT_DIFF_LIMITS,
): Promise<ReviewDiff> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  // 還沒有任何 commit 的 repo：和空樹比。
  const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    (out) => out.trim() || EMPTY_TREE,
    () => EMPTY_TREE,
  );
  const diff = await git(root, [...DIFF_FLAGS, head, '--', ':(top)', ...SENSITIVE_PATHSPECS]);
  const chunks: SourceChunk[] = splitDiff(diff);
  chunks.push(...(await sensitiveChanges(root, [head])));
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    // Agent Board 自己裝的 hook 設定（§4.1，未追蹤）不是使用者的變更，不送審。
    .filter((path) => path && path !== HOOK_SETTINGS_FILE)
    .sort();
  for (const [i, path] of untracked.entries()) {
    const full = resolve(root, path);
    // 只讀 repo 裡面的（ls-files 本來就不會給外面的，保險）。
    const rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    if (i >= UNTRACKED_MAX_FILES) {
      chunks.push({ path, status: 'untracked', body: '', skip: true });
      continue;
    }
    if (isSensitivePath(path)) {
      chunks.push({ path, status: 'untracked', body: '', sensitive: true });
      continue;
    }
    try {
      const read = await readUntracked(root, path, limits.fileMaxBytes);
      if (!read) continue;
      const { text, size } = read;
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      const body = `--- /dev/null (untracked)\n+++ b/${path}\n${lines.map((l) => `+${l}`).join('\n')}\n`;
      chunks.push({ path, status: 'untracked', body, sourceTruncated: size > limits.fileMaxBytes });
    } catch {
      // 讀到一半消失或沒有權限：略過。
    }
  }
  return assemble(chunks, limits);
}

/** 分支相對 base：`git diff <base>...<branch>`。兩個名稱都先驗證（不會被當成 git 參數）。 */
export async function branchDiff(
  cwd: string,
  branch: string,
  base: string,
  limits: ReviewDiffLimits = DEFAULT_DIFF_LIMITS,
): Promise<ReviewDiff> {
  for (const ref of [branch, base]) {
    if (!REF.test(ref) || ref.includes('..')) {
      throw new ReviewDiffError('invalid_ref', `Invalid branch name: ${ref}`);
    }
    await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => {
      throw new ReviewDiffError('unknown_ref', `Branch not found: ${ref}`);
    });
  }
  const range = `${base}...${branch}`;
  const diff = await git(cwd, [...DIFF_FLAGS, range, '--', ':(top)', ...SENSITIVE_PATHSPECS]);
  return assemble([...splitDiff(diff), ...(await sensitiveChanges(cwd, [range]))], limits);
}

/** 不讀 textconv（會執行設定裡的轉換程式）、不跑外部 diff、不上色。 */
const DIFF_FLAGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];

/** 被排除的機密檔：只列名稱與狀態（name-status），不讀內容。 */
async function sensitiveChanges(cwd: string, revs: readonly string[]): Promise<SourceChunk[]> {
  const out = await git(cwd, ['diff', '--name-status', '--no-renames', '-z', ...revs, '--']);
  const fields = out.split('\0').filter(Boolean);
  const chunks: SourceChunk[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]!;
    const path = fields[i + 1]!;
    if (!isSensitivePath(path)) continue;
    const status: ReviewFile['status'] =
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    chunks.push({ path, status, body: '', sensitive: true });
  }
  return chunks;
}
