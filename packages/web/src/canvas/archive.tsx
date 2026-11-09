// 畫布上的封存（CONTRACTS §9.5）：卡片選單、Delete 鍵、框選多張都走這裡。
// 還沒結束的先確認「會停止」；封存後 10 秒內可以復原（即 archived: false）。
import { useEffect } from 'react';
import { Panel } from '@xyflow/react';
import { create } from 'zustand';
import type { HandoffRule, Session } from '@agent-board/protocol';
import { Dialog } from '../flows';
import { stopsOnArchive } from '../flows/archive';
import { useT } from '../shared/i18n';
import { isSessionDeleting } from '../shared/backend';
import { useBoard } from '../shared/store';
import { refreshTeams, useTeams } from '../team/store';
import { errorText, Lamp } from '../views';

const ERROR_KEY = {
  archive: 'canvas.archive.failed',
  restore: 'canvas.archive.undoFailed',
  deleting: 'canvas.archive.undoDeleting',
} as const;

/** 封存後「復原」留多久。 */
export const UNDO_MS = 10_000;

interface ArchiveUi {
  /** 等使用者確認的 session。 */
  confirm: string[] | null;
  /** 剛封存的，可以復原。key 讓連續封存時計時重來。 */
  toast: { ids: string[]; names: string[]; rulesPaused: number; key: number } | null;
  /** 封存或復原失敗的原文（畫面再翻譯）。 */
  error: { kind: 'archive' | 'restore' | 'deleting'; detail: string } | null;
}

export const useArchiveUi = create<ArchiveUi>(() => ({ confirm: null, toast: null, error: null }));

/** 會被 hub 暫停的交接規則：從它出發或指向它、目前開著的（§9.1）。 */
export const rulesPausedBy = (ids: readonly string[], rules: readonly HandoffRule[]) =>
  rules.filter(
    (r) => r.enabled && (ids.includes(r.fromSessionId) || ids.includes(r.action.toSessionId)),
  );

/**
 * 要封存這些卡片。有還沒結束的（會被停止）就先確認；always 用在 Delete 鍵：
 * 按鍵比點選單更容易誤觸，一律先問。
 */
export function requestArchive(ids: string[], always = false): void {
  if (ids.length === 0) return;
  const sessions = useBoard.getState().sessions.filter((s) => ids.includes(s.id));
  if (always || sessions.some(stopsOnArchive)) {
    useArchiveUi.setState({ confirm: ids, error: null });
  } else {
    void archiveNow(ids);
  }
}

export async function archiveNow(ids: string[]): Promise<void> {
  const { backend, sessions } = useBoard.getState();
  const rulesPaused = rulesPausedBy(ids, useTeams.getState().rules).length;
  useArchiveUi.setState({ confirm: null, error: null });
  const results = await Promise.allSettled(
    ids.map((id) => backend.updateSession(id, { archived: true })),
  );
  const done = ids.filter((_, i) => results[i]?.status === 'fulfilled');
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  useArchiveUi.setState({
    toast:
      done.length > 0
        ? {
            ids: done,
            names: done.map((id) => sessions.find((s) => s.id === id)?.name ?? id),
            rulesPaused,
            key: Date.now(),
          }
        : null,
    error: failed ? { kind: 'archive', detail: errorText(failed.reason) } : null,
  });
  // 交接規則被 hub 關掉了，畫布上的線要跟著變。
  if (rulesPaused > 0) refreshTeams(backend).catch(() => {});
}

async function undo(ids: string[]): Promise<void> {
  const { backend } = useBoard.getState();
  useArchiveUi.setState({ toast: null, error: null });
  const results = await Promise.allSettled(
    ids.map((id) => backend.updateSession(id, { archived: false })),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed)
    useArchiveUi.setState({
      error: isSessionDeleting(failed.reason)
        ? { kind: 'deleting', detail: '' }
        : { kind: 'restore', detail: errorText(failed.reason) },
    });
}

function stopNote(session: Session, t: ReturnType<typeof useT>): string | null {
  if (!stopsOnArchive(session)) return null;
  return session.status === 'queued' ? t('canvas.archive.cancelsQueue') : t('canvas.archive.stops');
}

/** 封存確認框。 */
export function ArchiveConfirm() {
  const t = useT();
  const ids = useArchiveUi((s) => s.confirm);
  const all = useBoard((s) => s.sessions);
  const rules = useTeams((s) => s.rules);
  if (!ids) return null;
  const sessions = all.filter((s) => ids.includes(s.id));
  const close = () => useArchiveUi.setState({ confirm: null });
  if (sessions.length === 0) return null;
  const stopping = sessions.filter(stopsOnArchive);
  const paused = rulesPausedBy(ids, rules).length;
  const title =
    sessions.length === 1
      ? t('canvas.archive.confirmOne', { name: sessions[0]!.name })
      : t('canvas.archive.confirmMany', { n: sessions.length });
  return (
    <Dialog title={title} onClose={close} testId="archive-confirm">
      <ul className="archive-list">
        {sessions.map((s) => {
          const note = stopNote(s, t);
          return (
            <li key={s.id}>
              <Lamp status={s.status} detail={s.statusDetail} />
              <span className="name">{s.name}</span>
              {note && <span className="you-text">{note}</span>}
            </li>
          );
        })}
      </ul>
      {paused > 0 && <p className="hint you">{t('canvas.archive.rulesPaused', { n: paused })}</p>}
      <p className="hint">{t('canvas.archive.where')}</p>
      <div className="acts">
        <button
          type="button"
          className={stopping.length > 0 ? 'danger' : 'primary'}
          onClick={() => void archiveNow(sessions.map((s) => s.id))}
        >
          {stopping.length > 0 ? t('canvas.archive.stopAndArchive') : t('canvas.archive.do')}
        </button>
        <button type="button" onClick={close}>
          {t('canvas.archive.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

/** 畫面下方的「已封存 X　[復原]」，10 秒後消失；封存失敗也寫在這裡。 */
export function ArchiveToast() {
  const t = useT();
  const toast = useArchiveUi((s) => s.toast);
  const error = useArchiveUi((s) => s.error);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => useArchiveUi.setState({ toast: null }), UNDO_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast && !error) return null;
  // 和整理後的提示疊在同一欄（CanvasPage 的 .toast-stack）。
  return (
    <div className="archive-toast" data-testid="archive-toast">
      {toast && (
        <div className="toast-row" role="status">
          <span>
            {toast.names.length === 1
              ? t('canvas.archive.doneOne', { name: toast.names[0]! })
              : t('canvas.archive.doneMany', { n: toast.names.length })}
            {toast.rulesPaused > 0 &&
              ` ${t('canvas.archive.donePaused', { n: toast.rulesPaused })}`}
          </span>
          <button type="button" className="sm" onClick={() => void undo(toast.ids)}>
            {t('canvas.archive.undo')}
          </button>
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          <span aria-hidden="true">✕</span>
          <div>{t(ERROR_KEY[error.kind], { detail: error.detail })}</div>
          <button
            type="button"
            className="link"
            onClick={() => useArchiveUi.setState({ error: null })}
          >
            {t('canvas.archive.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}

/** 框選兩張以上時出現。 */
export function ArchiveSelection({ ids }: { ids: string[] }) {
  const t = useT();
  if (ids.length < 2) return null;
  return (
    <Panel position="top-left" className="edge-panel select-panel" data-testid="archive-selection">
      <button type="button" className="sm" onClick={() => requestArchive(ids)}>
        {t('canvas.archive.selected', { n: ids.length })}
      </button>
    </Panel>
  );
}
