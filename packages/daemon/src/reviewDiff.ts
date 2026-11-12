// 交叉審查的 diff（Codex 第二輪，docs/codex-round2-spec.md §2-1）：只跑 git 讀資料，不改 repo、不呼叫任何模型。
// - session：工作資料夾 `git diff HEAD`（含 staged）＋未追蹤檔案的內容；
// - branch：`git diff <base>...<branch>`。
// 單檔超過上限截斷並標明；整份超過上限，後面的檔案只列名稱（omitted）。整份 diff 只留在 daemon 記憶體。
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      // 不讓 git 開分頁器、不跑使用者設定的外部 diff 工具。
      env: { ...process.env, GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '' },
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

/** sourceTruncated：讀檔時就只讀了前面；skip：太多檔案，只列名稱。 */
type SourceChunk = Chunk & { sourceTruncated?: boolean; skip?: boolean };

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

/** 讀未追蹤檔：二進位（有 NUL）不送內容；超過上限只讀前面。 */
async function readUntracked(path: string, max: number): Promise<{ text: string; size: number }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, max + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.includes(0)) return { text: '(binary file, content not included)\n', size };
    return { text: head.toString('utf8'), size };
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
    const omitted = chunk.skip === true || total + size > limits.totalMaxBytes;
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
      omitted,
    });
  }
  const omittedFiles = files.filter((f) => f.omitted).map((f) => f.path);
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
  const diff = await git(root, ['diff', '--no-color', '--no-ext-diff', head, '--']);
  const chunks: SourceChunk[] = splitDiff(diff);
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
    try {
      const { text, size } = await readUntracked(join(root, path), limits.fileMaxBytes);
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
  const diff = await git(cwd, ['diff', '--no-color', '--no-ext-diff', `${base}...${branch}`, '--']);
  return assemble(splitDiff(diff), limits);
}
