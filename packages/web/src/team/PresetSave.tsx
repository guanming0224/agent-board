// 「存成 Preset」（P3 §2.3）：從團隊面板「⋯ → 存成 Preset」或新增團隊表單旁的按鈕開。
// 先顯示摘要（同預覽格式），填名稱（必填、不分大小寫不能重複）、可填隊長第一個指令，按「存」。
import { useState } from 'react';
import {
  TEAM_PRESET_NAME_MAX,
  TEAM_PRESET_PROMPT_MAX,
  TeamPresetConfig,
  type TeamPresetConfigInput,
  type TeamPresetProgress,
} from '@agent-board/protocol';
import { Dialog } from '../flows/Dialog';
import { errorCode } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, ModeChip } from '../views';
import { CostChip } from './common';
import { kindLabel } from './PlanEditor';
import { presetAbbr, presetCosts, presetToPlanRows } from './presetPlan';
import { usePresetList } from './presetStore';
import './presetMessages';
import './presets.css';

export function SavePresetDialog({
  defaultName,
  config,
  skippedRules = 0,
  progress = null,
  onClose,
}: {
  defaultName: string;
  config: TeamPresetConfigInput;
  /** 連到團隊外而沒存進來的交接規則數（提示用）。 */
  skippedRules?: number;
  /** 目前的進度卡（有進度卡功能時才給）：勾了才當初始內容。 */
  progress?: TeamPresetProgress | null;
  onClose: () => void;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const machines = useBoard((s) => s.machines);
  const { presets } = usePresetList();
  const [name, setName] = useState(defaultName);
  const [prompt, setPrompt] = useState(config.leadFirstPrompt ?? '');
  const [attach, setAttach] = useState(config.attachProgressCard ?? true);
  const [withProgress, setWithProgress] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const input: TeamPresetConfigInput = {
    ...config,
    leadFirstPrompt: prompt.trim() || null,
    attachProgressCard: attach,
    ...(withProgress && progress ? { initialProgress: progress } : {}),
  };
  const parsed = TeamPresetConfig.safeParse(input);
  const taken = presets.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const problem =
    name.trim() === ''
      ? t('team.preset.nameRequired')
      : taken
        ? t('team.preset.nameTaken', { name: name.trim() })
        : !parsed.success
          ? t('team.preset.invalid', { detail: parsed.error.issues[0]?.message ?? '' })
          : null;

  const save = async () => {
    if (problem || busy || !parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const preset = await backend.createTeamPreset({ name: name.trim(), config: parsed.data });
      setSaved(preset.name);
    } catch (e) {
      setError(
        errorCode(e) === 'preset_name_taken'
          ? t('team.preset.nameTaken', { name: name.trim() })
          : t('team.failed', { detail: errorText(e) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const shown = parsed.success ? parsed.data : null;
  const rows = shown ? presetToPlanRows(shown.rows, name.trim() || defaultName) : [];
  const costs = shown ? presetCosts(shown) : null;
  const machine = machines.find((m) => m.id === config.placement.machineId);

  return (
    <Dialog title={t('team.preset.saveTitle')} onClose={onClose} testId="preset-save">
      <div className="preset-save">
        {saved ? (
          <>
            <p role="status" data-testid="preset-saved">
              {t('team.preset.saved', { name: saved })}
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={onClose}>
                {t('team.preset.close')}
              </button>
              <a href="#/settings/presets" onClick={onClose}>
                {t('team.preset.manage')}
              </a>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // 對話框在 portal 裡，但 React 的事件仍會冒到外面的表單（新增團隊表單）：不能讓它建立團隊。
              e.stopPropagation();
              void save();
            }}
          >
            <label className="preset-field">
              {t('team.preset.name')}
              <input
                value={name}
                maxLength={TEAM_PRESET_NAME_MAX}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                data-testid="preset-save-name"
              />
            </label>
            {/* 摘要（同預覽格式）。 */}
            <p className="mono sub">
              {shown ? presetAbbr(shown) : ''} · {machine?.name ?? t('team.preset.noMachine')} ·{' '}
              {config.placement.cwd}
            </p>
            <ol className="preset-rows" data-testid="preset-save-rows">
              {rows.map((row) => (
                <li
                  key={row.key}
                  className={`preset-plan-row${row.mode === 'bypassPermissions' ? ' bypass' : ''}`}
                >
                  <span className="preset-row-name">{row.name}</span>
                  <span className="sub">{kindLabel(t, row.kind)}</span>
                  <ModeChip mode={row.mode} />
                </li>
              ))}
            </ol>
            <p className="sub" data-testid="preset-save-rules">
              {t('team.preset.rulesSummary', {
                n: shown?.handoffRules.length ?? 0,
                on: costs?.rules ?? 0,
              })}
              {costs && costs.rules > 0 && <CostChip />}
              {shown?.taskAuto && (
                <>
                  {' · '}
                  {t('team.preset.taskAuto')} <CostChip />
                </>
              )}
            </p>
            {skippedRules > 0 && (
              <p className="sub" data-testid="preset-save-skipped">
                {t('team.preset.skippedRules', { n: skippedRules })}
              </p>
            )}
            <label className="preset-field">
              {t('team.preset.firstPromptLabel')}
              <textarea
                rows={3}
                value={prompt}
                maxLength={TEAM_PRESET_PROMPT_MAX}
                onChange={(e) => setPrompt(e.target.value)}
                data-testid="preset-save-prompt"
              />
            </label>
            {prompt.trim() && (
              <p className="sub">
                <CostChip /> {t('team.preset.firstPromptCost')}
              </p>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={attach}
                onChange={(e) => setAttach(e.target.checked)}
              />
              {t('team.preset.attach')}
            </label>
            {progress && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={withProgress}
                  onChange={(e) => setWithProgress(e.target.checked)}
                  data-testid="preset-save-progress"
                />
                {t('team.preset.withProgress')}
              </label>
            )}
            <div className="row">
              <button
                className="primary"
                disabled={busy || problem !== null}
                data-testid="preset-save-submit"
              >
                {t('team.preset.save')}
              </button>
              <button type="button" onClick={onClose}>
                {t('team.preset.cancel')}
              </button>
              {(problem || error) && (
                <span className="msg err" role="alert" data-testid="preset-save-error">
                  {error ?? problem}
                </span>
              )}
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
