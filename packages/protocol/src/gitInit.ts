// 不是 git 的資料夾（GM 2026-11-13，CONTRACTS §24）：一鍵 git init 與團隊「共用資料夾」。
// daemon（執行）、hub（轉送、權限、audit）、網頁（按鈕與結果）共用這裡的常數與格式。
import { z } from 'zod';

/** daemon 在 hello `features` 宣告：認得 `fs.gitInit`。舊 daemon 沒有 → hub 回 409 `daemon_too_old`。 */
export const GIT_INIT_FEATURE = 'fs.gitInit';

/** 預設分支。 */
export const GIT_INIT_BRANCH = 'main';
/** 第一個 commit 的訊息（固定）。 */
export const GIT_INIT_COMMIT_MESSAGE = 'Agent Board：初始 commit';
/** 使用者沒設定 git 身分時，只對這一次 commit 用 `-c user.name=… -c user.email=…` 帶的值（不改任何 git 設定檔）。 */
export const GIT_INIT_FALLBACK_NAME = 'Agent Board';
export const GIT_INIT_FALLBACK_EMAIL = 'agent-board@localhost';
/** 單一檔案超過這個大小就不 commit（寫進 `.git/info/exclude`，只在這台、不進版控）。 */
export const GIT_INIT_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 回報裡最多列幾個略過的大檔（其餘只算數量）。 */
export const GIT_INIT_SKIPPED_LIST_MAX = 50;

/**
 * 資料夾裡沒有 `.gitignore` 時建立的內容（已有就不動）。順序：相依套件與建置產物、密鑰、系統檔。
 * 密鑰類放進來是為了第一個 commit 不會把 `.env`、私鑰收進版控。
 */
export const DEFAULT_GITIGNORE_LINES = [
  '# Agent Board 建立（git init 時資料夾裡沒有 .gitignore）',
  'node_modules/',
  'dist/',
  'build/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.terraform/',
  '*.tfstate',
  '*.tfstate.*',
  '.env',
  '.env.*',
  '!.env.example',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.aws/',
  '.ssh/',
  '.gnupg/',
  'credentials.json',
  'service-account*.json',
  'client_secret*.json',
  'token.json',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.ppk',
  '*.kdbx',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '.DS_Store',
  'Thumbs.db',
] as const;

/**
 * 拒絕的原因。
 * - not_absolute：不是絕對路徑（`~` 開頭會先展開成家目錄）。
 * - not_found／not_directory：資料夾不存在、不是資料夾。
 * - already_repo：資料夾本身或任何上層已經在某個 git repo 裡（`git rev-parse --absolute-git-dir` 成功）、
 *   路徑中有一段是 `.git`，或資料夾裡已有 `.git`。rev-parse 失敗但不是「not a git repository」（例如 dubious ownership）→ git_failed。
 * - too_broad：系統根目錄（`/`、`C:\`）、磁碟或網路碟的根目錄（POSIX 掛載點）、家目錄本身與它的上層、
 *   家目錄底下的標準大資料夾（Desktop、Documents…）與以 `.` 開頭的資料夾、iCloud／CloudStorage 根目錄、
 *   系統資料夾（`/usr`、`C:\Windows`…）、暫存資料夾本身（見 `tooBroadReason`，daemon/src/gitInit.ts）。
 * - busy：同一個資料夾已經有一次 git init 在跑（兩個分頁同時按），這次沒做任何事。
 * - git_missing：這台找不到 git。
 * - git_failed：git 指令失敗（訊息是 git 的錯誤，已截斷）；建到一半的 `.git` 與剛建的 `.gitignore` 會收掉。
 */
export const GitInitErrorCode = z.enum([
  'not_absolute',
  'not_found',
  'not_directory',
  'already_repo',
  'too_broad',
  'busy',
  'git_missing',
  'git_failed',
]);
export type GitInitErrorCode = z.infer<typeof GitInitErrorCode>;

export const GitInitSkipped = z.object({
  /** 相對於資料夾，`/` 分隔。 */
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type GitInitSkipped = z.infer<typeof GitInitSkipped>;

export const GitInitResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** 實際 init 的資料夾（展開 `~`、解析符號連結後）。 */
    path: z.string(),
    branch: z.string(),
    /** 第一個 commit 的 hash。 */
    commit: z.string(),
    /** 這次建立了 `.gitignore`（原本沒有）。 */
    gitignoreCreated: z.boolean(),
    /** user：用使用者自己的 git 身分；fallback：沒設定，這次 commit 用 Agent Board 的固定身分。 */
    identity: z.enum(['user', 'fallback']),
    /** commit 進去的檔案數。 */
    files: z.number().int().nonnegative(),
    /** 超過 `GIT_INIT_MAX_FILE_BYTES` 沒 commit 的檔案（最多列 `GIT_INIT_SKIPPED_LIST_MAX` 個）。 */
    skipped: z.array(GitInitSkipped).max(GIT_INIT_SKIPPED_LIST_MAX),
    /** 略過但沒列出來的數量。 */
    skippedMore: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    path: z.string(),
    code: GitInitErrorCode,
    /** 給人看的說明（英文、已截斷），網頁依 code 顯示中文，這個放在後面當細節。 */
    message: z.string().max(1000),
  }),
]);
export type GitInitResult = z.infer<typeof GitInitResult>;
