// 團隊工作台：目標、成員、補成員、研究階段、任務板、TEAM.md、交接規則、全隊暫停／停止。
import { useCallback, useEffect, useState } from 'react';
import { TeamRole } from '@agent-board/protocol';
import type { Session, Task, Team, TeamMember } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { Callsign, errorText, handsClass, Lamp, ModeChip, ReadOnlyChip } from '../views';
import {
  ActionMessage,
  ColorPicker,
  CostChip,
  TwoClickButton,
  useAction,
  useDraft,
} from './common';
import { AddMembers } from './AddMembers';
import { HandoffPanel } from './HandoffPanel';
import { PhasePanel } from './PhasePanel';
import { kindLabel } from './PlanEditor';
import { memberKind } from './research';
import { refreshTeams, teamColorVar, useTeams } from './store';
import { TaskBoard } from './TaskBoard';
import { ROLE_ABBR } from './teamPlan';
import { memberClashes, worktreeConflicts } from './worktree';

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

  const recordOf = (id: string) => roles.find((m) => m.teamId === team.id && m.sessionId === id);
  const roleOf = (id: string) => recordOf(id)?.role ?? 'worker';
  const candidates = sessions.filter(
    (s) => !s.archived && isLive(s) && !members.some((m) => m.id === s.id),
  );

  const add = () => {
    const candidate = candidates.find((s) => s.id === pick);
    if (!candidate) return;
    setMessage(null);
    const conflicts = worktreeConflicts(candidate, members, { candidate: role, of: roleOf });
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
      try {
        await backend.putTeamMember(team.id, candidate.id, role);
      } catch (e) {
        // hub 才看得到還沒開好的 session 的 worktree 設定，所以前端放行的也可能在這裡被擋。
        if ((e as { code?: string }).code !== 'worktree_required') throw e;
        setConflict(t('team.members.conflictHub', { name: candidate.name, detail: errorText(e) }));
        return;
      }
      await refreshTeams(backend);
      setPick('');
    });
  };

  const changeRole = (id: string, next: Role) =>
    run(async () => {
      setConflict(null);
      try {
        await backend.putTeamMember(team.id, id, next);
      } catch (e) {
        // 唯讀成員改成會改檔案的角色：hub 會重新檢查同資料夾（CONTRACTS「團隊事件」）。
        if ((e as { code?: string }).code !== 'worktree_required') throw e;
        const name = members.find((s) => s.id === id)?.name ?? id;
        setConflict(t('team.members.roleConflict', { name, detail: errorText(e) }));
        return;
      }
      await refreshTeams(backend);
    });

  const markDone = (id: string) =>
    run(async () => {
      await backend.updateSession(id, { markDone: true });
    });

  const firesHandoff = (id: string) =>
    rules.some((r) => r.enabled && r.trigger === 'on_done' && r.fromSessionId === id);

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
          {members.map((s) => {
            const clashes = memberClashes(s, members, roleOf);
            return (
              <li
                key={s.id}
                className={`member hands-host ${handsClass(s.permissionMode)}`}
                data-testid={`member-${s.id}`}
              >
                <div className="member-head">
                  <b>{s.name}</b>
                  <Lamp status={s.status} detail={s.statusDetail} />
                </div>
                <div className="sign">
                  <Callsign session={s} />
                  <ModeChip mode={s.permissionMode} />
                  <ReadOnlyChip session={s} />
                  {team.phase && (
                    <span className="chip" data-testid={`member-kind-${s.id}`}>
                      {kindLabel(t, memberKind(recordOf(s.id) ?? { role: 'worker' }))}
                    </span>
                  )}
                </div>
                {clashes.length > 0 && (
                  <p className="member-clash" role="note" data-testid={`member-clash-${s.id}`}>
                    <span aria-hidden="true">◆ </span>
                    {t('team.members.clash', {
                      others: clashes.map((x) => x.name).join('、'),
                      dir: s.worktreePath ?? s.cwd,
                    })}
                  </p>
                )}
                <div className="row">
                  <select
                    aria-label={t('team.members.roleOf', { name: s.name })}
                    value={roleOf(s.id)}
                    onChange={(e) => void changeRole(s.id, e.target.value as Role)}
                  >
                    {TeamRole.options.map((r) => (
                      <option key={r} value={r}>
                        {t('team.role.withAbbr', { role: t(`team.role.${r}`), abbr: ROLE_ABBR[r] })}
                      </option>
                    ))}
                  </select>
                  {isLive(s) && (
                    <button onClick={() => void markDone(s.id)}>
                      {t('team.members.markDone')}
                    </button>
                  )}
                  {isLive(s) && firesHandoff(s.id) && (
                    <>
                      <CostChip />
                      <span className="sub">{t('team.members.markDoneHint')}</span>
                    </>
                  )}
                  <button onClick={() => void remove(s.id)}>{t('team.members.remove')}</button>
                </div>
              </li>
            );
          })}
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
              {t('team.role.withAbbr', { role: t(`team.role.${r}`), abbr: ROLE_ABBR[r] })}
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

  // 兩者都先關規則與任務自動執行：不然中斷或結束本身又會觸發交接、送下一個任務。
  const tasksWereAuto = team.taskAuto === true;
  const disableRules = async () => {
    if (tasksWereAuto) await backend.updateTeam(team.id, { taskAuto: false });
    await Promise.all(enabledRules.map((r) => backend.updateHandoffRule(r.id, { enabled: false })));
  };
  const withTasks = (text: string) => (tasksWereAuto ? `${text} ${t('team.paused.tasks')}` : text);

  const pause = () =>
    run(async () => {
      await disableRules();
      const targets = members.filter(isInterruptible);
      for (const s of targets) {
        backend.terminal.send({ type: 'terminal.signal', sessionId: s.id, signal: 'escape' });
      }
      await refreshTeams(backend);
      return withTasks(t('team.paused', { n: targets.length, rules: enabledRules.length }));
    });

  const stop = () =>
    run(async () => {
      await disableRules();
      const results = await Promise.allSettled(live.map((s) => backend.stopSession(s.id)));
      await refreshTeams(backend);
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) throw new Error(t('team.stopPartial', { failed, n: live.length }));
      return withTasks(t('team.stopped', { n: live.length }));
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
  const [adding, setAdding] = useState(false);

  const records = roles
    .filter((m) => m.teamId === team.id)
    .flatMap((member) => {
      const session = sessions.find((s) => s.id === member.sessionId);
      return session ? [{ member, session }] : [];
    });
  const members = records.map((r) => r.session);

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
      <div className="row add-members-toggle">
        <button
          aria-expanded={adding}
          data-testid="add-members-toggle"
          onClick={() => setAdding((open) => !open)}
        >
          {t('team.add.open')}
        </button>
        <span className="sub">{t('team.add.hint')}</span>
      </div>
      {adding && (
        <AddMembers
          team={team}
          members={records}
          title={t('team.add.title')}
          onClose={() => setAdding(false)}
        />
      )}
      {team.phase && <PhasePanel team={{ ...team, phase: team.phase }} members={records} />}
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
