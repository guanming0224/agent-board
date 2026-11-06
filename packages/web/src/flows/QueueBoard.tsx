// 待處理（#/queue）：可以一眼掃過的分組清單，常用動作直接在列上做（GM 2026-11-06）。
// 動作全部沿用既有的後端行為：決定 approval、送進 session、標記完成、開終端機。
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Approval, Project, Session, User } from '@agent-board/protocol';
import { terminalHash } from '../canvas/terminalRoute';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useViewsUi } from '../views';
import { answerDecision, parseQuestions, useBlockedReason, useDecide } from './approvalParts';
import {
  callsign,
  Callsign,
  errorText,
  handsClass,
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
import { StatusBadge } from './StatusBadge';
import { summarizeTool } from './toolView';
import {
  contextLine,
  filterTriage,
  groupTriage,
  triageItems,
  type TriageGroup,
  type TriageItem,
} from './triage';

export interface TeamOption {
  id: string;
  name: string;
  memberIds: readonly string[];
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

/** 在畫布上框出這張卡（和原本點一列的行為一樣）。 */
function openOnCanvas(id: string) {
  useViewsUi.getState().focusSession(id);
  location.hash = '#/canvas';
}

/** 必填的一段文字（拒絕原因、回覆）。空白不送，錯誤訊息緊貼按鈕。 */
function TextForm({
  label,
  submitLabel,
  requiredText,
  options = [],
  disabled,
  note,
  setNote,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  requiredText: string;
  options?: string[];
  disabled: boolean;
  note: Note | null;
  setNote: (note: Note | null) => void;
  onSubmit: (text: string) => void;
}) {
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
        <div className="acts options">
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
        <Msg note={note} />
      </div>
    </div>
  );
}

function TerminalLink({ session }: { session: Session }) {
  const t = useT();
  return (
    <a className="button ghost" href={terminalHash(session.id)}>
      {t('flows.triage.openTerminal')}
    </a>
  );
}

/** 允許一次／拒絕。危險指令照審核中心的規則：按兩次、第一次顯示全文；拒絕要原因。 */
function PermissionActions({
  approval,
  session,
  disabled,
}: {
  approval: Approval;
  session: Session;
  disabled: boolean;
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
      <div className="row-acts">
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
            setDenying((open) => !open);
          }}
        >
          {t('flows.review.deny')}
        </button>
        <TerminalLink session={session} />
        {!denying && <Msg note={decide.note} />}
      </div>
      {twoStep.armed && (
        <div className="armed row-panel" role="status">
          <div>{t('flows.review.armedHint')}</div>
          {(view.kind === 'command' || view.kind === 'raw') && (
            <pre className="command">{mask(view.text)}</pre>
          )}
        </div>
      )}
      {denying && (
        <TextForm
          label={t('flows.review.denyReason')}
          submitLabel={t('flows.inbox.sendDeny')}
          requiredText={t('flows.review.denyNeedsReason')}
          disabled={off}
          note={decide.note}
          setNote={decide.setNote}
          onSubmit={(reason) => void decide.decide({ behavior: 'deny', reason })}
        />
      )}
    </>
  );
}

/** 回覆：提問走 approval（answer），沒有 approval 的直接送進 session。 */
function ReplyActions({
  session,
  approval,
  disabled,
}: {
  session: Session;
  approval: Approval | null;
  disabled: boolean;
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
          className="primary"
          disabled={disabled || decide.busy}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {t('flows.triage.reply')}
        </button>
        <TerminalLink session={session} />
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
      <TerminalLink session={session} />
      <Msg note={note} />
    </div>
  );
}

interface RowContext {
  projects: Project[];
  me: Loaded<User | null>;
  now: number;
}

function TriageRow({
  item,
  teamName,
  active,
  disabledAll,
  onFocusRow,
  context: { projects, me, now },
}: {
  item: TriageItem;
  teamName: string | null;
  active: boolean;
  disabledAll: boolean;
  onFocusRow: (id: string) => void;
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

  let actions;
  if (approval && (approval.kind === 'permission' || approval.kind === 'danger')) {
    actions = <PermissionActions approval={approval} session={session} disabled={disabled} />;
  } else if (kind === 'plan') {
    actions = (
      <div className="row-acts">
        <a className="button primary" href={`#/review/${encodeURIComponent(session.id)}`}>
          {t('flows.triage.reviewPlan')}
        </a>
        <TerminalLink session={session} />
      </div>
    );
  } else if (kind === 'question' || kind === 'reply' || kind === 'idle') {
    actions = <ReplyActions session={session} approval={approval} disabled={disabled} />;
  } else if (kind === 'error' || kind === 'stuck' || kind === 'rate_limited') {
    actions = <TroubleActions session={session} disabled={disabled} />;
  } else {
    actions = (
      <div className="row-acts">
        <TerminalLink session={session} />
      </div>
    );
  }

  return (
    <li
      className={`triage-row ${handsClass(session.permissionMode)}${kind === 'danger' ? ' is-danger' : ''}${gone ? ' gone' : ''}`}
      data-testid={`queue-${session.id}`}
      data-row-id={session.id}
      data-kind={kind}
      tabIndex={active ? 0 : -1}
      onFocus={() => onFocusRow(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          openOnCanvas(session.id);
        }
      }}
      onClick={(e) => {
        // 點列的空白處＝在畫布上打開；點按鈕、連結、輸入框照它們自己的行為。
        if (
          (e.target as Element).closest(
            'button, a, input, textarea, select, pre, .row-acts, .row-panel',
          )
        )
          return;
        openOnCanvas(session.id);
      }}
    >
      <div className="row-main">
        <div className="row-top">
          <StatusBadge kind={kind} />
          <a
            className="row-name"
            href="#/canvas"
            onClick={(e) => {
              e.preventDefault();
              openOnCanvas(session.id);
            }}
          >
            {session.name}
          </a>
          <WaitAge since={item.since} now={now} />
          {teamName && <span className="chip team-chip">{teamName}</span>}
          <ModeChip mode={session.permissionMode} />
        </div>
        <div className="row-sign">
          <Callsign text={callsign(session, machines, projects)} />
        </div>
        {kind === 'danger' && approval?.matchedRule && (
          <div className="row-rule">
            {t('flows.review.dangerHit')} <Callsign text={approval.matchedRule} />
          </div>
        )}
        {context && (
          <div className="triage-context" title={mask(context)}>
            {tool && <b>{tool}</b>}
            <span className={approval?.toolInput?.['command'] ? 'mono' : undefined}>
              {mask(context)}
            </span>
          </div>
        )}
        {blocked && <p className="blocked">{blocked}</p>}
      </div>
      {actions}
    </li>
  );
}

/** 待處理頁的內容（頁首、側欄、載入狀態由畫布的 QueuePage 包）。 */
export function QueueBoard({ teams }: { teams: readonly TeamOption[] }) {
  const t = useT();
  const { sessions, approvals, machines, connected } = useBoard();
  const [teamId, setTeamId] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const projects = useProjects();
  const me = useCurrentUser();
  const now = useNow();
  const context: RowContext = { projects: projects.data ?? [], me, now };

  const all = useMemo(() => triageItems(sessions, approvals), [sessions, approvals]);
  const team = teams.find((x) => x.id === teamId) ?? null;
  const items = filterTriage(all, {
    teamMembers: team ? new Set(team.memberIds) : null,
    machineId,
  });
  const groups = groupTriage(items);
  const order = groups.flatMap((g) => g.items.map((item) => item.session.id));
  // 處理完一列、下一列滑上來時，短暫停用按鈕，連點不會按到別人（同收件匣）。
  const settling = useListSettling(order.join('|'));
  const counted = all.filter((item) => item.counted).length;
  const quota = all.filter((item) => !item.counted && item.kind === 'rate_limited').length;
  const idle = all.filter((item) => !item.counted && item.kind === 'idle').length;
  const current = activeId !== null && order.includes(activeId) ? activeId : (order[0] ?? null);

  const teamOf = (id: string) => teams.find((x) => x.memberIds.includes(id))?.name ?? null;

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

  // 焦點還不在清單裡（剛進頁面）時，j／k 也能開始移動。
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

  const machineOptions = machines.filter((m) => all.some((i) => i.session.machineId === m.id));

  return (
    <div className="flows triage" data-testid="triage">
      <header className="triage-head">
        <h1>{t('flows.triage.title')}</h1>
        <span
          className={`waiting${counted === 0 ? ' none' : ''}`}
          aria-label={t('flows.waiting.aria', { n: counted })}
          data-testid="triage-waiting"
        >
          <span>{t('label.waiting')}</span>
          <b className="num">{counted}</b>
        </span>
        <div className="triage-filters">
          {teams.length > 0 && (
            <label>
              <span>{t('flows.triage.filter.team')}</span>
              <select
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
      </header>
      <p className="triage-note" data-testid="triage-note">
        {t('flows.triage.countNote')}
        {quota + idle > 0 && (
          <>
            {' '}
            {t('flows.triage.notCounted', {
              list: [
                quota > 0 ? t('flows.triage.notCounted.quota', { n: quota }) : null,
                idle > 0 ? t('flows.triage.notCounted.idle', { n: idle }) : null,
              ]
                .filter(Boolean)
                .join(t('flows.triage.listSep')),
            })}
          </>
        )}
      </p>
      <p className="triage-keys">{t('flows.triage.keys')}</p>
      <div ref={listRef} className="triage-groups" onKeyDown={onKey}>
        {groups.map(({ group, items: rows }) => (
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
              <ol className="triage-list">
                {rows.map((item) => (
                  <TriageRow
                    key={item.session.id}
                    item={item}
                    teamName={teamOf(item.session.id)}
                    active={item.session.id === current}
                    disabledAll={settling || !connected}
                    onFocusRow={setActiveId}
                    context={context}
                  />
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
