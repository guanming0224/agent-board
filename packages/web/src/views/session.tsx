// 航班條、待處理清單共用的小元件（STYLE.md §5）。
import { useEffect, useState } from 'react';
import { QUEUE_DETAIL_RATE_LIMITED } from '@agent-board/protocol';
import type { AgentKind, Machine, PermissionMode, Project, Session } from '@agent-board/protocol';
import { useT, useLocale } from '../shared/i18n';
import {
  codeClass,
  HANDS_LINE,
  statusCode,
  statusGlyph,
  statusLabelKey,
  visualOf,
  type StatusCode,
} from '../shared/status';
import { useBoard } from '../shared/store';
import { contextPercent, formatTokens } from './usage';
import { useProjects } from './useBoardLoad';
import '../shared/styles/status.css';

type T = ReturnType<typeof useT>;

export function handsClass(mode: PermissionMode): string {
  return `h-${HANDS_LINE[mode]}`;
}

export function callsign(session: Session, machines: Machine[], projects: Project[]): string {
  const machine = machines.find((m) => m.id === session.machineId)?.name ?? session.machineId;
  const project =
    projects.find((p) => p.id === session.projectId)?.name ??
    session.cwd.split(/[\\/]/).filter(Boolean).pop() ??
    session.cwd;
  return session.branch ? `${machine} / ${project} @ ${session.branch}` : `${machine} / ${project}`;
}

export function Callsign({ session }: { session: Session }) {
  const machines = useBoard((s) => s.machines);
  const projects = useProjects((s) => s.projects);
  return <span className="callsign">{callsign(session, machines, projects)}</span>;
}

/**
 * 狀態燈：符號＋英文狀態代碼（GM 2026-11-08，代碼與顏色見 shared/status.ts 的 statusCode）。
 * 完整說明（分得出錯誤／卡住、剛開好／啟動中）放在 title 與 aria-label。
 * badge：實心膠囊徽章（shared/styles/status.css），卡片標題列與圖例用，只顯示代碼；
 * 不是徽章的（清單、成員列）代碼後面再接一段說明文字。
 * detail 是 session 的 statusDetail、awaiting 是 hub 算的等隊長／等成員結果（判斷 NEW 要用）；
 * 只有狀態沒有 session 時（例如狀態變化紀錄）可以不給。
 */
export function Lamp({
  status,
  detail = null,
  awaiting,
  badge = false,
}: {
  status: Session['status'];
  detail?: string | null;
  awaiting?: Session['awaiting'];
  badge?: boolean;
}) {
  const t = useT();
  const session = { status, statusDetail: detail, awaiting };
  return (
    <CodeChip
      code={statusCode(session)}
      glyph={statusGlyph(session)}
      label={t(statusLabelKey(session))}
      badge={badge}
      data={{ 'data-status': status }}
    />
  );
}

/**
 * 代碼徽章的畫法只有這一份（Lamp 與 flows 的 StatusBadge 共用）：符號＋代碼，說明在 title／aria-label。
 * 不是徽章時代碼後面接說明文字。
 */
export function CodeChip({
  code,
  glyph,
  label,
  badge = false,
  data,
}: {
  code: StatusCode;
  glyph: string;
  label: string;
  badge?: boolean;
  data?: Record<`data-${string}`, string>;
}) {
  const t = useT();
  const full = t('status.title', { code, label });
  return (
    <span
      className={`lamp ${codeClass(code)}${badge ? ' badge' : ''}`}
      data-code={code}
      {...data}
      role="img"
      title={full}
      aria-label={full}
    >
      <i aria-hidden="true">{glyph}</i>
      <span className="code">{code}</span>
      {!badge && <span className="lamp-label">{label}</span>}
    </span>
  );
}

export function ModeChip({ mode }: { mode: PermissionMode }) {
  const t = useT();
  return mode === 'bypassPermissions' ? (
    <span className="chip mode bypass">{t('views.mode.bypass')}</span>
  ) : (
    <span className="chip mode">{mode}</span>
  );
}

/** 跑的是 Codex CLI（CONTRACTS §19）。Claude Code 是預設，不標。 */
export function AgentChip({ session }: { session: { agent?: AgentKind } }) {
  const t = useT();
  if (session.agent !== 'codex') return null;
  return (
    <span className="chip agent" data-testid="agent-chip" title={t('views.agent.codex.title')}>
      {t('views.agent.codex')}
    </span>
  );
}

/** 唯讀 session（建立時拿掉改檔工具）。只擋 Edit、Write 等工具，Bash 仍寫得了檔案，title 說清楚。 */
export function ReadOnlyChip({ session }: { session: { readOnly: boolean } }) {
  const t = useT();
  if (!session.readOnly) return null;
  return (
    <span className="chip read-only" title={t('views.readOnly.title')}>
      {t('views.readOnly')}
    </span>
  );
}

/** 由哪個 session 用派工工具開的（CONTRACTS §11）。找不到那個 session（已刪除）就不顯示。 */
export function DispatchedByChip({ session }: { session: { dispatchedBy?: string | null } }) {
  const t = useT();
  const name = useBoard((s) =>
    session.dispatchedBy ? s.sessions.find((x) => x.id === session.dispatchedBy)?.name : undefined,
  );
  if (!name) return null;
  return (
    <span
      className="chip dispatched-by"
      title={t('views.dispatchedBy.title', { name })}
      data-testid="dispatched-by"
    >
      {t('views.dispatchedBy', { name })}
    </span>
  );
}

export function Meter({ percent, label }: { percent: number; label: string }) {
  const tone = percent >= 85 ? ' f' : percent >= 60 ? ' w' : '';
  return (
    <div
      className={`m${tone}`}
      role="meter"
      aria-label={label}
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <i style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

/**
 * context 用量。上限由 daemon 依模型回報；不知道上限時只寫 token 數，不畫比例，
 * 提示框說明原因（多數模型是 1M，用 200k 硬算會誤報）。
 */
export function ContextUsage({
  tokens,
  window = null,
}: {
  tokens: number | null;
  window?: number | null;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const percent = contextPercent(tokens, window);
  const text =
    percent !== null ? `${percent}%` : tokens !== null ? formatTokens(tokens, locale) : '—';
  const title =
    window !== null
      ? t('views.ctx.window', { window: formatTokens(window, locale) })
      : tokens !== null
        ? t('views.ctx.unknownWindow')
        : undefined;
  return (
    <div className="ctx" title={title} data-testid="context-usage">
      <span>context</span>
      <Meter percent={percent ?? 0} label="context" />
      <span className="num">{text}</span>
    </div>
  );
}

/** 相對時間每 5 秒更新；hub 斷線時內容凍結，時間也跟著停。 */
export function useNow(): number {
  const connected = useBoard((s) => s.connected);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!connected) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [connected]);
  return now;
}

export function formatSpan(ms: number, t: T): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return t('views.span.sec', { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t('views.span.min', { n: min });
  const hour = Math.floor(min / 60);
  if (hour < 24) return t('views.span.hour', { n: hour });
  return t('views.span.day', { n: Math.floor(hour / 24) });
}

export function useClock() {
  const locale = useLocale((s) => s.locale);
  return (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 每張卡都有時間（規則四）；提示框放完整時間（STYLE.md §6）。 */
export function Age({ session }: { session: Session }) {
  const t = useT();
  const now = useNow();
  const clock = useClock();
  const machines = useBoard((s) => s.machines);
  const locale = useLocale((s) => s.locale);
  const span = (iso: string) => formatSpan(now - Date.parse(iso), t);
  const output = session.lastOutputAt;
  let text: string;
  let at: string | null = session.statusSince;

  // 剛開好（NEW）不是在等你回覆，只寫「多久前」（views.age.since）。
  switch (statusCode(session) === 'NEW' ? 'agent' : visualOf(session.status).holder) {
    case 'you':
      text = t('views.age.waiting', { span: span(session.statusSince) });
      break;
    case 'quota':
      text = t('views.age.quota', { span: span(session.statusSince) });
      break;
    case 'fault':
      if (session.status === 'error') {
        text = t('views.age.error', { span: span(session.statusSince) });
      } else {
        at = output && output < session.statusSince ? output : session.statusSince;
        text = t('views.age.silent', { span: span(at) });
      }
      break;
    case 'agent':
      if (session.status === 'queued' && session.statusDetail === QUEUE_DETAIL_RATE_LIMITED) {
        // §8-5：說清楚在等什麼，不然看起來像卡住。
        text = t('views.age.queuedLimit', { span: span(session.statusSince) });
      } else if (session.status === 'running') {
        at = output;
        text = output ? t('views.age.output', { span: span(output) }) : t('views.age.noOutput');
      } else {
        text = t('views.age.since', { span: span(session.statusSince) });
      }
      break;
    default:
      if (session.status === 'done') {
        text = t('views.age.done', { span: span(session.statusSince) });
      } else {
        at = machines.find((m) => m.id === session.machineId)?.lastSeenAt ?? output;
        text = at ? t('views.age.lastSeen', { time: clock(at) }) : t('views.age.lastSeenNever');
      }
  }

  return (
    <span className="age num" title={at ? new Date(at).toLocaleString(locale) : undefined}>
      {text}
    </span>
  );
}
