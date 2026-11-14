// 新建團隊：名稱、顏色、目標，選一個成員組合就一起開各角色的 session（GM 2026-11-06）。
// 「只建團隊」保留原本的行為。團隊類型：程式開發（原本的組合）／學術研究（依研究階段組隊）。
import { useEffect, useRef, useState } from 'react';
import type { ResearchPhase, TeamPresetConfigInput } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { clearDraft, NEW_TEAM_DRAFT, useDraftState } from '../shared/draftStore';
import { useBoard } from '../shared/store';
import { currentZoneId } from '../zones';
import { errorText } from '../views';
import { ActionMessage, ColorPicker, useAction } from './common';
import { createRules, ROUND_OPTIONS, TWO_WAY_DEFAULT_ROUNDS } from './handoffRules';
import { PlaceFields, PlanRowsEditor, usePlanPlace } from './PlanEditor';
import { planRowsToPreset, rulesToPreset } from './presetPlan';
import { SavePresetDialog } from './PresetSave';
import { planHasPair, researchPairRules } from './research';
import { runPlan, type RowStep } from './runPlan';
import { refreshTeams, TEAM_COLORS } from './store';
import {
  PHASE_IDS,
  phaseRows,
  PRESET_IDS,
  presetRows,
  renameRows,
  validatePlan,
  type PlanRow,
  type PresetId,
  type TeamType,
} from './teamPlan';

/** 建立後預設雙向交接的結果：少了實驗／寫作所以沒建、建好、部分失敗。沒勾就沒有結果。 */
const D = NEW_TEAM_DRAFT;

type PairResult =
  | { state: 'missing' }
  | { state: 'done'; n: number }
  | { state: 'failed'; created: number; detail: string };

export function NewTeamForm() {
  const t = useT();
  const { backend, connected } = useBoard();
  // 表單欄位放草稿（STYLE §5.2）：換掉右側面板、跨 640px 換畫法再回來，填到一半的內容還在；
  // 團隊建好（成功或部分成功）才清。
  const [name, setName] = useDraftState(D, 'name', '');
  const [color, setColor] = useDraftState<string>(D, 'color', TEAM_COLORS[0]);
  const [goal, setGoal] = useDraftState(D, 'goal', '');
  const [teamType, setTeamType] = useDraftState<TeamType>(D, 'teamType', 'dev');
  const [preset, setPreset] = useDraftState<PresetId>(D, 'preset', 'none');
  const [phase, setPhase] = useDraftState<ResearchPhase>(D, 'phase', 'topic');
  const [rows, setRows] = useDraftState<PlanRow[]>(D, 'rows', []);
  const [pair, setPair] = useDraftState(D, 'pair', true);
  const [pairRounds, setPairRounds] = useDraftState(D, 'pairRounds', TWO_WAY_DEFAULT_ROUNDS);
  const [pairResult, setPairResult] = useState<PairResult | null>(null);
  const [tried, setTried] = useState(false);
  const [steps, setSteps] = useState<Record<string, RowStep>>({});
  const [created, setCreated] = useState<{
    teamId: string;
    failed: number;
    refreshFailed: boolean;
  } | null>(null);
  const { busy, message, run } = useAction();
  /** 「存成 Preset」對話框（P3 §2.3：不建立團隊，只存目前表單）。 */
  const [savingPreset, setSavingPreset] = useState<TeamPresetConfigInput | null>(null);
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

  const place = usePlanPlace(undefined, false, D);
  const { gitOk } = place;
  const research = teamType === 'research';
  const withSessions = rows.length > 0;
  const locked = busy || created !== null;
  const planError = validatePlan(rows, gitOk, undefined, place.shared);
  const placeError = withSessions ? place.error : null;
  const formError = planError ? t(`team.new.err.${planError}`) : placeError;
  const offerPair = research && planHasPair(rows);

  const setTeamName = (value: string) => {
    setName(value);
    setRows((list) => renameRows(list, value));
  };
  const pickPreset = (id: PresetId) => {
    setPreset(id);
    setRows(presetRows(id, name));
    setTried(false);
  };
  const pickPhase = (id: ResearchPhase) => {
    setPhase(id);
    setRows(phaseRows(id, name));
    setTried(false);
  };
  const pickType = (type: TeamType) => {
    setTeamType(type);
    if (type === 'research') pickPhase(phase);
    else pickPreset(preset);
  };

  /** 目前表單 → Preset 內容。研究團隊勾了雙向交接：規則照列序號存（套用時建，和這裡一樣先關著）。 */
  const presetConfig = (): TeamPresetConfigInput => {
    const keys = new Map(rows.map((r) => [r.key, r.key]));
    const pairRules = offerPair && pair ? researchPairRules(rows, keys, pairRounds) : null;
    return {
      teamType,
      phase: research ? phase : null,
      color,
      goal: goal.trim(),
      doneCriteria: '',
      contextMd: research ? t('team.research.contextTemplate') : '',
      placement: {
        machineId: place.machineId,
        cwd: place.cwd.trim(),
        projectId: place.projectId || null,
      },
      rows: planRowsToPreset(rows, name),
      handoffRules: pairRules
        ? rulesToPreset(
            pairRules,
            rows.map((r) => r.key),
          ).rules
        : [],
      taskAuto: false,
    };
  };

  const create = () => {
    setTried(true);
    if (formError || submitting.current || created) return;
    submitting.current = true;
    void run(async () => {
      setSteps(Object.fromEntries(rows.map((r) => [r.key, { step: 'waiting' } as RowStep])));
      setPairResult(null);
      // 只有建立團隊本身會丟出來（那時什麼都還沒建），清掉進度讓使用者直接再按一次。
      const result = await runPlan(
        backend,
        {
          team: {
            name: name.trim(),
            goal: goal.trim(),
            doneCriteria: '',
            color,
            // 研究團隊先放 TEAM.md 範本（資料夾分工、數字只能引用 results/、要補實驗怎麼寫）。
            // TEAM.md 不會自動送進任何 session，只有使用者按「請隊長拆解」時才帶上。
            contextMd: research ? t('team.research.contextTemplate') : '',
            ...(research ? { phase } : {}),
            // 新團隊放在目前工作區。
            zoneId: currentZoneId(),
            // 不是 git、使用者勾了共用資料夾（§24）：存在團隊上，之後隊長開 BD 也照樣共用。
            ...(place.shared ? { sharedWriters: true } : {}),
          },
          machineId: place.machineId,
          cwd: place.cwd.trim(),
          projectId: place.projectId || null,
          gitOk,
          rows,
        },
        (key, step) => setSteps((all) => ({ ...all, [key]: step })),
      ).catch((e: unknown) => {
        setSteps({});
        submitting.current = false;
        throw e;
      });
      let pairFailed = false;
      if (offerPair && pair) {
        // 實驗 ⇄ 寫作的雙向交接；和列一樣，失敗就寫出來、已建的保留。
        const inputs = researchPairRules(rows, result.sessionIds, pairRounds);
        if (!inputs) {
          setPairResult({ state: 'missing' });
          pairFailed = true;
        } else {
          const rules = await createRules(backend, result.team.id, inputs);
          pairFailed = rules.failed.length > 0;
          setPairResult(
            pairFailed
              ? {
                  state: 'failed',
                  created: rules.created.length,
                  detail: errorText(rules.failed[0]!.error),
                }
              : { state: 'done', n: pairRounds },
          );
        }
      }
      // 團隊已經建好：先鎖住表單，之後重新讀取失敗也不能再按一次（會多建一組）。
      const { failed } = result;
      setCreated({ teamId: result.team.id, failed, refreshFailed: false });
      clearDraft(D);
      // 清單沒讀到就跳過去，工作台會顯示「找不到這個團隊」；改成留在這裡給連結。
      const refreshed = await refreshTeams(backend).then(
        () => true,
        () => false,
      );
      if (!refreshed) setCreated((c) => c && { ...c, refreshFailed: true });
      // 規則沒建好也留在這裡：要讓使用者看到哪裡沒完成。
      if (refreshed && failed === 0 && !pairFailed && mounted.current) {
        location.hash = `#/team/${encodeURIComponent(result.team.id)}`;
      }
    });
  };

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

        <div className="seg" role="group" aria-label={t('team.new.type')}>
          {(['dev', 'research'] as const).map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={teamType === type}
              onClick={() => pickType(type)}
            >
              {t(`team.new.type.${type}`)}
            </button>
          ))}
        </div>

        {research ? (
          <>
            <div className="seg" role="group" aria-label={t('team.new.phase')}>
              {PHASE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={phase === id}
                  title={t(`team.phase.hint.${id}`)}
                  onClick={() => pickPhase(id)}
                >
                  {t(`team.phase.${id}`)}
                </button>
              ))}
            </div>
            <p className="sub" data-testid="preset-hint">
              {t(`team.phase.hint.${phase}`)}
            </p>
            <p className="sub" data-testid="research-context-hint">
              {t('team.new.researchContext')}
            </p>
          </>
        ) : (
          <>
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
          </>
        )}

        {withSessions && (
          <>
            <PlaceFields place={place} rows={rows} tried={tried} allowShared />
            <PlanRowsEditor
              rows={rows}
              setRows={setRows}
              teamName={name}
              teamType={teamType}
              gitOk={gitOk}
              shared={place.shared}
              steps={steps}
            />
            {offerPair && (
              <div className="row research-pair" data-testid="research-pair">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={pair}
                    onChange={(e) => setPair(e.target.checked)}
                  />
                  {t('team.new.pair')}
                </label>
                <select
                  aria-label={t('team.rules.rounds')}
                  value={pairRounds}
                  disabled={!pair}
                  onChange={(e) => setPairRounds(Number(e.target.value))}
                >
                  {ROUND_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {t('team.rules.roundsN', { n })}
                    </option>
                  ))}
                </select>
                <p className="sub">{t('team.new.pairHint')}</p>
              </div>
            )}
          </>
        )}
      </fieldset>

      <div className="row">
        {created ? (
          <a
            className="button primary open-team"
            href={`#/team/${encodeURIComponent(created.teamId)}`}
          >
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
        {!created && (
          <button
            type="button"
            disabled={busy || !withSessions || formError !== null}
            title={withSessions ? t('team.preset.saveFormHint') : t('team.preset.noMembers')}
            onClick={() => setSavingPreset(presetConfig())}
            data-testid="new-team-save-preset"
          >
            {t('team.preset.saveAs')}
          </button>
        )}
        {tried && formError && !created && (
          <span className="msg err" role="alert" data-testid="new-team-error">
            {formError}
          </span>
        )}
        <ActionMessage message={message} />
      </div>
      {pairResult && (
        <p
          className={`msg${pairResult.state === 'done' ? '' : ' err'}`}
          role={pairResult.state === 'done' ? 'status' : 'alert'}
          data-testid="research-pair-result"
        >
          {pairResult.state === 'done'
            ? t('team.new.pairDone', { n: pairResult.n })
            : pairResult.state === 'missing'
              ? t('team.new.pairMissing')
              : t('team.new.pairFailed', {
                  created: pairResult.created,
                  detail: pairResult.detail,
                })}
        </p>
      )}
      {savingPreset && (
        <SavePresetDialog
          defaultName={name.trim()}
          config={savingPreset}
          onClose={() => setSavingPreset(null)}
        />
      )}
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
