// 不是 git 的資料夾：「在這裡 git init」（GM 2026-11-13，CONTRACTS §24）。新增團隊、補成員、新增 session、
// session 卡片與全尺寸頁（§24.5，flows/SessionGitInit.tsx）共用。
// 只有 owner 能按；按下先顯示會做什麼（確認步驟），確認後 hub 請那台 daemon 執行，結果寫在這裡。
// 成功後呼叫 onDone（重新偵測資料夾），BD 就能開 worktree；正在這個資料夾跑的 session 不會中斷。
// 呼叫端用 `key={machineId + path}` 掛：換資料夾時結果清掉。
import { useState } from 'react';
import {
  GIT_INIT_BRANCH,
  GIT_INIT_MAX_FILE_BYTES,
  type GitInitResult,
  type Machine,
} from '@agent-board/protocol';
import { errorCode } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, useCurrentUser } from './common';

const MB = 1024 * 1024;

type State =
  | { step: 'idle' }
  | { step: 'confirm' }
  | { step: 'busy' }
  | { step: 'done'; result: GitInitResult }
  | { step: 'error'; text: string };

export function GitInitAction({
  machine,
  path,
  notGit,
  onDone,
  startOpen = false,
  onStart,
}: {
  machine: Machine | undefined;
  path: string;
  /** daemon 確認不是 git。成功後變成 false 時仍留著結果（略過的大檔要看得到）。 */
  notGit: boolean;
  /** 成功後（重新偵測資料夾是不是 git）。 */
  onDone: () => void;
  /** 一打開就是確認步驟（卡片「⋯」的「在這裡 git init…」已經表示要做，§24.5）。 */
  startOpen?: boolean;
  /** 按下確認、送出之前（呼叫端據此在結果回來前就保留這個元件）。 */
  onStart?: () => void;
}) {
  const t = useT();
  const { backend } = useBoard();
  const me = useCurrentUser();
  const [state, setState] = useState<State>({ step: startOpen ? 'confirm' : 'idle' });
  const dir = path.trim();
  if (!machine || !dir) return null;
  // 已經是 git：還沒開始（或只在確認）就不顯示。送出中與有結果時照常顯示到使用者離開——新的 repoRoot
  // 可能比 API 回應早到（daemon 先送 session.runtime），不能在 busy 期間變成空白（審查 N7）。
  if (!notGit && (state.step === 'idle' || state.step === 'confirm')) return null;
  // 還沒讀到使用者：先不顯示（不讓非 owner 看到按鈕又被 403）。
  if (!me.data) return null;
  if (me.data.role !== 'owner') {
    return (
      <p className="sub" data-testid="git-init-owner-only">
        {t('flows.gitInit.ownerOnly')}
      </p>
    );
  }

  const run = async () => {
    onStart?.();
    setState({ step: 'busy' });
    try {
      const result = await backend.gitInit(machine.id, dir);
      setState({ step: 'done', result });
      if (result.ok) onDone();
    } catch (e) {
      const code = errorCode(e);
      setState({
        step: 'error',
        text:
          code === 'daemon_too_old'
            ? t('flows.gitInit.tooOld', { machine: machine.name })
            : code === 'machine_offline'
              ? t('flows.new.err.machineOffline', { machine: machine.name })
              : code === 'daemon_timeout'
                ? t('flows.gitInit.timeout')
                : t('flows.gitInit.failed', { detail: errorText(e) }),
      });
    }
  };

  const result = state.step === 'done' ? state.result : null;
  return (
    <div className="git-init" data-testid="git-init">
      {notGit && (state.step === 'idle' || state.step === 'error' || (result && !result.ok)) && (
        <button
          type="button"
          className="touch"
          disabled={!machine.online}
          onClick={() => setState({ step: 'confirm' })}
          data-testid="git-init-open"
        >
          {t('flows.gitInit.button')}
        </button>
      )}
      {(state.step === 'confirm' || state.step === 'busy') && (
        <div className="git-init-confirm" role="group" aria-label={t('flows.gitInit.confirmTitle')}>
          <p>
            <strong>{t('flows.gitInit.confirmTitle')}</strong>
          </p>
          <p className="sub mono">{`${machine.name} · ${dir}`}</p>
          <ul className="sub">
            <li>{t('flows.gitInit.what.init', { branch: GIT_INIT_BRANCH })}</li>
            <li>{t('flows.gitInit.what.ignore')}</li>
            <li>{t('flows.gitInit.what.commit', { mb: GIT_INIT_MAX_FILE_BYTES / MB })}</li>
            <li>{t('flows.gitInit.what.identity')}</li>
            <li>{t('flows.gitInit.what.local')}</li>
            <li>{t('flows.gitInit.what.sessions')}</li>
            <li>{t('flows.gitInit.what.worktreeFiles')}</li>
          </ul>
          <div className="row">
            <button
              type="button"
              className="primary touch"
              disabled={state.step === 'busy' || !machine.online}
              onClick={() => void run()}
              data-testid="git-init-confirm"
            >
              {state.step === 'busy' ? t('flows.gitInit.busy') : t('flows.gitInit.confirm')}
            </button>
            <button
              type="button"
              className="touch"
              disabled={state.step === 'busy'}
              onClick={() => setState({ step: 'idle' })}
            >
              {t('flows.gitInit.cancel')}
            </button>
          </div>
        </div>
      )}
      {state.step === 'error' && (
        <p className="msg err" role="alert" data-testid="git-init-error">
          {state.text}
        </p>
      )}
      {result && !result.ok && (
        <p className="msg err" role="alert" data-testid="git-init-error">
          {t(`flows.gitInit.err.${result.code}`)}
          {result.message ? ` (${result.message})` : ''}
        </p>
      )}
      {result?.ok && (
        <div className="msg" role="status" data-testid="git-init-done">
          <p>
            {t('flows.gitInit.done', {
              files: result.files,
              commit: result.commit.slice(0, 7),
              branch: result.branch,
            })}
            {result.gitignoreCreated ? ` ${t('flows.gitInit.doneIgnore')}` : ''}
            {result.identity === 'fallback' ? ` ${t('flows.gitInit.doneIdentity')}` : ''}
          </p>
          {result.skipped.length > 0 && (
            <>
              <p>
                {t('flows.gitInit.skipped', {
                  n: result.skipped.length + result.skippedMore,
                  mb: GIT_INIT_MAX_FILE_BYTES / MB,
                })}
              </p>
              <ul className="sub mono" data-testid="git-init-skipped">
                {result.skipped.map((f) => (
                  <li key={f.path}>{`${f.path}（${Math.round(f.bytes / MB)} MB）`}</li>
                ))}
                {result.skippedMore > 0 && (
                  <li>{t('flows.gitInit.skippedMore', { n: result.skippedMore })}</li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
