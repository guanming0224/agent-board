// 手機 PWA 收件匣：只列待處理項目，大按鈕；複雜操作回電腦（DISPATCH §5.3-6）。
import { useRef, useState } from 'react';
import type { Approval, Machine, Project, Session, User } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  answerDecision,
  parseQuestions,
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
  useTwoStep,
  WaitAge,
  Waiting,
  type Loaded,
  type Note,
} from './common';
import { summarizeTool } from './toolView';
import { isFault, workItems, type WorkItem } from './workItems';

interface ItemContext {
  machines: Machine[];
  projects: Project[];
  now: number;
  me: Loaded<User | null>;
  settling: boolean;
}

function DenyPanel({
  disabled,
  decide,
}: {
  disabled: boolean;
  decide: ReturnType<typeof useDecide>;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const text = reason.trim();
    if (!text) {
      setInvalid(true);
      decide.setNote({ text: t('flows.review.denyNeedsReason'), tone: 'err' });
      inputRef.current?.focus();
      return;
    }
    void decide.decide({ behavior: 'deny', reason: text });
  };
  return (
    <>
      <textarea
        ref={inputRef}
        autoFocus
        className="field-input"
        rows={2}
        value={reason}
        aria-label={t('flows.review.denyReason')}
        aria-invalid={invalid}
        placeholder={t('flows.review.denyReason')}
        onChange={(e) => {
          setReason(e.target.value);
          setInvalid(false);
        }}
      />
      <div className="big">
        <button type="button" className="wide" disabled={disabled} onClick={send}>
          {t('flows.inbox.sendDeny')}
        </button>
      </div>
    </>
  );
}

function PermissionItem({ approval, disabled }: { approval: Approval; disabled: boolean }) {
  const t = useT();
  const decide = useDecide(approval);
  const twoStep = useTwoStep();
  const [denying, setDenying] = useState(false);
  const danger = approval.kind === 'danger';
  const view = summarizeTool(approval.toolName, approval.toolInput);
  const off = disabled || decide.busy;
  const allow = () => {
    if (!danger) return void decide.decide({ behavior: 'allow', remember: false });
    twoStep.press(() => void decide.decide({ behavior: 'allow', remember: false }));
  };
  return (
    <>
      <ToolBody approval={approval} />
      <div className="big">
        <button
          type="button"
          className={danger ? 'danger' : 'primary'}
          disabled={off}
          onClick={allow}
        >
          {twoStep.armed ? t('flows.review.confirmAgain') : t('flows.review.allowOnce')}
        </button>
        <button
          type="button"
          disabled={off}
          aria-expanded={denying}
          onClick={() => {
            twoStep.disarm();
            setDenying(true);
          }}
        >
          {t('flows.review.deny')}
        </button>
      </div>
      {twoStep.armed && (
        <div className="armed" role="status">
          <div>{t('flows.review.armedHint')}</div>
          {(view.kind === 'command' || view.kind === 'raw') && (
            <pre className="command">{view.text}</pre>
          )}
        </div>
      )}
      {denying && <DenyPanel disabled={off} decide={decide} />}
      <Msg note={decide.note} />
    </>
  );
}

function ReplyBox({
  options,
  disabled,
  onSend,
  note,
  setNote,
}: {
  options: string[];
  disabled: boolean;
  onSend: (text: string) => void;
  note: Note | null;
  setNote: (note: Note | null) => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const value = text.trim();
    if (!value) {
      setInvalid(true);
      setNote({ text: t('flows.review.answerRequired'), tone: 'err' });
      inputRef.current?.focus();
      return;
    }
    onSend(value);
    setText('');
  };
  return (
    <>
      {options.length > 0 && (
        <div className="big">
          {options.map((option) => (
            <button
              type="button"
              key={option}
              className="wide"
              disabled={disabled}
              onClick={() => onSend(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        className="field-input"
        rows={2}
        value={text}
        aria-label={t('flows.review.answer')}
        aria-invalid={invalid}
        placeholder={t('flows.review.answer')}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
      />
      <div className="big">
        <button type="button" className="wide" disabled={disabled} onClick={send}>
          {t('flows.review.sendAnswer')}
        </button>
      </div>
      <Msg note={note} />
    </>
  );
}

function QuestionItem({ approval, disabled }: { approval: Approval; disabled: boolean }) {
  const decide = useDecide(approval);
  const questions = parseQuestions(approval);
  // 多題的提問一鍵按不完，只能打字一次回答；單題才給選項按鈕。
  const options = questions.length === 1 ? (questions[0]?.options ?? []) : [];
  return (
    <>
      {questions.map((q) => (
        <p key={q.question} className="body-text">
          {q.question}
        </p>
      ))}
      <ReplyBox
        options={options}
        disabled={disabled || decide.busy}
        note={decide.note}
        setNote={decide.setNote}
        onSend={(text) => void decide.decide(answerDecision(text))}
      />
    </>
  );
}

function SessionReply({ session, disabled }: { session: Session; disabled: boolean }) {
  const t = useT();
  const { backend } = useBoard();
  const [note, setNote] = useState<Note | null>(null);
  return (
    <>
      <pre className="command">{session.lastLines.join('\n')}</pre>
      <ReplyBox
        options={[]}
        disabled={disabled}
        note={note}
        setNote={setNote}
        onSend={(text) => {
          backend.sendPrompt(session.id, text);
          setNote({ text: t('flows.review.sent') });
        }}
      />
    </>
  );
}

function InboxItem({ item, context }: { item: WorkItem; context: ItemContext }) {
  const t = useT();
  const { approval, session } = item;
  const machine = context.machines.find((m) => m.id === session?.machineId);
  const blocked = useBlockedReason(session !== null, machine, approval, context.me);
  const disabled = blocked !== null || context.settling;
  const fault = isFault(item);
  const gone = machine !== undefined && !machine.online;

  let body;
  if (approval?.kind === 'permission' || approval?.kind === 'danger') {
    body = <PermissionItem approval={approval} disabled={disabled} />;
  } else if (approval?.kind === 'question') {
    body = <QuestionItem approval={approval} disabled={disabled} />;
  } else if (session?.status === 'waiting_input') {
    body = <SessionReply session={session} disabled={disabled} />;
  } else {
    body = (
      <p className="back">
        {t(approval?.kind === 'plan' ? 'flows.inbox.planBack' : 'flows.inbox.back')}
      </p>
    );
  }

  return (
    <article
      className={`inbox-item ${session ? handsClass(session.permissionMode) : ''}${fault ? ' is-fault' : ''}${gone ? ' gone' : ''}`}
      data-testid={`inbox-${item.key}`}
    >
      {approval?.kind === 'danger' && (
        <div className="alert" role="alert">
          <span aria-hidden="true">⛔</span>
          <div className="alert-body">
            <div>
              {t('flows.review.dangerHit')}{' '}
              {approval.matchedRule && <Callsign text={approval.matchedRule} />}
            </div>
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
        {session && <span className="title">{session.name}</span>}
        <WaitAge since={item.since} now={context.now} />
      </div>
      {blocked && <p className="blocked">{blocked}</p>}
      {body}
    </article>
  );
}

export function InboxPage() {
  const t = useT();
  const board = useBoard();
  const projects = useProjects();
  const me = useCurrentUser();
  const now = useNow();
  const items = workItems(board);
  const settling = useListSettling(items.map((item) => item.key).join('|'));
  const context: ItemContext = {
    machines: board.machines,
    projects: projects.data ?? [],
    now,
    me,
    settling,
  };

  return (
    <Page narrow>
      <header className="page-head">
        <h1>{t('flows.inbox.title')}</h1>
        <span className="waiting-slot">
          <Waiting count={items.length} />
        </span>
      </header>
      {projects.error && (
        <ErrorBox
          what={t('flows.error.projects', { error: projects.error })}
          how={t('flows.error.projectsHow')}
          onRetry={projects.reload}
        />
      )}
      {projects.loading && !projects.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty title={t('flows.waiting.none')} next={t('flows.inbox.emptyNext')} />
      ) : (
        <div className="phone">
          {items.map((item) => (
            <InboxItem key={item.key} item={item} context={context} />
          ))}
        </div>
      )}
    </Page>
  );
}
