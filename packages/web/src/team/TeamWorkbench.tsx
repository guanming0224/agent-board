// 團隊面板（P2 §2.3）：頂部名稱、工作區、寬版；名單（狀態代碼、角色、時間）；工作台原本的區塊（成員管理、補成員、
// 研究階段、任務板、交接規則、目標與 TEAM.md）收合呈現；底部群發指令框。
import { useCallback, useEffect, useState } from 'react';
import { TeamRole } from '@agent-board/protocol';
import type {
  Session,
  Task,
  Team,
  TeamMember,
  TeamResumeResult,
  TeamSessionRef,
} from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  Callsign,
  closeRight,
  errorText,
  handsClass,
  Lamp,
  ModeChip,
  AgentChip,
  ReadOnlyChip,
  resumeErrorText,
  useClock,
  useViewsUi,
} from '../views';
import { moveTeamToZone, useZones } from '../zones';
import { ProgressCardView } from '../progress/ProgressCard';
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
import { TeamHeldFirstPrompts } from './HeldFirstPrompt';
import { SaveTeamPreset } from './PresetSettings';
import { HandoffPanel } from './HandoffPanel';
import { PhasePanel } from './PhasePanel';
import { kindLabel } from './PlanEditor';
import { memberKind } from './research';
import { refreshTeams, teamColorVar, useTeams } from './store';
import { TaskBoard } from './TaskBoard';
import { ROLE_ABBR } from './teamPlan';
import { memberClashes, worktreeConflicts } from './worktree';
import { PHONE_QUERY } from '../shared/breakpoints';
import { Empty, useCurrentUser } from '../flows/common';
import { PanelHead, WideButton } from '../views/Overlays';

/** STYLE 沒定義字數，DISPATCH §8-3 的「1 頁」以約 3000 字計。 */
export const TEAM_MD_PAGE_CHARS = 3000;
const TASKS_POLL_MS = 5000;

type Role = TeamMember['role'];

const isLive = (s: Session) => s.endedAt === null && s.status !== 'done';

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
        <button
          className="primary"
          disabled={busy || !(goal.dirty || criteria.dirty)}
          onClick={() => void save()}
        >
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
        <Empty title={t('team.members.emptyTitle')} next={t('team.members.empty')} />
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
                  <Lamp status={s.status} detail={s.statusDetail} awaiting={s.awaiting} />
                </div>
                <div className="sign">
                  <Callsign session={s} />
                  <ModeChip mode={s.permissionMode} />
                  <AgentChip session={s} />
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
                    <button className="sm" onClick={() => void markDone(s.id)}>
                      {t('team.members.markDone')}
                    </button>
                  )}
                  {isLive(s) && firesHandoff(s.id) && (
                    <>
                      <CostChip />
                      <span className="sub">{t('team.members.markDoneHint')}</span>
                    </>
                  )}
                  <button className="sm" onClick={() => void remove(s.id)}>
                    {t('team.members.remove')}
                  </button>
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
          className="primary"
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

/** 名字清單（訊息裡用）。 */
const names = (list: TeamSessionRef[]) => list.map((x) => x.name).join('、');

/** 全隊繼續／啟動的結果訊息：打開幾條、略過哪些、接回幾個、幾個失聯（CONTRACTS §17）。 */
function resumeText(
  t: ReturnType<typeof useT>,
  r: TeamResumeResult,
  machineOf: (sessionId: string) => string,
): string {
  if (r.mode === null) return t('team.resumed.none');
  const parts = [
    r.mode === 'stop'
      ? t('team.started', { n: r.resumed.length, rules: r.rules.enabled })
      : t('team.resumed', { rules: r.rules.enabled }),
  ];
  if (r.rules.alreadyOn > 0) parts.push(t('team.resumed.alreadyOn', { n: r.rules.alreadyOn }));
  if (r.rules.deleted > 0) parts.push(t('team.resumed.deleted', { n: r.rules.deleted }));
  if (r.taskAuto === 'enabled') parts.push(t('team.resumed.tasks'));
  if (r.taskAuto === 'already_on') parts.push(t('team.resumed.tasksAlready'));
  if (r.alreadyRunning.length > 0) {
    parts.push(
      t('team.started.running', { n: r.alreadyRunning.length, names: names(r.alreadyRunning) }),
    );
  }
  if (r.failed.length > 0) {
    const detail = r.failed
      .map((f) => `${f.name}（${resumeErrorText(t, f, machineOf(f.sessionId))}）`)
      .join('、');
    parts.push(t('team.started.failed', { n: r.failed.length, names: detail }));
  }
  if (r.gone > 0) parts.push(t('team.started.gone', { n: r.gone }));
  if (r.offline.length > 0) {
    parts.push(t('team.started.offline', { n: r.offline.length, names: names(r.offline) }));
  }
  if (r.boardPaused) parts.push(t('team.resumed.boardPaused'));
  return parts.join(' ');
}

/**
 * 全隊暫停／停止，以及暫停、停止之後的全隊繼續／啟動（CONTRACTS §17）。關規則、送 Esc、停 session、
 * 記下關了哪些都在 hub 一次做完（瀏覽器做到一半斷線也不會只關一半）；記錄在 team.hold，別的裝置跟著換按鈕。
 */
function TeamControls({ team, members }: { team: Team; members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const machines = useBoard((s) => s.machines);
  const clock = useClock();
  const { busy, message, run } = useAction();
  const live = members.filter(isLive);
  const hold = team.hold;
  // 停止後還活著、又不是當初停掉的（停不了的、手動接回的）：仍可再按「全隊停止」。
  const canStop = hold?.mode !== 'stop' || live.some((s) => !hold.stoppedSessionIds.includes(s.id));

  const withTasks = (turnedOff: boolean, text: string) =>
    turnedOff ? `${text} ${t('team.paused.tasks')}` : text;

  const pause = () =>
    run(async () => {
      const r = await backend.holdTeam(team.id, 'pause');
      await refreshTeams(backend);
      let text = t('team.paused', { n: r.interrupted.length, rules: r.rules });
      if (r.offline.length > 0) {
        text += ` ${t('team.paused.offline', { n: r.offline.length, names: names(r.offline) })}`;
      }
      return withTasks(r.taskAuto, text);
    });

  const stop = () =>
    run(async () => {
      const r = await backend.holdTeam(team.id, 'stop');
      await refreshTeams(backend);
      const n = r.stopped.length + r.failed.length;
      if (r.failed.length > 0)
        throw new Error(t('team.stopPartial', { failed: r.failed.length, n }));
      return withTasks(r.taskAuto, t('team.stopped', { n }));
    });

  const machineOf = (sessionId: string) => {
    const machineId = sessions.find((s) => s.id === sessionId)?.machineId;
    return machines.find((m) => m.id === machineId)?.name ?? machineId ?? '';
  };
  const resume = () =>
    run(async () => {
      const r = await backend.resumeTeam(team.id);
      await refreshTeams(backend);
      return resumeText(t, r, machineOf);
    });

  const holdNote = hold
    ? t(hold.mode === 'stop' ? 'team.hold.stop' : 'team.hold.pause', {
        since: clock(hold.since),
        by: hold.byName,
        n: hold.stoppedSessionIds.length,
        rules: hold.ruleIds.length,
        tasks: hold.taskAuto ? t('team.hold.tasks') : '',
      })
    : null;

  return (
    <div className="row team-controls">
      {hold?.mode === 'pause' && (
        <button
          className="act"
          disabled={busy}
          onClick={() => void resume()}
          data-testid="team-resume"
        >
          {t('team.resumeHeld')}
        </button>
      )}
      {hold?.mode === 'stop' && (
        <button
          className="act"
          disabled={busy}
          onClick={() => void resume()}
          data-testid="team-start"
        >
          {t('team.startHeld')}
        </button>
      )}
      {!hold && (
        <button className="act" disabled={busy || live.length === 0} onClick={() => void pause()}>
          {t('team.pause')}
        </button>
      )}
      {canStop && (
        <TwoClickButton
          label={t('team.stop')}
          armedLabel={t('team.stopArmed', { n: live.length })}
          className="act"
          disabled={busy || live.length === 0}
          onConfirm={() => void stop()}
        />
      )}
      {holdNote && (
        <span className="hint-inline" data-testid="team-hold-note">
          {holdNote}
        </span>
      )}
      <ActionMessage message={message} testId="team-controls-msg" />
    </div>
  );
}

/**
 * 團隊「共用資料夾」（§24）：開著時顯示說明；owner 可以關掉（之後隊長開 BD 又要各自 worktree，
 * 不是 git 的資料夾就會被擋，請改按 git init）。開的地方是新增團隊與補成員的勾選。
 */
function SharedFolderNote({ team }: { team: Team }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const me = useCurrentUser();
  const { busy, message, run } = useAction();
  if (!team.sharedWriters) return null;
  return (
    <div className="alert you-alert team-shared-note" data-testid="team-shared">
      <span aria-hidden="true">◆</span>
      <div>
        <p>{t('team.shared.on')}</p>
        {me.data?.role === 'owner' ? (
          <div className="row">
            <TwoClickButton
              className="touch"
              label={t('team.shared.off')}
              armedLabel={t('team.shared.offArmed')}
              testId="team-shared-off"
              disabled={busy}
              onConfirm={() =>
                void run(async () => {
                  await backend.updateTeam(team.id, { sharedWriters: false });
                  await refreshTeams(backend);
                  return t('team.shared.offDone');
                })
              }
            />
            <ActionMessage message={message} />
          </div>
        ) : (
          <p className="sub">{t('team.shared.ownerOnly')}</p>
        )}
      </div>
    </div>
  );
}

export function TeamWorkbench({ team, inPanel = false }: { team: Team; inPanel?: boolean }) {
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
      {/* 右側面板：名稱與寬版、✕ 在共用的標題列（和 Memory、收件匣同一個長相）；手機是一般 h1。 */}
      {inPanel ? (
        <PanelHead
          title={
            <>
              <i className="swatch" aria-hidden="true" />
              {team.name}
            </>
          }
          onClose={closeRight}
          closeTestId="team-close"
        >
          {!phone && <WideToggle />}
        </PanelHead>
      ) : (
        <h1>
          <i className="swatch" aria-hidden="true" />
          {team.name}
        </h1>
      )}
      <p className="crumb">
        <a href="#/team">← {t('team.backToList')}</a>
      </p>
      <div className="team-head">
        <ZonePicker team={team} />
        <TeamColor
          value={team.color}
          onChange={(color) =>
            void run(async () => {
              await backend.updateTeam(team.id, { color });
              await refreshTeams(backend);
            })
          }
        />
        <span className="spacer" />
        {/* 「⋯」：存成 Preset、刪除團隊（不和每天在用的群發送出放在一起，報告 E5）。 */}
        <SaveTeamPreset team={team} records={records}>
          <TwoClickButton
            className="menu-item"
            role="menuitem"
            label={t('team.delete')}
            armedLabel={t('team.deleteArmed')}
            testId="team-delete"
            onConfirm={() =>
              void run(async () => {
                await backend.deleteTeam(team.id);
                await refreshTeams(backend);
                location.hash = '#/team';
              })
            }
          />
        </SaveTeamPreset>
      </div>
      <TeamHeldFirstPrompts teamId={team.id} />
      <div className="row team-head-controls">
        <TeamControls team={team} members={members} />
      </div>
      <SharedFolderNote team={team} />
      <ActionMessage message={message} />
      {/* 進度卡（P3 項目一 §1.5）：名單上方，同畫布展開樣式；手機與桌面一致。 */}
      <TeamProgress team={team} />
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
      <BroadcastBox team={team} rows={records} />
    </div>
  );
}

/** 團隊面板的進度卡：預設展開（面板就是來看這個團隊的），可收合。 */
function TeamProgress({ team }: { team: Team }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="team-progress">
      <ProgressCardView
        owner={{ teamId: team.id }}
        name={team.name}
        variant="panel"
        expanded={open}
        onExpandedChange={setOpen}
        testId="team-progress"
      />
    </div>
  );
}

const FOLDS_KEY = 'agent-board.team.folds';

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
 * 手機上的「回電腦處理」（§2.4）：按了複製這個團隊頁的連結，拿到電腦上打開；
 * 複製不了（沒有剪貼簿權限、非 https）就直接把網址秀出來讓 GM 自己選取。
 */
function DesktopLink() {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const url = location.href;
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('manual');
    }
  };
  return (
    <span className="fold-desktop">
      <button
        type="button"
        className="link"
        onClick={() => void copy()}
        data-testid="fold-desktop-link"
      >
        {t('team.fold.desktopOnly')}
      </button>
      {state === 'copied' && (
        <span className="sub" role="status">
          {t('team.fold.copied')}
        </span>
      )}
      {state === 'manual' && (
        <input
          className="fold-url"
          readOnly
          value={url}
          aria-label={t('team.fold.url')}
          onFocus={(e) => e.currentTarget.select()}
          data-testid="fold-desktop-url"
        />
      )}
    </span>
  );
}

/**
 * 收合的區塊。預設收起；打開哪些每台瀏覽器自己記。手機不展開（任務板等要大畫面），給「回電腦處理」連結。
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
  const [open, setOpen] = useState(() => readFolds().includes(id));
  if (phone) {
    return (
      <div className="fold fold-phone" data-testid={`fold-${id}`}>
        <span>{title}</span>
        <DesktopLink />
      </div>
    );
  }
  return (
    <div className="fold" data-testid={`fold-${id}`} data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="ghost sm fold-toggle"
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
    <WideButton
      wide={wide}
      onToggle={() => setWide(!wide)}
      label={wide ? t('team.wide.off') : t('team.wide.on')}
      hint={t('team.wide.hint')}
      testId="team-wide"
    />
  );
}

/**
 * 團隊顏色：平常只佔一顆精簡按鈕（目前顏色＋「團隊顏色」），按了才展開 8 個色塊。
 * 420px 面板放不下整排色塊（以前佔了標題列 82% 寬，報告 D4）。
 */
function TeamColor({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="sm team-color-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="team-color-toggle"
      >
        <i className="swatch" aria-hidden="true" />
        {t('team.color')}
      </button>
      {open && (
        <div className="team-color-row">
          <ColorPicker
            value={value}
            onChange={(color) => {
              onChange(color);
              setOpen(false);
            }}
          />
        </div>
      )}
    </>
  );
}
