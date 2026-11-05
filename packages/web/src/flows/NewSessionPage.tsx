// 新增 session：左邊表單，右邊即時預覽實際執行的指令與額度警告（DISPATCH §5.3-2）。
import { useCallback, useEffect, useState } from 'react';
import { AbsolutePath, ClaudeSessionId, PermissionMode } from '@agent-board/protocol';
import type { Machine, Session, Settings } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { commandPreview } from './commandPreview';
import {
  createErrorText,
  Empty,
  ErrorBox,
  errorText,
  handsClass,
  Loading,
  ModeChip,
  Msg,
  Page,
  useLoad,
  useProjects,
  type Note,
  type T,
} from './common';
import {
  Field,
  FolderBrowser,
  useFolderNameFill,
  isActive,
  ProjectSelect,
  suggestMachine,
  TASK_TYPES,
  useWorktreeAdvice,
  worktreeOn,
  WorktreeHints,
  type TaskType,
} from './sessionForm';
import { PairMachineNext } from './settingsParts';

const LONG_CONTEXT_TOKENS = 100_000;
const NO_GUARDS: Settings['quotaGuards'] = {
  denyReadPaths: [],
  maxConcurrentSessions: null,
  queueWhenRateLimited: true,
};
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku'];

function suggestionReason(t: T, machine: Machine, task: TaskType): string {
  const { gpuName, cpuCores, memoryBytes } = machine.capabilities;
  if (task === 'gpu') return t('flows.new.reason.gpu', { gpu: gpuName ?? 'GPU' });
  if (task === 'heavy') {
    return t('flows.new.reason.heavy', {
      cores: cpuCores,
      memory: Math.round(memoryBytes / 1024 ** 3),
    });
  }
  return t('flows.new.reason.general');
}

interface Warning {
  key: string;
  text: string;
  tone: 'quota' | 'fault';
}

function quotaWarnings(
  t: T,
  guards: Settings['quotaGuards'] | null,
  sessions: readonly Session[],
  machineId: string,
  accountProfile: string,
  resumed: Session | undefined,
): Warning[] {
  const list: Warning[] = [];
  if (!guards) {
    list.push({ key: 'noSettings', text: t('flows.new.warn.noSettings'), tone: 'quota' });
  } else {
    const running = sessions.filter(
      (s) => isActive(s) && !['queued', 'offline', 'rate_limited'].includes(s.status),
    ).length;
    const limit = guards.maxConcurrentSessions;
    if (limit !== null && running >= limit) {
      list.push({
        key: 'queue',
        text: t('flows.new.warn.queue', { running, limit }),
        tone: 'quota',
      });
    }
    if (guards.denyReadPaths.length === 0) {
      list.push({ key: 'noDeny', text: t('flows.new.warn.noDeny'), tone: 'quota' });
    }
  }
  // 帳號＝機器＋設定資料夾：另一台機器的同名資料夾是另一個帳號（§8-5）。
  const limited = sessions.filter(
    (s) =>
      s.status === 'rate_limited' &&
      s.endedAt === null &&
      s.machineId === machineId &&
      (s.accountProfile ?? '') === accountProfile,
  ).length;
  if (limited > 0) {
    // 沒讀到設定（非管理員）時不知道會不會排隊，只說可能停住。
    const queues = guards?.queueWhenRateLimited === true;
    list.push({
      key: 'limited',
      text: t(queues ? 'flows.new.warn.limitedQueue' : 'flows.new.warn.limited', { n: limited }),
      tone: 'quota',
    });
  }
  if ((resumed?.contextTokens ?? 0) >= LONG_CONTEXT_TOKENS) {
    list.push({
      key: 'longContext',
      text: t('flows.new.warn.longContext', {
        tokens: Math.round((resumed?.contextTokens ?? 0) / 1000),
      }),
      tone: 'quota',
    });
  }
  return list;
}

export function NewSessionPage() {
  const t = useT();
  const { backend, machines, sessions, connected } = useBoard();
  const projects = useProjects();
  const templates = useLoad(useCallback(() => backend.listTemplates(), [backend]));
  const settings = useLoad(useCallback(() => backend.getSettings(), [backend]));

  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [taskType, setTaskType] = useState<TaskType>('general');
  const [chosenMachine, setChosenMachine] = useState<string | null>(null);
  const [cwd, setCwd] = useState('');
  const fillName = useFolderNameFill(name, setName);
  const [browsing, setBrowsing] = useState(false);
  const [worktreeChoice, setWorktreeChoice] = useState<boolean | null>(null);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [model, setModel] = useState('');
  const [account, setAccount] = useState('');
  const [resume, setResume] = useState('');
  const [firstPrompt, setFirstPrompt] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [templateNote, setTemplateNote] = useState<Note | null>(null);
  const [applyNote, setApplyNote] = useState<Note | null>(null);

  const guards = settings.data?.quotaGuards ?? null;
  const suggestion = suggestMachine(machines, sessions, taskType);
  const machineId = chosenMachine ?? suggestion?.id ?? '';
  const machine = machines.find((m) => m.id === machineId);
  // 同一個 working tree 才會互相改到檔案：同 repo 的不同子資料夾也算（daemon 回報的根目錄）。
  const advice = useWorktreeAdvice(machine, cwd);
  const useWorktree = worktreeOn(advice, worktreeChoice);
  // 舊資料可能有不合格的 id（hub 會拒絕），不放進建議清單。
  const resumable = sessions.filter(
    (s) => s.claudeSessionId && ClaudeSessionId.safeParse(s.claudeSessionId).success,
  );
  const resumed = sessions.find((s) => s.claudeSessionId === resume.trim());
  const accounts = [
    ...new Set(sessions.flatMap((s) => (s.accountProfile ? [s.accountProfile] : []))),
  ];
  const trimmedAccount = account.trim();

  // 換機器後資料夾清單就不是同一台的了。
  useEffect(() => setBrowsing(false), [machineId]);

  const errors = {
    name: name.trim() ? null : t('flows.new.err.name'),
    machine: !machine
      ? t('flows.new.err.machine')
      : !machine.online
        ? t('flows.new.err.machineOffline', { machine: machine.name })
        : null,
    cwd: cwd.trim() ? null : t('flows.new.err.cwd'),
    // 和 hub 的 SessionSpec 用同一組規則（protocol 的 AbsolutePath、ClaudeSessionId）。
    account:
      trimmedAccount && !AbsolutePath.safeParse(trimmedAccount).success
        ? t('flows.new.err.account')
        : null,
    resume:
      resume.trim() && !ClaudeSessionId.safeParse(resume.trim()).success
        ? t('flows.new.err.resume')
        : null,
  };
  const firstError = Object.values(errors).find(Boolean) ?? null;

  const preview = commandPreview({
    readOnly: false,
    name: name.trim(),
    cwd: cwd.trim(),
    useWorktree,
    permissionMode: mode,
    model: model.trim() || null,
    accountProfile: trimmedAccount || null,
    resumeClaudeSessionId: resume.trim() || null,
  });
  const settingsPending = settings.loading && !settings.data;
  const warnings = quotaWarnings(t, guards, sessions, machineId, trimmedAccount, resumed);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    setApplyNote(null);
    const template = templates.data?.find((x) => x.id === id);
    if (!template) return;
    const { config } = template;
    setCwd(config.cwd ?? '');
    setMode(config.permissionMode);
    setModel(config.model ?? '');
    setFirstPrompt(config.firstPrompt ?? '');
    if (config.machineId && machines.some((m) => m.id === config.machineId)) {
      setChosenMachine(config.machineId);
    } else {
      setChosenMachine(null);
      if (config.machineId) setApplyNote({ text: t('flows.new.templateNoMachine'), tone: 'err' });
    }
  };

  const submit = async () => {
    setTried(true);
    if (firstError) {
      setNote({ text: firstError, tone: 'err' });
      return;
    }
    setBusy(true);
    setNote({ text: t('flows.new.creating') });
    try {
      const created = await backend.createSession({
        name: name.trim(),
        machineId,
        projectId: projectId || null,
        cwd: cwd.trim(),
        useWorktree,
        permissionMode: mode,
        model: model.trim() || null,
        accountProfile: trimmedAccount || null,
        resumeClaudeSessionId: resume.trim() || null,
        firstPrompt: firstPrompt.trim() || null,
        readOnly: false,
      });
      // 清掉名稱，避免連按建立出第二個一樣的 session。
      setName('');
      setTried(false);
      setNote({
        text: (
          <>
            {t('flows.new.created', { name: created.name })}{' '}
            <a href="#/canvas">{t('flows.new.toCanvas')}</a>
          </>
        ),
      });
    } catch (e) {
      setNote({ text: createErrorText(t, e), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const saveTemplate = async () => {
    const label = (templateName || name).trim();
    if (!label) {
      setTemplateNote({ text: t('flows.new.templateNeedsName'), tone: 'err' });
      return;
    }
    try {
      await backend.saveTemplate({
        name: label,
        config: {
          machineId: machineId || null,
          cwd: cwd.trim() || null,
          permissionMode: mode,
          model: model.trim() || null,
          firstPrompt: firstPrompt.trim() || null,
          quotaGuards: guards ?? NO_GUARDS,
        },
      });
      setTemplateName('');
      setTemplateNote({ text: t('flows.new.templateSaved', { name: label }) });
      templates.reload();
    } catch (e) {
      setTemplateNote({
        text: t('flows.new.templateFailed', { error: errorText(e) }),
        tone: 'err',
      });
    }
  };

  if (machines.length === 0) {
    return (
      <Page>
        <header className="page-head">
          <h1>{t('flows.new.title')}</h1>
        </header>
        <Empty
          title={t('flows.new.noMachines')}
          next={<PairMachineNext label={t('flows.new.noMachinesNext')} />}
        />
      </Page>
    );
  }

  const bypass = mode === 'bypassPermissions';

  return (
    <Page>
      <header className="page-head">
        <h1>{t('flows.new.title')}</h1>
      </header>
      {projects.error && (
        <ErrorBox
          what={t('flows.error.projects', { error: projects.error })}
          how={t('flows.error.projectsHow')}
          onRetry={projects.reload}
        />
      )}
      {templates.error && (
        <ErrorBox
          what={t('flows.error.templates', { error: templates.error })}
          how={t('flows.error.templatesHow')}
          onRetry={templates.reload}
        />
      )}
      <div className="new-grid">
        <form
          className="form-card"
          aria-label={t('flows.new.title')}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={t('flows.new.template')} htmlFor="ns-template">
            <select
              id="ns-template"
              value={templateId}
              disabled={templates.loading && !templates.data}
              onChange={(e) => applyTemplate(e.target.value)}
            >
              <option value="">{t('flows.new.templateNone')}</option>
              {templates.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <Msg note={applyNote} />
          </Field>

          <Field label={t('flows.new.name')} htmlFor="ns-name" error={tried ? errors.name : null}>
            <input
              id="ns-name"
              value={name}
              aria-invalid={tried && !!errors.name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field
            label={t('flows.new.project')}
            htmlFor="ns-project"
            hint={projects.data?.length === 0 ? t('flows.new.projectEmpty') : null}
          >
            <ProjectSelect
              id="ns-project"
              projects={projects}
              value={projectId}
              onChange={setProjectId}
            />
          </Field>

          <fieldset className="field">
            <legend>{t('flows.new.taskType')}</legend>
            <div className="segmented">
              {TASK_TYPES.map((type) => (
                <label key={type} className={taskType === type ? 'on' : ''}>
                  <input
                    type="radio"
                    name="ns-task"
                    checked={taskType === type}
                    onChange={() => setTaskType(type)}
                  />
                  {t(`flows.new.task.${type}`)}
                </label>
              ))}
            </div>
            <p className="hint" data-testid="machine-suggestion">
              {suggestion
                ? t('flows.new.suggest', {
                    machine: suggestion.name,
                    reason: suggestionReason(t, suggestion, taskType),
                  })
                : t(`flows.new.suggestNone.${taskType}`)}
            </p>
            {suggestion && chosenMachine && chosenMachine !== suggestion.id && (
              <button type="button" onClick={() => setChosenMachine(suggestion.id)}>
                {t('flows.new.useSuggestion', { machine: suggestion.name })}
              </button>
            )}
          </fieldset>

          <Field
            label={t('flows.new.machine')}
            htmlFor="ns-machine"
            error={tried ? errors.machine : null}
          >
            <select
              id="ns-machine"
              value={machineId}
              onChange={(e) => setChosenMachine(e.target.value)}
            >
              {!machine && <option value="">{t('flows.new.machineNone')}</option>}
              {machines.map((m) => (
                <option key={m.id} value={m.id} disabled={!m.online}>
                  {m.online
                    ? `${m.name}${m.capabilities.hasGpu ? ' · GPU' : ''}`
                    : `⊘ ${m.name} · ${t('status.offline')}`}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('flows.new.cwd')} htmlFor="ns-cwd" error={tried ? errors.cwd : null}>
            <div className="input-row">
              <input
                id="ns-cwd"
                className="mono"
                value={cwd}
                aria-invalid={tried && !!errors.cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button
                type="button"
                disabled={!machine?.online}
                aria-expanded={browsing}
                onClick={() => setBrowsing((open) => !open)}
              >
                {t('flows.new.browse')}
              </button>
            </div>
            {browsing && machine && (
              <FolderBrowser
                machine={machine}
                start={cwd.trim()}
                onSelect={(path) => {
                  setCwd(path);
                  fillName(path);
                }}
                onPick={(path) => {
                  setCwd(path);
                  fillName(path);
                  setBrowsing(false);
                }}
                onClose={() => setBrowsing(false)}
              />
            )}
          </Field>

          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={useWorktree}
                disabled={advice.notGit}
                onChange={(e) => setWorktreeChoice(e.target.checked)}
              />
              {t('flows.new.worktree')}
            </label>
            <WorktreeHints {...advice} />
          </div>

          <fieldset className={`field modes${bypass ? ' modes-bypass' : ''}`}>
            <legend>{t('flows.new.mode')}</legend>
            {PermissionMode.options.map((option) => (
              <label key={option} className={`mode-row ${handsClass(option)}`}>
                <input
                  type="radio"
                  name="ns-mode"
                  checked={mode === option}
                  onChange={() => setMode(option)}
                />
                <span className="mode-text">
                  <ModeChip mode={option} />
                  <span className="sub">{t(`flows.mode.desc.${option}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <Field label={t('flows.new.model')} htmlFor="ns-model" hint={t('flows.new.modelHint')}>
            <input
              id="ns-model"
              list="ns-model-list"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="ns-model-list">
              {MODEL_ALIASES.map((alias) => (
                <option key={alias} value={alias} />
              ))}
            </datalist>
          </Field>

          <Field
            label={t('flows.new.account')}
            htmlFor="ns-account"
            hint={t('flows.new.accountHint')}
            error={errors.account}
          >
            <input
              id="ns-account"
              className="mono"
              list="ns-account-list"
              value={account}
              aria-invalid={!!errors.account}
              onChange={(e) => setAccount(e.target.value)}
            />
            <datalist id="ns-account-list">
              {accounts.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
          </Field>

          <Field
            label={t('flows.new.resume')}
            htmlFor="ns-resume"
            hint={t('flows.new.resumeHint')}
            error={errors.resume}
          >
            <input
              id="ns-resume"
              className="mono"
              list="ns-resume-list"
              value={resume}
              aria-invalid={!!errors.resume}
              onChange={(e) => setResume(e.target.value)}
            />
            <datalist id="ns-resume-list">
              {resumable.map((s) => (
                <option key={s.id} value={s.claudeSessionId ?? ''}>
                  {s.name}
                </option>
              ))}
            </datalist>
          </Field>

          <Field label={t('flows.new.firstPrompt')} htmlFor="ns-first">
            <textarea
              id="ns-first"
              rows={3}
              value={firstPrompt}
              onChange={(e) => setFirstPrompt(e.target.value)}
            />
          </Field>

          <div className="acts">
            <button type="submit" className="primary" disabled={busy || !connected}>
              {t('flows.new.create')}
            </button>
            <Msg note={note} />
          </div>

          <div className="field template-save">
            <label htmlFor="ns-template-name">{t('flows.new.saveTemplate')}</label>
            <div className="input-row">
              <input
                id="ns-template-name"
                value={templateName}
                placeholder={name || t('flows.new.templateNamePlaceholder')}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <button type="button" disabled={!connected} onClick={() => void saveTemplate()}>
                {t('flows.new.saveTemplateAction')}
              </button>
            </div>
            <Msg note={templateNote} />
          </div>
        </form>

        <aside
          className={`card preview ${handsClass(mode)}${bypass ? ' preview-bypass' : ''}`}
          aria-label={t('flows.new.preview')}
        >
          <div className="sign">
            <h2>{t('flows.new.preview')}</h2>
            <ModeChip mode={mode} />
          </div>
          {bypass && (
            <div className="alert" role="alert" data-testid="bypass-alert">
              <span aria-hidden="true">⛔</span>
              <div className="alert-body">{t('flows.new.bypassWarn')}</div>
            </div>
          )}
          <p className="sub">
            {machine
              ? t('flows.new.previewOn', { machine: machine.name })
              : t('flows.new.machineNone')}
          </p>
          <pre className="command" data-testid="command-preview">
            {preview.join('\n')}
          </pre>
          <p className="hint">{t('flows.new.previewNote')}</p>
          {firstPrompt.trim() && (
            <>
              <h3>{t('flows.new.previewFirst')}</h3>
              <pre className="command">{firstPrompt.trim()}</pre>
            </>
          )}
          <h3>{t('flows.new.quota')}</h3>
          <div data-testid="quota-warnings">
            {settingsPending ? (
              <Loading />
            ) : warnings.length === 0 ? (
              <p className="hint">
                {guards && guards.denyReadPaths.length > 0
                  ? t('flows.new.denyList', { paths: guards.denyReadPaths.join('、') })
                  : t('flows.new.noWarnings')}
              </p>
            ) : (
              <ul className="warn-list">
                {warnings.map((w) => (
                  <li key={w.key}>
                    <span aria-hidden="true">◈</span> {w.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </Page>
  );
}
