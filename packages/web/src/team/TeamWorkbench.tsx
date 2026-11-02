// 團隊工作台：目標、成員、任務板、TEAM.md、交接規則、全隊暫停／停止。
import { useCallback, useEffect, useState } from 'react';
import { TeamRole } from '@agent-board/protocol';
import type { Session, Task, Team, TeamMember } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { Callsign, handsClass, Lamp, ModeChip } from '../views';
import { ActionMessage, ColorPicker, TwoClickButton, useAction, useDraft } from './common';
import { HandoffPanel } from './HandoffPanel';
import { refreshTeams, teamColorVar, useTeams } from './store';
import { TaskBoard } from './TaskBoard';
import { worktreeConflicts } from './worktree';

/** STYLE 沒定義字數，DISPATCH §8-3 的「1 頁」以約 3000 字計。 */
export const TEAM_MD_PAGE_CHARS = 3000;
const TASKS_POLL_MS = 5000;

type Role = TeamMember['role'];

const isLive = (s: Session) => s.endedAt === null && s.status !== 'done';
/** Esc 只送給正在動的：對權限對話框按 Esc 等於拒絕。 */
const isInterruptible = (s: Session) => s.status === 'running' || s.status === 'stuck';

function GoalPanel({ team }: { team: Team }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const goal = useDraft(team.goal);
  const criteria = useDraft(team.doneCriteria);
  const { busy, message, run } = useAction();
  const save = () =>
    run(async () => {
      await backend.updateTeam(team.id, { goal: goal.draft, doneCriteria: criteria.draft });
      await refreshTeams(backend);
      goal.markSaved();
      criteria.markSaved();
      return t('team.saved');
    });
  return (
    <section className="panel" aria-labelledby="goal-title">
      <h2 id="goal-title">{t('team.goal.title')}</h2>
      <label htmlFor={`${team.id}-goal`}>{t('team.goal.goal')}</label>
      <textarea
        id={`${team.id}-goal`}
        rows={3}
        value={goal.draft}
        onChange={(e) => goal.set(e.target.value)}
        placeholder={t('team.goal.placeholder')}
      />
      <label htmlFor={`${team.id}-criteria`}>{t('team.goal.criteria')}</label>
      <textarea
        id={`${team.id}-criteria`}
        rows={3}
        value={criteria.draft}
        onChange={(e) => criteria.set(e.target.value)}
        placeholder={t('team.goal.criteriaPlaceholder')}
      />
      <div className="row">
        <button disabled={busy || !(goal.dirty || criteria.dirty)} onClick={() => void save()}>
          {t('team.save')}
        </button>
        <ActionMessage message={message} />
      </div>
    </section>
  );
}

function MembersPanel({ team, members }: { team: Team; members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const roles = useTeams((s) => s.members);
  const rules = useTeams((s) => s.rules);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<Role>('worker');
  const { busy, message, run, setMessage } = useAction();
  const [conflict, setConflict] = useState<string | null>(null);

  const roleOf = (id: string) =>
    roles.find((m) => m.teamId === team.id && m.sessionId === id)?.role ?? 'worker';
  const candidates = sessions.filter(
    (s) => !s.archived && isLive(s) && !members.some((m) => m.id === s.id),
  );

  const add = () => {
    const candidate = candidates.find((s) => s.id === pick);
    if (!candidate) return;
    setMessage(null);
    const conflicts = worktreeConflicts(candidate, members);
    if (conflicts.length > 0) {
      setConflict(
        t('team.members.conflict', {
          name: candidate.name,
          others: conflicts.map((s) => s.name).join('、'),
          dir: candidate.worktreePath ?? candidate.cwd,
        }),
      );
      return;
    }
    setConflict(null);
    void run(async () => {
      await backend.putTeamMember(team.id, candidate.id, role);
      await refreshTeams(backend);
      setPick('');
    });
  };

  const changeRole = (id: string, next: Role) =>
    run(async () => {
      await backend.putTeamMember(team.id, id, next);
      await refreshTeams(backend);
    });

  /** 離開團隊的成員，和他有關的交接規則也不該留著。 */
  const remove = (id: string) =>
    run(async () => {
      const related = rules.filter(
        (r) => r.teamId === team.id && (r.fromSessionId === id || r.action.toSessionId === id),
      );
      await Promise.all(related.map((r) => backend.deleteHandoffRule(r.id)));
      await backend.deleteTeamMember(team.id, id);
      await refreshTeams(backend);
    });

  return (
    <section className="panel" aria-labelledby="members-title">
      <h2 id="members-title">{t('team.members.title')}</h2>
      {members.length === 0 ? (
        <p className="sub">{t('team.members.empty')}</p>
      ) : (
        <ul className="members">
          {members.map((s) => (
            <li
              key={s.id}
              className={`member hands-host ${handsClass(s.permissionMode)}`}
              data-testid={`member-${s.id}`}
            >
              <div className="member-head">
                <b>{s.name}</b>
                <Lamp status={s.status} />
              </div>
              <div className="sign">
                <Callsign session={s} />
                <ModeChip mode={s.permissionMode} />
              </div>
              <div className="row">
                <select
                  aria-label={t('team.members.roleOf', { name: s.name })}
                  value={roleOf(s.id)}
                  onChange={(e) => void changeRole(s.id, e.target.value as Role)}
                >
                  {TeamRole.options.map((r) => (
                    <option key={r} value={r}>
                      {t(`team.role.${r}`)}
                    </option>
                  ))}
                </select>
                <button onClick={() => void remove(s.id)}>{t('team.members.remove')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="row add-member">
        <select
          aria-label={t('team.members.pick')}
          value={pick}
          onChange={(e) => {
            setPick(e.target.value);
            setConflict(null);
          }}
        >
          <option value="">{t('team.members.pick')}</option>
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          aria-label={t('team.members.role')}
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          {TeamRole.options.map((r) => (
            <option key={r} value={r}>
              {t(`team.role.${r}`)}
            </option>
          ))}
        </select>
        <button disabled={busy || pick === ''} onClick={add}>
          {t('team.members.add')}
        </button>
        <ActionMessage message={message} />
      </div>
      {conflict && (
        <div className="alert you-alert" role="alert" data-testid="worktree-conflict">
          <span aria-hidden="true">◆</span>
          <div>
            <div>{conflict}</div>
            <button onClick={() => (location.hash = '#/new')}>{t('team.members.openNew')}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function ContextPanel({ team }: { team: Team }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const context = useDraft(team.contextMd);
  const { busy, message, run } = useAction();
  const length = [...context.draft].length;
  return (
    <section className="panel" aria-labelledby="context-title">
      <h2 id="context-title">
        <code>TEAM.md</code>
      </h2>
      <p className="sub">{t('team.context.hint')}</p>
      <textarea
        className="mono"
        rows={10}
        aria-labelledby="context-title"
        value={context.draft}
        onChange={(e) => context.set(e.target.value)}
      />
      {length > TEAM_MD_PAGE_CHARS && (
        <div className="alert you-alert" role="alert" data-testid="team-md-long">
          <span aria-hidden="true">◆</span>
          <div>{t('team.context.tooLong', { n: length, limit: TEAM_MD_PAGE_CHARS })}</div>
        </div>
      )}
      <div className="row">
        <button
          disabled={busy || !context.dirty}
          onClick={() =>
            void run(async () => {
              await backend.updateTeam(team.id, { contextMd: context.draft });
              await refreshTeams(backend);
              context.markSaved();
              return t('team.saved');
            })
          }
        >
          {t('team.save')}
        </button>
        <span className="sub num" data-testid="team-md-count">
          {t('team.context.count', { n: length, limit: TEAM_MD_PAGE_CHARS })}
        </span>
        <ActionMessage message={message} />
      </div>
    </section>
  );
}

function TeamControls({ team, members }: { team: Team; members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const rules = useTeams((s) => s.rules);
  const { busy, message, run } = useAction();
  const enabledRules = rules.filter((r) => r.teamId === team.id && r.enabled);
  const live = members.filter(isLive);

  // 兩者都先關規則：不然中斷或結束本身又會觸發交接。
  const disableRules = () =>
    Promise.all(enabledRules.map((r) => backend.updateHandoffRule(r.id, { enabled: false })));

  const pause = () =>
    run(async () => {
      await disableRules();
      const targets = members.filter(isInterruptible);
      for (const s of targets) {
        backend.terminal.send({ type: 'terminal.signal', sessionId: s.id, signal: 'escape' });
      }
      await refreshTeams(backend);
      return t('team.paused', { n: targets.length, rules: enabledRules.length });
    });

  const stop = () =>
    run(async () => {
      await disableRules();
      const results = await Promise.allSettled(live.map((s) => backend.stopSession(s.id)));
      await refreshTeams(backend);
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) throw new Error(t('team.stopPartial', { failed, n: live.length }));
      return t('team.stopped', { n: live.length });
    });

  return (
    <div className="row team-controls">
      <button disabled={busy || live.length === 0} onClick={() => void pause()}>
        {t('team.pause')}
      </button>
      <TwoClickButton
        label={t('team.stop')}
        armedLabel={t('team.stopArmed', { n: live.length })}
        disabled={busy || live.length === 0}
        onConfirm={() => void stop()}
      />
      <ActionMessage message={message} testId="team-controls-msg" />
    </div>
  );
}

export function TeamWorkbench({ team }: { team: Team }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const roles = useTeams((s) => s.members);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { message, run } = useAction();

  const members = roles
    .filter((m) => m.teamId === team.id)
    .flatMap((m) => sessions.find((s) => s.id === m.sessionId) ?? []);

  const reloadTasks = useCallback(async () => {
    setTasks(await backend.listTasks(team.id));
    setLoadError(null);
  }, [backend, team.id]);

  useEffect(() => {
    const load = () => {
      if (document.hidden) return;
      reloadTasks().catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)));
    };
    load();
    const timer = setInterval(load, TASKS_POLL_MS);
    return () => clearInterval(timer);
  }, [reloadTasks]);

  return (
    <div
      className="page team-page"
      style={{ ['--team' as string]: teamColorVar(team.color) }}
      data-testid="team-workbench"
    >
      <p className="crumb">
        <a href="#/team">← {t('team.backToList')}</a>
      </p>
      <div className="team-head">
        <h1>
          <i className="swatch" aria-hidden="true" />
          {team.name}
        </h1>
        <ColorPicker
          value={team.color}
          onChange={(color) =>
            void run(async () => {
              await backend.updateTeam(team.id, { color });
              await refreshTeams(backend);
            })
          }
        />
        <span className="spacer" />
        <TeamControls team={team} members={members} />
      </div>
      <ActionMessage message={message} />
      <div className="team-grid">
        <GoalPanel team={team} />
        <MembersPanel team={team} members={members} />
      </div>
      {loadError && (
        <div className="alert" role="alert">
          <span aria-hidden="true">✕</span>
          <div>{t('team.error.tasks', { detail: loadError })}</div>
        </div>
      )}
      <TaskBoard team={team} members={members} tasks={tasks} reload={reloadTasks} />
      <div className="team-grid">
        <ContextPanel team={team} />
        <HandoffPanel team={team} members={members} />
      </div>
      <div className="row team-delete">
        <TwoClickButton
          label={t('team.delete')}
          armedLabel={t('team.deleteArmed')}
          onConfirm={() =>
            void run(async () => {
              await backend.deleteTeam(team.id);
              await refreshTeams(backend);
              location.hash = '#/team';
            })
          }
        />
      </div>
    </div>
  );
}
