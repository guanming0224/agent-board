// 收件匣（P2 §1.2）：原本的「待處理」與「審核中心」合併成右側抽屜。只列算「等你」的 session，
// 每個 session 一列；常用動作直接在列上做，點列展開原本審核中心的審核卡（diff、指令全文、危險指令兩次確認）。
// 動作全部沿用既有的後端行為：決定 approval、送進 session、標記完成、開終端機。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Approval, Project, Session, User } from '@agent-board/protocol';
import { terminalHash } from '../canvas/terminalRoute';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { codeClass, statusCode } from '../shared/status';
import { useViewsUi, type InboxSort } from '../views';
import { ZoneChip } from '../zones';
import { answerDecision, parseQuestions, useBlockedReason, useDecide } from './approvalParts';
import {
  callsign,
  Callsign,
  Empty,
  ErrorBox,
  errorText,
  handsClass,
  Loading,
  ModeChip,
  Msg,
  useCurrentUser,
  useListSettling,
  useNow,
  useProjects,
  useTwoStep,
  WaitAge,
  type Loaded,
  type Note,
} from './common';
import { DecisionHistory } from './DecisionHistory';
import { SessionReviewCards } from './ReviewCards';
import { badgeCode, StatusBadge } from './StatusBadge';
import { DenyForm } from './DenyForm';
import { TeamActivitySection } from './TeamActivity';
import { summarizeTool } from './toolView';
import {
  contextLine,
  filterTriage,
  groupTriage,
  inboxItems,
  keepSelection,
  triageItems,
  urgencyOrder,
  type TriageGroup,
  type TriageItem,
} from './triage';

export interface TeamOption {
  id: string;
  name: string;
  memberIds: readonly string[];
  /** 團隊框色（CSS 值，例如 var(--team-teal)）；團隊晶片的框用它。 */
  color: string;
}

const GROUP_TITLE: Record<TriageGroup, string> = {
  decide: 'flows.triage.group.decide',
  reply: 'flows.triage.group.reply',
  trouble: 'flows.triage.group.trouble',
  other: 'flows.triage.group.other',
};

const GROUP_EMPTY: Record<TriageGroup, string> = {
  decide: 'flows.triage.empty.decide',
  reply: 'flows.triage.empty.reply',
  trouble: 'flows.triage.empty.trouble',
  other: 'flows.triage.empty.other',
};

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  );
}

/** 在畫布上框出這張卡；抽屜不關（畫布在底下）。 */
export function showOnCanvas(id: string) {
  useViewsUi.getState().focusSession(id);
}

/**
 * 必填的回覆。空白不送，錯誤訊息緊貼按鈕。提問選項先選（選中反白）再按主按鈕送出（GM Q3）。
 * 拒絕原因用 DenyForm（三處共用）。
 */
function TextForm({
  label,
  submitLabel,
  requiredText,
  options = [],
  disabled,
  note,
  setNote,
  onSubmit,
  onCancel,
}: {
  label: string;
  submitLabel: string;
  requiredText: string;
  options?: string[];
  disabled: boolean;
  note: Note | null;
  setNote: (note: Note | null) => void;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const value = text.trim();
    if (!value) {
      setInvalid(true);
      setNote({ text: requiredText, tone: 'err' });
      inputRef.current?.focus();
      return;
    }
    onSubmit(value);
    setText('');
  };
  return (
    <div className="row-panel">
      {options.length > 0 && (
        <div className="acts options" role="group" aria-label={t('flows.review.options')}>
          {options.map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={text === option}
              disabled={disabled}
              onClick={() => {
                setText(option);
                setInvalid(false);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        autoFocus
        className="field-input"
        rows={2}
        value={text}
        aria-label={label}
        aria-invalid={invalid}
        placeholder={label}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          // Cmd／Ctrl＋Enter 送出；單按 Enter 照常換行。
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="acts">
        <button type="button" className="primary" disabled={disabled} onClick={send}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            {t('flows.inbox.denyCancel')}
          </button>
        )}
        <Msg note={note} />
      </div>
    </div>
  );
}

/** 「開啟終端機」：和「在畫布上看」同一種低調精簡鈕，放在列尾（不和處理動作擠同一排）。 */
function TerminalLink({ session }: { session: Session }) {
  const t = useT();
  return (
    <a className="button ghost sm" href={terminalHash(session.id)}>
      {t('flows.triage.openTerminal')}
    </a>
  );
}

/** 允許一次／拒絕。危險指令照審核中心的規則：按兩次、第一次顯示全文；拒絕要原因。 */
function PermissionActions({
  approval,
  disabled,
  lead,
}: {
  approval: Approval;
  disabled: boolean;
  /** 目前這一列（鍵盤所在、畫布框選）：處理鈕用白色主按鈕，其他列用代碼色框（GM Q2）。 */
  lead: boolean;
}) {
  const t = useT();
  const mask = useMaskText();
  const decide = useDecide(approval);
  const twoStep = useTwoStep();
  const [denying, setDenying] = useState(false);
  const danger = approval.kind === 'danger';
  const view = summarizeTool(approval.toolName, approval.toolInput);
  const off = disabled || decide.busy;
  const allow = () => {
    setDenying(false);
    if (!danger) return void decide.decide({ behavior: 'allow', remember: false });
    twoStep.press(() => void decide.decide({ behavior: 'allow', remember: false }));
  };
  return (
    <>
      {/* 拒絕展開時「允許一次」收起：同一時間只有框裡那顆紅框「拒絕」（和手機、展開卡同一套）。 */}
      {!denying && (
        <div className="row-acts">
          <button
            type="button"
            className={danger ? 'danger' : lead ? 'primary' : 'cue'}
            disabled={off}
            onClick={allow}
          >
            {twoStep.armed ? t('flows.review.confirmAgain') : t('flows.review.allowOnce')}
          </button>
          <button
            type="button"
            disabled={off}
            aria-expanded={false}
            onClick={() => {
              twoStep.disarm();
              setDenying(true);
            }}
          >
            {t('flows.review.deny')}
          </button>
          <Msg note={decide.note} />
        </div>
      )}
      {twoStep.armed && (
        <div className="armed row-panel" role="status">
          <div>{t('flows.review.armedHint')}</div>
          {(view.kind === 'command' || view.kind === 'raw') && (
            <pre className="command">{mask(view.text)}</pre>
          )}
        </div>
      )}
      {denying && <DenyForm disabled={off} decide={decide} onCancel={() => setDenying(false)} />}
    </>
  );
}

/** 回覆：提問走 approval（answer），沒有 approval 的直接送進 session。 */
function ReplyActions({
  session,
  approval,
  disabled,
  lead,
}: {
  session: Session;
  approval: Approval | null;
  disabled: boolean;
  lead: boolean;
}) {
  const t = useT();
  const { backend } = useBoard();
  const decide = useDecide(approval);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const questions = approval ? parseQuestions(approval) : [];
  const options = questions.length === 1 ? (questions[0]?.options ?? []) : [];
  const shown = approval ? decide.note : note;
  return (
    <>
      <div className="row-acts">
        <button
          type="button"
          className={open ? undefined : lead ? 'primary' : 'cue'}
          disabled={disabled || decide.busy}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {t('flows.triage.reply')}
        </button>
        {!open && <Msg note={shown} />}
      </div>
      {open && (
        <TextForm
          label={t('flows.review.answer')}
          submitLabel={t('flows.review.sendAnswer')}
          requiredText={t('flows.review.answerRequired')}
          options={options}
          disabled={disabled || decide.busy}
          note={shown}
          setNote={approval ? decide.setNote : setNote}
          onSubmit={(text) => {
            if (approval) return void decide.decide(answerDecision(text));
            backend.sendPrompt(session.id, text);
            setNote({ text: t('flows.review.sent') });
          }}
        />
      )}
    </>
  );
}

/** 錯誤、卡住：開終端機看，或標記完成（和團隊工作台的「標記完成」同一個後端呼叫）。 */
function TroubleActions({ session, disabled }: { session: Session; disabled: boolean }) {
  const t = useT();
  const { backend } = useBoard();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const markDone = async () => {
    setBusy(true);
    setNote(null);
    try {
      await backend.updateSession(session.id, { markDone: true });
      setNote({ text: t('flows.triage.markedDone') });
    } catch (e) {
      setNote({ text: t('flows.triage.markDoneFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row-acts">
      {session.status !== 'rate_limited' && (
        <button
          type="button"
          disabled={disabled || busy}
          title={t('flows.triage.markDoneHint')}
          onClick={() => void markDone()}
        >
          {t('flows.triage.markDone')}
        </button>
      )}
      <Msg note={note} />
    </div>
  );
}

interface RowContext {
  projects: Project[];
  me: Loaded<User | null>;
  now: number;
}

/** 「在畫布上看」：聚焦那張卡，抽屜留著。 */
function ShowOnCanvas({ sessionId }: { sessionId: string }) {
  const t = useT();
  return (
    <button
      type="button"
      className="ghost sm"
      onClick={() => showOnCanvas(sessionId)}
      data-testid={`inbox-show-${sessionId}`}
    >
      {t('flows.inbox.showOnCanvas')}
    </button>
  );
}

function TriageRow({
  item,
  team,
  active,
  expanded,
  highlighted,
  scrollKey,
  focused,
  disabledAll,
  onFocusRow,
  onToggle,
  context: { projects, me, now },
}: {
  item: TriageItem;
  team: TeamOption | null;
  active: boolean;
  expanded: boolean;
  /** 從網址（推播）指到的這一項：高亮 2 秒。 */
  highlighted: boolean;
  /** 網址每指到一次就變：同一個網址再送一次也重新捲到這一項。 */
  scrollKey: number;
  /** 畫布上框出的卡（「下一個等我的」）也是這一項。 */
  focused: boolean;
  disabledAll: boolean;
  onFocusRow: (id: string) => void;
  onToggle: (id: string) => void;
  context: RowContext;
}) {
  const t = useT();
  const mask = useMaskText();
  const machines = useBoard((s) => s.machines);
  const { session, approval, kind } = item;
  const machine = machines.find((m) => m.id === session.machineId);
  const blocked = useBlockedReason(true, machine, approval, me);
  const disabled = blocked !== null || disabledAll;
  const gone = machine !== undefined && !machine.online;
  const context = contextLine(item);
  const tool = approval?.toolName && approval.kind !== 'question' ? approval.toolName : null;
  const rowRef = useRef<HTMLLIElement>(null);

  // 變成目標或被畫布框選時捲進來；之後的資料更新不再搶畫面。
  useEffect(() => {
    if (!highlighted && !focused) return;
    rowRef.current?.scrollIntoView({ block: highlighted ? 'center' : 'nearest' });
    if (highlighted) rowRef.current?.focus({ preventScroll: true });
  }, [highlighted, focused, scrollKey]);

  // 白色主按鈕只給目前這一列（鍵盤所在＝預設第一列，或畫布框選的那張）；其他列用代碼色框＋淡底（GM Q2）。
  const lead = active || focused;
  let actions;
  if (expanded) {
    actions = null;
  } else if (approval && (approval.kind === 'permission' || approval.kind === 'danger')) {
    actions = <PermissionActions approval={approval} disabled={disabled} lead={lead} />;
  } else if (kind === 'plan') {
    actions = (
      <div className="row-acts">
        <button
          type="button"
          className={lead ? 'primary' : 'cue'}
          onClick={() => onToggle(session.id)}
          aria-expanded={false}
        >
          {t('flows.triage.reviewPlan')}
        </button>
      </div>
    );
  } else if (kind === 'question' || kind === 'reply' || kind === 'idle') {
    actions = (
      <ReplyActions session={session} approval={approval} disabled={disabled} lead={lead} />
    );
  } else if (kind === 'error' || kind === 'stuck' || kind === 'rate_limited') {
    actions = <TroubleActions session={session} disabled={disabled} />;
  } else {
    actions = null;
  }

  return (
    <li
      ref={rowRef}
      className={`triage-row list-row ${codeClass(badgeCode(kind))} ${handsClass(session.permissionMode)}${kind === 'danger' ? ' is-danger' : ''}${gone ? ' gone' : ''}${expanded ? ' expanded' : ''}${highlighted ? ' targeted' : ''}${focused ? ' focused' : ''}`}
      data-testid={`queue-${session.id}`}
      data-row-id={session.id}
      data-kind={kind}
      aria-current={focused ? 'true' : undefined}
      tabIndex={active ? 0 : -1}
      onFocus={() => onFocusRow(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          onToggle(session.id);
        }
      }}
      onClick={(e) => {
        // 點列的空白處＝展開或收起審核卡；點按鈕、連結、輸入框照它們自己的行為。
        if (
          (e.target as Element).closest(
            'button, a, input, textarea, select, pre, .row-acts, .row-panel, .session-reviews',
          )
        )
          return;
        onToggle(session.id);
      }}
    >
      <div className="row-main">
        {/* 呼號在最上面（STYLE 邏輯 2，和手機收件匣、審核卡同一個順序）；狀態只在這裡畫一次。 */}
        <div className="row-sign">
          <Callsign text={callsign(session, machines, projects)} />
          <ZoneChip session={session} />
        </div>
        <div className="row-top">
          <StatusBadge kind={kind} />
          <button
            type="button"
            className="row-name link-button"
            aria-expanded={expanded}
            onClick={() => onToggle(session.id)}
            data-testid={`inbox-toggle-${session.id}`}
          >
            {session.name}
          </button>
          <WaitAge since={item.since} now={now} />
          {team && (
            <span className="chip team-chip" style={{ ['--team' as string]: team.color }}>
              {team.name}
            </span>
          )}
          <ModeChip mode={session.permissionMode} />
        </div>
        {/* 危險指令：和審核卡同一種警示列（精簡版）；展開後由審核卡畫，不重複。 */}
        {kind === 'danger' && approval?.matchedRule && !expanded && (
          <div className="alert row-rule">
            <span aria-hidden="true">⛔</span>
            <div className="alert-body">
              {t('flows.review.dangerHit')} <Callsign text={approval.matchedRule} />
            </div>
          </div>
        )}
        {context && !expanded && (
          <div className="triage-context" title={mask(context)}>
            {tool && <b>{tool}</b>}
            <span className={approval?.toolInput?.['command'] ? 'mono' : undefined}>
              {mask(context)}
            </span>
          </div>
        )}
        {blocked && !expanded && <p className="blocked">{blocked}</p>}
      </div>
      {actions}
      {expanded && (
        <SessionReviewCards sessionId={session.id} includeSession detail settling={disabledAll} />
      )}
      <div className="row-foot">
        <TerminalLink session={session} />
        <ShowOnCanvas sessionId={session.id} />
      </div>
    </li>
  );
}

/** 網址指到的 session 已經不在等你：說明它現在的狀態，還是可以去畫布看。 */
function TargetGone({ sessionId }: { sessionId: string }) {
  const t = useT();
  const session = useBoard((s) => s.sessions.find((x) => x.id === sessionId));
  return (
    <p className="blocked target-missing" role="status" data-testid="inbox-target-gone">
      {session
        ? t('flows.inbox.targetDone', { code: statusCode(session) })
        : t('flows.inbox.targetUnknown')}{' '}
      {session && <ShowOnCanvas sessionId={session.id} />}
    </p>
  );
}

/** 排序切換：依急迫（預設，和 N 鍵一致）｜依組別（原本待處理頁的分組）。 */
function SortSwitch({ sort, onSort }: { sort: InboxSort; onSort: (sort: InboxSort) => void }) {
  const t = useT();
  return (
    <div className="seg sm" role="group" aria-label={t('flows.inbox.sort')}>
      {(['urgency', 'group'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={sort === value}
          onClick={() => onSort(value)}
          data-testid={`inbox-sort-${value}`}
        >
          {t(`flows.inbox.sort.${value}`)}
        </button>
      ))}
    </div>
  );
}

/** 從網址（推播）指到的 session：展開、捲到、高亮 2 秒。同一個網址再送一次也要重新捲。 */
function useHighlight(target: string | null, present: boolean, nonce: number) {
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!target || !present) return;
    setLit(target);
    const timer = setTimeout(() => setLit(null), 2000);
    return () => clearTimeout(timer);
  }, [target, present, nonce]);
  return lit;
}

/**
 * 收件匣的內容（抽屜的外框、關閉由呼叫端給）。
 * target：網址 #/inbox/<sessionId> 指到的 session；nonce 每次網址指到時變，用來重新捲到同一項。
 */
export function InboxBoard({
  teams,
  target,
  nonce = 0,
  tools,
}: {
  teams: readonly TeamOption[];
  target: string | null;
  nonce?: number;
  /** 標題列右邊要多放的東西（抽屜的展開、關閉鈕）。 */
  tools?: ReactNode;
}) {
  const t = useT();
  const { sessions, approvals, machines, connected } = useBoard();
  const sort = useViewsUi((s) => s.inboxSort);
  const setSort = useViewsUi((s) => s.setInboxSort);
  const focusId = useViewsUi((s) => s.focusId);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const projects = useProjects();
  const me = useCurrentUser();
  const now = useNow();
  const context: RowContext = { projects: projects.data ?? [], me, now };

  const all = useMemo(() => inboxItems(sessions, approvals), [sessions, approvals]);
  const notListed = useMemo(
    () => triageItems(sessions, approvals).filter((item) => !item.counted),
    [sessions, approvals],
  );
  const team = teams.find((x) => x.id === teamId) ?? null;
  const items = filterTriage(all, {
    teamMembers: team ? new Set(team.memberIds) : null,
    machineId,
  });
  const groups = sort === 'group' ? groupTriage(items).filter((g) => g.group !== 'other') : null;
  const ordered = groups ? groups.flatMap((g) => g.items) : urgencyOrder(items);
  const order = ordered.map((item) => item.session.id);
  // 處理完一列、下一列滑上來時，短暫停用按鈕，連點不會按到別人（同手機收件匣）。
  const settling = useListSettling(order.join('|'));
  const quota = notListed.filter((item) => item.kind === 'rate_limited').length;
  const idle = notListed.filter((item) => item.kind === 'idle').length;
  const current = activeId !== null && order.includes(activeId) ? activeId : (order[0] ?? null);
  const targetPresent = target !== null && order.includes(target);
  // 「還在不在等你」看沒篩過的清單：被團隊／機器篩選藏起來的不算處理完。
  const targetWaiting = target !== null && all.some((item) => item.session.id === target);
  const lit = useHighlight(targetPresent ? target : null, targetPresent, nonce);

  // 網址指到的那一項還在等你、只是被篩選藏起來：清掉篩選，讓它列出來再捲過去。
  useEffect(() => {
    if (target && targetWaiting && !targetPresent) {
      setTeamId(null);
      setMachineId(null);
    }
  }, [target, targetWaiting, targetPresent, nonce]);

  // 網址指到的那一項：展開（推播點進來就能直接按允許）。同一個網址再送一次（nonce 變）也重來。
  useEffect(() => {
    if (target && targetPresent) setExpandedId(target);
  }, [target, targetPresent, nonce]);

  // 展開的那一項處理掉之後，展開原本位置的下一項（和原本審核中心「處理完選下一項」一樣）。
  const previous = useRef(order);
  const kept = expandedId === null ? null : keepSelection(previous.current, order, expandedId);
  useEffect(() => {
    previous.current = order;
    if (kept !== expandedId) setExpandedId(kept);
  });

  const teamOf = (id: string) => teams.find((x) => x.memberIds.includes(id)) ?? null;

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setActiveId(id);
    listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus();
  };

  const move = (step: 1 | -1, from: string | null) => {
    if (order.length === 0) return;
    const at = from === null ? -1 : order.indexOf(from);
    const next = at < 0 ? (step === 1 ? 0 : order.length - 1) : at + step;
    focusRow(order[Math.max(0, Math.min(order.length - 1, next))]);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing || isTyping(e.target)) {
      return;
    }
    const row = (e.target as Element).closest<HTMLElement>('[data-row-id]');
    const from = row?.dataset.rowId ?? null;
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(1, from);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1, from);
    }
  };

  // 焦點還不在清單裡（剛打開抽屜）時，j／k 也能開始移動。畫布、終端機、輸入框裡的按鍵不搶。
  useEffect(() => {
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      if (isTyping(e.target) || listRef.current?.contains(e.target as Node)) return;
      if (e.target !== document.body && e.target !== document.documentElement) return;
      e.preventDefault();
      const start = e.key === 'k' || e.key === 'ArrowUp' ? order.length - 1 : 0;
      focusRow(order[start]);
    };
    addEventListener('keydown', onDocKey);
    return () => removeEventListener('keydown', onDocKey);
  });

  const toggle = (id: string) => setExpandedId((open) => (open === id ? null : id));

  const machineOptions = machines.filter((m) => all.some((i) => i.session.machineId === m.id));

  const row = (item: TriageItem) => (
    <TriageRow
      key={item.session.id}
      item={item}
      team={teamOf(item.session.id)}
      active={item.session.id === current}
      expanded={item.session.id === expandedId}
      highlighted={item.session.id === lit}
      scrollKey={item.session.id === lit ? nonce : 0}
      focused={item.session.id === focusId}
      disabledAll={settling || !connected}
      onFocusRow={setActiveId}
      onToggle={toggle}
      context={context}
    />
  );

  return (
    <div className={`flows triage inbox${connected ? '' : ' is-stale'}`} data-testid="triage">
      <header className="triage-head panel-head">
        <h1>{t('flows.inbox.title')}</h1>
        {tools && <div className="panel-acts">{tools}</div>}
      </header>
      {!connected && (
        <div className="stale-line" role="alert" data-testid="inbox-stale">
          {t('flows.stale')}
        </div>
      )}
      <div className="triage-tools">
        <SortSwitch sort={sort} onSort={setSort} />
        <div className="triage-filters">
          {teams.length > 0 && (
            <label>
              <span>{t('flows.triage.filter.team')}</span>
              <select
                className="sm"
                value={teamId ?? ''}
                onChange={(e) => setTeamId(e.target.value || null)}
                data-testid="triage-filter-team"
              >
                <option value="">{t('flows.triage.filter.all')}</option>
                {teams.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {machineOptions.length > 1 && (
            <label>
              <span>{t('flows.triage.filter.machine')}</span>
              <select
                className="sm"
                value={machineId ?? ''}
                onChange={(e) => setMachineId(e.target.value || null)}
                data-testid="triage-filter-machine"
              >
                <option value="">{t('flows.triage.filter.all')}</option>
                {machineOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      {target && !targetWaiting && <TargetGone sessionId={target} />}
      {quota + idle > 0 && (
        <p className="triage-note" data-testid="triage-note">
          {t('flows.inbox.notListed', {
            list: [
              quota > 0 ? t('flows.triage.notCounted.quota', { n: quota }) : null,
              idle > 0 ? t('flows.triage.notCounted.idle', { n: idle }) : null,
            ]
              .filter(Boolean)
              .join(t('flows.triage.listSep')),
          })}
        </p>
      )}
      {projects.error && (
        <ErrorBox
          what={t('flows.error.projects', { error: projects.error })}
          how={t('flows.error.projectsHow')}
          onRetry={projects.reload}
        />
      )}
      {/* 呼號要有專案名稱才算數（按允許前先確認呼號）：專案清單還沒讀到時先不列。 */}
      {projects.loading && !projects.data ? (
        <Loading />
      ) : all.length === 0 ? (
        <Empty
          title={t('flows.waiting.none')}
          next={
            <>
              {t('flows.inbox.emptyNextDesk')} <a href="#/new">{t('flows.new.title')}</a>
            </>
          }
        />
      ) : (
        <>
          <p className="triage-keys">{t('flows.inbox.keys')}</p>
          <div ref={listRef} className="triage-groups" onKeyDown={onKey}>
            {groups ? (
              groups.map(({ group, items: rows }) => (
                <section
                  key={group}
                  className={`triage-group g-${group}`}
                  aria-labelledby={`triage-${group}`}
                  data-testid={`triage-group-${group}`}
                >
                  <h2 id={`triage-${group}`}>
                    {t(GROUP_TITLE[group])}
                    <span className="count num" data-testid={`triage-count-${group}`}>
                      {rows.length}
                    </span>
                  </h2>
                  {rows.length === 0 ? (
                    <p className="group-empty">{t(GROUP_EMPTY[group])}</p>
                  ) : (
                    <ol className="triage-list">{rows.map(row)}</ol>
                  )}
                </section>
              ))
            ) : (
              <ol className="triage-list" data-testid="inbox-urgency">
                {ordered.map(row)}
              </ol>
            )}
          </div>
        </>
      )}
      <TeamActivitySection canvas />
      <DecisionHistory me={me} />
    </div>
  );
}
