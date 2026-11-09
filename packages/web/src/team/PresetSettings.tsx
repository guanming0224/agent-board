// 團隊 Presets 的管理（P3 項目二 §2.3、§2.4）：設定次畫面的「Presets」分類（#/settings/presets）。
// 清單：名稱、角色縮寫串、最後使用時間；每列改名、上移／下移、編輯、複製、刪除（刪了 10 秒內可復原）。
// 編輯用和新增團隊同一套列編輯與檢查，另有交接規則、第一個指令、初始進度卡三個區塊；手機只能改名、刪除（編輯回電腦）。
// 另外放團隊面板的「⋯ → 存成 Preset」。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  HANDOFF_MAX_ROUNDS,
  PROGRESS_FIELD_MAX,
  PROGRESS_GM_NOTES_MAX,
  ResearchPhase,
  TEAM_PRESET_NAME_MAX,
  TEAM_PRESET_PROMPT_MAX,
  TeamPresetConfig,
  type Team,
  type TeamPreset,
  type TeamPresetProgress,
  type TeamPresetRule,
} from '@agent-board/protocol';
import { registerSettingsCategory } from '../flows/settingsExtra';
import type { Trigger as HandoffTrigger } from './handoffRules';
import { Section } from '../flows/settingsParts';
import { Empty } from '../flows/common';
import { errorCode } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, formatSpan, ModeChip, useNow } from '../views';
import { ColorPicker, CostChip } from './common';
import { PlaceFields, PlanRowsEditor, usePlanPlace } from './PlanEditor';
import {
  planRowsToPreset,
  presetAbbr,
  presetCosts,
  presetHasBypass,
  presetToPlanRows,
  teamToPresetConfig,
  uniqueTeamName,
  type TeamRecord,
} from './presetPlan';
import { usePresetList } from './presetStore';
import { SavePresetDialog } from './PresetSave';
import { useTeams } from './store';
import { validatePlan, type PlanRow } from './teamPlan';
import './presetMessages';
import './presets.css';
import { PHONE_QUERY } from '../shared/breakpoints';

type T = ReturnType<typeof useT>;

const UNDO_MS = 10_000;
const TRIGGERS: readonly HandoffTrigger[] = ['on_done', 'on_file', 'on_fail', 'on_marker'];

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

const failText = (t: T, e: unknown, name: string) =>
  errorCode(e) === 'preset_name_taken'
    ? t('team.preset.nameTaken', { name })
    : t('team.failed', { detail: errorText(e) });

// ── 團隊面板「⋯ → 存成 Preset」 ────────────────────────────

/** 團隊面板「⋯」：存成 Preset，加上呼叫端給的其他項目（刪除團隊）。 */
export function SaveTeamPreset({
  team,
  records,
  children,
}: {
  team: Team;
  records: TeamRecord[];
  children?: ReactNode;
}) {
  const t = useT();
  const rules = useTeams((s) => s.rules);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false);
    };
    addEventListener('pointerdown', onDown);
    return () => removeEventListener('pointerdown', onDown);
  }, [menu]);
  const captured = teamToPresetConfig(team, records, rules);
  // 目前的進度卡（P3 項目一，board 快照）：寫過才給「把目前進度卡當初始內容」勾選。
  const card = useBoard((s) => (s.progress ?? []).find((c) => c.teamId === team.id));
  const progress =
    card && card.revision > 0
      ? { status: card.status, next: card.next, blockers: card.blockers, gmNotes: card.gmNotes }
      : null;
  return (
    <div className="team-more" ref={box}>
      <button
        type="button"
        className="icon sm"
        aria-label={t('team.preset.more')}
        aria-expanded={menu}
        onClick={() => setMenu((open) => !open)}
        data-testid="team-more"
      >
        ⋯
      </button>
      {menu && (
        <div className="menu team-more-menu" role="menu">
          <button
            type="button"
            className="menu-item"
            role="menuitem"
            disabled={!captured}
            title={captured ? undefined : t('team.preset.noMembers')}
            onClick={() => {
              setMenu(false);
              setDialog(true);
            }}
            data-testid="team-save-preset"
          >
            {t('team.preset.saveAs')}
          </button>
          {children}
        </div>
      )}
      {dialog && captured && (
        <SavePresetDialog
          defaultName={team.name}
          config={captured.config}
          skippedRules={captured.skippedRules}
          progress={progress}
          onClose={() => setDialog(false)}
        />
      )}
    </div>
  );
}

// ── 設定「Presets」 ────────────────────────────────────

function lastUsedText(t: T, now: number, preset: TeamPreset): string {
  return preset.lastUsedAt
    ? t('team.preset.lastUsed', { span: formatSpan(now - Date.parse(preset.lastUsedAt), t) })
    : t('team.preset.neverUsed');
}

function PresetSettingsRow({
  preset,
  index,
  count,
  phone,
  editing,
  onEdit,
  onDeleted,
}: {
  preset: TeamPreset;
  index: number;
  count: number;
  phone: boolean;
  editing: boolean;
  onEdit: () => void;
  onDeleted: (preset: TeamPreset) => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const now = useNow();
  const { presets } = usePresetList();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(preset.name);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const costs = presetCosts(preset.config);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await action();
      return true;
    } catch (e) {
      setMsg(failText(t, e, name.trim()));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const rename = async () => {
    if (!name.trim() || name.trim() === preset.name) return setRenaming(false);
    if (await act(() => backend.updateTeamPreset(preset.id, { name: name.trim() }))) {
      setRenaming(false);
    }
  };
  const move = (to: number) =>
    void act(() => backend.updateTeamPreset(preset.id, { position: to }));
  const duplicate = () =>
    void act(() =>
      backend.createTeamPreset({
        name: uniqueTeamName(
          t('team.preset.copyName', { name: preset.name }),
          presets.map((p) => p.name),
        ),
        config: preset.config,
        position: index + 1,
      }),
    );
  const remove = () =>
    void act(async () => {
      await backend.deleteTeamPreset(preset.id);
      onDeleted(preset);
    });

  return (
    <li
      className={`preset-admin-row${editing ? ' editing' : ''}`}
      data-testid={`preset-admin-${preset.id}`}
      data-name={preset.name}
    >
      <div className="preset-admin-main">
        {renaming ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input
              className="sm"
              value={name}
              maxLength={TEAM_PRESET_NAME_MAX}
              autoFocus
              aria-label={t('team.preset.name')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setName(preset.name);
                  setRenaming(false);
                }
              }}
              data-testid="preset-rename-input"
            />
            <button className="primary sm" disabled={busy} data-testid="preset-rename-save">
              {t('team.save')}
            </button>
          </form>
        ) : (
          <b className="preset-admin-name">{preset.name}</b>
        )}
        <span className="mono sub">{presetAbbr(preset.config)}</span>
        <span className="sub">{lastUsedText(t, now, preset)}</span>
        {costs.any && <CostChip />}
        {presetHasBypass(preset.config) && (
          <span className="chip mode bypass">{t('views.mode.bypass')}</span>
        )}
      </div>
      {/* 列內動作一律精簡 32（手機 44）：編輯在最前面，刪除在最後、和其他動作隔開（報告 C5）。 */}
      <div className="row preset-admin-acts">
        {phone ? (
          <span className="sub" data-testid="preset-edit-desktop">
            {t('team.preset.editDesktop')}
          </span>
        ) : (
          <button
            type="button"
            className="sm"
            aria-pressed={editing}
            disabled={busy}
            onClick={onEdit}
            data-testid="preset-edit"
          >
            {t('team.preset.edit')}
          </button>
        )}
        {!renaming && (
          <button
            type="button"
            className="sm"
            disabled={busy}
            onClick={() => {
              setName(preset.name);
              setRenaming(true);
            }}
            data-testid="preset-rename"
          >
            {t('team.preset.rename')}
          </button>
        )}
        <button
          type="button"
          className="sm"
          disabled={busy}
          onClick={duplicate}
          data-testid="preset-duplicate"
        >
          {t('team.preset.duplicate')}
        </button>
        <button
          type="button"
          className="icon sm"
          disabled={busy || index === 0}
          aria-label={t('team.preset.up', { name: preset.name })}
          onClick={() => move(index - 1)}
          data-testid="preset-up"
        >
          ↑
        </button>
        <button
          type="button"
          className="icon sm"
          disabled={busy || index === count - 1}
          aria-label={t('team.preset.down', { name: preset.name })}
          onClick={() => move(index + 1)}
          data-testid="preset-down"
        >
          ↓
        </button>
        <button
          type="button"
          className="danger sm preset-admin-delete"
          disabled={busy}
          onClick={remove}
          data-testid="preset-delete"
        >
          {t('team.preset.delete')}
        </button>
        {msg && (
          <span className="msg err" role="alert" data-testid="preset-admin-error">
            {msg}
          </span>
        )}
      </div>
    </li>
  );
}

export function PresetsSettings() {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const phone = usePhone();
  const { presets, status, error, retry } = usePresetList();
  const [editing, setEditing] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<TeamPreset | null>(null);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [deleted]);
  const editingPreset = presets.find((p) => p.id === editing);
  const undo = async () => {
    if (!deleted) return;
    const { name, config, position } = deleted;
    setDeleted(null);
    try {
      await backend.createTeamPreset({ name, config, position });
      setUndoMsg(null);
    } catch (e) {
      setUndoMsg(failText(t, e, name));
    }
  };
  return (
    <Section id="presets" title={t('team.preset.settingsTitle')}>
      <p className="sub">{t('team.preset.settingsHint')}</p>
      {deleted && (
        <div className="preset-undo" role="status" data-testid="preset-undo">
          <span>{t('team.preset.deleted', { name: deleted.name })}</span>
          <button
            type="button"
            className="sm"
            onClick={() => void undo()}
            data-testid="preset-undo-button"
          >
            {t('team.preset.undo')}
          </button>
        </div>
      )}
      {undoMsg && (
        <p className="msg err" role="alert">
          {undoMsg}
        </p>
      )}
      {status === 'loading' ? (
        <p className="sub">{t('team.preset.loading')}</p>
      ) : status === 'error' ? (
        <div className="alert" role="alert">
          <span aria-hidden="true">✕</span>
          <div>
            {t('team.preset.loadFailed', { detail: error ?? '' })}{' '}
            <button type="button" onClick={retry}>
              {t('team.preset.retry')}
            </button>
          </div>
        </div>
      ) : presets.length === 0 ? (
        <Empty
          title={t('team.preset.emptyTitle')}
          next={t('team.preset.empty')}
          testId="preset-admin-empty"
        />
      ) : (
        <ol className="preset-admin" data-testid="preset-admin">
          {presets.map((preset, i) => (
            <PresetSettingsRow
              key={preset.id}
              preset={preset}
              index={i}
              count={presets.length}
              phone={phone}
              editing={editing === preset.id}
              onEdit={() => setEditing((id) => (id === preset.id ? null : preset.id))}
              onDeleted={(p) => {
                if (editing === p.id) setEditing(null);
                setUndoMsg(null);
                setDeleted(p);
              }}
            />
          ))}
        </ol>
      )}
      {editingPreset && !phone && (
        <PresetEditor
          key={editingPreset.id}
          preset={editingPreset}
          onDone={() => setEditing(null)}
        />
      )}
    </Section>
  );
}

registerSettingsCategory('presets', PresetsSettings);

// ── 編輯 Preset ─────────────────────────────────────────

/** 編輯中的規則用列的 key 表示：列刪掉、換順序都不會指錯人（§2.8）。 */
interface DraftRule {
  id: number;
  from: string;
  to: string;
  trigger: HandoffTrigger;
  filePattern: string;
  marker: string;
  maxRounds: number | null;
  enabled: boolean;
}

let nextRuleId = 0;

function toDraftRules(rules: readonly TeamPresetRule[], rows: readonly PlanRow[]): DraftRule[] {
  return rules.flatMap((r) => {
    const from = rows[r.fromRow]?.key;
    const to = rows[r.toRow]?.key;
    if (!from || !to) return [];
    return [
      {
        id: (nextRuleId += 1),
        from,
        to,
        trigger: r.trigger,
        filePattern: r.filePattern ?? '',
        marker: r.marker ?? '',
        maxRounds: r.maxRounds ?? null,
        enabled: r.enabled,
      },
    ];
  });
}

function fromDraftRules(rules: readonly DraftRule[], rows: readonly PlanRow[]): TeamPresetRule[] {
  const index = (key: string) => rows.findIndex((r) => r.key === key);
  return rules
    .filter((r) => index(r.from) >= 0 && index(r.to) >= 0)
    .map((r) => ({
      fromRow: index(r.from),
      toRow: index(r.to),
      trigger: r.trigger,
      ...(r.trigger === 'on_file' && r.filePattern.trim()
        ? { filePattern: r.filePattern.trim() }
        : {}),
      ...(r.trigger === 'on_marker' && r.marker.trim() ? { marker: r.marker.trim() } : {}),
      ...(r.maxRounds !== null ? { maxRounds: r.maxRounds } : {}),
      enabled: r.enabled,
    }));
}

function RulesEditor({
  rules,
  setRules,
  rows,
  dropped,
}: {
  rules: DraftRule[];
  setRules: (update: (rules: DraftRule[]) => DraftRule[]) => void;
  rows: readonly PlanRow[];
  dropped: number;
}) {
  const t = useT();
  const patch = (id: number, change: Partial<DraftRule>) =>
    setRules((list) => list.map((r) => (r.id === id ? { ...r, ...change } : r)));
  return (
    <fieldset className="preset-rules" data-testid="preset-rules-editor">
      <legend>{t('team.preset.rulesTitle')}</legend>
      {dropped > 0 && (
        <p className="sub" role="status" data-testid="preset-rules-dropped">
          {t('team.preset.rulesDropped', { n: dropped })}
        </p>
      )}
      {rules.map((rule, i) => (
        <div key={rule.id} className="row preset-rule" data-testid={`preset-rule-${i + 1}`}>
          <select
            aria-label={t('team.preset.ruleFrom', { n: i + 1 })}
            value={rule.from}
            onChange={(e) => patch(rule.id, { from: e.target.value })}
          >
            {rows.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
          <span aria-hidden="true">→</span>
          <select
            aria-label={t('team.preset.ruleTo', { n: i + 1 })}
            value={rule.to}
            onChange={(e) => patch(rule.id, { to: e.target.value })}
          >
            {rows.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t('team.preset.ruleTrigger', { n: i + 1 })}
            value={rule.trigger}
            onChange={(e) => patch(rule.id, { trigger: e.target.value as HandoffTrigger })}
          >
            {TRIGGERS.map((trigger) => (
              <option key={trigger} value={trigger}>
                {t(`team.preset.trigger.${trigger}`)}
              </option>
            ))}
          </select>
          {rule.trigger === 'on_file' && (
            <input
              className="mono"
              placeholder="*.md"
              aria-label={t('team.preset.ruleFile', { n: i + 1 })}
              value={rule.filePattern}
              onChange={(e) => patch(rule.id, { filePattern: e.target.value })}
            />
          )}
          {rule.trigger === 'on_marker' && (
            <input
              aria-label={t('team.preset.ruleMarker', { n: i + 1 })}
              value={rule.marker}
              maxLength={40}
              onChange={(e) => patch(rule.id, { marker: e.target.value })}
            />
          )}
          <select
            aria-label={t('team.preset.ruleRounds', { n: i + 1 })}
            value={rule.maxRounds ?? ''}
            onChange={(e) =>
              patch(rule.id, { maxRounds: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">{t('team.preset.oneWay')}</option>
            {Array.from({ length: HANDOFF_MAX_ROUNDS }, (_, k) => k + 1).map((n) => (
              <option key={n} value={n}>
                {t('team.rules.roundsN', { n })}
              </option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => patch(rule.id, { enabled: e.target.checked })}
            />
            {t('team.preset.ruleOn')}
          </label>
          {rule.enabled && <CostChip />}
          <button
            type="button"
            className="sm"
            aria-label={t('team.preset.ruleRemove', { n: i + 1 })}
            onClick={() => setRules((list) => list.filter((r) => r.id !== rule.id))}
          >
            {t('team.plan.remove')}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="sm"
        disabled={rows.length < 2}
        onClick={() =>
          setRules((list) => [
            ...list,
            {
              id: (nextRuleId += 1),
              from: rows[1]?.key ?? '',
              to: rows[0]?.key ?? '',
              trigger: 'on_done',
              filePattern: '',
              marker: '',
              maxRounds: null,
              // 新規則先關著：開啟才會花額度，要使用者自己勾。
              enabled: false,
            },
          ])
        }
        data-testid="preset-rule-add"
      >
        {t('team.preset.ruleAdd')}
      </button>
    </fieldset>
  );
}

const PROGRESS_FIELDS = ['status', 'next', 'blockers', 'gmNotes'] as const;

/** 編輯 Preset（§2.3）：同一套列編輯與檢查；存檔只改 Preset，不影響已建的團隊。 */
function PresetEditor({ preset, onDone }: { preset: TeamPreset; onDone: () => void }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const { config } = preset;
  const teamName = preset.name;
  const [rows, setRowsState] = useState<PlanRow[]>(() => presetToPlanRows(config.rows, teamName));
  const [rules, setRules] = useState<DraftRule[]>(() => toDraftRules(config.handoffRules, rows));
  const [dropped, setDropped] = useState(0);
  const [color, setColor] = useState(config.color);
  const [phase, setPhase] = useState(config.phase);
  const [goal, setGoal] = useState(config.goal);
  const [doneCriteria, setDoneCriteria] = useState(config.doneCriteria);
  const [contextMd, setContextMd] = useState(config.contextMd);
  const [taskAuto, setTaskAuto] = useState(config.taskAuto);
  const [prompt, setPrompt] = useState(config.leadFirstPrompt ?? '');
  const [attach, setAttach] = useState(config.attachProgressCard);
  const [progress, setProgress] = useState<TeamPresetProgress>(config.initialProgress);
  const place = usePlanPlace({
    machineId: config.placement.machineId,
    cwd: config.placement.cwd,
    projectId: config.placement.projectId ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);

  // 列被刪掉：連到那一列的規則跟著刪，並說出刪了幾條。
  // （每次操作只改一次列，用這次 render 的 rows 算就好；不在 setState 的 updater 裡改別的 state。）
  const setRows = (update: (rows: PlanRow[]) => PlanRow[]) => {
    const next = update(rows);
    const keys = new Set(next.map((r) => r.key));
    const kept = rules.filter((r) => keys.has(r.from) && keys.has(r.to));
    setRowsState(next);
    if (kept.length !== rules.length) {
      setRules(() => kept);
      setDropped((n) => n + rules.length - kept.length);
    }
  };

  const draft = {
    teamType: config.teamType,
    phase: config.teamType === 'research' ? phase : null,
    color,
    goal,
    doneCriteria,
    contextMd,
    placement: {
      machineId: place.machineId,
      cwd: place.cwd.trim(),
      projectId: place.projectId || null,
    },
    rows: planRowsToPreset(rows, teamName),
    handoffRules: fromDraftRules(rules, rows),
    taskAuto,
    leadFirstPrompt: prompt.trim() || null,
    attachProgressCard: attach,
    initialProgress: progress,
  };
  const parsed = TeamPresetConfig.safeParse(draft);
  const planError = validatePlan(rows, place.gitOk);
  const problem = planError
    ? t(`team.new.err.${planError}`)
    : !place.machine
      ? t('flows.new.err.machine')
      : !place.cwd.trim()
        ? t('flows.new.err.cwd')
        : !parsed.success
          ? t('team.preset.invalid', { detail: parsed.error.issues[0]?.message ?? '' })
          : null;

  const save = async () => {
    if (problem || !parsed.success || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await backend.updateTeamPreset(preset.id, { config: parsed.data });
      setMsg({ text: t('team.saved'), err: false });
    } catch (e) {
      setMsg({ text: failText(t, e, preset.name), err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="preset-editor team-page"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="preset-editor"
    >
      <h3>{t('team.preset.editing', { name: preset.name })}</h3>
      <p className="sub">{t('team.preset.editHint')}</p>
      <ColorPicker value={color} onChange={setColor} />
      {config.teamType === 'research' && (
        <label>
          {t('team.new.phase')}
          <select
            value={phase ?? 'topic'}
            onChange={(e) => setPhase(e.target.value as ResearchPhase)}
          >
            {ResearchPhase.options.map((id) => (
              <option key={id} value={id}>
                {t(`team.phase.${id}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      <PlaceFields place={place} rows={rows} tried />
      <PlanRowsEditor
        rows={rows}
        setRows={setRows}
        teamName={teamName}
        teamType={config.teamType}
        gitOk={place.gitOk}
        steps={{}}
      />
      <RulesEditor rules={rules} setRules={setRules} rows={rows} dropped={dropped} />
      <label className="check">
        <input
          type="checkbox"
          checked={taskAuto}
          onChange={(e) => setTaskAuto(e.target.checked)}
          data-testid="preset-task-auto"
        />
        {t('team.preset.taskAuto')}
      </label>
      {taskAuto && <CostChip />}
      <label>
        {t('team.goal.goal')}
        <textarea rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label>
        {t('team.goal.criteria')}
        <textarea rows={2} value={doneCriteria} onChange={(e) => setDoneCriteria(e.target.value)} />
      </label>
      <label>
        TEAM.md
        <textarea rows={4} value={contextMd} onChange={(e) => setContextMd(e.target.value)} />
      </label>
      <fieldset className="preset-first-edit">
        <legend>{t('team.preset.firstPromptLabel')}</legend>
        <textarea
          rows={3}
          value={prompt}
          maxLength={TEAM_PRESET_PROMPT_MAX}
          aria-label={t('team.preset.firstPromptLabel')}
          onChange={(e) => setPrompt(e.target.value)}
          data-testid="preset-edit-prompt"
        />
        {prompt.trim() && (
          <p className="sub">
            <CostChip /> {t('team.preset.firstPromptCost')}
          </p>
        )}
        <label className="check">
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          {t('team.preset.attach')}
        </label>
      </fieldset>
      <fieldset className="preset-progress-edit">
        <legend>{t('team.preset.progressTitle')}</legend>
        {PROGRESS_FIELDS.map((field) => (
          <label key={field}>
            {t(`team.preset.progress.${field}`)}
            <textarea
              rows={2}
              value={progress[field]}
              maxLength={field === 'gmNotes' ? PROGRESS_GM_NOTES_MAX : PROGRESS_FIELD_MAX}
              onChange={(e) => setProgress((p) => ({ ...p, [field]: e.target.value }))}
              data-testid={`preset-progress-${field}`}
            />
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button
          className="primary"
          disabled={busy || problem !== null}
          data-testid="preset-edit-save"
        >
          {t('team.preset.saveEdit')}
        </button>
        <button type="button" onClick={onDone}>
          {t('team.preset.close')}
        </button>
        {problem && (
          <span className="msg err" role="alert" data-testid="preset-edit-error">
            {problem}
          </span>
        )}
        {msg && (
          <span
            className={`msg${msg.err ? ' err' : ''}`}
            role={msg.err ? 'alert' : 'status'}
            data-testid="preset-edit-msg"
          >
            {msg.text}
          </span>
        )}
      </div>
      {presetHasBypass(draft) && (
        <p className="sub">
          <ModeChip mode="bypassPermissions" />
        </p>
      )}
    </form>
  );
}
