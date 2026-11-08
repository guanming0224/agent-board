// 團隊面板（P2 §2.3）：頂部名稱、工作區、寬版；名單（狀態代碼、角色、時間）；工作台原本的區塊（成員管理、補成員、
// 研究階段、任務板、交接規則、目標與 TEAM.md）收合呈現；底部群發指令框。
import { useCallback, useEffect, useState } from 'react';
import { TeamRole } from '@agent-board/protocol';
import type { Session, Task, Team, TeamMember } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  Callsign,
  errorText,
  handsClass,
  Lamp,
  ModeChip,
  ReadOnlyChip,
  useViewsUi,
} from '../views';
import { moveTeamToZone, useZones } from '../zones';
import { BroadcastBox, Roster } from './Roster';
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
                  {/* 角色在上面的名單裡改（P2 §2.3），這裡只放完成、移除。 */}
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
  const phone = usePhone();

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
        <ZonePicker team={team} />
        {!phone && <WideToggle />}
      </div>
      <div className="row team-head-controls">
        <TeamControls team={team} members={members} />
      </div>
      <ActionMessage message={message} />
      {/* 名單（P2 §2.3）：狀態代碼、名稱、角色、時間；點列＝畫布聚焦那張卡。 */}
      <Roster team={team} rows={records} />
      {/* 工作台原本的區塊收合呈現，點開在面板內展開；手機上只給「回電腦處理」。 */}
      <Fold id="members" title={t('team.fold.members')} phone={phone}>
        <MembersPanel team={team} members={members} />
      </Fold>
      <Fold id="add" title={t('team.fold.add')} phone={phone}>
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
      </Fold>
      {team.phase && (
        <Fold id="phase" title={t('team.fold.phase')} phone={phone}>
          <PhasePanel team={{ ...team, phase: team.phase }} members={records} />
        </Fold>
      )}
      <Fold id="tasks" title={t('team.fold.tasks')} phone={phone}>
        {loadError && (
          <div className="alert" role="alert">
            <span aria-hidden="true">✕</span>
            <div>{t('team.error.tasks', { detail: loadError })}</div>
          </div>
        )}
        <TaskBoard team={team} members={members} tasks={tasks} reload={reloadTasks} />
      </Fold>
      <Fold id="handoff" title={t('team.fold.handoff')} phone={phone}>
        <HandoffPanel team={team} members={members} />
      </Fold>
      <Fold id="goal" title={t('team.fold.goal')} phone={phone}>
        <div className="team-grid">
          <GoalPanel team={team} />
          <ContextPanel team={team} />
        </div>
      </Fold>
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
      <BroadcastBox team={team} rows={records} />
    </div>
  );
}

const FOLDS_KEY = 'agent-board.team.folds';
const PHONE_QUERY = '(max-width: 640px)';

function readFolds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    const query = matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/**
 * 收合的區塊。預設收起；打開哪些每台瀏覽器自己記。手機不展開（任務板等要大畫面），只寫「回電腦處理」。
 */
function Fold({
  id,
  title,
  phone,
  children,
}: {
  id: string;
  title: string;
  phone: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(() => readFolds().includes(id));
  if (phone) {
    return (
      <div className="fold fold-phone" data-testid={`fold-${id}`}>
        <span>{title}</span>
        <span className="sub">{t('team.fold.desktopOnly')}</span>
      </div>
    );
  }
  return (
    <div className="fold" data-testid={`fold-${id}`} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="fold-toggle"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          try {
            const all = new Set(readFolds());
            if (next) all.add(id);
            else all.delete(id);
            localStorage.setItem(FOLDS_KEY, JSON.stringify([...all]));
          } catch {
            // 存不了就只在這次有效。
          }
        }}
        data-testid={`fold-toggle-${id}`}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

/** 團隊面板頂部「工作區：[下拉]」：把團隊移到別的工作區（觸控也能用的做法，P2 §2.3）。 */
function ZonePicker({ team }: { team: Team }) {
  const t = useT();
  const zones = useZones();
  const [error, setError] = useState<string | null>(null);
  return (
    <label className="zone-picker">
      <span>{t('team.zone.label')}</span>
      <select
        value={team.zoneId}
        onChange={(e) => {
          setError(null);
          moveTeamToZone(team.id, e.target.value).catch((err: unknown) => setError(errorText(err)));
        }}
        data-testid="team-zone-select"
      >
        {zones.map((z) => (
          <option key={z.id} value={z.id}>
            {z.name}
          </option>
        ))}
      </select>
      {error && (
        <span className="msg err" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

/** 面板切寬版（760px）看任務板。 */
function WideToggle() {
  const t = useT();
  const wide = useViewsUi((s) => s.teamWide);
  const setWide = useViewsUi((s) => s.setTeamWide);
  return (
    <button
      type="button"
      aria-pressed={wide}
      onClick={() => setWide(!wide)}
      data-testid="team-wide"
      title={t('team.wide.hint')}
    >
      {wide ? t('team.wide.off') : t('team.wide.on')}
    </button>
  );
}
