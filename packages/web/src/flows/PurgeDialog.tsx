// 永久刪除已封存的 session（CONTRACTS §9.4、§9.5）。只有 owner 看得到入口。
// 三組：一定刪（Agent Board 的紀錄）、可選（機器上的 worktree、hook、對話紀錄）、一定留（專案檔案、操作紀錄）。
import { useCallback, useEffect, useState } from 'react';
import type {
  PurgeOptions,
  PurgeOutcome,
  PurgeResult,
  Session,
  SessionInspect,
} from '@agent-board/protocol';
import { errorCode, isMachineOffline } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { formatBytes } from './archive';
import { errorText, Loading, Msg, useTwoStep, type Note } from './common';
import { Dialog } from './Dialog';

type Inspect =
  | { state: 'loading' }
  | { state: 'ready'; data: SessionInspect }
  | { state: 'offline' }
  | { state: 'error'; detail: string };

/**
 * daemon 那邊沒有確定的回覆（逾時、斷線、出錯）：hub 沒刪紀錄，但機器可能已經清了一部分
 * （CONTRACTS §9.6）。不能說「什麼都還沒刪」。
 */
const DAEMON_UNSURE = new Set(['daemon_timeout', 'daemon_disconnected', 'daemon_error']);
/** 這些錯誤之後重新檢查：共用狀態變了，或機器上的檔案可能已經不同。 */
const RECHECK = new Set([...DAEMON_UNSURE, 'worktree_shared', 'transcript_shared', 'hooks_shared']);

/** hub 回的錯誤碼換成白話；其他照原文。 */
function deleteError(t: ReturnType<typeof useT>, e: unknown): string {
  const code = errorCode(e);
  if (code && DAEMON_UNSURE.has(code)) return t('flows.purge.err.daemonUnsure');
  if (code === 'machine_offline') return t('flows.purge.err.offline');
  if (code === 'hooks_shared') return t('flows.purge.err.hooksShared');
  if (code === 'worktree_shared') return t('flows.purge.err.worktreeShared');
  if (code === 'transcript_shared') return t('flows.purge.err.transcriptShared');
  if (code === 'session_deleting') return t('flows.purge.err.deleting');
  if (code === 'session_active') return t('flows.purge.err.active');
  if (code === 'not_archived') return t('flows.purge.err.notArchived');
  return t('flows.purge.err.other', { error: errorText(e) });
}

function OutcomeRow({ label, outcome }: { label: string; outcome: PurgeOutcome }) {
  const t = useT();
  return (
    <li data-testid="purge-outcome" data-status={outcome.status}>
      <span className="name">{label}</span>
      <span
        className={outcome.status === 'failed' || outcome.status === 'kept' ? 'you-text' : 'sub'}
      >
        {t(`flows.purge.outcome.${outcome.status}`)}
        {outcome.detail ? `：${outcome.detail}` : ''}
      </span>
    </li>
  );
}

export function PurgeDialog({
  session,
  machineName,
  onClose,
  onDeleted,
}: {
  session: Session;
  machineName: string;
  onClose: () => void;
  /** 刪除成功（關閉結果之前就呼叫，讓清單先移掉這一列）。 */
  onDeleted: (id: string) => void;
}) {
  const t = useT();
  const { backend, machines } = useBoard();
  const online = machines.find((m) => m.id === session.machineId)?.online ?? false;
  const [inspect, setInspect] = useState<Inspect>({ state: 'loading' });
  const [round, setRound] = useState(0);
  const hasWorktree = session.worktreePath !== null;
  const [options, setOptions] = useState<PurgeOptions>({
    removeWorktree: hasWorktree,
    removeTranscript: false,
    removeHooks: true,
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [result, setResult] = useState<PurgeResult | null>(null);
  const twoStep = useTwoStep();

  useEffect(() => {
    if (!online) {
      setInspect({ state: 'offline' });
      return;
    }
    let live = true;
    setInspect({ state: 'loading' });
    backend.inspectSession(session.id).then(
      (data) => {
        if (!live) return;
        setInspect({ state: 'ready', data });
        // hook 共用時不能拿掉（hub 會拒絕），預設就不勾。
        // 共用的項目不能清（hub 會拒絕，CONTRACTS §9.6），預設就不勾。
        setOptions((o) => ({
          removeHooks: o.removeHooks && !data.hooksShared,
          removeWorktree: o.removeWorktree && !data.worktreeShared,
          removeTranscript: o.removeTranscript && !data.transcriptShared,
        }));
      },
      (e: unknown) => {
        if (!live) return;
        setInspect(
          isMachineOffline(e) ? { state: 'offline' } : { state: 'error', detail: errorText(e) },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [backend, online, session.id, round]);

  const offline = inspect.state === 'offline';
  const data = inspect.state === 'ready' ? inspect.data : null;
  const hooksShared = data?.hooksShared ?? false;
  // 舊版 hub 沒有這兩個欄位：當成不共用，由 hub 的 409 把關。
  const worktreeShared = data?.worktreeShared ?? false;
  const transcriptShared = data?.transcriptShared ?? false;
  // 機器離線時只能刪 hub 的紀錄：清理項全部停用、不送。
  const effective: PurgeOptions = offline
    ? { removeWorktree: false, removeTranscript: false, removeHooks: false }
    : {
        removeWorktree: hasWorktree && !worktreeShared && options.removeWorktree,
        removeTranscript: !transcriptShared && options.removeTranscript,
        removeHooks: !hooksShared && options.removeHooks,
      };
  const git = data?.git ?? null;
  const set = (key: keyof PurgeOptions) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setOptions((o) => ({ ...o, [key]: e.target.checked }));

  const run = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const done = await backend.deleteSession(session.id, effective);
      setResult(done);
      onDeleted(session.id);
    } catch (e) {
      setNote({ text: deleteError(t, e), tone: 'err' });
      // 重新檢查：勾選框的停用與說明、git 警告、對話大小跟著機器上現在的狀況更新。
      const code = errorCode(e);
      if (code && RECHECK.has(code)) setRound((r) => r + 1);
    } finally {
      setBusy(false);
    }
  }, [backend, effective, onDeleted, session.id, t]);

  if (result) {
    return (
      <Dialog
        title={t('flows.purge.doneTitle', { name: session.name })}
        onClose={onClose}
        testId="purge-dialog"
      >
        <ul className="archive-list purge-result" data-testid="purge-result">
          <OutcomeRow label={t('flows.purge.worktree')} outcome={result.worktree} />
          <OutcomeRow label={t('flows.purge.hooks')} outcome={result.hooks} />
          <OutcomeRow label={t('flows.purge.transcript')} outcome={result.transcript} />
        </ul>
        <p className="hint">{t('flows.purge.doneKept')}</p>
        <div className="acts">
          <button type="button" className="primary" onClick={onClose}>
            {t('flows.purge.close')}
          </button>
        </div>
      </Dialog>
    );
  }

  const size =
    data?.transcriptBytes != null ? formatBytes(data.transcriptBytes) : t('flows.archived.noSize');

  return (
    <Dialog
      title={t('flows.purge.title', { name: session.name })}
      onClose={onClose}
      testId="purge-dialog"
    >
      <p className="sub">{t('flows.purge.lead')}</p>

      {inspect.state === 'loading' && <Loading label={t('flows.purge.inspecting')} />}
      {offline && (
        <div className="alert" role="alert" data-testid="purge-offline">
          <span aria-hidden="true">⊘</span>
          <div className="alert-body">{t('flows.purge.offline', { machine: machineName })}</div>
        </div>
      )}
      {inspect.state === 'error' && (
        <div className="alert" role="alert">
          <span aria-hidden="true">✕</span>
          <div className="alert-body">
            <div>{t('flows.purge.inspectFailed', { error: inspect.detail })}</div>
            <button type="button" onClick={() => setRound((r) => r + 1)}>
              {t('flows.retry')}
            </button>
          </div>
        </div>
      )}

      {git && (
        <ul className="purge-warn" data-testid="purge-warnings">
          {git.dirtyFiles > 0 && (
            <li>
              {hasWorktree
                ? t('flows.purge.warn.dirtyWorktree', { n: git.dirtyFiles })
                : t('flows.purge.warn.dirty', { n: git.dirtyFiles })}
            </li>
          )}
          {(git.unpushedCommits ?? 0) > 0 && (
            <li>{t('flows.purge.warn.unpushed', { n: git.unpushedCommits ?? 0 })}</li>
          )}
          {(git.unmergedCommits ?? 0) > 0 && (
            <li>
              {t('flows.purge.warn.unmerged', {
                n: git.unmergedCommits ?? 0,
                branch: git.branch ?? session.branch ?? '?',
              })}
            </li>
          )}
        </ul>
      )}

      <h3>{t('flows.purge.always')}</h3>
      <ul className="purge-group">
        <li>{t('flows.purge.alwaysHub')}</li>
      </ul>

      <h3>{t('flows.purge.optional')}</h3>
      <div className="purge-group" role="group" aria-label={t('flows.purge.optional')}>
        {hasWorktree && (
          <label className="check">
            <input
              type="checkbox"
              checked={effective.removeWorktree}
              disabled={offline || busy || worktreeShared}
              onChange={set('removeWorktree')}
            />
            <span>
              {t('flows.purge.worktreeOpt')}
              <span className="sub mono-path"> {session.worktreePath}</span>
            </span>
          </label>
        )}
        {hasWorktree && worktreeShared && !offline && (
          <p className="hint">{t('flows.purge.worktreeShared')}</p>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={effective.removeHooks}
            disabled={offline || busy || hooksShared}
            onChange={set('removeHooks')}
          />
          <span>{t('flows.purge.hooksOpt')}</span>
        </label>
        {hooksShared && !offline && <p className="hint">{t('flows.purge.hooksShared')}</p>}
        <label className="check">
          <input
            type="checkbox"
            checked={effective.removeTranscript}
            disabled={offline || busy || transcriptShared}
            onChange={set('removeTranscript')}
          />
          <span>
            {t('flows.purge.transcriptOpt')}
            {!offline && <span className="sub"> {t('flows.purge.size', { size })}</span>}
          </span>
        </label>
        {transcriptShared && !offline && (
          <p className="hint">{t('flows.purge.transcriptShared')}</p>
        )}
        {effective.removeTranscript && (
          <p className="hint you">{t('flows.purge.transcriptWarn')}</p>
        )}
      </div>

      <h3>{t('flows.purge.kept')}</h3>
      <ul className="purge-group">
        <li>{t('flows.purge.keptProject', { path: session.cwd })}</li>
        <li>{t('flows.purge.keptAudit')}</li>
        {!effective.removeTranscript && <li>{t('flows.purge.keptTranscript')}</li>}
        {hasWorktree && !effective.removeWorktree && <li>{t('flows.purge.keptWorktree')}</li>}
      </ul>

      {twoStep.armed && (
        <p className="hint you" role="status">
          {t('flows.purge.confirmAgain')}
        </p>
      )}
      <div className="acts">
        <button
          type="button"
          className="danger"
          disabled={busy || inspect.state === 'loading'}
          onClick={() => twoStep.press(() => void run())}
        >
          {twoStep.armed ? t('flows.purge.deleteArmed') : t('flows.purge.delete')}
        </button>
        <button type="button" onClick={onClose}>
          {t('flows.purge.cancel')}
        </button>
        <Msg note={note} />
      </div>
    </Dialog>
  );
}
