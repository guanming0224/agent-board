// 「依角色一次開好 session」的共用零件：新建團隊、補成員、換階段都用這一套（GM 2026-11-06）。
// 機器、資料夾、專案的選法和 worktree 判斷沿用 flows/sessionForm。
import { useEffect, useState } from 'react';
import type { PermissionMode } from '@agent-board/protocol';
import { useProjects } from '../flows/common';
import {
  FolderBrowser,
  ProjectSelect,
  suggestMachine,
  useWorktreeAdvice,
  worktreeOn,
} from '../flows/sessionForm';
import { isSessionDeleting } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText } from '../views';
import type { RowStep } from './runPlan';
import {
  addRow,
  ADD_KIND,
  changeKind,
  isReadOnlyRole,
  kindRole,
  KIND_ABBR,
  KINDS_FOR,
  modesFor,
  renameRows,
  rowUsesWorktree,
  type PlanRow,
  type RowKind,
  type TeamType,
} from './teamPlan';

type T = ReturnType<typeof useT>;

export function stepText(t: T, step: RowStep): string {
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

/** 分工的顯示名稱：研究團隊用「實驗（EX）」，程式開發團隊用角色「成員（BD）」。 */
export function kindLabel(t: T, kind: RowKind): string {
  const name = kind === kindRole(kind) ? t(`team.role.${kind}`) : t(`team.kind.${kind}`);
  return t('team.role.withAbbr', { role: name, abbr: KIND_ABBR[kind] });
}

export interface PlanPlace {
  machineId: string;
  cwd: string;
  projectId: string;
}

/** 機器、資料夾、專案的狀態與 worktree 判斷。`initial` 給補成員時沿用隊長的位置。 */
export function usePlanPlace(initial?: PlanPlace) {
  const t = useT();
  const { machines, sessions } = useBoard();
  const [chosenMachine, setChosenMachine] = useState<string | null>(initial?.machineId ?? null);
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const suggestion = suggestMachine(machines, sessions, 'general');
  const machineId = chosenMachine ?? suggestion?.id ?? '';
  const machine = machines.find((m) => m.id === machineId);
  const advice = useWorktreeAdvice(machine, cwd);
  // 同 sessionForm 的 worktreeOn：daemon 確認不是 git 才關；還不知道時照開，失敗會寫在那一列。
  const gitOk = worktreeOn(advice, true);
  const error = !machine
    ? t('flows.new.err.machine')
    : !machine.online
      ? t('flows.new.err.machineOffline', { machine: machine.name })
      : !cwd.trim()
        ? t('flows.new.err.cwd')
        : null;
  return {
    machineId,
    machine,
    machines,
    cwd,
    projectId,
    advice,
    gitOk,
    error,
    setMachine: setChosenMachine,
    setCwd,
    setProjectId,
  };
}
export type PlanPlaceState = ReturnType<typeof usePlanPlace>;

/** 機器、專案、資料夾。`fixed` 時只顯示（補成員沿用現有成員的位置）。 */
export function PlaceFields({
  place,
  rows,
  fixed = false,
  tried,
}: {
  place: PlanPlaceState;
  rows: readonly PlanRow[];
  fixed?: boolean;
  tried: boolean;
}) {
  const t = useT();
  const projects = useProjects();
  const [browsing, setBrowsing] = useState(false);
  const { machine, machineId } = place;
  useEffect(() => setBrowsing(false), [machineId]);

  const hints = (
    <>
      {place.advice.notGit ? (
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
    </>
  );

  if (fixed) {
    return (
      <div className="new-team-folder" data-testid="plan-place-fixed">
        <p className="sub">
          {t('team.add.place', { machine: machine?.name ?? machineId, dir: place.cwd })}
        </p>
        {hints}
      </div>
    );
  }
  return (
    <>
      <div className="new-team-place">
        <label>
          {t('flows.new.machine')}
          <select value={machineId} onChange={(e) => place.setMachine(e.target.value)}>
            {!machine && <option value="">{t('flows.new.machineNone')}</option>}
            {place.machines.map((m) => (
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
            value={place.projectId}
            onChange={place.setProjectId}
          />
        </div>
      </div>
      <div className="new-team-folder">
        <label>
          {t('flows.new.cwd')}
          <span className="input-line">
            <input
              className="mono"
              value={place.cwd}
              onChange={(e) => place.setCwd(e.target.value)}
              aria-invalid={tried && !place.cwd.trim()}
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
              start={place.cwd.trim()}
              onSelect={place.setCwd}
              onPick={(path) => {
                place.setCwd(path);
                setBrowsing(false);
              }}
              onClose={() => setBrowsing(false)}
            />
          </div>
        )}
        {hints}
      </div>
    </>
  );
}

/** 每一列：分工、名稱、權限模式、資料夾、移除，以及建立時的進度。 */
export function PlanRowsEditor({
  rows,
  setRows,
  teamName,
  teamType,
  taken,
  gitOk,
  steps,
}: {
  rows: PlanRow[];
  setRows: (update: (rows: PlanRow[]) => PlanRow[]) => void;
  teamName: string;
  teamType: TeamType;
  /** 已經存在的 session 名稱（補成員時），預設名稱避開它們。 */
  taken?: ReadonlySet<string>;
  gitOk: boolean;
  steps: Record<string, RowStep>;
}) {
  const t = useT();
  const updateRow = (key: string, patch: Partial<PlanRow>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const where = (row: PlanRow) =>
    rowUsesWorktree(row, gitOk)
      ? t('team.new.where.worktree')
      : isReadOnlyRole(row.role)
        ? t('team.new.where.shared')
        : t('team.new.where.main');

  return (
    <>
      <ol className="plan-rows">
        {rows.map((row, i) => {
          const n = i + 1;
          const step = steps[row.key];
          return (
            <li key={row.key} className="plan-row" data-testid={`plan-row-${n}`}>
              <select
                aria-label={t('team.new.rowRole', { n })}
                value={row.kind}
                onChange={(e) =>
                  setRows((list) =>
                    changeKind(list, row.key, e.target.value as RowKind, teamName, taken),
                  )
                }
              >
                {KINDS_FOR[teamType].map((kind) => (
                  <option key={kind} value={kind}>
                    {kindLabel(t, kind)}
                  </option>
                ))}
              </select>
              <input
                aria-label={t('team.new.rowName', { n })}
                value={row.name}
                maxLength={80}
                onChange={(e) => updateRow(row.key, { name: e.target.value, nameEdited: true })}
              />
              <select
                aria-label={t('team.new.rowMode', { n })}
                value={row.mode}
                onChange={(e) => updateRow(row.key, { mode: e.target.value as PermissionMode })}
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
                      teamName,
                      taken,
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
        <button
          type="button"
          onClick={() => setRows((list) => addRow(list, ADD_KIND[teamType], teamName, taken))}
        >
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
  );
}
