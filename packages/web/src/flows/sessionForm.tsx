// 新增 session 的共用零件：完整表單（NewSessionPage）與畫布上的快速建立（QuickCreate）都用。
import { useCallback, useEffect, useRef, useState } from 'react';
import { sameWorkingTree } from '@agent-board/protocol';
import type { Machine, Project, RepoInfo, Session } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useProjects as useProjectNames } from '../views/useBoardLoad';
import { ErrorBox, errorText, Loading, Msg, type Loaded, type Note, type T } from './common';
import {
  breadcrumbs,
  childPath,
  parentPath,
  readLastFolder,
  readStartFolder,
  recentFolders,
  saveLastFolder,
  saveStartFolder,
} from './folders';

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

/**
 * 選資料夾時帶入名稱：名稱欄是空的，或還是上次自動帶入的資料夾名，才換成新的資料夾名。
 * 使用者自己打過的名稱不動。
 */
export function useFolderNameFill(name: string, setName: (value: string) => void) {
  const auto = useRef('');
  return (path: string) => {
    if (name.trim() && name !== auto.current) return;
    const next = folderName(path);
    auto.current = next;
    setName(next);
  };
}

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
 * null：daemon 確認不是 git；undefined：還沒問到、問不到或機器離線。兩者都退回只比資料夾。
 */
function useRepoOf(machine: Machine | undefined, path: string): RepoInfo | null | undefined {
  const { backend } = useBoard();
  const [found, setFound] = useState<{ key: string; repo: RepoInfo | null | undefined } | null>(
    null,
  );
  const machineId = machine?.online ? machine.id : '';
  const key = machineId && path ? `${machineId}\n${path}` : '';
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      backend.browseDirectory(machineId, path).then(
        (listing) => !cancelled && setFound({ key, repo: listing.repo }),
        () => !cancelled && setFound({ key, repo: undefined }),
      );
    }, REPO_LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, key, machineId, path]);
  if (!key) return undefined;
  return found?.key === key ? found.repo : undefined;
}

/**
 * 同一個 working tree 已有哪些 session（會互相改到檔案，預設開 worktree），
 * 以及同 repo 但各自在 linked worktree 的（不會衝突，只告知）。
 * 不是 git 的資料夾開不了 worktree（daemon 跑 `git worktree add` 會失敗），就不預設也不給勾。
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
  return { related, relatedByRepo, siblings, notGit: cwdRepo === null };
}

/** 勾選框的實際值：使用者選過就照選的，否則同 working tree 有人就打開；不是 git 一律關。 */
export const worktreeOn = (advice: ReturnType<typeof useWorktreeAdvice>, choice: boolean | null) =>
  !advice.notGit && (choice ?? advice.related.length > 0);

export function WorktreeHints({
  related,
  relatedByRepo,
  siblings,
  notGit,
}: ReturnType<typeof useWorktreeAdvice>) {
  const t = useT();
  if (notGit) {
    return (
      <p className={related.length > 0 ? 'hint you' : 'hint'} data-testid="worktree-not-git">
        {related.length > 0
          ? t('flows.new.worktreeNotGitShared', {
              n: related.length,
              names: related.map((s) => s.name).join('、'),
            })
          : t('flows.new.worktreeNotGit')}
      </p>
    );
  }
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

type Listing = Awaited<ReturnType<BoardBackend['browseDirectory']>>;

/**
 * 瀏覽遠端資料夾。操作：
 * - 單擊資料夾 = 選取（反白並立刻填入工作目錄欄）；雙擊或列尾「›」= 進入。
 * - 鍵盤：↑↓ 在資料夾之間移動，空白鍵選取（按鈕的原生行為），Enter 或 → 進入，← 或 Backspace 回上一層，
 *   Esc 關閉瀏覽（篩選框有字時先清掉字）。篩選框裡按 ↓ 跳到清單、Enter 進入第一個符合的資料夾。
 *   Enter 用來「進入」而不是「選取」：和檔案總管一樣，往下走是最常做的事；選取已經在單擊時完成。
 * - 起始位置：工作目錄欄有值就從它的上一層開始並反白它；否則上次在這台機器瀏覽到的位置；再否則 ~。
 */
export function FolderBrowser({
  machine,
  start,
  onSelect,
  onPick,
  onClose,
}: {
  machine: Machine;
  /** 工作目錄欄目前的值。 */
  start: string;
  /** 選取：立刻填入工作目錄欄，瀏覽器留著。 */
  onSelect: (path: string) => void;
  /** 選定並關閉（「選這個資料夾」、剛建好的資料夾）。 */
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { backend, sessions } = useBoard();
  const sep = machine.os === 'win32' ? '\\' : '/';
  const desktop = `~${sep}Desktop`;
  const [customStart, setCustomStart] = useState(() => readStartFolder(machine.id));
  const [initial] = useState(() => {
    const field = start.trim();
    if (field) return { path: parentPath(field, sep) ?? field, selected: field };
    // 沒填工作目錄：從使用者設的起始位置開始，沒設就從桌面（GM 2026-11-06）。
    return { path: customStart ?? desktop, selected: null };
  });
  /** 上次瀏覽到的位置，改成捷徑按鈕（不再當起始位置）。 */
  const [last] = useState(() => readLastFolder(machine.id));
  const [path, setPath] = useState(initial.path);
  const [selected, setSelected] = useState<string | null>(initial.selected);
  const [filter, setFilter] = useState('');
  const [round, setRound] = useState(0);
  const [result, setResult] = useState<{ for: string; data?: Listing; error?: string } | null>(
    null,
  );
  /** 點捷徑時：等列出來，選 daemon 回的完整路徑（`~` 會被展開）。 */
  const selectWhenLoaded = useRef<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  // 呼叫端每次重畫都給新的函式；放 ref 才不會讓下面的讀取 effect 一直重跑。
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const select = useCallback((p: string) => {
    setSelected(p);
    onSelectRef.current(p);
  }, []);

  useEffect(() => {
    let live = true;
    backend.browseDirectory(machine.id, path).then(
      (data) => {
        if (!live) return;
        setResult({ for: path, data });
        saveLastFolder(machine.id, data.path);
        if (selectWhenLoaded.current === path) select(data.path);
        selectWhenLoaded.current = null;
      },
      (e: unknown) => {
        if (!live) return;
        // 預設的桌面不存在（例如 Linux 沒有 ~/Desktop）：改從家目錄開始，不顯示錯誤。
        if (path === initial.path && path === desktop && customStart === null) {
          setPath('~');
          return;
        }
        setResult({ for: path, error: errorText(e) });
        selectWhenLoaded.current = null;
      },
    );
    return () => {
      live = false;
    };
  }, [backend, machine.id, path, round, select, initial.path, desktop, customStart]);

  const current = result?.for === path ? result : null;
  const listing = current?.data ?? null;
  const shown = listing?.path ?? path;
  const crumbs = breadcrumbs(shown, sep);
  const up = parentPath(shown, sep);
  const box = useRef<HTMLDivElement>(null);
  /** 換資料夾時焦點在瀏覽器裡：清單會先換成「載入中」，焦點會掉到 body，出來後要接回清單第一列。 */
  const refocus = useRef(false);
  const go = (p: string) => {
    refocus.current = box.current?.contains(document.activeElement) ?? false;
    setPath(p);
    setFilter('');
  };
  const jump = (p: string) => {
    selectWhenLoaded.current = p;
    go(p);
  };
  const needle = filter.trim().toLowerCase();
  const folders = (listing?.entries ?? [])
    .filter((e) => e.isDir)
    .filter((e) => !needle || e.name.toLowerCase().includes(needle));
  const recent = recentFolders(sessions, machine.id);
  const home = '~';

  const picks = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('.pick') ?? [])];
  const onRowKey = (e: React.KeyboardEvent<HTMLButtonElement>, full: string) => {
    const items = picks();
    const i = items.indexOf(e.currentTarget);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : i - 1;
      if (next >= 0) items[next]?.focus();
      else document.getElementById(`fb-${machine.id}-filter`)?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
    } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      go(full);
    } else if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && up) {
      e.preventDefault();
      go(up);
    }
  };
  useEffect(() => {
    if (!listing || !refocus.current) return;
    refocus.current = false;
    (picks()[0] ?? document.getElementById(`fb-${machine.id}-filter`))?.focus();
  }, [listing]);

  const listId = `fb-${machine.id}`;
  return (
    <div
      ref={box}
      className="browser"
      data-testid="folder-browser"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        // 不讓外層（快速建立小卡）一起關掉。
        e.preventDefault();
        onClose();
      }}
    >
      <div className="browser-quick" role="group" aria-label={t('flows.new.browseShortcuts')}>
        {recent.length > 0 && <span className="label">{t('flows.new.browseRecent')}</span>}
        {recent.map((p) => (
          <button
            key={p}
            type="button"
            className="mono"
            title={p}
            data-testid="recent-folder"
            onClick={() => jump(p)}
          >
            {folderName(p) || p}
          </button>
        ))}
        <button type="button" onClick={() => jump(home)}>
          {t('flows.new.browseHome')}
        </button>
        <button type="button" onClick={() => jump(desktop)}>
          {t('flows.new.browseDesktop')}
        </button>
        {last && trimSlash(last) !== trimSlash(customStart ?? '') && (
          <button type="button" className="mono" title={last} onClick={() => jump(last)}>
            {t('flows.new.browseLast', { name: folderName(last) || last })}
          </button>
        )}
      </div>

      <nav className="crumbs" aria-label={t('flows.new.browseWhere', { machine: machine.name })}>
        <span className="crumb-machine">{machine.name}:</span>
        {crumbs.map((c, i) => (
          <span key={c.path} className="crumb">
            {i > 0 && !crumbs[i - 1]!.label.endsWith(sep) && (
              <span className="crumb-sep" aria-hidden="true">
                {sep}
              </span>
            )}
            <button
              type="button"
              aria-current={i === crumbs.length - 1 ? 'location' : undefined}
              onClick={() => go(c.path)}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      <div className="browser-tools">
        <button type="button" className="browser-up" disabled={!up} onClick={() => up && go(up)}>
          {t('flows.new.browseUp')}
        </button>
        <input
          id={`${listId}-filter`}
          type="search"
          aria-label={t('flows.new.browseFilter')}
          placeholder={t('flows.new.browseFilter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              picks()[0]?.focus();
            } else if (e.key === 'Enter') {
              // 不送出外層表單。
              e.preventDefault();
              const first = folders[0];
              if (first && needle) go(childPath(shown, first.name, sep));
            } else if (e.key === 'Escape' && filter) {
              e.preventDefault();
              setFilter('');
            }
          }}
        />
      </div>

      {current?.error ? (
        <ErrorBox
          what={t('flows.new.browseError', { path, error: current.error })}
          how={t('flows.new.browseHow')}
          onRetry={() => setRound((r) => r + 1)}
        />
      ) : !listing ? (
        <Loading />
      ) : folders.length === 0 ? (
        <p className="hint">
          {needle ? t('flows.new.browseNoMatch', { q: filter.trim() }) : t('flows.new.browseEmpty')}
        </p>
      ) : (
        <ul className="browser-list" id={listId} ref={list} aria-label={t('flows.new.browseList')}>
          {folders.map((entry) => {
            const full = childPath(shown, entry.name, sep);
            const on = selected !== null && trimSlash(selected) === trimSlash(full);
            return (
              <li key={entry.name} className={on ? 'on' : undefined}>
                <button
                  type="button"
                  className="pick"
                  aria-pressed={on}
                  onClick={() => select(full)}
                  onDoubleClick={() => go(full)}
                  onKeyDown={(e) => onRowKey(e, full)}
                >
                  {entry.name}
                </button>
                {entry.isGitRepo && <span className="chip">git</span>}
                <button
                  type="button"
                  className="enter"
                  aria-label={t('flows.new.browseEnter', { name: entry.name })}
                  title={t('flows.new.browseEnter', { name: entry.name })}
                  onClick={() => go(full)}
                >
                  ›
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="hint browser-selected" data-testid="browser-selected">
        {t('flows.new.browseSelected')}{' '}
        <span className="mono">{selected ?? t('flows.new.browseNone')}</span>
      </p>

      <p className="hint browser-start" data-testid="browser-start">
        {t('flows.new.browseStart')}{' '}
        <span className="mono">{customStart ?? t('flows.new.browseStartDefault')}</span>{' '}
        {listing && trimSlash(listing.path) !== trimSlash(customStart ?? '') && (
          <button
            type="button"
            onClick={() => {
              saveStartFolder(machine.id, listing.path);
              setCustomStart(listing.path);
            }}
          >
            {t('flows.new.browseSetStart')}
          </button>
        )}{' '}
        {customStart !== null && (
          <button
            type="button"
            onClick={() => {
              saveStartFolder(machine.id, null);
              setCustomStart(null);
            }}
          >
            {t('flows.new.browseResetStart')}
          </button>
        )}
      </p>

      {listing && <NewFolder machine={machine} parent={shown} onMade={onPick} />}
      <div className="acts">
        <button type="button" className="primary" disabled={!listing} onClick={() => onPick(shown)}>
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
