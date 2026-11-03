// 審核中心：按「允許」之前先確認呼號（STYLE.md 邏輯 2、6）。
import { useEffect, useRef, useState } from 'react';
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
import { summarizeTool } from './toolView';
import { isFault, workItems, type WorkItem } from './workItems';

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
    <>
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
        <button type="button" disabled={disabled} onClick={deny}>
          {t('flows.review.deny')}
        </button>
        {!twoStep.armed && <Msg note={decide.note} />}
      </div>
      {twoStep.armed && (
        <div className="armed" role="status">
          <div>{t('flows.review.armedHint')}</div>
          {fullText !== null && <pre className="command">{mask(fullText)}</pre>}
        </div>
      )}
      {!danger && !canRemember && <p className="hint">{t('flows.review.noSuggestions')}</p>}
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
    </>
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
    <>
      <div className="acts">
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() => void decide.decide({ behavior: 'allow', remember: false })}
        >
          {t('flows.review.approvePlan')}
        </button>
        <button type="button" disabled={disabled} onClick={requestChanges}>
          {t('flows.review.requestChanges')}
        </button>
        <Msg note={decide.note} />
      </div>
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
    </>
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
    <>
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
    </>
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
    <>
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
    </>
  );
}

function ReviewCard({
  item,
  context,
  targeted,
}: {
  item: WorkItem;
  context: CardContext;
  targeted: boolean;
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

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      className={`card review ${session ? handsClass(session.permissionMode) : ''}${gone ? ' gone' : ''}${targeted ? ' targeted' : ''}`}
      data-testid={`review-${item.key}`}
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

      {approval && approval.kind !== 'question' && approval.kind !== 'plan' && (
        <ToolBody approval={approval} />
      )}
      {approval?.kind === 'plan' && (
        <pre className="command plan">
          {mask(planText(approval) ?? approval.message ?? session?.lastLines.join('\n') ?? '')}
        </pre>
      )}
      {!approval && session && <pre className="command">{mask(session.lastLines.join('\n'))}</pre>}

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
    </section>
  );
}

export function ReviewPage() {
  const t = useT();
  const board = useBoard();
  const projects = useProjects();
  const me = useCurrentUser();
  const target = useTargetSession();
  const now = useNow();
  // 故障（✕ ⚠）沒有東西可審，留在待處理清單與收件匣。
  const items = workItems(board).filter((item) => !isFault(item));
  const settling = useListSettling(items.map((item) => item.key).join('|'));
  const context: CardContext = {
    machines: board.machines,
    projects: projects.data ?? [],
    now,
    me,
    settling,
  };

  // 同一個 session 有多張卡時，指向排最前面的那張。
  const targetKey = items.find(
    (item) => (item.approval?.sessionId ?? item.session?.id) === target,
  )?.key;
  const loaded = !(projects.loading && !projects.data);

  return (
    <Page>
      <header className="page-head">
        <h1>{t('flows.review.title')}</h1>
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
        <div className="grid2">
          {items.map((item) => (
            <ReviewCard
              key={item.key}
              item={item}
              context={context}
              targeted={item.key === targetKey}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
