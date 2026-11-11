// 發版與自動更新（docs/release-update-spec.md、CONTRACTS §21）：版本號、平台、通道、更新狀態、協定相容。
// 純資料與純函式：hub、daemon、網頁共用，不碰檔案與網路。
import { z } from 'zod';
import { Id, IsoTime, MachineOs } from './models';

/**
 * hub ↔ daemon 協定版本（hello 的 `protocolVersion`）。不相容的改動才加一；加欄位、加訊息類型不用（舊的一方會忽略）。
 * hub 接受目前版與前一版的 daemon（`protocolCompat`），新一版的 daemon 也接受（canary 比 hub 先升級時，
 * 新 daemon 有責任照舊協定和舊 hub 說話）。
 */
export const PROTOCOL_VERSION = 1;
/** 舊 daemon（沒送 protocolVersion）＝第 1 版：加這個欄位之前的協定。 */
export const LEGACY_PROTOCOL_VERSION = 1;

export type ProtocolCompat = 'ok' | 'needs_update' | 'hub_too_old';

/** daemon 的協定版本 hub 收不收：比 hub 舊兩版以上要更新 daemon；比 hub 新兩版以上要先更新 hub。 */
export function protocolCompat(hubVersion: number, daemonVersion: number): ProtocolCompat {
  if (daemonVersion < hubVersion - 1) return 'needs_update';
  if (daemonVersion > hubVersion + 1) return 'hub_too_old';
  return 'ok';
}

/** 語意版本：`主.次.修`，可帶 `-預發布`（例如 `0.0.0-legacy`、`0.2.0-rc.1`）。不收 `+build`。 */
export const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const Version = z.string().regex(VERSION_PATTERN);
export type Version = z.infer<typeof Version>;

export const isVersion = (value: string): boolean => VERSION_PATTERN.test(value);

/** tag `v0.1.2` → `0.1.2`；不是版本 tag 回 null。 */
export function versionFromTag(tag: string): string | null {
  const version = tag.startsWith('v') ? tag.slice(1) : null;
  return version && isVersion(version) ? version : null;
}

/** 語意版本比較（semver 2.0 的優先順序）：a < b 回負數，相等 0，a > b 正數。不是版本字串的排在最前面。 */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_PATTERN.exec(a);
  const pb = VERSION_PATTERN.exec(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  const preA = pa[4];
  const preB = pb[4];
  // 沒有預發布的比有的大（1.0.0 > 1.0.0-rc.1）。
  if (preA === undefined || preB === undefined) {
    return (preA === undefined ? 1 : 0) - (preB === undefined ? 1 : 0);
  }
  const partsA = preA.split('.');
  const partsB = preB.split('.');
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i];
    const y = partsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 有成品的平台。Linux 沒有成品（`install.sh --from` 自己建），daemon 回報了也不會有更新目標。 */
export const RELEASE_PLATFORMS = ['darwin-arm64', 'win-x64'] as const;
export const ReleasePlatform = z.enum(RELEASE_PLATFORMS);
export type ReleasePlatform = z.infer<typeof ReleasePlatform>;

/** 這台機器的平台字串（`darwin-arm64`、`win-x64`、`linux-x64`…）。Node 的 win32 寫成 win。 */
export function platformKey(os: string, arch: string): string {
  return `${os === 'win32' ? 'win' : os}-${arch}`;
}

export const isReleasePlatform = (value: string): value is ReleasePlatform =>
  (RELEASE_PLATFORMS as readonly string[]).includes(value);

/** 成品檔名：`agent-board-<版本>-<平台>.tar.gz`，Windows 是 `.zip`。 */
export function releaseAssetName(version: string, platform: string): string {
  return `agent-board-${version}-${platform}.${platform.startsWith('win-') ? 'zip' : 'tar.gz'}`;
}

/** SHA256SUMS 的格式：每行 `<64 位小寫 hex>  <檔名>`（sha256sum 的輸出）。壞行略過。 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(\S+)\s*$/.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}

export const ReleaseChannel = z.enum(['canary', 'stable']);
export type ReleaseChannel = z.infer<typeof ReleaseChannel>;
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = 'stable';

/** 這個通道的目標版本：canary 跟 canary（沒有就跟 stable），stable 只跟 stable。 */
export function channelTarget(
  channel: ReleaseChannel,
  versions: { canary: string | null; stable: string | null },
): string | null {
  if (channel === 'canary') {
    const { canary, stable } = versions;
    if (canary && stable) return compareVersions(canary, stable) >= 0 ? canary : stable;
    return canary ?? stable;
  }
  return versions.stable;
}

/** hub 告訴 daemon 的更新目標：版本、成品檔名、SHA-256（hub 從 Release 的 SHA256SUMS 驗過）、大小。 */
export const ReleaseTarget = z.object({
  version: Version,
  platform: z.string(),
  asset: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export type ReleaseTarget = z.infer<typeof ReleaseTarget>;

/**
 * 更新進行到哪裡（`<dataDir>/update-state.json`，daemon 在 hello／`update.status` 回報）。
 * idle：沒事；deferred：延後（reason 說明）；downloading／installing／checking／rolling_back：進行中；
 * succeeded：成功；failed：沒換到新版就失敗（什麼都沒改）；rolled_back：換了但健康檢查沒過，已回到舊版；
 * rollback_failed：回滾也沒成功（要人處理）。
 */
export const UpdatePhase = z.enum([
  'idle',
  'deferred',
  'downloading',
  'installing',
  'checking',
  'rolling_back',
  'succeeded',
  'failed',
  'rolled_back',
  'rollback_failed',
]);
export type UpdatePhase = z.infer<typeof UpdatePhase>;

export const UPDATE_IN_PROGRESS: readonly UpdatePhase[] = [
  'downloading',
  'installing',
  'checking',
  'rolling_back',
];
export const UPDATE_FAILED: readonly UpdatePhase[] = ['failed', 'rolled_back', 'rollback_failed'];

/**
 * 原因代碼（畫面、推播用代碼翻成文字；`detail` 是程式自己的錯誤訊息，不含 Claude 寫的內容）。
 * waiting_permission：有 session 在等你允許；host_busy：這次要換 session host，但有 session 在工作；
 * not_installed：不是用安裝程式裝的（開發模式），不能自動更新；schema_changed：手動回滾跨過 hub.db 升級（會丟資料，
 * 不自動做）；interrupted：進行中的更新中斷（可重試）；其他是失敗原因。
 */
export const UpdateReason = z.enum([
  'waiting_permission',
  'host_busy',
  'not_installed',
  'unsupported_platform',
  'download_failed',
  'checksum_mismatch',
  'extract_failed',
  'backup_failed',
  'install_failed',
  'health_timeout',
  'rollback_requested',
  'no_previous',
  'schema_changed',
  'busy',
  /** 進行中的更新中斷了（daemon 重啟時還在下載、更新程式已經不在或超過 15 分鐘沒結束）。可以重試。 */
  'interrupted',
  /** 啟動不了更新程式（spawn 失敗）。 */
  'spawn_failed',
  /** 延後中的回滾被「立即更新」取代。 */
  'superseded',
  'unknown',
]);
export type UpdateReason = z.infer<typeof UpdateReason>;

export const UpdateState = z.object({
  phase: UpdatePhase,
  fromVersion: z.string().nullable(),
  toVersion: z.string().nullable(),
  reason: UpdateReason.nullable(),
  /** 程式產生的說明（錯誤訊息），最多 500 字。 */
  detail: z.string().max(500).nullable(),
  at: IsoTime,
  /** 寫這個狀態的程序（downloading＝daemon，其他進行中的階段＝更新程式）。舊版沒有。 */
  pid: z.number().int().positive().optional(),
  /** 這次更新開始的時間（判斷進行中的狀態是否過期）。舊版沒有。 */
  startedAt: IsoTime.optional(),
});
export type UpdateState = z.infer<typeof UpdateState>;

/**
 * 進行中的狀態的硬上限：更新程式還拿著鎖也一樣，超過就當作卡住（N2）。正常的更新（安裝、60 秒健康檢查、
 * 最多 5 分鐘等連上 hub、回滾）遠低於這個時間。
 */
export const UPDATE_STALE_MS = 60 * 60 * 1000;

/** 第一個有自動更新（scripts/updater.mjs、installer switch、daemon-status.json）的版本：更早的不能自動回滾過去。 */
export const FIRST_UPDATER_VERSION = '0.1.0';

/** 能不能從面板回滾到這一版：0.0.0-legacy 或比 FIRST_UPDATER_VERSION 舊的不行（健康檢查等不到舊 daemon）。 */
export function rollbackSupported(previousVersion: string | null): boolean {
  return (
    previousVersion !== null &&
    isVersion(previousVersion) &&
    compareVersions(previousVersion, FIRST_UPDATER_VERSION) >= 0
  );
}

/** 沒有發目標的原因（面板顯示）：hub_first＝等 hub 那台先升到這版；hub_update_failed＝hub 那台這版更新失敗，
 * 其他機器暫停；platform_unverified＝這個平台還沒實機驗證（win-x64）；node_too_old＝這台的 Node 主版本低於
 * 成品的最低版本（§21.10）。abi_mismatch 是 0.1.1 以前的 hub 用的，現在不再產生（原生模組是 N-API），留著相容。 */
export const TargetNote = z.enum([
  'hub_first',
  'hub_update_failed',
  /** 手動回滾後暫停剛退掉的那一版（M1）：「立即更新」或通道換成別的版本才解除。 */
  'rolled_back_hold',
  'platform_unverified',
  'node_too_old',
  'abi_mismatch',
]);
export type TargetNote = z.infer<typeof TargetNote>;

/**
 * 還沒在實機驗證過安裝與更新的平台：hub 照樣下載成品，但預設不發給這些平台的機器（W8）。
 * owner 可以對單一機器打開「允許自動更新」（settings `machineAllowUnverified:<id>`，§21.3）。
 */
export const UNVERIFIED_PLATFORMS: readonly string[] = ['win-x64'];

/** 延後條件（規格 §5 第 2 點）：有 PERM 就延後；這次要換 session host 而有 RUN／PERM／PLAN／starting 也延後。 */
export function updateDeferReason(
  statuses: readonly string[],
  needsHostRestart: boolean,
): 'waiting_permission' | 'host_busy' | null {
  if (statuses.includes('waiting_permission')) return 'waiting_permission';
  if (
    needsHostRestart &&
    statuses.some((s) => ['running', 'waiting_permission', 'plan_review', 'starting'].includes(s))
  ) {
    return 'host_busy';
  }
  return null;
}

/** 面板上一台機器的版本與更新狀態。 */
export const MachineRelease = z.object({
  machineId: Id,
  name: z.string(),
  os: MachineOs,
  online: z.boolean(),
  lastSeenAt: IsoTime.nullable(),
  /** daemon 回報的；舊 daemon 不送為 null。 */
  platform: z.string().nullable(),
  version: z.string().nullable(),
  buildId: z.string().nullable(),
  protocolVersion: z.number().int().nullable(),
  /** daemon 回報的 Node 版本（只供顯示，§21.10）；0.1.2 以前的 daemon 不送為 null。 */
  nodeVersion: z.string().nullable().optional(),
  /** 上一版（可以回滾到的版本）；不知道為 null。 */
  previousVersion: z.string().nullable(),
  channel: ReleaseChannel,
  /** 依通道算出的目標版本；沒有成品（例如 Linux）或還沒有 Release 為 null。 */
  targetVersion: z.string().nullable(),
  compat: z.enum(['ok', 'needs_update', 'hub_too_old']),
  /** 這台有 hub（hub 自己的更新也走這台的 daemon）。 */
  hasHub: z.boolean(),
  update: UpdateState.nullable(),
  /** targetVersion 是 null 的原因（有的話）。 */
  targetNote: TargetNote.nullable(),
  /** 能不能按「回滾到上一版」（rollbackSupported(previousVersion)）。 */
  canRollback: z.boolean(),
  /**
   * 這台回報的平台還沒實機驗證（UNVERIFIED_PLATFORMS，例如 win-x64）。舊 hub 不送＝false。
   * 面板依此顯示說明與「允許自動更新」按鈕。
   */
  unverifiedPlatform: z.boolean().default(false),
  /** owner 對這台打開了「允許自動更新」（settings `machineAllowUnverified:<id>`）。舊 hub 不送＝false。 */
  allowUnverified: z.boolean().default(false),
});
export type MachineRelease = z.infer<typeof MachineRelease>;

/** gh 的狀態：ok、找不到 gh、沒登入、其他錯誤、還沒檢查過、沒設定 repo。 */
export const GhState = z.enum(['ok', 'missing', 'not_logged_in', 'error', 'unknown', 'no_repo']);
export type GhState = z.infer<typeof GhState>;

export const CanaryStats = z.object({
  /** canary 目前版本開始當 canary 的時間；沒有 canary 為 null。 */
  since: IsoTime.nullable(),
  /** 期間 canary 機器上進入 ERR 的 session 數。 */
  errors: z.number().int().nonnegative(),
  /** 期間 canary 機器的 daemon 非預期斷線（崩潰、重啟）次數。 */
  disconnects: z.number().int().nonnegative(),
  /** 期間 canary 機器的更新失敗（含回滾）次數。 */
  updateFailures: z.number().int().nonnegative(),
});
export type CanaryStats = z.infer<typeof CanaryStats>;

/** 「升為 stable」建議 canary 先跑滿的時間（派工單：24 小時無錯誤再升）。 */
export const CANARY_SOAK_MS = 24 * 60 * 60 * 1000;

export const ReleaseOverview = z.object({
  hub: z.object({ version: z.string(), buildId: z.string(), protocolVersion: z.number().int() }),
  repo: z.string().nullable(),
  gh: z.object({ state: GhState, message: z.string().nullable() }),
  canary: z.string().nullable(),
  stable: z.string().nullable(),
  canaryStats: CanaryStats,
  /** release-cache 裡驗過 SHA-256 的版本（新到舊）與各自有的平台。 */
  cached: z.array(z.object({ version: z.string(), platforms: z.array(z.string()) })),
  lastCheckAt: IsoTime.nullable(),
  /** 上次檢查的錯誤（程式產生的訊息）；成功為 null。 */
  lastCheckError: z.string().nullable(),
  checking: z.boolean(),
  machines: z.array(MachineRelease),
});
export type ReleaseOverview = z.infer<typeof ReleaseOverview>;

/** GitHub repo（`owner/name`）。 */
export const ReleaseRepo = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

/** `GET /api/health`（public）：服務活著、版本。更新程式的健康檢查用它。 */
export const HealthInfo = z.object({
  ok: z.literal(true),
  version: z.string(),
  buildId: z.string(),
  protocolVersion: z.number().int(),
});
export type HealthInfo = z.infer<typeof HealthInfo>;

/** daemon 向 hub 下載成品的路徑（機器 token 驗證，不在 routes 表：回的是檔案不是 JSON）。 */
export const releaseDownloadPath = (version: string, platform: string): string =>
  `/api/releases/${encodeURIComponent(version)}/${encodeURIComponent(platform)}`;
