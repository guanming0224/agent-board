// 機器面板（發版與自動更新，docs/release-update-spec.md §7）的純函式：把 hub 給的 MachineRelease 轉成畫面要顯示的狀態、
// 哪些按鈕不能按與為什麼、canary 跑了多久。不碰 React、不碰網路，畫面與測試共用。
import {
  type TargetNote,
  canarySoakMs,
  compareVersions,
  LEGACY_CANARY_SOAK_HOURS,
  ReleaseRepo,
  UPDATE_FAILED,
  UPDATE_IN_PROGRESS,
  type GhState,
  type MachineRelease,
  type ReleaseOverview,
  type UpdatePhase,
  type UpdateReason,
  type UpdateState,
} from '@agent-board/protocol';

/** 下載進度（UpdateState.progress，§21.12）。 */
export type DownloadProgress = NonNullable<UpdateState['progress']>;

/**
 * 一台機器的更新狀態（畫面上那一格）。順序就是優先序：相容性問題最先講（連不上就談不上更新），
 * 再來是正在進行、延後、失敗，最後才比版本。
 */
export type ReleaseStatus =
  /** hub 收不了這台 daemon 的協定：要先更新 hub。 */
  | { kind: 'hub_too_old' }
  /** daemon 太舊，hub 拒絕：要更新 daemon（會每 5 分鐘再試）。 */
  | { kind: 'needs_update' }
  | {
      kind: 'updating';
      phase: UpdatePhase;
      toVersion: string | null;
      /** 下載中的進度（新 daemon＋新 hub 才有）。 */
      progress: DownloadProgress | null;
    }
  | { kind: 'deferred'; reason: UpdateReason | null; toVersion: string | null }
  | { kind: 'failed'; phase: UpdatePhase; reason: UpdateReason | null; toVersion: string | null }
  /** 舊 daemon 沒回報版本。 */
  | { kind: 'unknown' }
  /** 開發模式（不是安裝程式裝的）：daemon 回 idle＋not_installed，不會自動更新。 */
  | { kind: 'dev' }
  /** 手動回滾成功（hub 收到 succeeded＋rollback_requested）：停在上一版，不再自動更新回去前要人處理。 */
  | { kind: 'rolled_back'; toVersion: string | null }
  /** 沒有目標版本：沒有成品的平台（Linux）或還沒有 Release。 */
  | { kind: 'no_target'; note: TargetNote | null }
  | { kind: 'latest' }
  /** 有新版但還沒開始（離線、下次連上才更新）。 */
  | { kind: 'pending'; toVersion: string };

export function releaseStatus(m: MachineRelease): ReleaseStatus {
  if (m.compat === 'hub_too_old') return { kind: 'hub_too_old' };
  if (m.compat === 'needs_update') return { kind: 'needs_update' };
  const update = m.update;
  if (update && UPDATE_IN_PROGRESS.includes(update.phase)) {
    return {
      kind: 'updating',
      phase: update.phase,
      toVersion: update.toVersion,
      progress: update.phase === 'downloading' ? (update.progress ?? null) : null,
    };
  }
  if (update?.phase === 'deferred') {
    return { kind: 'deferred', reason: update.reason, toVersion: update.toVersion };
  }
  // 失敗之後版本已經是目標（例如後來手動更新成功、或目標改回舊版）就不再顯示失敗。
  if (
    update &&
    UPDATE_FAILED.includes(update.phase) &&
    !(m.version && m.version === m.targetVersion)
  ) {
    return {
      kind: 'failed',
      phase: update.phase,
      reason: update.reason,
      toVersion: update.toVersion,
    };
  }
  if (isDev(m)) return { kind: 'dev' };
  if (update?.phase === 'succeeded' && update.reason === 'rollback_requested') {
    return { kind: 'rolled_back', toVersion: update.toVersion ?? m.version };
  }
  if (!m.version) return { kind: 'unknown' };
  if (!m.targetVersion) return { kind: 'no_target', note: m.targetNote ?? null };
  if (m.version === m.targetVersion) return { kind: 'latest' };
  return { kind: 'pending', toVersion: m.targetVersion };
}

/** 開發模式的 daemon（idle＋not_installed）：不能自動更新，也沒有版本資料夾可回滾。 */
const isDev = (m: MachineRelease): boolean =>
  m.update?.phase === 'idle' && m.update.reason === 'not_installed';

/** 狀態的語氣：fault 紅（失敗、要人處理）、you 琥珀（延後、要更新）、其他不上色。 */
export function statusTone(status: ReleaseStatus): 'fault' | 'you' | 'plain' {
  switch (status.kind) {
    case 'failed':
    case 'hub_too_old':
      return 'fault';
    case 'deferred':
    case 'needs_update':
      return 'you';
    default:
      return 'plain';
  }
}

/** 「立即更新」不能按的原因（i18n 鍵的尾巴）；可以按回 null。權限另外判斷。 */
export function updateBlock(
  m: MachineRelease,
): 'dev' | 'offline' | 'busy' | 'no_target' | 'latest' | null {
  if (isDev(m)) return 'dev';
  if (!m.online) return 'offline';
  if (m.update && UPDATE_IN_PROGRESS.includes(m.update.phase)) return 'busy';
  if (!m.targetVersion) return 'no_target';
  const failed = m.update !== null && UPDATE_FAILED.includes(m.update.phase);
  // 已經是目標版本、上次也沒失敗：沒東西可更新。失敗過就讓人再試一次（hub：「不管上次失敗過」）。
  if (m.version === m.targetVersion && !failed) return 'latest';
  return null;
}

/** 「回滾到上一版」不能按的原因；可以按回 null。 */
export function rollbackBlock(
  m: MachineRelease,
): 'dev' | 'offline' | 'busy' | 'no_previous' | 'previous_unsupported' | null {
  if (isDev(m)) return 'dev';
  if (!m.previousVersion) return 'no_previous';
  // 0.0.0-legacy 或比第一個有自動更新的版本舊：hub 也會擋（W6）。
  if (m.canRollback === false) return 'previous_unsupported';
  if (!m.online) return 'offline';
  if (m.update && UPDATE_IN_PROGRESS.includes(m.update.phase)) return 'busy';
  return null;
}

export interface CanarySoak {
  /** canary 已經跑了多久（毫秒）；沒有 canary 為 null。 */
  ms: number | null;
  /** 門檻（小時）：hub 的設定 `canarySoakHours`；0＝不檢查。舊 hub 沒帶＝舊行為 24。 */
  hours: number;
  /** 門檻 > 0 而且還沒跑滿（升 stable 要再確認一次）。門檻 0 一律 false。 */
  short: boolean;
}

/** 升 stable 前 canary 至少要跑幾小時：新 hub 帶設定值；舊 hub 沒有這個欄位＝固定 24 小時（舊行為）。 */
export const soakHoursOf = (overview: Pick<ReleaseOverview, 'canarySoakHours'>): number =>
  overview.canarySoakHours ?? LEGACY_CANARY_SOAK_HOURS;

export function canarySoak(
  overview: Pick<ReleaseOverview, 'canaryStats' | 'canarySoakHours'>,
  now: number,
): CanarySoak {
  const hours = soakHoursOf(overview);
  const since = overview.canaryStats.since;
  const at = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(at)) return { ms: null, hours, short: hours > 0 };
  const ms = Math.max(0, now - at);
  return { ms, hours, short: hours > 0 && ms < canarySoakMs(hours) };
}

/** 「升為 stable」能不能按：要有 canary，而且比 stable 新。 */
export function promoteBlock(
  overview: Pick<ReleaseOverview, 'canary' | 'stable'>,
): 'no_canary' | 'same' | null {
  if (!overview.canary) return 'no_canary';
  if (overview.stable && compareVersions(overview.canary, overview.stable) <= 0) return 'same';
  return null;
}

/** 期間有沒有出事（ERR、斷線、更新失敗任一 > 0）：數字要標紅提醒。 */
export const canaryTroubled = (stats: ReleaseOverview['canaryStats']): boolean =>
  stats.errors + stats.disconnects + stats.updateFailures > 0;

/** 時長拆成天／時／分（畫面依語言組字）。 */
export function spanParts(ms: number): { d: number; h: number; m: number } {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  return {
    d: Math.floor(totalMin / (24 * 60)),
    h: Math.floor((totalMin % (24 * 60)) / 60),
    m: totalMin % 60,
  };
}

/** gh 的狀態要不要標成問題（畫面上警示框）。 */
export const ghProblem = (state: GhState): boolean => state !== 'ok' && state !== 'unknown';

/** buildId 只顯示前 8 碼。 */
export const shortBuild = (buildId: string | null): string | null =>
  buildId ? buildId.slice(0, 8) : null;

/** repo 欄位的格式（protocol 的 ReleaseRepo：`owner/name`，前後空白會去掉）。 */
export const isRepo = (value: string): boolean => ReleaseRepo.safeParse(value).success;

/** 翻譯函式（useT() 或 translate 綁好語言）。 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function formatAge(ms: number, t: Translate): string {
  const { d, h, m } = spanParts(ms);
  if (d > 0) return t('machines.span.dhm', { d, h });
  if (h > 0) return t('machines.span.hm', { h, m });
  return t('machines.span.m', { m });
}

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** 位元組／秒 → `1.2 MB/s` 或 `350 KB/s`。 */
export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec >= 1024 * 1024
    ? `${mib(bytesPerSec)} MB/s`
    : `${Math.round(bytesPerSec / 1024)} KB/s`;
}

/** 下載中：`下載中 42%（12.3/29.8 MB，1.2 MB/s）`；第 2 次以後的嘗試加「第 n 次嘗試」（§21.12）。 */
export function downloadText(progress: DownloadProgress, t: Translate): string {
  const pct = Math.min(100, Math.floor((progress.received / progress.total) * 100));
  const text = t('machines.download.progress', {
    pct,
    received: mib(progress.received),
    total: mib(progress.total),
    speed: formatSpeed(progress.bytesPerSec),
  });
  return progress.attempt > 1
    ? `${text}${t('machines.download.attempt', { attempt: progress.attempt })}`
    : text;
}

/** 更新狀態的文字（含原因代碼的翻譯）。 */
export function statusText(status: ReleaseStatus, t: Translate): string {
  const reason = (code: string | null) => t(`machines.reason.${code ?? 'none'}`);
  switch (status.kind) {
    case 'updating':
      if (status.progress && status.progress.total > 0) {
        return t('machines.status.updating', { phase: downloadText(status.progress, t) });
      }
      return t('machines.status.updating', { phase: t(`machines.phase.${status.phase}`) });
    case 'deferred':
      return t('machines.status.deferred', { reason: reason(status.reason) });
    case 'failed':
      return t(
        status.phase === 'rolled_back'
          ? 'machines.status.rolled_back'
          : status.phase === 'rollback_failed'
            ? 'machines.status.rollback_failed'
            : 'machines.status.failed',
        { reason: reason(status.reason) },
      );
    case 'rolled_back':
      return t('machines.status.rolledBackTo', { version: status.toVersion ?? '?' });
    case 'pending':
      return t('machines.status.pending', { version: status.toVersion });
    case 'no_target':
      return status.note ? t(`machines.note.${status.note}`) : t('machines.status.no_target');
    default:
      return t(`machines.status.${status.kind}`);
  }
}

/**
 * session host 那一段要顯示什麼（事故 9，CONTRACTS §20.8）。hidden＝不顯示（離線、舊 daemon 沒回報、一切正常）。
 * restart：按鈕狀態——ok 能按；old_daemon 舊 daemon 不認得指令；unsupported 這台不能自己重啟（Windows、沒有服務名稱）。
 */
export type SessionHostView =
  | { kind: 'hidden' }
  | {
      kind: 'suspect' | 'legacy' | 'unusable';
      restart: 'ok' | 'old_daemon' | 'unsupported';
    };

export function sessionHostView(m: MachineRelease): SessionHostView {
  const state = m.sessionHost;
  if (!m.online || !state) return { kind: 'hidden' };
  const restart = !m.sessionHostRestartSupported
    ? 'old_daemon'
    : state.canRestart
      ? 'ok'
      : 'unsupported';
  if (state.inputSuspect) return { kind: 'suspect', restart };
  if (state.mode === 'legacy') return { kind: 'legacy', restart };
  if (state.mode === 'unusable') return { kind: 'unusable', restart };
  return { kind: 'hidden' };
}

/** 重啟 session host 前要特別提醒的 session 狀態（正在跑、等你允許、等你看計畫：重啟會中斷它們）。 */
export const BUSY_FOR_HOST_RESTART: readonly string[] = [
  'running',
  'waiting_permission',
  'plan_review',
];
