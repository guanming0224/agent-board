// 套用團隊 Preset（P3 項目二 §2.3、§2.4）：清單 → 預覽（GM 決定 Q1：先預覽，按「建立」或 Enter 才建立）→ 逐列建立。
// 桌面從底部指令列「Presets」彈出；手機從團隊清單頂部「從 Preset 建立」進來（全螢幕）。
// 建立沿用「團隊快速建立」的 runPlan（逐列 createSession＋加入團隊，失敗的列記下來、已建的保留，不自動重試）。
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  leadFirstPrompt,
  type Machine,
  type Settings,
  type TeamPreset,
  type TeamPresetConfig,
} from '@agent-board/protocol';
import { isActive } from '../flows/sessionForm';
import { errorCode } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, handsClass, ModeChip, teamHash, usePauseState } from '../views';
import { currentZoneId, useCurrentZoneId, useZones } from '../zones';
import { CostChip } from './common';
import { useHeldPrompts } from './heldPrompts';
import { kindLabel, PlaceFields, stepText, usePlanPlace } from './PlanEditor';
import {
  lastSegment,
  presetAbbr,
  presetCosts,
  presetHasBypass,
  presetToPlanRows,
  uniqueTeamName,
} from './presetPlan';
import { usePresetList } from './presetStore';
import { runPlan, type PlanResult, type RowStep } from './runPlan';
import { refreshTeams, teamColorVar, useTeams } from './store';
import { isReadOnlyRole, rowUsesWorktree, validatePlan } from './teamPlan';
import './presetMessages';
import './presets.css';

type T = ReturnType<typeof useT>;

/** 清單一次顯示幾個（超過可捲動，並出現篩選框）。 */
const VISIBLE_ROWS = 8;

function machineLabel(t: T, machines: readonly Machine[], id: string): string {
  return machines.find((m) => m.id === id)?.name ?? t('team.preset.noMachine');
}

/** 清單每一列：名稱 → 角色縮寫串 → 資料夾最後一段＋機器名 → 標記（◈、略過權限）。 */
function PresetRow({ preset, onPick }: { preset: TeamPreset; onPick: () => void }) {
  const t = useT();
  const machines = useBoard((s) => s.machines);
  const { config } = preset;
  const costs = presetCosts(config);
  return (
    <li>
      <button
        type="button"
        className="preset-row"
        onClick={onPick}
        title={config.placement.cwd}
        data-testid={`preset-${preset.id}`}
        data-name={preset.name}
      >
        <span className="preset-name">
          <i className="swatch" style={{ background: teamColorVar(config.color) }} aria-hidden />
          <b>{preset.name}</b>
        </span>
        <span className="mono sub preset-abbr">{presetAbbr(config)}</span>
        <span className="sub preset-where">
          {lastSegment(config.placement.cwd)} ·{' '}
          {machineLabel(t, machines, config.placement.machineId)}
        </span>
        <span className="preset-marks">
          {costs.any && <CostChip />}
          {presetHasBypass(config) && (
            <span className="chip mode bypass" data-testid="preset-bypass">
              {t('views.mode.bypass')}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function PresetList({ onPick }: { onPick: (preset: TeamPreset) => void }) {
  const t = useT();
  const { presets, status, error, retry } = usePresetList();
  const [filter, setFilter] = useState('');
  const shown = presets.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  if (status === 'loading') return <p className="sub">{t('team.preset.loading')}</p>;
  if (status === 'error') {
    return (
      <div className="alert" role="alert">
        <span aria-hidden="true">✕</span>
        <div>
          {t('team.preset.loadFailed', { detail: error ?? '' })}{' '}
          <button type="button" onClick={retry}>
            {t('team.preset.retry')}
          </button>
        </div>
      </div>
    );
  }
  if (presets.length === 0) {
    return (
      <p className="sub preset-empty" data-testid="preset-empty">
        {t('team.preset.empty')}
      </p>
    );
  }
  return (
    <>
      {presets.length > VISIBLE_ROWS && (
        <input
          className="preset-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('team.preset.filter')}
          aria-label={t('team.preset.filter')}
          data-testid="preset-filter"
        />
      )}
      <ul className="preset-list" data-testid="preset-list">
        {shown.map((preset) => (
          <PresetRow key={preset.id} preset={preset} onPick={() => onPick(preset)} />
        ))}
      </ul>
    </>
  );
}

/** 資料夾存不存在：用既有的資料夾瀏覽 API 問 daemon（§2.3）。fs_error＝不存在或讀不到。 */
function useFolderCheck(machine: Machine | undefined, cwd: string) {
  const backend = useBoard((s) => s.backend);
  const dir = cwd.trim();
  const key = machine?.online && dir ? `${machine.id}\n${dir}` : '';
  const [result, setResult] = useState<{
    key: string;
    state: 'ok' | 'missing' | 'error';
    detail?: string;
  } | null>(null);
  useEffect(() => {
    if (!key || !machine) return;
    let live = true;
    backend.browseDirectory(machine.id, dir).then(
      () => live && setResult({ key, state: 'ok' }),
      (e: unknown) =>
        live &&
        setResult({
          key,
          state: errorCode(e) === 'fs_error' ? 'missing' : 'error',
          detail: errorText(e),
        }),
    );
    return () => {
      live = false;
    };
  }, [backend, key, machine, dir]);
  if (!key) return { state: 'idle' as const };
  return result?.key === key ? result : { state: 'checking' as const };
}

/** 同時 session 上限（設定只有 owner 讀得到；讀不到就不預測排隊）。 */
function useConcurrencyLimit(): number | null | undefined {
  const backend = useBoard((s) => s.backend);
  const [limit, setLimit] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    backend.getSettings().then(
      (s: Settings) => live && setLimit(s.quotaGuards.maxConcurrentSessions),
      () => live && setLimit(undefined),
    );
    return () => {
      live = false;
    };
  }, [backend]);
  return limit;
}

/** 前兩行（預覽用）。 */
const firstLines = (text: string) => text.split(/\r?\n/).slice(0, 2).join('\n');

type Done = {
  result: PlanResult;
  held: boolean;
  refreshFailed: boolean;
};

/**
 * 預覽（§2.3）：團隊名稱（撞名自動加編號，可改）、目標工作區、每列、會開啟的交接規則與任務自動執行（◈）、
 * 隊長第一個指令前兩行。即時檢查機器在線、資料夾存在、名稱規則、會不會排隊。按「建立」或 Enter 執行，Esc 返回清單。
 */
function PresetPreview({
  preset,
  phone,
  onBack,
  onClose,
}: {
  preset: TeamPreset;
  phone: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { backend, connected, sessions } = useBoard();
  const teams = useTeams((s) => s.teams);
  const zones = useZones();
  const zoneId = useCurrentZoneId();
  const { paused } = usePauseState();
  const limit = useConcurrencyLimit();
  const config: TeamPresetConfig = preset.config;
  const [name, setName] = useState(() =>
    uniqueTeamName(
      preset.name,
      teams.map((x) => x.name),
    ),
  );
  const place = usePlanPlace({
    machineId: config.placement.machineId,
    cwd: config.placement.cwd,
    projectId: config.placement.projectId ?? '',
  });
  const [changing, setChanging] = useState(false);
  const folder = useFolderCheck(place.machine, place.cwd);
  const rows = useMemo(() => presetToPlanRows(config.rows, name), [config.rows, name]);
  const [frozen, setFrozen] = useState<typeof rows | null>(null);
  const shownRows = frozen ?? rows;
  const [steps, setSteps] = useState<Record<string, RowStep>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const submitting = useRef(false);
  const createRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const machine = place.machine;
  const planError = validatePlan(rows, place.gitOk);
  const firstPrompt = leadFirstPrompt(name.trim(), config);
  const costs = presetCosts(config);
  const running = sessions.filter(
    (s) => isActive(s) && !['queued', 'offline', 'rate_limited'].includes(s.status),
  ).length;
  const willQueue =
    typeof limit === 'number'
      ? Math.max(0, Math.min(rows.length, running + rows.length - limit))
      : 0;

  const problem: string | null = !machine
    ? t('team.preset.machineMissing')
    : !machine.online
      ? t('team.preset.machineOffline', { machine: machine.name })
      : !place.cwd.trim()
        ? t('flows.new.err.cwd')
        : folder.state === 'missing'
          ? t('team.preset.folderMissing', { dir: place.cwd.trim() })
          : name.trim() === ''
            ? t('team.preset.nameRequired')
            : planError
              ? t(`team.new.err.${planError}`)
              : null;
  const checking = !problem && folder.state === 'checking';
  const canCreate = !problem && !checking && connected && !busy && done === null;

  // 預覽一打開就把焦點放在「建立」上：直接按 Enter 就建立（能建立時）。
  useEffect(() => {
    if (canCreate && !frozen) createRef.current?.focus({ preventScroll: true });
  }, [canCreate, frozen]);

  const create = () => {
    if (!canCreate || submitting.current) return;
    submitting.current = true;
    const fixed = rows;
    setFrozen(fixed);
    setBusy(true);
    setError(null);
    setSteps(Object.fromEntries(fixed.map((r) => [r.key, { step: 'waiting' } as RowStep])));
    // 按下當時的暫停狀態：暫停中第一個指令不隨建立送出（D7）。
    const hold = paused !== null && firstPrompt !== null;
    void (async () => {
      let result: PlanResult;
      try {
        result = await runPlan(
          backend,
          {
            team: {
              name: name.trim(),
              goal: config.goal,
              doneCriteria: config.doneCriteria,
              color: config.color,
              contextMd: config.contextMd,
              ...(config.phase ? { phase: config.phase } : {}),
              taskAuto: config.taskAuto,
              // 不存工作區：放在目前工作區（§2.2）。
              zoneId: currentZoneId(),
            },
            machineId: place.machineId,
            cwd: place.cwd.trim(),
            projectId: place.projectId || null,
            gitOk: place.gitOk,
            rows: fixed,
            leadFirstPrompt: hold ? null : firstPrompt,
            rules: config.handoffRules,
            progress: config.initialProgress,
          },
          (key, step) => setSteps((all) => ({ ...all, [key]: step })),
        );
      } catch (e) {
        // 建立團隊本身失敗：什麼都還沒建，回到可以再按的狀態。
        setError(t('team.preset.teamFailed', { detail: errorText(e) }));
        setFrozen(null);
        setSteps({});
        setBusy(false);
        submitting.current = false;
        return;
      }
      const lead = fixed.find((r) => r.role === 'lead');
      const leadId = lead ? result.sessionIds.get(lead.key) : undefined;
      const held = hold && leadId !== undefined;
      if (held) {
        useHeldPrompts.getState().hold(leadId, {
          teamId: result.team.id,
          text: firstPrompt,
          at: new Date().toISOString(),
        });
      }
      // 回報給 hub：最後使用時間與 audit（失敗不影響已建好的團隊，畫面也不擋）。
      void backend
        .teamPresetUsed(preset.id, {
          teamId: result.team.id,
          created: fixed.length - result.failed,
          failed: result.failed,
          rulesCreated: result.rules.created,
          rulesFailed: result.rules.failed.length + result.rules.skipped,
          firstPromptHeld: held,
        })
        .catch(() => undefined);
      const refreshFailed = await refreshTeams(backend).then(
        () => false,
        () => true,
      );
      setBusy(false);
      setDone({ result, held, refreshFailed });
      const clean =
        result.failed === 0 &&
        result.rules.failed.length === 0 &&
        result.rules.skipped === 0 &&
        (result.progress.state === 'none' || result.progress.state === 'written');
      // 全部順利：畫布聚焦新團隊、開團隊面板（#/team/<id> 會框住成員）。有沒完成的留在這裡給 GM 看。
      // 暫停中留著的第一個指令：隊長卡片與團隊面板上有「送出第一個指令」。
      if (clean && !refreshFailed) {
        location.hash = teamHash(result.team.id);
        onClose();
      }
    })();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // 只回清單，不讓 App 關掉右側面板。
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onBack();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
      const target = e.target as HTMLElement;
      if (target.closest('textarea, select, button, a')) return;
      e.preventDefault();
      create();
    }
  };

  const enabledRules = config.handoffRules.filter((r) => r.enabled);
  const label = (i: number) => shownRows[i]?.name ?? `#${i + 1}`;

  return (
    <div
      className="preset-preview"
      role="group"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      data-testid="preset-preview"
    >
      <div className="preset-preview-head">
        <button type="button" onClick={onBack} disabled={busy} data-testid="preset-back">
          ← {t('team.preset.back')}
        </button>
        <b id={titleId}>{preset.name}</b>
      </div>
      {paused && firstPrompt && (
        <div className="alert you-alert" role="status" data-testid="preset-paused">
          <span aria-hidden="true">⏸</span>
          <div>{t('team.preset.pausedHint')}</div>
        </div>
      )}
      <label className="preset-field">
        {t('team.preset.teamName')}
        <input
          value={name}
          maxLength={80}
          disabled={busy || done !== null}
          onChange={(e) => setName(e.target.value)}
          data-testid="preset-team-name"
        />
      </label>
      <p className="sub" data-testid="preset-zone">
        {t('team.preset.zone', { zone: zones.find((z) => z.id === zoneId)?.name ?? '' })}
      </p>
      <div className="preset-place" data-testid="preset-place">
        <span className="mono">
          {machine?.name ?? t('team.preset.noMachine')} · {place.cwd || '—'}
        </span>
        {!busy && done === null && (
          <button
            type="button"
            className="link"
            aria-expanded={changing}
            onClick={() => setChanging((open) => !open)}
            data-testid="preset-change-machine"
          >
            {t('team.preset.changeMachine')}
          </button>
        )}
      </div>
      {changing && !busy && done === null && (
        <div className="preset-place-edit team-page">
          <PlaceFields
            place={{
              ...place,
              // 換機器要重選資料夾（同一個 repo 在不同機器的路徑不一樣，§2.8）。
              setMachine: (id) => {
                if (id !== place.machineId) place.setCwd('');
                place.setMachine(id);
              },
            }}
            rows={rows}
            tried
          />
        </div>
      )}
      <ol className="preset-rows" data-testid="preset-rows">
        {shownRows.map((row, i) => {
          const step = steps[row.key];
          const failed = step?.step === 'sessionFailed' || step?.step === 'memberFailed';
          const bypass = row.mode === 'bypassPermissions';
          return (
            <li
              key={row.key}
              className={`preset-plan-row hands-host ${handsClass(row.mode)}${bypass ? ' bypass' : ''}`}
              data-testid={`preset-row-${i + 1}`}
            >
              <span className="preset-row-name">{row.name}</span>
              <span className="sub">{kindLabel(t, row.kind)}</span>
              <ModeChip mode={row.mode} />
              <span className="sub">
                {rowUsesWorktree(row, place.gitOk)
                  ? t('team.new.where.worktree')
                  : isReadOnlyRole(row.role)
                    ? t('team.preset.readOnly')
                    : t('team.new.where.main')}
              </span>
              {row.model && <span className="chip mono">{row.model}</span>}
              {step && (
                <span
                  className={`step${failed ? ' err' : ''}`}
                  role={failed ? 'alert' : 'status'}
                  data-testid={`preset-step-${i + 1}`}
                >
                  {stepText(t, step)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {(enabledRules.length > 0 || config.taskAuto) && (
        <ul className="preset-autos" data-testid="preset-autos">
          {enabledRules.map((r, i) => (
            <li key={i}>
              {t('team.preset.rule', {
                from: label(r.fromRow),
                to: label(r.toRow),
                trigger: t(`team.preset.trigger.${r.trigger}`),
              })}{' '}
              <CostChip />
            </li>
          ))}
          {config.taskAuto && (
            <li>
              {t('team.preset.taskAuto')} <CostChip />
            </li>
          )}
        </ul>
      )}
      {config.handoffRules.length > enabledRules.length && (
        <p className="sub">
          {t('team.preset.rulesOff', { n: config.handoffRules.length - enabledRules.length })}
        </p>
      )}
      {firstPrompt && (
        <div className="preset-first" data-testid="preset-first-prompt">
          <span className="sub">
            {t('team.preset.firstPrompt')} {costs.firstPrompt && <CostChip />}
          </span>
          <pre className="mono">{firstLines(firstPrompt)}</pre>
        </div>
      )}
      {willQueue > 0 && (
        <p className="sub" data-testid="preset-queue">
          {t('team.preset.queue', { running, limit: limit ?? 0, n: willQueue })}
        </p>
      )}
      {problem && (
        <div className="alert" role="alert" data-testid="preset-problem">
          <span aria-hidden="true">⊘</span>
          <div>{problem}</div>
        </div>
      )}
      {!problem && folder.state === 'error' && (
        <p className="sub" data-testid="preset-folder-unknown">
          {t('team.preset.folderUnknown', { detail: folder.detail ?? '' })}
        </p>
      )}
      <div className="row preset-actions">
        {done ? (
          <a
            className="open-team"
            href={teamHash(done.result.team.id)}
            onClick={onClose}
            data-testid="preset-open-team"
          >
            {t('team.new.open')}
          </a>
        ) : (
          <button
            ref={createRef}
            type="button"
            className="primary"
            disabled={!canCreate}
            onClick={create}
            data-testid="preset-create"
          >
            {busy
              ? t('team.preset.creating')
              : checking
                ? t('team.preset.checking')
                : t('team.preset.create', { n: rows.length })}
          </button>
        )}
        {!connected && <span className="sub">{t('team.preset.offlineHub')}</span>}
        {error && (
          <span className="msg err" role="alert" data-testid="preset-error">
            {error}
          </span>
        )}
      </div>
      {done && <DoneNotes done={done} phone={phone} />}
    </div>
  );
}

function DoneNotes({ done, phone }: { done: Done; phone: boolean }) {
  const t = useT();
  const { result } = done;
  const notes: string[] = [];
  if (result.failed > 0) notes.push(t('team.new.partial', { failed: result.failed }));
  if (result.rules.failed.length > 0) {
    notes.push(
      t('team.preset.rulesFailed', {
        n: result.rules.failed.length,
        detail: errorText(result.rules.failed[0]!.error),
      }),
    );
  }
  if (result.rules.skipped > 0)
    notes.push(t('team.preset.rulesSkipped', { n: result.rules.skipped }));
  if (result.progress.state === 'failed') {
    notes.push(t('team.preset.progressFailed', { detail: errorText(result.progress.error) }));
  }
  if (done.refreshFailed) notes.push(t('team.new.refreshFailed'));
  return (
    <>
      {done.held && (
        <div className="alert you-alert" role="status" data-testid="preset-held">
          <span aria-hidden="true">⏸</span>
          <div>{t(phone ? 'team.preset.heldPhone' : 'team.preset.held')}</div>
        </div>
      )}
      {notes.length > 0 && (
        <div className="alert you-alert" role="alert" data-testid="preset-partial">
          <span aria-hidden="true">◆</span>
          <div>
            {notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** 清單 ↔ 預覽。onClose：關掉彈出區（手機是離開全螢幕清單）。 */
export function PresetPicker({ phone = false, onClose }: { phone?: boolean; onClose: () => void }) {
  const t = useT();
  const [picked, setPicked] = useState<string | null>(null);
  const { presets } = usePresetList();
  const preset = presets.find((p) => p.id === picked);
  // 預覽中的 Preset 被別人刪掉：回清單。
  useEffect(() => {
    if (picked !== null && !preset) setPicked(null);
  }, [picked, preset]);
  return (
    <div className={`preset-picker${phone ? ' phone' : ''}`} data-testid="preset-picker">
      {preset ? (
        <PresetPreview
          key={preset.id}
          preset={preset}
          phone={phone}
          onBack={() => setPicked(null)}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="preset-head">
            <b>{t('team.preset.title')}</b>
            <a className="sub" href="#/settings/presets" onClick={onClose}>
              {t('team.preset.manage')}
            </a>
          </div>
          <PresetList onPick={(p) => setPicked(p.id)} />
        </>
      )}
    </div>
  );
}

/**
 * 底部指令列的「Presets」：按鈕上方彈出清單（桌面）。點外面或 Esc（在清單時）關閉。
 */
export function PresetsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      // 預覽自己處理 Esc（回清單）並 preventDefault；這裡只處理清單上的 Esc。
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close();
      toggle.current?.focus();
    };
    addEventListener('pointerdown', onDown);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', onDown);
      removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return (
    <div className="presets-menu" ref={box}>
      <button
        ref={toggle}
        type="button"
        aria-expanded={open}
        title={t('team.preset.buttonHint')}
        onClick={() => setOpen((o) => !o)}
        data-testid="command-presets"
      >
        {t('team.preset.button')}
      </button>
      {open && (
        <div className="presets-pop" data-testid="presets-pop">
          <PresetPicker onClose={close} />
        </div>
      )}
    </div>
  );
}

/** 手機（與團隊清單）頂部「從 Preset 建立」：展開成全寬清單，按鈕 ≥ 56px（§2.4）。 */
export function PresetEntry() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="preset-entry">
      <button
        type="button"
        className="preset-entry-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="preset-entry"
      >
        {t('team.preset.fromPreset')}
      </button>
      {open && <PresetPicker phone onClose={() => setOpen(false)} />}
    </div>
  );
}
