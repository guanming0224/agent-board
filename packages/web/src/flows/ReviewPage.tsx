// 審核中心：按「允許」之前先確認呼號（STYLE.md 邏輯 2、6）。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Approval, Machine, Project, Session, User } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  answerDecision,
  parseQuestions,
  planText,
  ToolBody,
  useBlockedReason,
  useDecide,
} from './approvalParts';
import {
  callsign,
  Callsign,
  Empty,
  ErrorBox,
  handsClass,
  Lamp,
  Loading,
  ModeChip,
  Msg,
  Page,
  useCurrentUser,
  useListSettling,
  useNow,
  useProjects,
  useTargetSession,
  useTwoStep,
  WaitAge,
  type Loaded,
  type Note,
} from './common';
import { terminalHash } from '../canvas/terminalRoute';
import { DecisionHistory } from './DecisionHistory';
import { StatusBadge } from './StatusBadge';
import { summarizeTool } from './toolView';
import {
  contextLine,
  groupReview,
  keepSelection,
  reviewGroupOf,
  reviewItems,
  type ReviewGroup,
} from './triage';
import { workItems, type WorkItem } from './workItems';

interface CardContext {
  machines: Machine[];
  projects: Project[];
  now: number;
  me: Loaded<User | null>;
  settling: boolean;
}

function RequiredField({
  label,
  value,
  onChange,
  invalid,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <textarea
      ref={inputRef}
      className="field-input"
      rows={2}
      value={value}
      placeholder={label}
      aria-label={label}
      aria-invalid={invalid}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 一般權限請求與危險指令的動作列。 */
function PermissionActions({
  approval,
  disabled,
  decide,
  canDecide,
}: {
  approval: Approval;
  disabled: boolean;
  /** false：這個使用者不能決定，連拒絕原因也不用填。 */
  canDecide: boolean;
  decide: ReturnType<typeof useDecide>;
}) {
  const t = useT();
  const danger = approval.kind === 'danger';
  const twoStep = useTwoStep();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const canRemember = approval.suggestions.length > 0;
  const view = summarizeTool(approval.toolName, approval.toolInput);
  const fullText = view.kind === 'command' || view.kind === 'raw' ? view.text : null;
  const mask = useMaskText();

  const deny = () => {
    const text = reason.trim();
    if (!text) {
      setInvalid(true);
      decide.setNote({ text: t('flows.review.denyNeedsReason'), tone: 'err' });
      reasonRef.current?.focus();
      return;
    }
    twoStep.disarm();
    void decide.decide({ behavior: 'deny', reason: text });
  };
  const allowOnce = () => {
    if (!danger) return void decide.decide({ behavior: 'allow', remember: false });
    twoStep.press(() => void decide.decide({ behavior: 'allow', remember: false }));
  };

  return (
    <div className="decision-bar">
      <div className="acts">
        <button
          type="button"
          className={danger ? 'danger' : 'primary'}
          disabled={disabled}
          onClick={allowOnce}
        >
          {twoStep.armed ? t('flows.review.confirmAgain') : t('flows.review.allowOnce')}
        </button>
        {!danger && (
          <button
            type="button"
            disabled={disabled || !canRemember}
            title={canRemember ? undefined : t('flows.review.noSuggestions')}
            onClick={() => void decide.decide({ behavior: 'allow', remember: true })}
          >
            {t('flows.review.allowRemember')}
          </button>
        )}
        {!twoStep.armed && <Msg note={decide.note} />}
      </div>
      {twoStep.armed && (
        <div className="armed" role="status">
          <div>{t('flows.review.armedHint')}</div>
          {fullText !== null && <pre className="command">{mask(fullText)}</pre>}
        </div>
      )}
      {!danger && !canRemember && <p className="hint">{t('flows.review.noSuggestions')}</p>}
      <div className="deny-row">
        {canDecide && (
          <RequiredField
            label={t('flows.review.denyReason')}
            value={reason}
            invalid={invalid}
            inputRef={reasonRef}
            onChange={(value) => {
              setReason(value);
              setInvalid(false);
            }}
          />
        )}
        <button type="button" disabled={disabled} onClick={deny}>
          {t('flows.review.deny')}
        </button>
      </div>
    </div>
  );
}

function PlanActions({
  disabled,
  decide,
}: {
  disabled: boolean;
  decide: ReturnType<typeof useDecide>;
}) {
  const t = useT();
  const [comment, setComment] = useState('');
  const [invalid, setInvalid] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const requestChanges = () => {
    const text = comment.trim();
    if (!text) {
      setInvalid(true);
      decide.setNote({ text: t('flows.review.changesNeedComment'), tone: 'err' });
      commentRef.current?.focus();
      return;
    }
    void decide.decide({ behavior: 'deny', reason: text });
  };
  return (
    <div className="decision-bar">
      <div className="acts">
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() => void decide.decide({ behavior: 'allow', remember: false })}
        >
          {t('flows.review.approvePlan')}
        </button>
        <Msg note={decide.note} />
      </div>
      <div className="deny-row">
        <RequiredField
          label={t('flows.review.changesComment')}
          value={comment}
          invalid={invalid}
          inputRef={commentRef}
          onChange={(value) => {
            setComment(value);
            setInvalid(false);
          }}
        />
        <button type="button" disabled={disabled} onClick={requestChanges}>
          {t('flows.review.requestChanges')}
        </button>
      </div>
    </div>
  );
}

function QuestionActions({
  approval,
  disabled,
  decide,
}: {
  approval: Approval;
  disabled: boolean;
  decide: ReturnType<typeof useDecide>;
}) {
  const t = useT();
  const mask = useMaskText();
  const [answer, setAnswer] = useState('');
  const [invalid, setInvalid] = useState(false);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const questions = parseQuestions(approval);
  const send = () => {
    const text = answer.trim();
    if (!text) {
      setInvalid(true);
      decide.setNote({ text: t('flows.review.answerRequired'), tone: 'err' });
      answerRef.current?.focus();
      return;
    }
    void decide.decide(answerDecision(text));
  };
  return (
    <div className="decision-bar">
      {questions.map((q) => (
        <div key={q.question} className="question">
          <p className="body-text">{mask(q.question)}</p>
          {q.options.length > 0 && (
            <div className="acts">
              {q.options.map((option) => (
                <button
                  type="button"
                  key={option}
                  aria-pressed={answer === option}
                  disabled={disabled}
                  onClick={() => {
                    setAnswer(option);
                    setInvalid(false);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <RequiredField
        label={t('flows.review.answer')}
        value={answer}
        invalid={invalid}
        inputRef={answerRef}
        onChange={(value) => {
          setAnswer(value);
          setInvalid(false);
        }}
      />
      <div className="acts">
        <button type="button" className="primary" disabled={disabled} onClick={send}>
          {t('flows.review.sendAnswer')}
        </button>
        <Msg note={decide.note} />
      </div>
    </div>
  );
}

/** 等你回覆但沒有 approval：直接送進 session。 */
function ReplyActions({ session, disabled }: { session: Session; disabled: boolean }) {
  const t = useT();
  const { backend } = useBoard();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const value = text.trim();
    if (!value) {
      setInvalid(true);
      setNote({ text: t('flows.review.answerRequired'), tone: 'err' });
      inputRef.current?.focus();
      return;
    }
    backend.sendPrompt(session.id, value);
    setText('');
    setNote({ text: t('flows.review.sent') });
  };
  return (
    <div className="decision-bar">
      <RequiredField
        label={t('flows.review.answer')}
        value={text}
        invalid={invalid}
        inputRef={inputRef}
        onChange={(value) => {
          setText(value);
          setInvalid(false);
        }}
      />
      <div className="acts">
        <button type="button" className="primary" disabled={disabled} onClick={send}>
          {t('flows.review.sendAnswer')}
        </button>
        <Msg note={note} />
      </div>
    </div>
  );
}

/** 很長的計畫或輸出：先收合，按鈕展開全文（文字一直都在 DOM 裡，只是限制高度）。 */
function Collapsible({ text, children }: { text: string; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > COLLAPSE_LINES || text.length > COLLAPSE_CHARS;
  if (!long) return <>{children}</>;
  return (
    <div className={`collapsible${open ? ' open' : ''}`}>
      {children}
      <button
        type="button"
        className="link-button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t('flows.review.collapse') : t('flows.review.expand')}
      </button>
    </div>
  );
}

const COLLAPSE_LINES = 14;
const COLLAPSE_CHARS = 1400;

/** 為什麼要你決定：一句白話。 */
function WhyLine({ item }: { item: WorkItem }) {
  const t = useT();
  const kind = reviewGroupOf(item);
  const mode = item.session?.permissionMode ?? 'default';
  const text =
    kind === 'permission'
      ? t('flows.review.why.permission', { mode })
      : t(
          kind === 'danger'
            ? 'flows.review.why.danger'
            : kind === 'plan'
              ? 'flows.review.why.plan'
              : kind === 'question'
                ? 'flows.review.why.question'
                : 'flows.review.why.reply',
        );
  return <p className="why">{text}</p>;
}

function ReviewCard({
  item,
  context,
  targeted,
  detail = false,
}: {
  item: WorkItem;
  context: CardContext;
  targeted: boolean;
  /** 審核中心右側的詳細面板：多顯示原因與 session 最後的輸出。 */
  detail?: boolean;
}) {
  const t = useT();
  const mask = useMaskText();
  const cardRef = useRef<HTMLElement>(null);
  // 從畫布的「檢視並決定」進來：只在變成目標時捲動與聚焦一次，之後的資料更新不搶焦點。
  useEffect(() => {
    if (!targeted) return;
    cardRef.current?.scrollIntoView({ block: 'center' });
    cardRef.current?.focus({ preventScroll: true });
  }, [targeted]);
  const { approval, session } = item;
  const decide = useDecide(approval);
  const machine = context.machines.find((m) => m.id === session?.machineId);
  const blocked = useBlockedReason(session !== null, machine, approval, context.me);
  const disabled = blocked !== null || decide.busy || context.settling;
  const danger = approval?.kind === 'danger';
  const bypass = session?.permissionMode === 'bypassPermissions';
  const gone = machine !== undefined && !machine.online;
  const plan =
    approval?.kind === 'plan'
      ? (planText(approval) ?? approval.message ?? session?.lastLines.join('\n') ?? '')
      : null;
  const tail = session?.lastLines.join('\n') ?? '';

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      className={`card review ${session ? handsClass(session.permissionMode) : ''}${gone ? ' gone' : ''}${targeted ? ' targeted' : ''}${detail ? ' detail' : ''}`}
      data-testid={`review-${item.key}`}
      aria-label={session?.name ?? t('flows.review.unknownSession')}
    >
      {danger && (
        <div className="alert" role="alert">
          <span aria-hidden="true">⛔</span>
          <div className="alert-body">
            <div>
              {t('flows.review.dangerHit')}{' '}
              {approval.matchedRule && <Callsign text={approval.matchedRule} />}
            </div>
            {bypass && <div className="sub">{t('flows.review.dangerBypass')}</div>}
          </div>
        </div>
      )}
      <div className="sign">
        {session ? (
          <>
            <Callsign text={callsign(session, context.machines, context.projects)} />
            <ModeChip mode={session.permissionMode} />
          </>
        ) : (
          <Callsign text={t('flows.review.unknownSession')} />
        )}
      </div>
      <div className="head">
        <Lamp status={item.status} />
        {session && <h2 className="title">{session.name}</h2>}
        <WaitAge since={item.since} now={context.now} />
      </div>
      {detail && <WhyLine item={item} />}

      {approval && approval.kind !== 'question' && approval.kind !== 'plan' && (
        <ToolBody approval={approval} />
      )}
      {plan !== null && (
        <Collapsible text={plan}>
          <pre className="command plan">{mask(plan)}</pre>
        </Collapsible>
      )}
      {!approval && session && (
        <Collapsible text={tail}>
          <pre className="command">{mask(tail)}</pre>
        </Collapsible>
      )}

      {blocked && <p className="blocked">{blocked}</p>}

      {approval && (approval.kind === 'permission' || approval.kind === 'danger') && (
        <PermissionActions
          approval={approval}
          disabled={disabled}
          decide={decide}
          canDecide={!danger || context.me.data?.role === 'owner'}
        />
      )}
      {approval?.kind === 'plan' && <PlanActions disabled={disabled} decide={decide} />}
      {approval?.kind === 'question' && (
        <QuestionActions approval={approval} disabled={disabled} decide={decide} />
      )}
      {!approval && session?.status === 'waiting_input' && (
        <ReplyActions session={session} disabled={disabled} />
      )}
      {!approval && session && session.status !== 'waiting_input' && (
        <p className="hint">{t('flows.review.useTerminal')}</p>
      )}

      {detail && approval && session && tail.trim() && (
        <details className="session-tail">
          <summary>{t('flows.review.lastOutput')}</summary>
          <pre className="tail-lines">{mask(tail)}</pre>
        </details>
      )}
      {detail && session && (
        <div className="detail-links">
          <a href={terminalHash(session.id)}>{t('flows.triage.openTerminal')}</a>
        </div>
      )}
    </section>
  );
}

const GROUP_LABEL: Record<ReviewGroup, string> = {
  danger: 'flows.review.group.danger',
  permission: 'flows.review.group.permission',
  plan: 'flows.review.group.plan',
  question: 'flows.review.group.question',
  reply: 'flows.review.group.reply',
};

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  );
}

/** 窄螢幕清單在上、詳細在下：選了之後捲到詳細。 */
const NARROW = '(max-width: 899px)';

export function ReviewPage() {
  const t = useT();
  const mask = useMaskText();
  const board = useBoard();
  const projects = useProjects();
  const me = useCurrentUser();
  const target = useTargetSession();
  const now = useNow();
  const items = reviewItems(workItems(board));
  const groups = groupReview(items);
  const order = groups.flatMap((g) => g.items.map((item) => item.key));
  const settling = useListSettling(items.map((item) => item.key).join('|'));
  const context: CardContext = {
    machines: board.machines,
    projects: projects.data ?? [],
    now,
    me,
    settling,
  };

  // 同一個 session 有多張卡時，指向排最前面的那張。
  const targetKey = groups
    .flatMap((g) => g.items)
    .find((item) => (item.approval?.sessionId ?? item.session?.id) === target)?.key;
  const loaded = !(projects.loading && !projects.data);

  const [picked, setPicked] = useState<string | null>(null);
  const previous = useRef(order);
  // 選中的處理掉之後，選原本位置的下一個（不跳回最上面）。
  const selected = keepSelection(previous.current, order, picked);
  useEffect(() => {
    previous.current = order;
    if (selected !== picked) setPicked(selected);
  });
  // 從畫布或網址指定的 session：選它。
  useEffect(() => {
    if (targetKey) setPicked(targetKey);
  }, [targetKey]);

  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const select = (key: string, focusRow = false) => {
    setPicked(key);
    if (focusRow) {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
        ?.focus({ preventScroll: false });
    }
  };
  const move = (step: 1 | -1) => {
    if (order.length === 0) return;
    const at = selected === null ? -1 : order.indexOf(selected);
    const next = order[Math.max(0, Math.min(order.length - 1, at + step))];
    if (next) select(next, true);
  };

  // j／k、↑↓ 換選中的項目；在輸入框裡不搶。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || isTyping(e.target)) return;
      const inList = listRef.current?.contains(e.target as Node) ?? false;
      const free = e.target === document.body || e.target === document.documentElement;
      if (!inList && !free) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const current = items.find((item) => item.key === selected) ?? null;

  return (
    <Page>
      <header className="page-head">
        <h1>{t('flows.review.title')}</h1>
        {items.length > 0 && (
          <span className="sub" data-testid="review-total">
            {t('flows.review.total', { n: items.length })}
          </span>
        )}
      </header>
      {target && loaded && !targetKey && (
        <p className="blocked target-missing" role="status" data-testid="review-target-missing">
          {t('flows.review.targetNone')}
        </p>
      )}
      {projects.error && (
        <ErrorBox
          what={t('flows.error.projects', { error: projects.error })}
          how={t('flows.error.projectsHow')}
          onRetry={projects.reload}
        />
      )}
      {!loaded ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty
          title={t('flows.waiting.none')}
          next={
            <>
              {t('flows.review.emptyNext')} <a href="#/new">{t('flows.new.title')}</a>
            </>
          }
        />
      ) : (
        <div className="review-layout">
          <nav className="review-queue" ref={listRef} aria-label={t('flows.review.listAria')}>
            {groups.map(({ group, items: rows }) => (
              <section key={group} data-testid={`review-group-${group}`}>
                <h2 className="group-title">
                  {t(GROUP_LABEL[group])}
                  <span className="count num">{rows.length}</span>
                </h2>
                <ul>
                  {rows.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        className="review-row"
                        data-key={item.key}
                        data-testid={`review-row-${item.key}`}
                        aria-current={item.key === selected ? 'true' : undefined}
                        tabIndex={item.key === selected ? 0 : -1}
                        onClick={() => {
                          select(item.key);
                          if (matchMedia(NARROW).matches) {
                            detailRef.current?.scrollIntoView({ block: 'start' });
                          }
                        }}
                      >
                        <span className="row-top">
                          <StatusBadge kind={reviewGroupOf(item)} />
                          <span className="row-name">
                            {item.session?.name ?? t('flows.review.unknownSession')}
                          </span>
                          <WaitAge since={item.since} now={now} />
                        </span>
                        <span className="row-context">
                          {mask(
                            item.session ? contextLine({ ...item, session: item.session }) : '',
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="keys">{t('flows.review.keys')}</p>
          </nav>
          <div className="review-detail" ref={detailRef}>
            {current && (
              <ReviewCard
                key={current.key}
                item={current}
                context={context}
                targeted={current.key === targetKey}
                detail
              />
            )}
          </div>
        </div>
      )}
      {loaded && <DecisionHistory me={me} />}
    </Page>
  );
}

/** 全尺寸終端機旁用：只列這個 session 待決的 approval，按鈕與規則和審核中心同一套。 */
export function SessionReviewCards({ sessionId }: { sessionId: string }) {
  const board = useBoard();
  const projects = useProjects();
  const me = useCurrentUser();
  const now = useNow();
  const items = workItems(board).filter((item) => item.approval?.sessionId === sessionId);
  const settling = useListSettling(items.map((item) => item.key).join('|'));
  if (items.length === 0) return null;
  const context: CardContext = {
    machines: board.machines,
    projects: projects.data ?? [],
    now,
    me,
    settling,
  };
  return (
    <div className="flows session-reviews">
      {items.map((item) => (
        <ReviewCard key={item.key} item={item} context={context} targeted={false} />
      ))}
    </div>
  );
}
