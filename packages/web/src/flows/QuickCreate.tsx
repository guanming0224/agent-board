// 畫布上的快速建立：雙擊空白處跳出的小卡。只問名稱、資料夾、專案、第一個指令，其餘用預設；
// 「更多設定」展開機器、權限模式、模型、worktree。完整的額度預覽仍在 #/new。
import { useEffect, useState } from 'react';
import { PermissionMode } from '@agent-board/protocol';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { createErrorText, ModeChip, Msg, useProjects, type Note } from './common';
import {
  Field,
  FolderBrowser,
  useFolderNameFill,
  ProjectSelect,
  suggestMachine,
  useWorktreeAdvice,
  worktreeOn,
  WorktreeHints,
} from './sessionForm';

export function QuickCreate({
  left,
  top,
  onCreated,
  onClose,
}: {
  /** 小卡左上角在畫布容器裡的位置（px）。 */
  left: number;
  top: number;
  onCreated: (session: Session) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { backend, machines, sessions, connected } = useBoard();
  const projects = useProjects();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const fillName = useFolderNameFill(name, setName);
  const [projectId, setProjectId] = useState('');
  const [firstPrompt, setFirstPrompt] = useState('');
  const [more, setMore] = useState(false);
  const [chosenMachine, setChosenMachine] = useState<string | null>(null);
  const [mode, setMode] = useState<PermissionMode>('default');
  const [model, setModel] = useState('');
  const [worktreeChoice, setWorktreeChoice] = useState<boolean | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const suggestion = suggestMachine(machines, sessions, 'general');
  const machineId = chosenMachine ?? suggestion?.id ?? '';
  const machine = machines.find((m) => m.id === machineId);
  const advice = useWorktreeAdvice(machine, cwd);
  const useWorktree = worktreeOn(advice, worktreeChoice);
  const online = machines.filter((m) => m.online);

  useEffect(() => setBrowsing(false), [machineId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const errors = {
    name: name.trim() ? null : t('flows.new.err.name'),
    machine: !machine
      ? t('flows.new.err.machine')
      : !machine.online
        ? t('flows.new.err.machineOffline', { machine: machine.name })
        : null,
    cwd: cwd.trim() ? null : t('flows.new.err.cwd'),
  };
  const firstError = Object.values(errors).find(Boolean) ?? null;

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
        accountProfile: null,
        resumeClaudeSessionId: null,
        firstPrompt: firstPrompt.trim() || null,
      });
      onCreated(created);
    } catch (e) {
      setNote({ text: createErrorText(t, e), tone: 'err' });
      setBusy(false);
    }
  };

  const bypass = mode === 'bypassPermissions';

  return (
    <div className="flows quick-create-host">
      <form
        className="quick-create form-card"
        style={{ left, top }}
        aria-label={t('flows.quick.aria')}
        data-testid="quick-create"
        // 畫布的平移、縮放與雙擊不要吃到小卡裡的操作。
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="quick-head">
          <h2>{t('flows.quick.title')}</h2>
          <ModeChip mode={mode} />
        </div>
        {online.length === 0 ? (
          <p className="field-error">{t('flows.quick.offline')}</p>
        ) : (
          <>
            <Field label={t('flows.new.name')} htmlFor="qc-name" error={tried ? errors.name : null}>
              <input
                id="qc-name"
                value={name}
                autoFocus
                aria-invalid={tried && !!errors.name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field
              label={t('flows.new.cwd')}
              htmlFor="qc-cwd"
              error={tried ? errors.cwd : null}
              hint={cwd.trim() ? null : t('flows.quick.cwdHint')}
            >
              <div className="input-row">
                <input
                  id="qc-cwd"
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
              <WorktreeHints {...advice} />
            </Field>

            <Field label={t('flows.new.project')} htmlFor="qc-project">
              <ProjectSelect
                id="qc-project"
                projects={projects}
                value={projectId}
                onChange={setProjectId}
              />
            </Field>

            <Field label={t('flows.new.firstPrompt')} htmlFor="qc-first">
              <textarea
                id="qc-first"
                rows={2}
                value={firstPrompt}
                onChange={(e) => setFirstPrompt(e.target.value)}
              />
            </Field>

            {more && (
              <div className="quick-more" data-testid="quick-more">
                <Field
                  label={t('flows.new.machine')}
                  htmlFor="qc-machine"
                  error={tried ? errors.machine : null}
                >
                  <select
                    id="qc-machine"
                    value={machineId}
                    onChange={(e) => setChosenMachine(e.target.value)}
                  >
                    {!machine && <option value="">{t('flows.new.machineNone')}</option>}
                    {machines.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.online}>
                        {m.online ? m.name : `⊘ ${m.name} · ${t('status.offline')}`}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('flows.new.mode')} htmlFor="qc-mode">
                  <select
                    id="qc-mode"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as PermissionMode)}
                  >
                    {PermissionMode.options.map((option) => (
                      <option key={option} value={option}>
                        {option === 'bypassPermissions' ? t('flows.mode.bypassName') : option}
                        {' — '}
                        {t(`flows.mode.desc.${option}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t('flows.new.model')}
                  htmlFor="qc-model"
                  hint={t('flows.new.modelHint')}
                >
                  <input id="qc-model" value={model} onChange={(e) => setModel(e.target.value)} />
                </Field>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={useWorktree}
                    disabled={advice.notGit}
                    onChange={(e) => setWorktreeChoice(e.target.checked)}
                  />
                  {t('flows.new.worktree')}
                </label>
              </div>
            )}

            {bypass && (
              <div className="alert" role="alert" data-testid="bypass-alert">
                <span aria-hidden="true">⛔</span>
                <div className="alert-body">{t('flows.new.bypassWarn')}</div>
              </div>
            )}

            <div className="acts">
              <button type="submit" className="primary" disabled={busy || !connected}>
                {t('flows.new.create')}
              </button>
              <button type="button" aria-expanded={more} onClick={() => setMore((v) => !v)}>
                {more ? t('flows.quick.less') : t('flows.quick.more')}
              </button>
              <a href="#/new">{t('flows.quick.fullForm')}</a>
            </div>
            <Msg note={note} />
          </>
        )}
        <button
          type="button"
          className="quick-close"
          aria-label={t('flows.new.browseClose')}
          onClick={onClose}
        >
          ×
        </button>
      </form>
    </div>
  );
}
