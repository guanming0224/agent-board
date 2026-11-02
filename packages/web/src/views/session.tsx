// 航班條、待處理清單共用的小元件（STYLE.md §5）。
import { useEffect, useState } from 'react';
import type { Machine, PermissionMode, Project, Session } from '@agent-board/protocol';
import { useT, useLocale } from '../shared/i18n';
import { HANDS_LINE, STATUS_VISUAL } from '../shared/status';
import { useBoard } from '../shared/store';
import { useProjects } from './useBoardLoad';

type T = ReturnType<typeof useT>;

/** Session 沒有帶模型的 context 上限，先用標準 200k 算比例。 */
const CONTEXT_WINDOW_TOKENS = 200_000;

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

export function ContextUsage({ tokens }: { tokens: number | null }) {
  const percent = tokens === null ? null : Math.round((tokens / CONTEXT_WINDOW_TOKENS) * 100);
  return (
    <div className="ctx">
      <span>context</span>
      <Meter percent={percent ?? 0} label="context" />
      <span className="num">{percent === null ? '—' : `${percent}%`}</span>
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
      if (session.status === 'running') {
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
