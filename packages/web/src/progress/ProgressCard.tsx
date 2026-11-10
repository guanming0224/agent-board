// 進度卡（P3 項目一，docs/p3-spec.md §1.5）：畫布、團隊面板、Memory、收件匣共用同一張卡。
// 收合＝一行「下一步」＋相對時間；展開＝四欄位＋自動事實＋按鈕列（編輯、帶入進度卡、請隊長更新 ◈、歷史、🔒）。
// 外觀沿用母規範卡片（--surface、圓角 12、1px --border），不用任何狀態色或團隊色當底（STYLE「靜止時要安靜」）。
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  emptyProgressCard,
  firstLine,
  progressIsBlank,
  progressLength,
  progressOwnerKey,
  progressStale,
  PROGRESS_FIELDS,
  PROGRESS_LIMITS,
  ProgressConflict,
  type Broadcast,
  type ProgressCard,
  type ProgressField,
  type ProgressFields,
  type ProgressOwner,
  type ProgressRevision,
} from '@agent-board/protocol';
import { useMaskMode, useMaskText } from '../security';
import { errorCode, errorDetail } from '../shared/backend';
import { useT } from '../shared/i18n';
import { statusCode } from '../shared/status';
import { useBoard } from '../shared/store';
import { useTeams } from '../team/store';
import { errorText, formatSpan, useClock, useNow } from '../views';
import {
  changedSince,
  editedFields,
  fieldsOf,
  parseMarkdown,
  resolveConflict,
  type ConflictChoice,
  type Inline,
} from './model';
import './messages';
import './progress.css';

type T = ReturnType<typeof useT>;

/** 這個擁有者目前的卡（board 快照，WS 即時更新）；還沒寫過是空卡。 */
export function useProgressCard(owner: ProgressOwner): ProgressCard {
  const key = progressOwnerKey(owner);
  const found = useBoard((s) =>
    (s.progress ?? []).find(
      (c) => (c.teamId !== null ? `team:${c.teamId}` : `session:${c.sessionId}`) === key,
    ),
  );
  return useMemo(() => found ?? emptyProgressCard(owner), [found, owner]);
}

const exists = (card: ProgressCard) => card.revision > 0 || card.id !== null;

function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'bold' ? (
          <b key={i}>{p.text}</b>
        ) : p.kind === 'code' ? (
          <code key={i}>{p.text}</code>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/** 只渲染清單、粗體、行內 code；連結與圖片照原樣當文字（§1.2）。 */
export function Markdown({ text }: { text: string }) {
  const mask = useMaskText();
  const blocks = parseMarkdown(mask(text));
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.kind === 'list' ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>
                <InlineText parts={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <InlineText parts={line} />
              </Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

function writerName(card: Pick<ProgressCard, 'updatedBy'>, t: T): string {
  return card.updatedBy?.name ?? t('progress.unknownWriter');
}

/** 「2 小時前・隊長」或「⚠ 3 天沒更新」。 */
export function ProgressAge({ card }: { card: ProgressCard }) {
  const t = useT();
  const now = useNow();
  const clock = useClock();
  if (!card.updatedAt) return null;
  const ms = now - Date.parse(card.updatedAt);
  const full = new Date(card.updatedAt).toLocaleString();
  if (progressStale(card, now)) {
    return (
      <span
        className="progress-age stale"
        title={`${t('progress.staleTitle')}\n${full}`}
        data-testid="progress-stale"
      >
        {t('progress.stale', { span: formatSpan(ms, t) })}
      </span>
    );
  }
  const age =
    ms < 60_000 ? t('progress.age.just') : t('progress.age.ago', { span: formatSpan(ms, t) });
  return (
    <span className="progress-age" title={`${full} ${clock(card.updatedAt)}`}>
      {t('progress.age.by', { age, name: writerName(card, t) })}
    </span>
  );
}

export interface ProgressCardProps {
  owner: ProgressOwner;
  /** 團隊名稱或 session 名稱。 */
  name: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** canvas：畫布上（收合可縮成小標籤）；panel：團隊面板、Memory、收件匣（滿寬）。 */
  variant: 'canvas' | 'panel';
  /** 畫布縮得很小（< 40%）：只畫「進度」小標籤與 ⚠。 */
  tiny?: boolean;
  testId?: string;
}

export function ProgressCardView(props: ProgressCardProps) {
  const { owner, name, expanded, onExpandedChange, variant, tiny } = props;
  const t = useT();
  const card = useProgressCard(owner);
  const now = useNow();
  const mask = useMaskText();
  const key = progressOwnerKey(owner);
  const testId = props.testId ?? `progress-${key}`;
  const [editing, setEditing] = useState(false);

  if (!expanded) {
    if (!exists(card)) {
      return (
        <button
          type="button"
          // 畫布縮很小（tiny）時和「進度」小標籤一樣只佔字的寬度，不撐成 280 寬蓋到旁邊的卡。
          className={`progress-card progress-add${tiny ? ' progress-tiny' : ''} ${variant === 'canvas' ? 'on-canvas' : 'in-panel'}`}
          aria-label={t('progress.addAria', { name })}
          onClick={() => {
            onExpandedChange(true);
            setEditing(true);
          }}
          data-testid={`${testId}-add`}
        >
          {t('progress.add')}
        </button>
      );
    }
    const stale = progressStale(card, now);
    if (tiny) {
      return (
        <button
          type="button"
          className={`progress-card progress-tiny ${variant === 'canvas' ? 'on-canvas' : 'in-panel'}`}
          aria-label={t('progress.aria', { name })}
          onClick={() => onExpandedChange(true)}
          data-testid={testId}
          data-state="tiny"
        >
          <span className="progress-tag">{t('progress.tag')}</span>
          {stale && <span aria-hidden="true">⚠</span>}
        </button>
      );
    }
    const next = firstLine(card.next);
    return (
      <button
        type="button"
        className={`progress-card progress-collapsed ${variant === 'canvas' ? 'on-canvas' : 'in-panel'}`}
        aria-label={t('progress.aria', { name })}
        aria-expanded={false}
        onClick={() => onExpandedChange(true)}
        data-testid={testId}
        data-state="collapsed"
      >
        <span className="progress-tag">{t('progress.tag')}</span>
        <span className="progress-line" data-testid={`${testId}-next`}>
          {next ? t('progress.collapsed.next', { text: mask(next) }) : t('progress.collapsed.none')}
        </span>
        {card.locked && <span aria-hidden="true">🔒</span>}
        <ProgressAge card={card} />
      </button>
    );
  }

  return (
    <section
      className={`progress-card progress-expanded ${variant === 'canvas' ? 'on-canvas' : 'in-panel'}`}
      aria-label={t('progress.aria', { name })}
      data-testid={testId}
      data-state="expanded"
      data-revision={card.revision}
      onKeyDown={(e) => {
        // 焦點不在輸入框時 Esc 收合（textarea 裡的 Esc 只取消編輯，由編輯器自己處理）。
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const target = e.target as HTMLElement;
        if (target.closest('textarea, input, select')) return;
        e.preventDefault();
        onExpandedChange(false);
      }}
    >
      <header className="progress-head">
        <button
          type="button"
          className="progress-title"
          aria-expanded={true}
          title={t('progress.collapse')}
          onClick={() => onExpandedChange(false)}
          data-testid={`${testId}-collapse`}
        >
          <span className="progress-tag">{t('progress.tag')}</span>
          <b>{name}</b>
        </button>
        {card.locked && <span title={t('progress.lockHint')}>🔒</span>}
        <ProgressAge card={card} />
      </header>
      {editing ? (
        <ProgressEditor
          owner={owner}
          card={card}
          onDone={(saved) => {
            setEditing(false);
            // 新卡按取消：收回成「+ 進度卡」。
            if (!saved && !exists(card)) onExpandedChange(false);
          }}
          testId={testId}
        />
      ) : (
        <ProgressBody
          owner={owner}
          name={name}
          card={card}
          onEdit={() => setEditing(true)}
          testId={testId}
        />
      )}
    </section>
  );
}

function FieldView({ field, card, t }: { field: ProgressField; card: ProgressCard; t: T }) {
  const text = card[field];
  return (
    <div className={`progress-field f-${field}`} data-testid={`progress-field-${field}`}>
      <h4>{t(`progress.field.${field}`)}</h4>
      {text.trim() ? <Markdown text={text} /> : <p className="faint">{t('progress.fieldEmpty')}</p>}
    </div>
  );
}

function ProgressBody({
  owner,
  name,
  card,
  onEdit,
  testId,
}: {
  owner: ProgressOwner;
  name: string;
  card: ProgressCard;
  onEdit: () => void;
  testId: string;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [facts, setFacts] = useState(card.facts);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [history, setHistory] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);
  // 展開時讀一次最新的自動事實（board 快照裡的事實是上次寫入時算的）。
  useEffect(() => {
    let live = true;
    backend
      .getProgress(owner)
      .then((fresh) => live && setFacts(fresh.facts))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [backend, owner, card.revision]);

  const run = async (action: () => Promise<string | null>) => {
    try {
      const text = await action();
      setMessage(text ? { text, failed: false } : null);
    } catch (e) {
      setMessage({ text: t('progress.error', { detail: errorText(e) }), failed: true });
    }
  };
  const blank = progressIsBlank(card);
  const team = 'teamId' in owner ? owner.teamId : null;
  return (
    <>
      {card.locked && <p className="progress-locked">{t('progress.lockedNote')}</p>}
      {blank && <p className="faint">{t('progress.empty')}</p>}
      <div className="progress-fields">
        {PROGRESS_FIELDS.map((f) => (
          <FieldView key={f} field={f} card={card} t={t} />
        ))}
      </div>
      <Facts card={{ ...card, facts }} />
      <div className="progress-actions row">
        <button className="sm" type="button" onClick={onEdit} data-testid={`${testId}-edit`}>
          {t('progress.action.edit')}
        </button>
        <button
          className="sm"
          type="button"
          aria-expanded={deliverOpen}
          disabled={blank}
          title={blank ? t('progress.deliver.empty') : t('progress.deliver.hint')}
          onClick={() => setDeliverOpen((open) => !open)}
          data-testid={`${testId}-deliver`}
        >
          {t('progress.action.deliver')}
        </button>
        {team !== null && <AskUpdate teamId={team} run={run} testId={testId} />}
        <button
          className="sm"
          type="button"
          aria-pressed={history}
          onClick={() => setHistory((open) => !open)}
          data-testid={`${testId}-history`}
        >
          {t('progress.action.history')}
        </button>
        <button
          className="sm"
          type="button"
          aria-pressed={card.locked}
          title={t('progress.lockHint')}
          onClick={() =>
            void run(async () => {
              await backend.saveProgress(owner, {
                baseRevision: card.revision,
                locked: !card.locked,
              });
              return null;
            })
          }
          data-testid={`${testId}-lock`}
        >
          {card.locked ? t('progress.action.unlock') : t('progress.action.lock')}
        </button>
      </div>
      {deliverOpen && (
        <DeliverMenu
          owner={owner}
          onPick={(sessionId) => {
            setDeliverOpen(false);
            void run(async () => {
              await backend.deliverProgress(owner, sessionId);
              return null;
            });
          }}
          testId={testId}
        />
      )}
      <SendStatus cardKey={progressOwnerKey(owner)} testId={testId} />
      {message && (
        <p className={`msg${message.failed ? ' err' : ''}`} role="status">
          {message.text}
        </p>
      )}
      {history && (
        <History
          owner={owner}
          name={name}
          card={card}
          onClose={() => setHistory(false)}
          testId={testId}
        />
      )}
    </>
  );
}

function Facts({ card }: { card: ProgressCard }) {
  const t = useT();
  const mask = useMaskText();
  const { facts } = card;
  const sessions = useBoard((s) => s.sessions);
  const awaitingOf = new Map(sessions.map((s) => [s.id, s.awaiting]));
  return (
    <div className="progress-facts" data-testid="progress-facts">
      <h4>{t('progress.facts.title')}</h4>
      <ul>
        {facts.tasks && (
          <li>
            {t('progress.facts.tasks', { done: facts.tasks.done, total: facts.tasks.total })}
            {facts.tasks.doing.length > 0 && (
              <>
                {' · '}
                {t('progress.facts.doing', { list: mask(facts.tasks.doing.join('、')) })}
              </>
            )}
          </li>
        )}
        <li className="mono">
          {facts.recentFiles.length > 0
            ? t('progress.facts.files', { list: mask(facts.recentFiles.join(', ')) })
            : t('progress.facts.noFiles')}
        </li>
        {facts.phase && <li>{t('progress.facts.phase', { phase: facts.phase })}</li>}
        {facts.members.length > 0 && (
          <li className="progress-members">
            {t('progress.facts.members')}：
            {facts.members.map((m) => {
              // 等隊長／等成員結果是 hub 即時算的（不在事實快照裡），從畫面上的 session 補。
              const code = m.ended
                ? 'DONE'
                : statusCode({
                    status: m.status,
                    statusDetail: m.statusDetail,
                    awaiting: awaitingOf.get(m.sessionId),
                  });
              return (
                <span key={m.sessionId} className="progress-member" title={m.name}>
                  <span className="mono">{code}</span> {m.name}
                </span>
              );
            })}
          </li>
        )}
        {card.updatedAt && (
          <li>
            {t('progress.facts.updated', {
              at: new Date(card.updatedAt).toLocaleString(),
              name: card.updatedBy?.name ?? t('progress.unknownWriter'),
              rev: card.revision,
            })}
          </li>
        )}
      </ul>
    </div>
  );
}

function AskUpdate({
  teamId,
  run,
  testId,
}: {
  teamId: string;
  run: (action: () => Promise<string | null>) => Promise<void>;
  testId: string;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const members = useTeams((s) => s.members);
  const hasLead = members.some(
    (m) =>
      m.teamId === teamId &&
      m.role === 'lead' &&
      sessions.some((s) => s.id === m.sessionId && !s.archived),
  );
  return (
    <span className="progress-ask">
      <button
        className="sm"
        type="button"
        disabled={!hasLead}
        title={hasLead ? t('progress.askHint') : t('progress.askNoLead')}
        onClick={() =>
          void run(async () => {
            await backend.askProgressUpdate(teamId);
            return null;
          })
        }
        data-testid={`${testId}-ask`}
      >
        {t('progress.action.askUpdate')}
      </button>
      <span className="chip cost" data-testid={`${testId}-ask-cost`}>
        ◈ {t('progress.cost')}
      </span>
      {!hasLead && <span className="faint">{t('progress.askNoLead')}</span>}
    </span>
  );
}

/** 帶入進度卡 ▾：團隊成員（隊長在最上、預設選它）＋「其他 session…」。 */
function DeliverMenu({
  owner,
  onPick,
  testId,
}: {
  owner: ProgressOwner;
  onPick: (sessionId: string) => void;
  testId: string;
}) {
  const t = useT();
  const sessions = useBoard((s) => s.sessions);
  const members = useTeams((s) => s.members);
  const [other, setOther] = useState(false);
  const live = sessions.filter((s) => !s.archived && s.endedAt === null);
  const teamMembers =
    'teamId' in owner
      ? members
          .filter((m) => m.teamId === owner.teamId)
          .flatMap((m) => {
            const s = live.find((x) => x.id === m.sessionId);
            return s ? [{ session: s, lead: m.role === 'lead' }] : [];
          })
          .sort(
            (a, b) =>
              Number(b.lead) - Number(a.lead) || a.session.name.localeCompare(b.session.name),
          )
      : [];
  return (
    <div className="progress-deliver" role="menu" aria-label={t('progress.deliver.aria')}>
      {teamMembers.map(({ session, lead }) => (
        <button
          className="sm"
          key={session.id}
          type="button"
          role="menuitem"
          autoFocus={lead}
          onClick={() => onPick(session.id)}
          data-testid={`${testId}-deliver-${session.id}`}
        >
          {lead ? t('progress.deliver.lead', { name: session.name }) : session.name}
        </button>
      ))}
      {other ? (
        <select
          aria-label={t('progress.deliver.pick')}
          defaultValue=""
          autoFocus
          onChange={(e) => e.target.value && onPick(e.target.value)}
          data-testid={`${testId}-deliver-select`}
        >
          <option value="" disabled>
            {t('progress.deliver.pick')}
          </option>
          {live.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : (
        <button
          className="sm"
          type="button"
          role="menuitem"
          onClick={() => setOther(true)}
          data-testid={`${testId}-deliver-other`}
        >
          {t('progress.deliver.other')}
        </button>
      )}
      <p className="faint">{t('progress.deliver.hint')}</p>
    </div>
  );
}

/** 最近一次「帶入進度卡」／「請隊長更新」的結果（同群發的格式，排隊中可取消）。 */
function SendStatus({ cardKey, testId }: { cardKey: string; testId: string }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const latest = useBoard((s) =>
    (s.broadcasts ?? []).filter((b: Broadcast) => b.cardKey === cardKey).at(-1),
  );
  if (!latest) return null;
  return (
    <ul className="progress-sent">
      {latest.targets.map((target) => (
        <li
          key={target.sessionId}
          data-testid={`${testId}-sent`}
          data-state={target.state}
          data-kind={latest.kind}
          title={latest.text}
        >
          {t(`progress.send.${target.state}`, { name: target.name })}
          {target.state === 'queued' && (
            <button
              type="button"
              className="link"
              onClick={() => void backend.cancelBroadcast(latest.id, target.sessionId)}
              data-testid={`${testId}-sent-cancel`}
            >
              {t('progress.send.cancel')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── 編輯 ──────────────────────────────────────────────

interface EditState {
  /** 開始編輯（或衝突後重新對齊）時的版本與內容。 */
  base: number;
  original: ProgressFields;
  draft: ProgressFields;
}

function ProgressEditor({
  owner,
  card,
  onDone,
  testId,
}: {
  owner: ProgressOwner;
  card: ProgressCard;
  onDone: (saved: boolean) => void;
  testId: string;
}) {
  const t = useT();
  const clock = useClock();
  const mask = useMaskText();
  const masking = useMaskMode((s) => s.masking);
  const backend = useBoard((s) => s.backend);
  const [edit, setEdit] = useState<EditState>(() => ({
    base: card.revision,
    original: fieldsOf(card),
    draft: fieldsOf(card),
  }));
  const [conflict, setConflict] = useState<ProgressConflict | null>(null);
  const [choices, setChoices] = useState<Partial<Record<ProgressField, ConflictChoice>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);

  // 編輯中被別人（agent）改過的欄位：上方一行提示，不覆蓋正在打的字。
  const changed = conflict ? [] : changedSince(card, edit.base);
  const over = PROGRESS_FIELDS.filter((f) => progressLength(edit.draft[f]) > PROGRESS_LIMITS[f]);
  const unresolved = conflict ? conflict.fields.some((f) => choices[f.field] === undefined) : false;

  const save = async () => {
    if (busy || over.length > 0 || unresolved) return;
    let { base, original, draft } = edit;
    if (conflict) {
      // 衝突後：以目前版本為準重新對齊。我沒動過的欄位換成目前的內容，衝突欄位照選的結果。
      const current = fieldsOf(conflict.card);
      const next = { ...draft };
      for (const f of PROGRESS_FIELDS) if (draft[f] === original[f]) next[f] = current[f];
      for (const { field } of conflict.fields) {
        next[field] = resolveConflict(draft[field], current[field], choices[field]!);
      }
      base = conflict.card.revision;
      original = current;
      draft = next;
    }
    const patch = editedFields(original, draft);
    if (Object.keys(patch).length === 0) {
      onDone(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await backend.saveProgress(owner, { baseRevision: base, ...patch });
      onDone(true);
    } catch (e) {
      if (errorCode(e) === 'progress_conflict') {
        const parsed = ProgressConflict.safeParse(errorDetail(e));
        if (parsed.success) {
          setEdit({ base, original, draft });
          setConflict(parsed.data);
          setChoices({});
          return;
        }
      }
      setError(t('progress.error', { detail: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      // textarea 內的 Esc 只取消編輯，不關面板、不收合卡片。
      e.preventDefault();
      e.stopPropagation();
      onDone(false);
    }
  };

  const conflictBy =
    conflict?.fields.find((f) => f.by?.name)?.by?.name ?? t('progress.conflict.someone');
  return (
    <div className="progress-editor" onKeyDown={onKeyDown} data-testid={`${testId}-editor`}>
      {masking && (
        <p className="progress-notice" role="note" data-testid={`${testId}-mask-note`}>
          {t('progress.edit.maskNote')}
        </p>
      )}
      {changed.length > 0 && card.updatedAt && (
        <div className="progress-notice" role="status" data-testid={`${testId}-changed`}>
          {t('progress.edit.changedWhileEditing', {
            name: card.updatedBy?.name ?? t('progress.unknownWriter'),
            time: clock(card.updatedAt),
            fields: changed.map((f) => t(`progress.field.${f}`)).join('、'),
          })}{' '}
          <button type="button" className="link" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? t('progress.edit.hideDiff') : t('progress.edit.viewDiff')}
          </button>
          {showDiff && (
            <dl className="progress-diff">
              {changed.map((f) => (
                <Fragment key={f}>
                  <dt>{t(`progress.field.${f}`)}</dt>
                  <dd>
                    <DiffPair before={edit.original[f]} after={card[f]} />
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
        </div>
      )}
      {conflict && (
        <div className="progress-conflict" role="alert" data-testid={`${testId}-conflict`}>
          <p>{t('progress.conflict.title', { name: conflictBy })}</p>
          {conflict.fields.map(({ field }) => (
            <div key={field} className="progress-conflict-field" data-field={field}>
              <h4>{t(`progress.field.${field}`)}</h4>
              <div className="progress-sides">
                <div>
                  <h5>{t('progress.conflict.mine')}</h5>
                  <pre>
                    {edit.draft[field] ? mask(edit.draft[field]) : t('progress.fieldEmpty')}
                  </pre>
                </div>
                <div>
                  <h5>{t('progress.conflict.theirs')}</h5>
                  <pre>
                    {conflict.card[field] ? mask(conflict.card[field]) : t('progress.fieldEmpty')}
                  </pre>
                </div>
              </div>
              <div className="seg sm" role="group" aria-label={t(`progress.field.${field}`)}>
                {(['mine', 'theirs', 'both'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    // 三選一用分段切換：選中＝全站的「按下」樣式（controls.css），
                    // 白色主按鈕只留給下面的「存檔」（GM Q2、Q3「先選再送出」）。
                    aria-pressed={choices[field] === choice}
                    onClick={() => setChoices((c) => ({ ...c, [field]: choice }))}
                    data-testid={`${testId}-conflict-${field}-${choice}`}
                  >
                    {t(
                      choice === 'mine'
                        ? 'progress.conflict.useMine'
                        : choice === 'theirs'
                          ? 'progress.conflict.useTheirs'
                          : 'progress.conflict.both',
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {unresolved && <p className="faint">{t('progress.conflict.pickAll')}</p>}
        </div>
      )}
      {PROGRESS_FIELDS.map((f, i) => {
        const length = progressLength(edit.draft[f]);
        const max = PROGRESS_LIMITS[f];
        const tooLong = length > max;
        const id = `${testId}-input-${f}`;
        return (
          <div key={f} className={`progress-input f-${f}`}>
            <label htmlFor={id}>
              {t(`progress.field.${f}`)}
              {f === 'gmNotes' && <span className="faint"> — {t('progress.gmNotesHint')}</span>}
            </label>
            <textarea
              id={id}
              ref={i === 0 ? first : undefined}
              rows={f === 'gmNotes' ? 3 : 2}
              value={edit.draft[f]}
              aria-invalid={tooLong}
              onChange={(e) =>
                setEdit((s) => ({ ...s, draft: { ...s.draft, [f]: e.target.value } }))
              }
              data-testid={id}
            />
            <span className={`progress-count num${tooLong ? ' err' : ''}`}>
              {tooLong
                ? t('progress.edit.tooLong', { max })
                : t('progress.edit.count', { n: length, max })}
            </span>
          </div>
        );
      })}
      <div className="row progress-edit-actions">
        <button
          type="button"
          className="sm primary"
          disabled={busy || over.length > 0 || unresolved}
          title={t('progress.edit.saveHint')}
          onClick={() => void save()}
          data-testid={`${testId}-save`}
        >
          {t('progress.edit.save')}
        </button>
        <button
          className="sm"
          type="button"
          onClick={() => onDone(false)}
          data-testid={`${testId}-cancel`}
        >
          {t('progress.edit.cancel')}
        </button>
        <span className="faint">{t('progress.edit.saveHint')}</span>
      </div>
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DiffPair({ before, after }: { before: string; after: string }): ReactNode {
  const t = useT();
  const mask = useMaskText();
  return (
    <div className="progress-sides">
      <pre className="before">{before ? mask(before) : t('progress.fieldEmpty')}</pre>
      <pre className="after" aria-label={t('progress.edit.diffNow')}>
        {after ? mask(after) : t('progress.fieldEmpty')}
      </pre>
    </div>
  );
}

// ── 歷史 ──────────────────────────────────────────────

function History({
  owner,
  card,
  onClose,
  testId,
}: {
  owner: ProgressOwner;
  name: string;
  card: ProgressCard;
  onClose: () => void;
  testId: string;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [rows, setRows] = useState<ProgressRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    backend
      .progressRevisions(owner)
      .then((list) => live && setRows(list))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [backend, owner, card.revision]);

  return (
    <div className="progress-history" data-testid={`${testId}-history-list`}>
      <div className="row">
        <h4>{t('progress.history.title')}</h4>
        <span className="spacer" />
        <button type="button" className="link" onClick={onClose}>
          {t('progress.history.close')}
        </button>
      </div>
      {error && <p className="msg err">{t('progress.error', { detail: error })}</p>}
      {message && (
        <p className="msg" role="status">
          {message}
        </p>
      )}
      {rows && rows.length === 0 && <p className="faint">{t('progress.history.empty')}</p>}
      <ol>
        {(rows ?? []).map((row, i) => {
          const previous = rows![i + 1];
          const diff = PROGRESS_FIELDS.filter(
            (f) => !previous || previous.fields[f] !== row.fields[f],
          );
          return (
            <li key={row.revision} data-testid={`${testId}-rev-${row.revision}`}>
              <div className="row">
                <span>
                  {t('progress.history.row', {
                    rev: row.revision,
                    at: new Date(row.at).toLocaleString(),
                    name: row.by.name ?? t('progress.unknownWriter'),
                  })}
                </span>
                <span className="chip">{t(`progress.history.source.${row.source}`)}</span>
                <span className="spacer" />
                {row.revision !== card.revision && (
                  <button
                    className="sm"
                    type="button"
                    onClick={() =>
                      void backend
                        .restoreProgress(owner, row.revision)
                        .then((next) =>
                          setMessage(
                            t('progress.history.restored', {
                              from: row.revision,
                              rev: next.revision,
                            }),
                          ),
                        )
                        .catch((e: unknown) => setError(errorText(e)))
                    }
                    data-testid={`${testId}-restore-${row.revision}`}
                  >
                    {t('progress.history.restore')}
                  </button>
                )}
              </div>
              {diff.length === 0 ? (
                <p className="faint">{t('progress.history.unchanged')}</p>
              ) : (
                <dl className="progress-diff">
                  {diff.map((f) => (
                    <Fragment key={f}>
                      <dt>{t(`progress.field.${f}`)}</dt>
                      <dd>
                        <DiffPair before={previous?.fields[f] ?? ''} after={row.fields[f]} />
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
