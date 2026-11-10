// 機器面板（發版與自動更新，docs/release-update-spec.md §7）：置中次畫面 `#/machines`（手機是全螢幕頁），
// 和用量詳情同一種外框。入口在設定的「機器」區與側欄的機器區。
// 上方：canary／stable 目前版本、gh 狀態、repo、檢查新版、升為 stable（canary 跑多久、期間出了幾次事）。
// 下方：各機一列——平台、版本、通道（可切換）、最後連線、更新狀態、立即更新、回滾到上一版。
// 非 owner 只能看（按鈕停用並說明；hub 也會擋）。開著時每 5 秒重讀。
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { MachineRelease, ReleaseChannel, ReleaseOverview } from '@agent-board/protocol';
import { useCurrentUser } from '../flows/common';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  canarySoak,
  canaryTroubled,
  formatAge,
  ghProblem,
  isRepo,
  promoteBlock,
  releaseStatus,
  rollbackBlock,
  shortBuild,
  statusText,
  statusTone,
  updateBlock,
  type Translate,
} from './model';
import './messages';
import './machines.css';

/** 開著時多久重讀一次（更新進度要看得到在動）。 */
export const MACHINES_REFRESH_MS = 5_000;

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; overview: ReleaseOverview }
  | { state: 'error'; detail: string; overview: ReleaseOverview | null };

type T = Translate;

interface Note {
  text: string;
  tone: 'ok' | 'err';
}

const errorCode = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};
const errorDetail = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** hub 的 409 錯誤碼翻成白話；其他錯誤照原訊息。 */
function actionError(e: unknown, t: T): string {
  const code = errorCode(e);
  if (
    code === 'canary_too_new' ||
    code === 'not_cached' ||
    code === 'machine_offline' ||
    code === 'no_previous' ||
    code === 'previous_unsupported' ||
    code === 'update_in_progress' ||
    code === 'no_target' ||
    code === 'schema_changed'
  ) {
    return t(`machines.err.${code}`);
  }
  return t('machines.err.other', { error: errorDetail(e) });
}

function useOverview() {
  const backend = useBoard((s) => s.backend);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    backend.releases().then(
      (overview) => live && setLoaded({ state: 'ready', overview }),
      (e: unknown) =>
        live &&
        setLoaded((prev) => ({
          state: 'error',
          detail: errorDetail(e),
          overview: prev.state === 'loading' ? null : prev.overview,
        })),
    );
    const timer = setTimeout(() => setTick((n) => n + 1), MACHINES_REFRESH_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [backend, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  /** 動作回來的總覽直接換上（不等下一次重讀）。 */
  const apply = useCallback(
    (overview: ReleaseOverview) => setLoaded({ state: 'ready', overview }),
    [],
  );
  return { loaded, reload, apply };
}

/** 一顆動作鈕＋旁邊的結果。pending 期間停用，避免連點送兩次。 */
function useAction(apply: (o: ReleaseOverview) => void) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const run = async (
    action: () => Promise<ReleaseOverview>,
    ok: string | null,
    onError?: (e: unknown) => boolean,
  ) => {
    setPending(true);
    setNote(null);
    try {
      apply(await action());
      if (ok) setNote({ text: ok, tone: 'ok' });
    } catch (e) {
      if (!onError?.(e)) setNote({ text: actionError(e, t), tone: 'err' });
    } finally {
      setPending(false);
    }
  };
  return { pending, note, setNote, run };
}

function NoteText({ note, testId }: { note: Note | null; testId?: string }) {
  return (
    <span className={`msg${note?.tone === 'err' ? ' err' : ''}`} role="status" data-testid={testId}>
      {note?.text}
    </span>
  );
}

function When({ iso }: { iso: string }) {
  const locale = useLocale((s) => s.locale);
  return <time dateTime={iso}>{new Date(iso).toLocaleString(locale)}</time>;
}

function GhLine({ overview }: { overview: ReleaseOverview }) {
  const t = useT();
  const { state, message } = overview.gh;
  const text = t(`machines.gh.${state}`, { message: message ? `：${message}` : '' });
  if (ghProblem(state)) {
    return (
      <div className="alert rel-warn rel-gh" role="alert" data-testid="machines-gh">
        <span aria-hidden="true">⚠</span>
        <span>{text}</span>
      </div>
    );
  }
  return (
    <p className="hint rel-gh" data-testid="machines-gh">
      {text}
    </p>
  );
}

function RepoField({
  overview,
  owner,
  apply,
}: {
  overview: ReleaseOverview;
  owner: boolean;
  apply: (o: ReleaseOverview) => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [draft, setDraft] = useState(overview.repo ?? '');
  const action = useAction(apply);
  // 別處改了 repo（另一個分頁、清除）：沒在編輯時跟著換。
  const [shown, setShown] = useState(overview.repo);
  if (shown !== overview.repo) {
    setShown(overview.repo);
    setDraft(overview.repo ?? '');
  }
  if (!owner) {
    return (
      <p className="rel-line" data-testid="machines-repo">
        <span className="rel-label">{t('machines.repo')}</span>
        <code>{overview.repo ?? t('machines.repoNone')}</code>
      </p>
    );
  }
  const save = () => {
    if (!isRepo(draft)) {
      action.setNote({ text: t('machines.repoInvalid'), tone: 'err' });
      return;
    }
    void action.run(() => backend.setReleaseRepo(draft.trim()), t('machines.repoSaved'));
  };
  return (
    <form
      className="rel-repo row"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="rel-label" htmlFor="machines-repo-input">
        {t('machines.repo')}
      </label>
      <input
        id="machines-repo-input"
        className="sm"
        value={draft}
        placeholder={t('machines.repoPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        data-testid="machines-repo-input"
      />
      <button
        type="submit"
        className="sm"
        disabled={action.pending || draft.trim() === (overview.repo ?? '')}
        data-testid="machines-repo-save"
      >
        {t('machines.repoSave')}
      </button>
      {overview.repo && (
        <button
          type="button"
          className="sm ghost"
          disabled={action.pending}
          onClick={() => void action.run(() => backend.setReleaseRepo(null), null)}
          data-testid="machines-repo-clear"
        >
          {t('machines.repoClear')}
        </button>
      )}
      <NoteText note={action.note} />
    </form>
  );
}

function Promote({
  overview,
  owner,
  apply,
  now,
}: {
  overview: ReleaseOverview;
  owner: boolean;
  apply: (o: ReleaseOverview) => void;
  now: number;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const action = useAction(apply);
  const [confirming, setConfirming] = useState(false);
  const soak = canarySoak(overview, now);
  const block = promoteBlock(overview);
  const stats = overview.canaryStats;
  const age = soak.ms === null ? null : formatAge(soak.ms, t);
  const canary = overview.canary;

  const promote = (confirm: boolean) => {
    if (!canary) return;
    void action
      .run(
        () => backend.promoteRelease(canary, confirm),
        t('machines.promoted'),
        (e) => {
          // 時鐘不準或 hub 算的不一樣：hub 說還不到 24 小時，就改成要再確認一次。
          if (errorCode(e) !== 'canary_too_new') return false;
          setConfirming(true);
          return true;
        },
      )
      .then(() => confirm && setConfirming(false));
  };

  return (
    <div className="rel-promote" data-testid="machines-promote">
      <div className="row">
        <button
          type="button"
          className="sm"
          disabled={!owner || block !== null || action.pending || confirming}
          title={
            !owner
              ? t('machines.block.member')
              : block
                ? t(`machines.promote.${block}`)
                : canary
                  ? t('machines.promoteVersion', { version: canary })
                  : undefined
          }
          onClick={() => (soak.short ? setConfirming(true) : promote(false))}
          data-testid="machines-promote-btn"
        >
          {t('machines.promote')}
        </button>
        <span className="sub" data-testid="machines-soak">
          {age === null ? t('machines.soakNone') : t('machines.soak', { age })}
          {age !== null && soak.short && t('machines.soakShort')}
        </span>
        <span
          className={`sub${canaryTroubled(stats) ? ' l-fault' : ''}`}
          data-testid="machines-stats"
        >
          {t('machines.stats', {
            errors: stats.errors,
            disconnects: stats.disconnects,
            failures: stats.updateFailures,
          })}
        </span>
        {block && owner && <span className="hint-inline">{t(`machines.promote.${block}`)}</span>}
      </div>
      {confirming && canary && (
        <div
          className="alert rel-warn rel-confirm"
          role="alert"
          data-testid="machines-promote-confirm"
        >
          <span aria-hidden="true">⚠</span>
          <div>
            <p>
              {t('machines.promoteShort', {
                version: canary,
                age: age ?? t('machines.span.m', { m: 0 }),
              })}
            </p>
            <div className="row">
              <button
                type="button"
                className="sm danger"
                disabled={action.pending}
                onClick={() => promote(true)}
                data-testid="machines-promote-yes"
              >
                {t('machines.promoteConfirm')}
              </button>
              <button
                type="button"
                className="sm"
                onClick={() => setConfirming(false)}
                data-testid="machines-promote-no"
              >
                {t('machines.promoteCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      <NoteText note={action.note} testId="machines-promote-note" />
    </div>
  );
}

function ReleaseSummary({
  overview,
  owner,
  apply,
  now,
}: {
  overview: ReleaseOverview;
  owner: boolean;
  apply: (o: ReleaseOverview) => void;
  now: number;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const check = useAction(apply);
  const checking = overview.checking || check.pending;
  return (
    <section className="rel-card" aria-label={t('machines.title')} data-testid="machines-summary">
      <dl className="rel-versions">
        <div>
          <dt>{t('machines.channel.canary')}</dt>
          <dd className="num" data-testid="machines-canary">
            {overview.canary ?? t('machines.none')}
          </dd>
        </div>
        <div>
          <dt>{t('machines.channel.stable')}</dt>
          <dd className="num" data-testid="machines-stable">
            {overview.stable ?? t('machines.none')}
          </dd>
        </div>
        <div>
          <dt>hub</dt>
          <dd className="num">
            {overview.hub.version}{' '}
            <span className="rel-build" title={overview.hub.buildId}>
              {shortBuild(overview.hub.buildId)}
            </span>
          </dd>
        </div>
      </dl>
      <GhLine overview={overview} />
      <RepoField overview={overview} owner={owner} apply={apply} />
      <div className="row rel-check">
        <button
          type="button"
          className="sm"
          disabled={!owner || checking}
          title={owner ? undefined : t('machines.block.member')}
          onClick={() => void check.run(() => backend.checkReleases(), t('machines.checked'))}
          data-testid="machines-check"
        >
          {checking ? t('machines.checking') : t('machines.check')}
        </button>
        <span className="sub" data-testid="machines-last-check">
          {overview.lastCheckAt ? (
            <>
              {t('machines.lastCheck', { time: '' })}
              <When iso={overview.lastCheckAt} />
            </>
          ) : (
            t('machines.neverChecked')
          )}
        </span>
        <NoteText note={check.note} />
      </div>
      {overview.lastCheckError && (
        <p className="hint l-fault" data-testid="machines-check-error">
          {t('machines.checkError', { error: overview.lastCheckError })}
        </p>
      )}
      <Promote overview={overview} owner={owner} apply={apply} now={now} />
    </section>
  );
}

function ChannelSwitch({
  machine,
  owner,
  apply,
}: {
  machine: MachineRelease;
  owner: boolean;
  apply: (o: ReleaseOverview) => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const action = useAction(apply);
  const set = (channel: ReleaseChannel) => {
    if (channel === machine.channel) return;
    void action.run(() => backend.setMachineChannel(machine.machineId, channel), null);
  };
  return (
    <div className="rel-channel">
      <div
        className="seg sm"
        role="group"
        aria-label={t('machines.channelLabel', { name: machine.name })}
        title={owner ? t('machines.channelHint') : t('machines.block.member')}
      >
        {(['canary', 'stable'] as const).map((channel) => (
          <button
            key={channel}
            type="button"
            aria-pressed={machine.channel === channel}
            disabled={!owner || action.pending}
            onClick={() => set(channel)}
            data-testid={`machine-channel-${machine.machineId}-${channel}`}
          >
            {t(`machines.channel.${channel}`)}
          </button>
        ))}
      </div>
      <NoteText note={action.note} />
    </div>
  );
}

function ActionButton({
  label,
  block,
  owner,
  pending,
  onClick,
  testId,
}: {
  label: string;
  block: string | null;
  owner: boolean;
  pending: boolean;
  onClick: () => void;
  testId: string;
}) {
  const t = useT();
  const why = !owner ? t('machines.block.member') : block ? t(`machines.block.${block}`) : null;
  return (
    <span className="rel-act">
      <button
        type="button"
        className="sm"
        disabled={why !== null || pending}
        title={why ?? undefined}
        onClick={onClick}
        aria-describedby={why ? `${testId}-why` : undefined}
        data-testid={testId}
      >
        {label}
      </button>
      {why && owner && (
        <span className="hint-inline rel-why" id={`${testId}-why`}>
          {why}
        </span>
      )}
    </span>
  );
}

function MachineRow({
  machine,
  owner,
  apply,
}: {
  machine: MachineRelease;
  owner: boolean;
  apply: (o: ReleaseOverview) => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const action = useAction(apply);
  const status = releaseStatus(machine);
  const tone = statusTone(status);
  const build = shortBuild(machine.buildId);
  return (
    <li
      className={`rel-row${machine.online ? '' : ' off'}`}
      data-testid={`machine-release-${machine.machineId}`}
    >
      <div className="rel-name">
        {machine.online ? (
          <span className="dot" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">⊘</span>
        )}
        <strong>{machine.name}</strong>
        <span className="sub">
          {t(machine.online ? 'machines.online' : 'machines.offline')}
          {machine.platform ? ` · ${machine.platform}` : ` · ${machine.os}`}
        </span>
        {machine.hasHub && <span className="chip">{t('machines.hasHub')}</span>}
      </div>
      <div className="rel-ver">
        <span className="num" data-testid={`machine-version-${machine.machineId}`}>
          {machine.version ?? t('machines.unknownVersion')}
        </span>
        {build && (
          <span className="rel-build" title={machine.buildId ?? undefined}>
            {build}
          </span>
        )}
        {machine.targetVersion && machine.targetVersion !== machine.version && (
          <span className="sub">→ {t('machines.target', { version: machine.targetVersion })}</span>
        )}
        {machine.previousVersion && (
          <span className="sub">
            {t('machines.previous', { version: machine.previousVersion })}
          </span>
        )}
      </div>
      <ChannelSwitch machine={machine} owner={owner} apply={apply} />
      <p
        className={`rel-status${tone === 'fault' ? ' l-fault' : tone === 'you' ? ' l-you' : ''}`}
        data-testid={`machine-status-${machine.machineId}`}
        data-status={status.kind}
      >
        {statusText(status, t)}
      </p>
      {machine.update?.detail && status.kind === 'failed' && (
        <p className="hint rel-detail">{machine.update.detail}</p>
      )}
      {!machine.online && machine.lastSeenAt && (
        <p className="sub">
          {t('machines.lastSeen', { time: '' })}
          <When iso={machine.lastSeenAt} />
        </p>
      )}
      <div className="rel-acts row">
        <ActionButton
          label={t('machines.update')}
          block={updateBlock(machine)}
          owner={owner}
          pending={action.pending}
          onClick={() =>
            void action.run(
              () => backend.updateMachine(machine.machineId),
              t('machines.updateStarted'),
            )
          }
          testId={`machine-update-${machine.machineId}`}
        />
        <ActionButton
          label={t('machines.rollback')}
          block={rollbackBlock(machine)}
          owner={owner}
          pending={action.pending}
          onClick={() =>
            void action.run(
              () => backend.rollbackMachine(machine.machineId),
              t('machines.rollbackStarted'),
            )
          }
          testId={`machine-rollback-${machine.machineId}`}
        />
        <NoteText note={action.note} testId={`machine-note-${machine.machineId}`} />
      </div>
    </li>
  );
}

function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function MachinesPage() {
  const t = useT();
  const me = useCurrentUser();
  const owner = me.data?.role === 'owner';
  const { loaded, reload, apply } = useOverview();
  const now = useTick(MACHINES_REFRESH_MS);
  const overview = loaded.state === 'loading' ? null : loaded.overview;

  let body: ReactNode;
  if (!overview) {
    body = loaded.state === 'loading' ? <p className="hint">{t('machines.loading')}</p> : null;
  } else {
    body = (
      <>
        <ReleaseSummary overview={overview} owner={owner} apply={apply} now={now} />
        {overview.machines.length === 0 ? (
          <p className="empty" data-testid="machines-empty">
            {t('machines.empty')}
          </p>
        ) : (
          <ul className="rel-rows" data-testid="machines-list">
            {overview.machines.map((machine) => (
              <MachineRow key={machine.machineId} machine={machine} owner={owner} apply={apply} />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <div className="page machines-page" data-testid="machines-page">
      <header className="panel-head machines-page-head">
        <h1>{t('machines.title')}</h1>
        <div className="panel-acts">
          <button type="button" className="sm" onClick={reload} data-testid="machines-refresh">
            {t('machines.refresh')}
          </button>
        </div>
      </header>
      {me.data && !owner && (
        <p className="hint" data-testid="machines-member-note">
          {t('machines.memberNote')}
        </p>
      )}
      {loaded.state === 'error' && (
        <div className="alert" role="alert" data-testid="machines-error">
          {t('machines.error', { detail: loaded.detail })}
        </div>
      )}
      {body}
    </div>
  );
}
