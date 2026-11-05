// 新建團隊：名稱、顏色、目標，選一個成員組合就一起開各角色的 session（GM 2026-11-06）。
// 「只建團隊」保留原本的行為。機器、資料夾、專案的選法和 worktree 判斷沿用 flows/sessionForm。
import { useEffect, useRef, useState } from 'react';
import { PermissionMode, TeamRole } from '@agent-board/protocol';
import { useProjects } from '../flows/common';
import { isSessionDeleting } from '../shared/backend';
import {
  FolderBrowser,
  ProjectSelect,
  suggestMachine,
  useWorktreeAdvice,
  worktreeOn,
} from '../flows/sessionForm';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText } from '../views';
import { ActionMessage, ColorPicker, useAction } from './common';
import { runPlan, type RowStep } from './runPlan';
import { refreshTeams, TEAM_COLORS } from './store';
import {
  addRow,
  changeRole,
  PRESET_IDS,
  presetRows,
  renameRows,
  ROLE_ABBR,
  isReadOnlyRole,
  modesFor,
  rowUsesWorktree,
  validatePlan,
  type PlanRow,
  type PresetId,
  type Role,
} from './teamPlan';

type T = ReturnType<typeof useT>;

function stepText(t: T, step: RowStep): string {
  switch (step.step) {
    case 'waiting':
    case 'session':
    case 'member':
    case 'done':
      return t(`team.new.step.${step.step}`);
    case 'sessionFailed':
      return t('team.new.step.sessionFailed', {
        detail: isSessionDeleting(step.error)
          ? t('flows.err.createDeleting')
          : errorText(step.error),
      });
    case 'memberFailed':
      return t('team.new.step.memberFailed', { detail: errorText(step.error) });
  }
}

const isFailed = (step: RowStep | undefined) =>
  step?.step === 'sessionFailed' || step?.step === 'memberFailed';

export function NewTeamForm() {
  const t = useT();
  const { backend, machines, sessions, connected } = useBoard();
  const projects = useProjects();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(TEAM_COLORS[0]);
  const [goal, setGoal] = useState('');
  const [preset, setPreset] = useState<PresetId>('none');
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [chosenMachine, setChosenMachine] = useState<string | null>(null);
  const [cwd, setCwd] = useState('');
  const [projectId, setProjectId] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [tried, setTried] = useState(false);
  const [steps, setSteps] = useState<Record<string, RowStep>>({});
  const [created, setCreated] = useState<{
    teamId: string;
    failed: number;
    refreshFailed: boolean;
  } | null>(null);
  const { busy, message, run } = useAction();
  /** 連按兩下也只送一次（busy 要等下一次 render 才生效）。 */
  const submitting = useRef(false);
  /** 使用者中途離開這頁：進度照跑，但不再把他拉回工作台。 */
  const mounted = useRef(true);
  useEffect(() => {
    // StrictMode 會掛載、卸載再掛載一次，所以掛載時要設回 true。
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const suggestion = suggestMachine(machines, sessions, 'general');
  const machineId = chosenMachine ?? suggestion?.id ?? '';
  const machine = machines.find((m) => m.id === machineId);
  const advice = useWorktreeAdvice(machine, cwd);
  // 同 sessionForm 的 worktreeOn：daemon 確認不是 git 才關；還不知道時照開，失敗會寫在那一列。
  const gitOk = worktreeOn(advice, true);
  useEffect(() => setBrowsing(false), [machineId]);

  const withSessions = rows.length > 0;
  const locked = busy || created !== null;
  const planError = validatePlan(rows, gitOk);
  const placeError = !withSessions
    ? null
    : !machine
      ? t('flows.new.err.machine')
      : !machine.online
        ? t('flows.new.err.machineOffline', { machine: machine.name })
        : !cwd.trim()
          ? t('flows.new.err.cwd')
          : null;
  const formError = planError ? t(`team.new.err.${planError}`) : placeError;

  const setTeamName = (value: string) => {
    setName(value);
    setRows((list) => renameRows(list, value));
  };
  const pickPreset = (id: PresetId) => {
    setPreset(id);
    setRows(presetRows(id, name));
    setTried(false);
  };
  const updateRow = (key: string, patch: Partial<PlanRow>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const create = () => {
    setTried(true);
    if (formError || submitting.current || created) return;
    submitting.current = true;
    void run(async () => {
      setSteps(Object.fromEntries(rows.map((r) => [r.key, { step: 'waiting' } as RowStep])));
      // 只有建立團隊本身會丟出來（那時什麼都還沒建），清掉進度讓使用者直接再按一次。
      const result = await runPlan(
        backend,
        {
          team: { name: name.trim(), goal: goal.trim(), doneCriteria: '', color, contextMd: '' },
          machineId,
          cwd: cwd.trim(),
          projectId: projectId || null,
          gitOk,
          rows,
        },
        (key, step) => setSteps((all) => ({ ...all, [key]: step })),
      ).catch((e: unknown) => {
        setSteps({});
        submitting.current = false;
        throw e;
      });
      // 團隊已經建好：先鎖住表單，之後重新讀取失敗也不能再按一次（會多建一組）。
      setCreated({ teamId: result.team.id, failed: result.failed, refreshFailed: false });
      // 清單沒讀到就跳過去，工作台會顯示「找不到這個團隊」；改成留在這裡給連結。
      const refreshed = await refreshTeams(backend).then(
        () => true,
        () => false,
      );
      if (!refreshed) setCreated((c) => c && { ...c, refreshFailed: true });
      if (refreshed && result.failed === 0 && mounted.current) {
        location.hash = `#/team/${encodeURIComponent(result.team.id)}`;
      }
    });
  };

  const where = (row: PlanRow) =>
    rowUsesWorktree(row, gitOk)
      ? t('team.new.where.worktree')
      : isReadOnlyRole(row.role)
        ? t('team.new.where.shared')
        : t('team.new.where.main');

  return (
    <form
      className="panel new-team"
      data-testid="new-team"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <fieldset className="new-team-basics" disabled={locked}>
        <label>
          {t('team.new.name')}
          <input value={name} onChange={(e) => setTeamName(e.target.value)} maxLength={80} />
        </label>
        <ColorPicker value={color} onChange={setColor} />
      </fieldset>
      <fieldset className="new-team-more" disabled={locked}>
        <label>
          {t('team.new.goal')}
          <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>

        <div className="seg" role="group" aria-label={t('team.new.preset')}>
          {PRESET_IDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={preset === id}
              title={t(`team.new.presetHint.${id}`)}
              onClick={() => pickPreset(id)}
            >
              {t(`team.new.preset.${id}`)}
            </button>
          ))}
        </div>
        <p className="sub" data-testid="preset-hint">
          {t(`team.new.presetHint.${preset}`)}
        </p>

        {withSessions && (
          <>
            <div className="new-team-place">
              <label>
                {t('flows.new.machine')}
                <select value={machineId} onChange={(e) => setChosenMachine(e.target.value)}>
                  {!machine && <option value="">{t('flows.new.machineNone')}</option>}
                  {machines.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.online}>
                      {m.online ? m.name : `⊘ ${m.name} · ${t('status.offline')}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flows new-team-project">
                <label htmlFor="nt-project">{t('flows.new.project')}</label>
                <ProjectSelect
                  id="nt-project"
                  projects={projects}
                  value={projectId}
                  onChange={setProjectId}
                />
              </div>
            </div>
            <div className="new-team-folder">
              <label>
                {t('flows.new.cwd')}
                <span className="input-line">
                  <input
                    className="mono"
                    value={cwd}
                    onChange={(e) => setCwd(e.target.value)}
                    aria-invalid={tried && !cwd.trim()}
                  />
                  <button
                    type="button"
                    disabled={!machine?.online}
                    aria-expanded={browsing}
                    onClick={() => setBrowsing((open) => !open)}
                  >
                    {t('flows.new.browse')}
                  </button>
                </span>
              </label>
              {browsing && machine && (
                <div className="flows">
                  <FolderBrowser
                    machine={machine}
                    start={cwd.trim()}
                    onSelect={setCwd}
                    onPick={(path) => {
                      setCwd(path);
                      setBrowsing(false);
                    }}
                    onClose={() => setBrowsing(false)}
                  />
                </div>
              )}
              {advice.notGit ? (
                <div className="alert you-alert" data-testid="team-not-git">
                  <span aria-hidden="true">◆</span>
                  <div>{t('team.new.notGit')}</div>
                </div>
              ) : (
                <p className="sub">{t('team.new.folderHint')}</p>
              )}
              {rows.some((r) => isReadOnlyRole(r.role)) && (
                <p className="sub" data-testid="read-only-hint">
                  {t('team.new.readOnlyHint')}
                </p>
              )}
            </div>

            <ol className="plan-rows">
              {rows.map((row, i) => {
                const n = i + 1;
                const step = steps[row.key];
                return (
                  <li key={row.key} className="plan-row" data-testid={`plan-row-${n}`}>
                    <select
                      aria-label={t('team.new.rowRole', { n })}
                      value={row.role}
                      onChange={(e) =>
                        setRows((list) => changeRole(list, row.key, e.target.value as Role, name))
                      }
                    >
                      {TeamRole.options.map((r) => (
                        <option key={r} value={r}>
                          {t('team.role.withAbbr', {
                            role: t(`team.role.${r}`),
                            abbr: ROLE_ABBR[r],
                          })}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={t('team.new.rowName', { n })}
                      value={row.name}
                      maxLength={80}
                      onChange={(e) =>
                        updateRow(row.key, { name: e.target.value, nameEdited: true })
                      }
                    />
                    <select
                      aria-label={t('team.new.rowMode', { n })}
                      value={row.mode}
                      onChange={(e) =>
                        updateRow(row.key, { mode: e.target.value as PermissionMode })
                      }
                    >
                      {modesFor(row.role).map((mode) => (
                        <option key={mode} value={mode}>
                          {mode === 'bypassPermissions' ? t('flows.mode.bypassName') : mode}
                        </option>
                      ))}
                    </select>
                    <span className="sub where">{where(row)}</span>
                    <button
                      type="button"
                      aria-label={t('team.new.rowRemove', { n })}
                      onClick={() =>
                        setRows((list) =>
                          renameRows(
                            list.filter((r) => r.key !== row.key),
                            name,
                          ),
                        )
                      }
                    >
                      ×
                    </button>
                    {step && (
                      <span
                        className={`step${isFailed(step) ? ' err' : ''}`}
                        role={isFailed(step) ? 'alert' : 'status'}
                        data-testid={`plan-step-${n}`}
                      >
                        {stepText(t, step)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="row">
              <button type="button" onClick={() => setRows((list) => addRow(list, 'worker', name))}>
                {t('team.new.addRow')}
              </button>
            </div>
            {rows.some((r) => r.mode === 'bypassPermissions') && (
              <div className="alert" role="alert" data-testid="bypass-alert">
                <span aria-hidden="true">⛔</span>
                <div>{t('flows.new.bypassWarn')}</div>
              </div>
            )}
            {rows.some((r) => r.mode === 'dontAsk') && (
              <div className="alert you-alert" role="alert" data-testid="dontask-alert">
                <span aria-hidden="true">◆</span>
                <div>{t('team.new.dontAskWarn')}</div>
              </div>
            )}
          </>
        )}
      </fieldset>

      <div className="row">
        {created ? (
          <a className="open-team" href={`#/team/${encodeURIComponent(created.teamId)}`}>
            {t('team.new.open')}
          </a>
        ) : (
          <button
            className="primary"
            disabled={busy || name.trim() === '' || (withSessions && !connected)}
          >
            {withSessions ? t('team.new.createWith', { n: rows.length }) : t('team.new.create')}
          </button>
        )}
        {tried && formError && !created && (
          <span className="msg err" role="alert" data-testid="new-team-error">
            {formError}
          </span>
        )}
        <ActionMessage message={message} />
      </div>
      {created && (created.failed > 0 || created.refreshFailed) && (
        <div className="alert you-alert" role="alert" data-testid="new-team-partial">
          <span aria-hidden="true">◆</span>
          <div>
            {created.failed > 0 && <p>{t('team.new.partial', { failed: created.failed })}</p>}
            {created.refreshFailed && <p>{t('team.new.refreshFailed')}</p>}
          </div>
        </div>
      )}
    </form>
  );
}
