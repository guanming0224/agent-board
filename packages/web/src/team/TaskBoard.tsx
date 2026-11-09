// 任務板：待分配 → 進行中 → 待審查 → 完成；未指派不可推進（hub 也會回 409）。
// 任務自動執行（GM 2026-11-06）：開關在這裡，實際送字與移欄由 hub 做（hub/src/tasks.ts），這裡只顯示進度。
import { useEffect, useRef, useState } from 'react';
import { TaskColumn } from '@agent-board/protocol';
import type { Session, SessionEvent, Task, Team } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { ActionMessage, CostChip, useAction } from './common';
import { assignOwners, decomposePrompt, parseTaskList, presentAbbrs, roleRefs } from './decompose';
import { refreshTeams, useTeams } from './store';
import { dropReasonKey, shortName, taskStatusLines } from './taskStatus';

const DECOMPOSE_POLL_MS = 1500;
const COLUMNS = TaskColumn.options;
const REPLY_PREVIEW_CHARS = 160;

const replyOf = (event: SessionEvent): string | null => {
  const text = event.payload.last_assistant_message;
  return event.type === 'hook' && event.payload.event === 'Stop' && typeof text === 'string'
    ? text
    : null;
};

/** 自動執行做到哪（例：已送給 BD1・等回覆、RV 退回 1/3）。 */
function TaskAutoStatus({ task, team }: { task: Task; team: Team }) {
  const t = useT();
  const mask = useMaskText();
  const sessions = useBoard((s) => s.sessions);
  const nameOf = (id: string | null) => {
    const session = id === null ? undefined : sessions.find((s) => s.id === id);
    return session ? shortName(session.name, team.name) : null;
  };
  const lines = taskStatusLines(task, nameOf);
  if (lines.length === 0) return null;
  const text = lines
    .map(({ key, params }) =>
      key === 'team.tasks.auto.dropped'
        ? t(key, { ...params, reason: t(dropReasonKey(String(params.reason))) })
        : t(key, params),
    )
    .join('・');
  // 退回原因、完成摘要是成員回覆裡的一句：放在提示文字，遮蔽模式照樣打碼。
  const note = task.auto?.note;
  const showNote = note && task.auto?.state !== 'dropped' ? mask(note) : undefined;
  return (
    <p
      className={`task-hint${task.needsUser ? ' attention' : ''}`}
      data-testid="task-auto-status"
      title={showNote}
    >
      {task.needsUser ? '◆ ' : '◇ '}
      {text}
      {task.needsUser && showNote && (
        <span className="sub"> — {t('team.tasks.auto.reason', { reason: showNote })}</span>
      )}
    </p>
  );
}

function TaskCard({
  task,
  team,
  members,
  reload,
}: {
  task: Task;
  team: Team;
  members: Session[];
  reload: () => Promise<void>;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const { busy, message, run } = useAction();
  const index = COLUMNS.indexOf(task.column);
  const unassigned = task.ownerSessionId === null;
  const owner = sessions.find((s) => s.id === task.ownerSessionId);
  const ownerIsMember = members.some((m) => m.id === task.ownerSessionId);

  const update = (patch: Parameters<typeof backend.updateTask>[1]) =>
    run(async () => {
      await backend.updateTask(task.id, patch);
      await reload();
    });

  const move = (column: Task['column'], label: string, disabled: boolean, glyph: string) => (
    <button
      className="move sm"
      aria-label={t('team.tasks.moveTo', { column: label })}
      title={t('team.tasks.moveTo', { column: label })}
      disabled={busy || disabled}
      onClick={() => void update({ column })}
    >
      {glyph}
    </button>
  );

  const previous = COLUMNS[index - 1];
  const following = COLUMNS[index + 1];

  return (
    <li className="task" data-testid={`task-${task.id}`} data-column={task.column}>
      <p className="task-title">
        <span className="num sub">#{task.number}</span> {task.title}
      </p>
      <select
        aria-label={t('team.tasks.ownerOf', { title: task.title })}
        value={task.ownerSessionId ?? ''}
        disabled={busy}
        onChange={(e) => void update({ ownerSessionId: e.target.value || null })}
      >
        {/* 已推進的任務不能變回未指派，hub 會回 409。 */}
        <option value="" disabled={task.column !== 'todo'}>
          {t('team.tasks.unassigned')}
        </option>
        {!ownerIsMember && owner && (
          <option value={owner.id}>{t('team.tasks.formerMember', { name: owner.name })}</option>
        )}
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {unassigned && (
        <p className="task-hint" data-testid="task-unassigned">
          ◆ {t('team.tasks.assignFirst')}
        </p>
      )}
      <TaskAutoStatus task={task} team={team} />
      <div className="row task-actions">
        {previous && move(previous, t(`team.column.${previous}`), false, '◂')}
        {following && move(following, t(`team.column.${following}`), unassigned, '▸')}
        <span className="spacer" />
        <button
          className="danger sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await backend.deleteTask(task.id);
              await reload();
            })
          }
        >
          {t('team.tasks.delete')}
        </button>
      </div>
      <ActionMessage message={message} />
    </li>
  );
}

function Decompose({
  team,
  members,
  tasks,
  reload,
}: {
  team: Team;
  members: Session[];
  tasks: Task[];
  reload: () => Promise<void>;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const roles = useTeams((s) => s.members);
  const leadId = roles.find((m) => m.teamId === team.id && m.role === 'lead')?.sessionId;
  const lead = members.find((m) => m.id === leadId);
  const sessions = useBoard((s) => s.sessions);
  // 可以接任務的成員與縮寫：提示請隊長標 role，回覆依它指派（不另外花額度）。
  const refs = roleRefs(
    team,
    roles.filter((m) => m.teamId === team.id),
    sessions,
  );
  const [waiting, setWaiting] = useState(false);
  const stopWaiting = useRef<(() => void) | null>(null);
  // 離開頁面就不再輪詢；回覆晚點到，回來按「重新讀取回覆」即可。
  useEffect(() => () => stopWaiting.current?.(), []);
  const { busy, message, run, setMessage } = useAction();
  const mask = useMaskText();

  const blocker = !lead
    ? t('team.decompose.noLead')
    : team.goal.trim() === ''
      ? t('team.decompose.noGoal')
      : !connected
        ? t('team.decompose.offline')
        : lead.status !== 'waiting_input'
          ? t('team.decompose.leadBusy', { name: lead.name, status: t(`status.${lead.status}`) })
          : null;

  /** 放進待分配。隊長重新回覆時，已有的標題不重複加。 */
  const accept = async (reply: string): Promise<string> => {
    const parsed = parseTaskList(reply);
    if (!parsed.ok) {
      const preview = mask(reply.replace(/\s+/g, ' ').trim().slice(0, REPLY_PREVIEW_CHARS));
      throw new Error(
        t(`team.decompose.parse.${parsed.reason}`, {
          preview: preview || t('team.decompose.emptyReply'),
        }),
      );
    }
    const existing = new Set(tasks.map((task) => task.title));
    const fresh = parsed.tasks.filter((task) => !existing.has(task.title));
    const owners = assignOwners(fresh, refs);
    for (const [i, task] of fresh.entries()) {
      await backend.createTask(team.id, { title: task.title, ownerSessionId: owners[i] ?? null });
    }
    await reload();
    return t('team.decompose.added', {
      n: fresh.length,
      skipped: parsed.tasks.length - fresh.length,
      assigned: owners.filter((owner) => owner !== null).length,
    });
  };

  /** 從事件輪詢而不是聽 WebSocket：斷線重連時不會漏掉隊長的回覆。 */
  const nextReply = (sessionId: string, seen: ReadonlySet<string>) =>
    new Promise<string | null>((resolve, reject) => {
      const timer = setInterval(() => {
        backend.sessionEvents(sessionId).then(
          (events) => {
            const fresh = events.filter((e) => !seen.has(e.id));
            const failure = fresh.find(
              (e) => e.type === 'hook' && e.payload.event === 'StopFailure',
            );
            if (failure) {
              finish();
              reject(
                new Error(
                  t('team.decompose.leadFailed', { detail: String(failure.payload.error ?? '') }),
                ),
              );
              return;
            }
            const reply = fresh.map(replyOf).find((text) => text !== null);
            if (reply !== undefined && reply !== null) {
              finish();
              resolve(reply);
            }
          },
          () => undefined,
        ); // 暫時連不上就下一輪再讀
      }, DECOMPOSE_POLL_MS);
      const finish = () => {
        clearInterval(timer);
        stopWaiting.current = null;
      };
      stopWaiting.current = () => {
        finish();
        resolve(null);
      };
    });

  const start = () => {
    if (!lead || blocker) return;
    setMessage(null);
    setWaiting(true);
    void run(async () => {
      try {
        const seen = new Set((await backend.sessionEvents(lead.id)).map((e) => e.id));
        backend.sendPrompt(lead.id, decomposePrompt(team, presentAbbrs(refs)));
        const reply = await nextReply(lead.id, seen);
        return reply === null ? t('team.decompose.cancelled') : await accept(reply);
      } finally {
        setWaiting(false);
      }
    });
  };

  /** 不送任何東西，不花額度：重新載入後、或請隊長在終端機改好之後再讀一次。 */
  const rereadLatest = () => {
    if (!lead) return;
    setMessage(null);
    void run(async () => {
      const events = await backend.sessionEvents(lead.id);
      const reply = events
        .map(replyOf)
        .filter((text) => text !== null)
        .at(-1);
      if (reply === undefined) throw new Error(t('team.decompose.noReply'));
      return accept(reply);
    });
  };

  return (
    <div className="decompose">
      <div className="row">
        <button disabled={busy || waiting || blocker !== null} onClick={start}>
          {t('team.decompose.action')}
        </button>
        <CostChip />
        {waiting ? (
          <>
            <span className="msg" role="status" data-testid="decompose-waiting">
              {t('team.decompose.waiting', { name: lead?.name ?? '' })}
            </span>
            <button onClick={() => stopWaiting.current?.()}>{t('team.decompose.cancel')}</button>
          </>
        ) : (
          lead && (
            <button disabled={busy} onClick={rereadLatest}>
              {t('team.decompose.reread')}
            </button>
          )
        )}
      </div>
      {blocker && !waiting && (
        <p className="sub" data-testid="decompose-blocker">
          {blocker}
        </p>
      )}
      <div className="row">
        <ActionMessage message={message} testId="decompose-msg" />
      </div>
    </div>
  );
}

function NewTask({ team, reload }: { team: Team; reload: () => Promise<void> }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [title, setTitle] = useState('');
  const { busy, message, run } = useAction();
  return (
    <form
      className="row new-task"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await backend.createTask(team.id, { title: title.trim(), ownerSessionId: null });
          setTitle('');
          await reload();
        });
      }}
    >
      <input
        aria-label={t('team.tasks.newTitle')}
        placeholder={t('team.tasks.newTitle')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <button disabled={busy || title.trim() === ''}>{t('team.tasks.add')}</button>
      <ActionMessage message={message} />
    </form>
  );
}

/** 任務自動執行的開關：會花成員的額度，預設關；全隊暫停、全隊停止也會關掉。 */
function TaskAutoToggle({ team }: { team: Team }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const { busy, message, run } = useAction();
  const on = team.taskAuto === true;
  return (
    <div className="task-auto" data-testid="task-auto">
      <div className="row">
        <label>
          <input
            type="checkbox"
            checked={on}
            disabled={busy}
            data-testid="task-auto-toggle"
            onChange={() =>
              void run(async () => {
                await backend.updateTeam(team.id, { taskAuto: !on });
                await refreshTeams(backend);
                return t(on ? 'team.tasks.auto.turnedOff' : 'team.tasks.auto.turnedOn');
              })
            }
          />{' '}
          {t('team.tasks.auto.label')}
        </label>
        <CostChip />
        <ActionMessage message={message} testId="task-auto-msg" />
      </div>
      <p className="sub">{t('team.tasks.auto.help')}</p>
    </div>
  );
}

export function TaskBoard({
  team,
  members,
  tasks,
  reload,
}: {
  team: Team;
  members: Session[];
  tasks: Task[] | null;
  reload: () => Promise<void>;
}) {
  const t = useT();
  return (
    <section className="panel" aria-labelledby="tasks-title">
      <h2 id="tasks-title">{t('team.tasks.title')}</h2>
      {tasks === null ? (
        <p className="sub">{t('views.loading')}</p>
      ) : (
        <>
          <Decompose team={team} members={members} tasks={tasks} reload={reload} />
          <TaskAutoToggle team={team} />
          <div className="columns">
            {COLUMNS.map((column) => {
              const list = tasks.filter((task) => task.column === column);
              return (
                <div className="column" key={column} data-testid={`column-${column}`}>
                  <h3>
                    {t(`team.column.${column}`)} <span className="num sub">{list.length}</span>
                  </h3>
                  {column === 'todo' && <NewTask team={team} reload={reload} />}
                  {list.length === 0 ? (
                    <p className="sub">{t(`team.column.${column}.empty`)}</p>
                  ) : (
                    <ul>
                      {list.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          team={team}
                          members={members}
                          reload={reload}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
