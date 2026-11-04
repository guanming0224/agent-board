// 新增 session 的共用零件：完整表單（NewSessionPage）與畫布上的快速建立（QuickCreate）都用。
import { useCallback, useEffect, useState } from 'react';
import { sameWorkingTree } from '@agent-board/protocol';
import type { Machine, Project, RepoInfo, Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useProjects as useProjectNames } from '../views/useBoardLoad';
import {
  ErrorBox,
  errorText,
  Loading,
  Msg,
  useLoad,
  type Loaded,
  type Note,
  type T,
} from './common';

export const TASK_TYPES = ['general', 'gpu', 'heavy'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** 打字時不要每個字都去問 daemon。 */
const REPO_LOOKUP_DELAY_MS = 400;

export const isActive = (s: Session) => !s.archived && s.status !== 'done';

export function suggestMachine(
  machines: readonly Machine[],
  sessions: readonly Session[],
  task: TaskType,
): Machine | null {
  const online = machines.filter((m) => m.online);
  const load = (m: Machine) => sessions.filter((s) => s.machineId === m.id && isActive(s)).length;
  const fewestSessions = (list: Machine[]) =>
    [...list].sort((a, b) => load(a) - load(b))[0] ?? null;
  if (task === 'gpu') return fewestSessions(online.filter((m) => m.capabilities.hasGpu));
  if (task === 'heavy') {
    const size = (m: Machine) => m.capabilities.cpuCores * m.capabilities.memoryBytes;
    return [...online].sort((a, b) => size(b) - size(a) || load(a) - load(b))[0] ?? null;
  }
  return fewestSessions(online);
}

export const trimSlash = (path: string) => path.replace(/[\\/]+$/, '');

/** 路徑最後一段，當成新 session 名稱的預設值。 */
export const folderName = (path: string) => trimSlash(path).split(/[\\/]/).pop() ?? '';

/** 同一個資料夾，或一個在另一個裡面。 */
function samePlace(a: string, b: string): boolean {
  const x = trimSlash(a);
  const y = trimSlash(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** session 實際改檔案的地方：有自己的 worktree 就是那裡。 */
const workDir = (s: Session) => s.worktreePath ?? s.cwd;

/**
 * 選定資料夾所在的 repo（daemon 跑 `git rev-parse`，借用資料夾瀏覽的回應）。
 * undefined：還沒問到；null：不是 git、問不到或機器離線，退回只比資料夾。
 */
function useRepoOf(machine: Machine | undefined, path: string): RepoInfo | null | undefined {
  const { backend } = useBoard();
  const [found, setFound] = useState<{ key: string; repo: RepoInfo | null } | null>(null);
  const machineId = machine?.online ? machine.id : '';
  const key = machineId && path ? `${machineId}\n${path}` : '';
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      backend.browseDirectory(machineId, path).then(
        (listing) => !cancelled && setFound({ key, repo: listing.repo ?? null }),
        () => !cancelled && setFound({ key, repo: null }),
      );
    }, REPO_LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, key, machineId, path]);
  if (!key) return null;
  return found?.key === key ? found.repo : undefined;
}

/**
 * 同一個 working tree 已有哪些 session（會互相改到檔案，預設開 worktree），
 * 以及同 repo 但各自在 linked worktree 的（不會衝突，只告知）。
 */
export function useWorktreeAdvice(machine: Machine | undefined, cwd: string) {
  const { sessions } = useBoard();
  const dir = cwd.trim();
  const cwdRepo = useRepoOf(machine, dir);
  const here = { dir, repoRoot: cwdRepo?.root ?? null };
  const sameMachine = sessions.filter((s) => s.machineId === machine?.id && isActive(s));
  const related = sameMachine.filter((s) =>
    sameWorkingTree({ dir: workDir(s), repoRoot: s.repoRoot }, here),
  );
  const relatedByRepo = related.some((s) => !samePlace(workDir(s), dir));
  const siblings = cwdRepo
    ? sameMachine.filter((s) => s.repoCommonDir === cwdRepo.commonDir && !related.includes(s))
    : [];
  return { related, relatedByRepo, siblings };
}

export function WorktreeHints({
  related,
  relatedByRepo,
  siblings,
}: ReturnType<typeof useWorktreeAdvice>) {
  const t = useT();
  return (
    <>
      {related.length > 0 && (
        <p className="hint you" data-testid="worktree-hint">
          {t(relatedByRepo ? 'flows.new.worktreeRepoHint' : 'flows.new.worktreeHint', {
            n: related.length,
            names: related.map((s) => s.name).join('、'),
          })}
        </p>
      )}
      {siblings.length > 0 && (
        <p className="hint" data-testid="worktree-siblings">
          {t('flows.new.worktreeSiblings', {
            n: siblings.length,
            names: siblings.map((s) => s.name).join('、'),
          })}
        </p>
      )}
    </>
  );
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string | null;
  hint?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="hint">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

/** daemon 回的是 Node 的錯誤字串；常見的換成白話。 */
function mkdirError(t: T, raw: string): string {
  if (raw.includes('EEXIST')) return t('flows.new.mkdirExists');
  if (raw.includes('EACCES') || raw.includes('EPERM')) return t('flows.new.mkdirDenied');
  if (raw.includes('invalid_folder_name') || raw.includes('invalid folder name')) {
    return t('flows.new.mkdirBadName');
  }
  return t('flows.new.mkdirFailed', { error: raw });
}

/** 名稱不能是 . ..、不能有 / \；和 protocol 的 FolderName 一致，先在畫面上擋。 */
const badFolderName = (name: string) => name === '.' || name === '..' || /[\\/\0]/.test(name);

function NewFolder({
  machine,
  parent,
  onMade,
}: {
  machine: Machine;
  parent: string;
  onMade: (path: string) => void;
}) {
  const t = useT();
  const { backend } = useBoard();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  if (!open) {
    return (
      <button type="button" data-testid="new-folder" onClick={() => setOpen(true)}>
        {t('flows.new.mkdir')}
      </button>
    );
  }
  const make = async () => {
    const trimmed = name.trim();
    if (!trimmed || badFolderName(trimmed)) {
      setNote({ text: t('flows.new.mkdirBadName'), tone: 'err' });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const made = await backend.makeDirectory(machine.id, parent, trimmed);
      setOpen(false);
      setName('');
      onMade(made.path);
    } catch (e) {
      setNote({ text: mkdirError(t, errorText(e)), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="new-folder">
      <div className="input-row">
        <input
          aria-label={t('flows.new.mkdirName')}
          placeholder={t('flows.new.mkdirName')}
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void make();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        <button type="button" className="primary" disabled={busy} onClick={() => void make()}>
          {t('flows.new.mkdirCreate')}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          {t('flows.new.browseClose')}
        </button>
      </div>
      <p className="hint">{t('flows.new.mkdirWhere', { path: `${machine.name}:${parent}` })}</p>
      <Msg note={note} />
    </div>
  );
}

export function FolderBrowser({
  machine,
  start,
  onPick,
  onClose,
}: {
  machine: Machine;
  start: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { backend } = useBoard();
  const [path, setPath] = useState(start || '~');
  const sep = machine.os === 'win32' ? '\\' : '/';
  const listing = useLoad(
    useCallback(() => backend.browseDirectory(machine.id, path), [backend, machine.id, path]),
  );
  const shown = listing.data?.path ?? path;
  const up = () => {
    const cut = trimSlash(shown).lastIndexOf(sep);
    setPath(cut > 0 ? shown.slice(0, cut) : sep);
  };
  const folders = listing.data?.entries.filter((e) => e.isDir) ?? [];
  return (
    <div className="browser" data-testid="folder-browser">
      <div className="browser-head">
        <span className="callsign">
          {machine.name}:{shown}
        </span>
      </div>
      {listing.error ? (
        <ErrorBox
          what={t('flows.new.browseError', { path, error: listing.error })}
          how={t('flows.new.browseHow')}
          onRetry={listing.reload}
        />
      ) : listing.loading ? (
        <Loading />
      ) : folders.length === 0 ? (
        <p className="hint">{t('flows.new.browseEmpty')}</p>
      ) : (
        <ul className="browser-list">
          {folders.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                onClick={() => setPath(`${trimSlash(shown)}${sep}${entry.name}`)}
              >
                {entry.name}
              </button>
              {entry.isGitRepo && <span className="chip">git</span>}
            </li>
          ))}
        </ul>
      )}
      {listing.data && <NewFolder machine={machine} parent={shown} onMade={onPick} />}
      <div className="acts">
        <button type="button" onClick={up}>
          {t('flows.new.browseUp')}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!listing.data}
          onClick={() => onPick(shown)}
        >
          {t('flows.new.browsePick')}
        </button>
        <button type="button" onClick={onClose}>
          {t('flows.new.browseClose')}
        </button>
      </div>
    </div>
  );
}

const NEW_PROJECT = '__new__';

/**
 * 專案下拉選單，最後一項「＋ 新增專案」在原地輸入名稱建立。
 * 專案不給顏色：顏色只回答「球在誰手上」（STYLE.md 規則一），專案只出現在呼號裡。
 */
export function ProjectSelect({
  id,
  projects,
  value,
  onChange,
}: {
  id: string;
  projects: Loaded<Project[]>;
  value: string;
  onChange: (projectId: string) => void;
}) {
  const t = useT();
  const { backend } = useBoard();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNote({ text: t('flows.new.projectNeedsName'), tone: 'err' });
      return;
    }
    // 同名的就直接選它，不建第二個。
    const same = projects.data?.find((p) => p.name.toLowerCase() === trimmed.toLowerCase());
    if (same) {
      onChange(same.id);
      setAdding(false);
      setName('');
      setNote(null);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const created = await backend.createProject({ name: trimmed, color: '' });
      // 呼號用的專案清單在 views 的 store，一起更新，卡片才會馬上顯示新名稱。
      useProjectNames.setState((s) => ({ projects: [...s.projects, created] }));
      projects.reload();
      onChange(created.id);
      setAdding(false);
      setName('');
    } catch (e) {
      setNote({ text: t('flows.new.projectFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  // 剛建好、清單還沒重新讀到時，先放一個臨時選項，選單才不會跳回「不指定」。
  const known = projects.data ?? [];
  const pending = value && !known.some((p) => p.id === value);
  const pendingName = useProjectNames((s) => s.projects.find((p) => p.id === value)?.name);

  return (
    <>
      <select
        id={id}
        value={adding ? NEW_PROJECT : value}
        onChange={(e) => {
          if (e.target.value === NEW_PROJECT) {
            setAdding(true);
            setNote(null);
          } else {
            setAdding(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">{t('flows.new.projectNone')}</option>
        {known.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {pending && <option value={value}>{pendingName ?? value}</option>}
        <option value={NEW_PROJECT}>{t('flows.new.projectAdd')}</option>
      </select>
      {adding && (
        <div className="input-row new-project">
          <input
            aria-label={t('flows.new.projectName')}
            placeholder={t('flows.new.projectName')}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setAdding(false);
              }
            }}
          />
          <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
            {t('flows.new.projectCreate')}
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            {t('flows.new.browseClose')}
          </button>
        </div>
      )}
      <Msg note={note} />
    </>
  );
}
