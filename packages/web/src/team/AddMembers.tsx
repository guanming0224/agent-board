// 補成員（GM 2026-11-06）：對已經存在的團隊，用和新建團隊同一套列一次開好 session 並加入。
// 換階段要補的人也走這裡（帶入缺的分工），不另做一份。
import { useMemo, useRef, useState } from 'react';
import type { ResearchPhase, Session, Team, TeamMember } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { ActionMessage, useAction } from './common';
import { PlaceFields, PlanRowsEditor, usePlanPlace, type PlanPlace } from './PlanEditor';
import { existingTeam } from './research';
import { runPlan, type RowStep } from './runPlan';
import { refreshTeams } from './store';
import {
  kindRows,
  PHASE_IDS,
  PHASE_PRESETS,
  PRESET_IDS,
  PRESETS,
  validatePlan,
  type PlanRow,
  type RowKind,
  type TeamType,
} from './teamPlan';

/** 沿用隊長的位置（沒有隊長就第一位成員）：機器、主資料夾、專案。隊長在 worktree 也取主資料夾 cwd。 */
export function defaultPlace(
  members: readonly { member: Pick<TeamMember, 'role'>; session: Session }[],
): PlanPlace | undefined {
  const live = members.filter(({ session }) => !session.archived);
  const anchor = live.find(({ member }) => member.role === 'lead') ?? live[0];
  if (!anchor) return undefined;
  const { session } = anchor;
  return { machineId: session.machineId, cwd: session.cwd, projectId: session.projectId ?? '' };
}

export function AddMembers({
  team,
  members,
  initialKinds,
  title,
  onClose,
}: {
  team: Team;
  members: readonly { member: TeamMember; session: Session }[];
  /** 換階段時帶入缺的分工；補成員不帶（從空的開始，可選組合）。 */
  initialKinds?: readonly RowKind[];
  title: string;
  onClose?: () => void;
}) {
  const t = useT();
  const { backend, sessions, connected } = useBoard();
  const teamType: TeamType = team.phase ? 'research' : 'dev';
  const initialPlace = useMemo(() => defaultPlace(members), [members]);
  const place = usePlanPlace(initialPlace, team.sharedWriters === true);
  const fixed = initialPlace !== undefined;
  const existing = existingTeam(members, { machineId: place.machineId, cwd: place.cwd }, sessions);
  const ctx = { taken: existing.names, hasLead: existing.leads > 0 };
  const [rows, setRows] = useState<PlanRow[]>(() =>
    initialKinds ? kindRows(initialKinds, team.name, ctx) : [],
  );
  const [steps, setSteps] = useState<Record<string, RowStep>>({});
  const [tried, setTried] = useState(false);
  const [result, setResult] = useState<{ failed: number } | null>(null);
  const { busy, message, run } = useAction();
  const submitting = useRef(false);

  const planError = validatePlan(rows, place.gitOk, existing, place.shared);
  const formError = planError ? t(`team.new.err.${planError}`) : place.error;

  const presets: { id: string; kinds: readonly RowKind[]; label: string }[] =
    teamType === 'research'
      ? PHASE_IDS.map((id: ResearchPhase) => ({
          id,
          kinds: PHASE_PRESETS[id],
          label: t(`team.phase.${id}`),
        }))
      : PRESET_IDS.filter((id) => id !== 'none').map((id) => ({
          id,
          kinds: PRESETS[id],
          label: t(`team.new.preset.${id}`),
        }));

  const create = () => {
    setTried(true);
    if (rows.length === 0 || formError || submitting.current) return;
    submitting.current = true;
    void run(async () => {
      setSteps(Object.fromEntries(rows.map((r) => [r.key, { step: 'waiting' } as RowStep])));
      // 補成員時才勾共用資料夾（§24）：先存到團隊上，hub 加成員時才不會擋同資料夾。
      if (place.shared && !team.sharedWriters) {
        await backend.updateTeam(team.id, { sharedWriters: true }).catch((e: unknown) => {
          submitting.current = false;
          setSteps({});
          throw e;
        });
      }
      // 團隊已經存在，runPlan 不會丟例外：每一列的失敗都記在進度裡。
      const done = await runPlan(
        backend,
        {
          team: { existing: team },
          machineId: place.machineId,
          cwd: place.cwd.trim(),
          projectId: place.projectId || null,
          gitOk: place.gitOk,
          rows,
        },
        (key, step) => setSteps((all) => ({ ...all, [key]: step })),
      );
      // 建過之後鎖住這一批（再按會多開一組）；要再補按「再補一批」清掉。
      setResult({ failed: done.failed });
      await refreshTeams(backend);
      return done.failed === 0 ? t('team.add.done', { n: done.sessionIds.size }) : null;
    });
  };

  return (
    <section className="panel add-members new-team" data-testid="add-members">
      <h3>{title}</h3>
      <fieldset className="add-members-plan" disabled={busy || result !== null}>
        <div className="seg" role="group" aria-label={t('team.new.preset')}>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy}
              onClick={() => {
                setRows(kindRows(p.kinds, team.name, ctx));
                setSteps({});
                setResult(null);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {existing.leads > 0 && <p className="sub">{t('team.add.hasLead')}</p>}
        <PlaceFields place={place} rows={rows} fixed={fixed} tried={tried} allowShared />
        <PlanRowsEditor
          rows={rows}
          setRows={setRows}
          teamName={team.name}
          teamType={teamType}
          taken={existing.names}
          gitOk={place.gitOk}
          shared={place.shared}
          steps={steps}
        />
      </fieldset>
      <div className="row">
        {result ? (
          <button
            type="button"
            onClick={() => {
              setRows([]);
              setSteps({});
              setResult(null);
              setTried(false);
              submitting.current = false;
            }}
          >
            {t('team.add.again')}
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || rows.length === 0 || !connected}
            onClick={create}
          >
            {t('team.add.create', { n: rows.length })}
          </button>
        )}
        {onClose && (
          <button type="button" disabled={busy} onClick={onClose}>
            {t('team.add.close')}
          </button>
        )}
        {tried && formError && (
          <span className="msg err" role="alert" data-testid="add-members-error">
            {formError}
          </span>
        )}
        <ActionMessage message={message} testId="add-members-msg" />
      </div>
      {result && result.failed > 0 && (
        <div className="alert you-alert" role="alert" data-testid="add-members-partial">
          <span aria-hidden="true">◆</span>
          <div>{t('team.add.partial', { failed: result.failed })}</div>
        </div>
      )}
    </section>
  );
}
