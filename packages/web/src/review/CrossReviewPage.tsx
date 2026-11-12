// 交叉審查（Codex 第二輪，CONTRACTS §22）：置中次畫面（手機全螢幕頁）。
// `#/cross-review/new?session=<id>`：選對象 → 產生 diff（只跑 git）→ 看檔案清單與大小 → GM 按「確認送出審查」才跑。
// `#/cross-review/<id>`：左右並排 Claude／Codex 的意見（手機上下）。意見全文是模型寫的字：一律純文字、經遮蔽模式。
import { useEffect, useMemo, useState } from 'react';
import type { Review, ReviewFile, ReviewSide, ReviewTargetInput } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { errorText } from '../flows/common';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { crossReviewHash, crossReviewTarget } from '../views/overlay';
import { replaceHash } from '../views/overlayStore';
import { durationParts, formatBytes, orderedFiles, sideBusy, sideReason } from './model';
import './messages';
import './review.css';

function useTarget() {
  const [target, setTarget] = useState(() => crossReviewTarget(location.hash));
  useEffect(() => {
    const onChange = () => setTarget(crossReviewTarget(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return target;
}

export function CrossReviewPage() {
  const t = useT();
  const target = useTarget();
  return (
    <div className="page cross-review-page" data-testid="cross-review-page">
      <header className="panel-head cross-review-head">
        <h1>{t('review.title')}</h1>
      </header>
      <p className="cr-note">
        <span aria-hidden="true">ⓘ </span>
        {t('review.note')}
      </p>
      {target?.id ? (
        <ReviewView id={target.id} />
      ) : (
        <NewReview sessionId={target?.session ?? null} />
      )}
    </div>
  );
}

// ── 發起 ─────────────────────────────────────────────

function NewReview({ sessionId }: { sessionId: string | null }) {
  const t = useT();
  const mask = useMaskText();
  const { backend, sessions, machines, connected } = useBoard();
  const live = sessions.filter((s) => !s.archived);
  const preset = live.find((s) => s.id === sessionId) ?? null;
  const [kind, setKind] = useState<'session' | 'branch'>('session');
  const [pick, setPick] = useState(preset?.id ?? '');
  const online = machines.filter((m) => m.online);
  const [machineId, setMachineId] = useState(preset?.machineId ?? online[0]?.id ?? '');
  const [repoPath, setRepoPath] = useState(preset?.repoRoot ?? preset?.cwd ?? '');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('main');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (preset) setPick(preset.id);
  }, [preset]);

  const ready =
    kind === 'session'
      ? pick !== ''
      : machineId !== '' && repoPath.trim() !== '' && branch.trim() !== '';
  const submit = async () => {
    const target: ReviewTargetInput =
      kind === 'session'
        ? { kind: 'session', sessionId: pick }
        : {
            kind: 'branch',
            machineId,
            repoPath: repoPath.trim(),
            branch: branch.trim(),
            base: base.trim() || 'main',
          };
    setBusy(true);
    setError('');
    try {
      const review = await backend.prepareReview(target, reason.trim() || undefined);
      replaceHash(crossReviewHash(review.id));
    } catch (e) {
      setError(t('review.failed', { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="cr-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void submit();
      }}
      data-testid="cross-review-new"
    >
      <h2>{t('review.new')}</h2>
      <div className="seg sm" role="group" aria-label={t('review.target')}>
        <button
          type="button"
          aria-pressed={kind === 'session'}
          onClick={() => setKind('session')}
          data-testid="cross-review-kind-session"
        >
          {t('review.target.session')}
        </button>
        <button
          type="button"
          aria-pressed={kind === 'branch'}
          onClick={() => setKind('branch')}
          data-testid="cross-review-kind-branch"
        >
          {t('review.target.branch')}
        </button>
      </div>
      {kind === 'session' ? (
        <label className="cr-field">
          <span>{t('review.session')}</span>
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            data-testid="cross-review-session"
          >
            <option value="">{t('review.session.pick')}</option>
            {live.map((s) => (
              <option key={s.id} value={s.id}>
                {mask(s.name)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="cr-field">
            <span>{t('review.machine')}</span>
            <select
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              data-testid="cross-review-machine"
            >
              {online.map((m) => (
                <option key={m.id} value={m.id}>
                  {mask(m.name)}
                </option>
              ))}
            </select>
          </label>
          <label className="cr-field">
            <span>{t('review.repoPath')}</span>
            <input
              className="mono"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              data-testid="cross-review-repo"
            />
          </label>
          <div className="cr-row">
            <label className="cr-field">
              <span>{t('review.branch')}</span>
              <input
                className="mono"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                data-testid="cross-review-branch"
              />
            </label>
            <label className="cr-field">
              <span>{t('review.base')}</span>
              <input
                className="mono"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                data-testid="cross-review-base"
              />
            </label>
          </div>
        </>
      )}
      <label className="cr-field">
        <span>{t('review.reason')}</span>
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      </label>
      <p className="hint">{t('review.prepareHint')}</p>
      <div className="cr-acts">
        <button
          type="submit"
          className="primary"
          disabled={!ready || busy || !connected}
          data-testid="cross-review-prepare"
        >
          {busy ? t('review.preparing') : t('review.prepare')}
        </button>
      </div>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// ── 一份審查 ────────────────────────────────────────

function useReview(id: string): { review: Review | null; missing: boolean } {
  const backend = useBoard((s) => s.backend);
  const fromBoard = useBoard((s) => s.reviews?.find((r) => r.id === id) ?? null);
  const [loaded, setLoaded] = useState<Review | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    // 快照只帶最近幾筆；更舊的（推播點進來）向 hub 讀一次。
    if (fromBoard) return;
    let live = true;
    backend.getReview(id).then(
      (r) => live && setLoaded(r),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [backend, id, fromBoard]);
  return { review: fromBoard ?? loaded, missing: !fromBoard && !loaded && missing };
}

function ReviewView({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const { backend, connected, machines } = useBoard();
  const { review, missing } = useReview(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 打開結果就算讀過了（收件匣不再列）。
  useEffect(() => {
    if (review && !review.read && (review.status === 'done' || review.status === 'failed')) {
      void backend.readReviews([review.id]).catch(() => undefined);
    }
  }, [backend, review]);
  if (missing) return <p className="empty">{t('review.notFound')}</p>;
  if (!review) return <p className="hint">{t('review.preparing')}</p>;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(t('review.failed', { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };
  const machine = machines.find((m) => m.id === review.machineId);
  const by =
    review.requestedBy.kind === 'lead'
      ? t('review.by.lead', { name: mask(review.requestedBy.name) })
      : t('review.by.user', { name: review.requestedBy.name });
  return (
    <section className="cr-review" data-testid="cross-review-view" data-status={review.status}>
      <header className="cr-review-head">
        <h2>{mask(review.target.label)}</h2>
        <span className={`cr-state cr-state-${review.status}`} data-testid="cross-review-state">
          {t(`review.state.${review.status}`)}
        </span>
      </header>
      <p className="cr-meta">
        {by}
        {machine ? ` · ${mask(machine.name)}` : ''}
        {' · '}
        {t('review.created', { time: new Date(review.createdAt).toLocaleString(locale) })}
      </p>
      {review.reason && (
        <p className="cr-meta">{t('review.reasonLine', { reason: mask(review.reason) })}</p>
      )}
      {review.status === 'preparing' && <p className="hint">{t('review.preparing')}</p>}
      {review.status === 'failed' && review.error && (
        <p className="msg err" role="alert" data-testid="cross-review-error">
          {t('review.error', { error: review.error })}
        </p>
      )}
      {review.diff && (
        <FileList
          files={review.diff.files}
          total={review.diff.totalBytes}
          additions={review.diff.additions}
          deletions={review.diff.deletions}
          truncated={review.diff.truncated}
          open={review.status === 'awaiting_confirm'}
        />
      )}
      {review.status === 'awaiting_confirm' && (
        <div className="cr-confirm">
          <p className="hint">{t('review.confirmHint')}</p>
          <div className="cr-acts">
            <button
              type="button"
              className="primary"
              disabled={busy || !connected}
              onClick={() => void run(() => backend.startReview(review.id))}
              data-testid="cross-review-confirm"
            >
              {t('review.confirm')} <span className="quota-mark">{t('review.quota')}</span>
            </button>
            <button
              type="button"
              disabled={busy || !connected}
              onClick={() => void run(() => backend.cancelReview(review.id))}
              data-testid="cross-review-cancel"
            >
              {t('review.cancel')}
            </button>
          </div>
        </div>
      )}
      {(review.status === 'running' || review.status === 'done' || review.startedAt) && (
        <div className="cr-sides" data-testid="cross-review-sides">
          <SideCard side={review.claude} title="Claude Code" />
          <SideCard side={review.codex} title="Codex" />
        </div>
      )}
      {review.status === 'running' && (
        <div className="cr-acts">
          <button
            type="button"
            className="sm"
            disabled={busy || !connected}
            onClick={() => void run(() => backend.cancelReview(review.id))}
          >
            {t('review.cancel')}
          </button>
        </div>
      )}
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function FileList({
  files,
  total,
  additions,
  deletions,
  truncated,
  open,
}: {
  files: readonly ReviewFile[];
  total: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  open: boolean;
}) {
  const t = useT();
  const mask = useMaskText();
  const list = useMemo(() => orderedFiles(files), [files]);
  return (
    <details className="cr-files" open={open} data-testid="cross-review-files">
      <summary>
        {t('review.files', {
          n: files.length,
          size: formatBytes(total),
          add: additions,
          del: deletions,
        })}
      </summary>
      {truncated && <p className="hint">{t('review.truncatedNote')}</p>}
      <table className="cr-file-table">
        <tbody>
          {list.map((f) => (
            <tr key={f.path} data-testid="cross-review-file" data-omitted={f.omitted ? '1' : '0'}>
              <td className="cr-file-status">{t(`review.status.${f.status}`)}</td>
              <td className="cr-file-path mono">{mask(f.path)}</td>
              <td className="num cr-file-lines">
                +{f.additions} −{f.deletions}
              </td>
              <td className="num cr-file-size">{f.omitted ? '—' : formatBytes(f.bytes)}</td>
              <td className="cr-file-flag">
                {f.omitted
                  ? t('review.file.omitted')
                  : f.truncated
                    ? t('review.file.truncated')
                    : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function SideCard({ side, title }: { side: ReviewSide; title: string }) {
  const t = useT();
  const mask = useMaskText();
  const reason = side.status === 'skipped' || side.status === 'failed' ? sideReason(side) : null;
  const duration = side.durationMs === null ? null : durationParts(side.durationMs);
  return (
    <article
      className={`cr-side cr-side-${side.status}`}
      data-testid={`cross-review-side-${side.agent}`}
      data-status={side.status}
      aria-busy={sideBusy(side)}
    >
      <header className="cr-side-head">
        <h3>{title}</h3>
        <span className="cr-side-state">{t(`review.side.${side.status}`)}</span>
      </header>
      <p className="cr-side-meta">
        {side.model ? t('review.side.model', { model: side.model }) : t('review.side.defaultModel')}
        {side.inputTokens !== null &&
          ` · ${t('review.side.tokens', { input: side.inputTokens, output: side.outputTokens ?? 0 })}`}
        {duration && ` · ${t('review.side.duration', duration)}`}
      </p>
      {reason === 'windows' && (
        <p className="cr-skip" data-testid="cross-review-windows">
          {t('review.skip.windows')}
        </p>
      )}
      {reason === 'unavailable' && <p className="cr-skip">{t('review.skip.unavailable')}</p>}
      {reason === 'other' && side.error && (
        <p className="msg err">{t('review.failed', { error: side.error })}</p>
      )}
      {side.status === 'timeout' && side.error && <p className="msg err">{side.error}</p>}
      {side.status === 'done' && (
        <pre className="cr-output" data-testid={`cross-review-output-${side.agent}`}>
          {side.output ? mask(side.output) : t('review.side.empty')}
        </pre>
      )}
    </article>
  );
}
