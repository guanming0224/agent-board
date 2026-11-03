// flows 各畫面共用的小元件與 hook。狀態語意一律從 shared/status.ts 取。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  Machine,
  PermissionMode,
  Project,
  Session,
  SessionStatus,
  User,
} from '@agent-board/protocol';
import { useLocale, useT } from '../shared/i18n';
import { HANDS_LINE, STATUS_VISUAL } from '../shared/status';
import { useBoard } from '../shared/store';

export type T = ReturnType<typeof useT>;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;

/** 呼號：`機器 / 專案 @ 分支`。沒有指定專案時用資料夾名稱，不是 git repo 時沒有 `@`。 */
export function callsign(
  session: Session,
  machines: readonly Machine[],
  projects: readonly Project[],
): string {
  const machine = machines.find((m) => m.id === session.machineId)?.name ?? session.machineId;
  const project = projects.find((p) => p.id === session.projectId)?.name ?? baseName(session.cwd);
  const head = `${machine} / ${project}`;
  return session.branch ? `${head} @ ${session.branch}` : head;
}

export function Callsign({ text }: { text: string }) {
  return <span className="callsign">{text}</span>;
}

export function ModeChip({ mode }: { mode: PermissionMode }) {
  const t = useT();
  if (mode === 'bypassPermissions') {
    return <span className="chip bypass">{t('flows.mode.bypassName')}</span>;
  }
  return <span className="chip">{mode}</span>;
}

/** 放手線的 class；元件本身要有 `position: relative`（`.card`、`.inbox-item` 已有）。 */
export const handsClass = (mode: PermissionMode) => `hands-${HANDS_LINE[mode]}`;

export function Lamp({ status }: { status: SessionStatus }) {
  const t = useT();
  const visual = STATUS_VISUAL[status];
  return (
    <span className={`lamp l-${visual.holder}`}>
      <i aria-hidden="true">{visual.glyph}</i>
      {t(visual.labelKey)}
    </span>
  );
}

/** 每 15 秒重畫一次，相對時間才會往前走。 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function WaitAge({ since, now }: { since: string; now: number }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const text =
    seconds < 60
      ? t('flows.time.waitedSec', { n: seconds })
      : minutes < 60
        ? t('flows.time.waitedMin', { n: minutes })
        : t('flows.time.waitedHour', { h: Math.floor(minutes / 60), m: minutes % 60 });
  return (
    <span className="age num" title={new Date(since).toLocaleString(locale)}>
      {text}
    </span>
  );
}

export function Waiting({ count }: { count: number }) {
  const t = useT();
  if (count === 0) return <span className="waiting none">{t('flows.waiting.none')}</span>;
  return (
    <span className="waiting" aria-label={t('flows.waiting.aria', { n: count })}>
      <span>{t('label.waiting')}</span>
      <b className="num">{count}</b>
    </span>
  );
}

export interface Note {
  text: ReactNode;
  tone?: 'ok' | 'err';
}

/** 操作結果，緊貼按鈕。 */
export function Msg({ note }: { note: Note | null }) {
  return (
    <span className={`msg${note?.tone === 'err' ? ' err' : ''}`} role="status">
      {note?.text}
    </span>
  );
}

/** hub 連不上：整頁淡化＋一行字，內容凍結（呼叫端同時停用操作）。 */
export function Page({
  children,
  narrow,
  ignoreHub,
}: {
  children: ReactNode;
  narrow?: boolean;
  /** 還沒登入的畫面：WebSocket 本來就連不上，不算資料過期。 */
  ignoreHub?: boolean;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const board = useBoard();
  const connected = ignoreHub || board.connected;
  useEffect(() => {
    document.documentElement.lang = locale === 'zh-TW' ? 'zh-Hant' : 'en';
  }, [locale]);
  return (
    <div className="flows">
      {!connected && (
        <div className="stale-line" role="alert">
          {t('flows.stale')}
        </div>
      )}
      <main className={`page${narrow ? ' narrow' : ''}${connected ? '' : ' is-stale'}`}>
        {children}
      </main>
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="state" role="status" data-state="loading">
      {label ?? t('flows.loading')}
    </div>
  );
}

export function Empty({ title, next }: { title: string; next: ReactNode }) {
  return (
    <div className="state" data-state="empty">
      <strong>{title}</strong>
      <div className="state-next">{next}</div>
    </div>
  );
}

export function ErrorBox({
  what,
  how,
  onRetry,
}: {
  what: string;
  how: string;
  onRetry?: () => void;
}) {
  const t = useT();
  return (
    <div className="alert" role="alert" data-state="error">
      <span aria-hidden="true">✕</span>
      <div className="alert-body">
        <div>{what}</div>
        <div className="sub">{how}</div>
        {onRetry && (
          <button type="button" onClick={onRetry}>
            {t('flows.retry')}
          </button>
        )}
      </div>
    </div>
  );
}

export interface Loaded<V> {
  data: V | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** 載入一次性資料（REST）。呼叫端的 load 要用 useCallback 或穩定參照。 */
export function useLoad<V>(load: () => Promise<V>): Loaded<V> {
  const [state, setState] = useState<{ data: V | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ ...s, error: errorText(e), loading: false })),
    );
    return () => {
      live = false;
    };
  }, [load, round]);
  const reload = useCallback(() => setRound((r) => r + 1), []);
  return { ...state, reload };
}

/** 目前登入的使用者。危險指令只有 owner 能決定，所以讀不到時要當成不能決定。 */
export function useCurrentUser(): Loaded<User | null> {
  const { backend } = useBoard();
  return useLoad(useCallback(() => backend.currentUser(), [backend]));
}

export function useProjects(): Loaded<Project[]> {
  const { backend } = useBoard();
  return useLoad(useCallback(() => backend.listProjects(), [backend]));
}

/**
 * 危險操作按兩次：第一次只是武裝，windowMs 內再按才執行。
 * 兩次太近（minGapMs 內，也就是手滑連點）不算確認，使用者才有時間看到第一次顯示的內容。
 */
export function useTwoStep(windowMs = 4000, minGapMs = 350) {
  const armedAt = useRef<number | null>(null);
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useCallback(() => {
    clearTimeout(timer.current);
    armedAt.current = null;
    setArmed(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const press = useCallback(
    (action: () => void) => {
      const now = Date.now();
      if (armedAt.current === null) {
        armedAt.current = now;
        setArmed(true);
        timer.current = setTimeout(disarm, windowMs);
        return;
      }
      if (now - armedAt.current < minGapMs) return;
      disarm();
      action();
    },
    [disarm, minGapMs, windowMs],
  );
  return { armed, press, disarm };
}

/**
 * 清單內容變動後短暫停用操作：處理完一張，下一張會滑到拇指底下，
 * 連點就會按到另一個 session 的「允許」。這正是這個介面要防的事（STYLE.md §0）。
 */
export function useListSettling(listKey: string, ms = 600): boolean {
  const [settling, setSettling] = useState(false);
  const previous = useRef(listKey);
  useLayoutEffect(() => {
    if (previous.current === listKey) return;
    previous.current = listKey;
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), ms);
    return () => clearTimeout(timer);
  }, [listKey, ms]);
  return settling;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [note, setNote] = useState<Note | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote({ text: t('flows.copy.done') });
    } catch {
      setNote({ text: t('flows.copy.failed'), tone: 'err' });
    }
  };
  return (
    <span className="acts inline">
      <button type="button" onClick={copy}>
        {label ?? t('flows.copy')}
      </button>
      <Msg note={note} />
    </span>
  );
}

/** `#/review/<sessionId>`、`#/inbox/<sessionId>`：畫布卡片的按鈕與推播通知用它指定要看哪個 session。 */
function targetFromHash(): string | null {
  const segment = location.hash.replace(/^#\/?/, '').split('/')[1];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function useTargetSession(): string | null {
  const [target, setTarget] = useState(targetFromHash);
  useEffect(() => {
    const onChange = () => setTarget(targetFromHash());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return target;
}
