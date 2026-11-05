// 航班條、待處理清單共用的小元件（STYLE.md §5）。
import { useEffect, useState } from 'react';
import { QUEUE_DETAIL_RATE_LIMITED } from '@agent-board/protocol';
import type { Machine, PermissionMode, Project, Session } from '@agent-board/protocol';
import { useT, useLocale } from '../shared/i18n';
import { HANDS_LINE, STATUS_VISUAL } from '../shared/status';
import { useBoard } from '../shared/store';
import { contextPercent, formatTokens } from './usage';
import { useProjects } from './useBoardLoad';

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

export function Lamp({ status }: { status: Session['status'] }) {
  const t = useT();
  const v = STATUS_VISUAL[status];
  return (
    <span className={`lamp l-${v.holder}`}>
      <i aria-hidden="true">{v.glyph}</i>
      {t(v.labelKey)}
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

  switch (STATUS_VISUAL[session.status].holder) {
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
