// 把 hook 設定合併進 <cwd>/.claude/settings.local.json（CONTRACTS.md §4.1）。
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CLAUDE_HOOK_EVENTS,
  HOOK_COMMAND,
  HOOK_TIMEOUT_SECONDS,
  HookEventName,
} from '@agent-board/protocol';

/** Claude Code 對 SessionEnd hook 的 timeout 上限（docs/claude-code-notes.md）。 */
const SESSION_END_MAX_TIMEOUT_SECONDS = 60;

/** 設定檔內容無法安全合併。檔案沒有被動過，呼叫方應回報 session.event 警告。 */
export class HookSettingsError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Cannot merge hooks into ${path}: ${reason}`, options);
    this.name = 'HookSettingsError';
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timeoutFor(event: HookEventName): number {
  return event === 'SessionEnd'
    ? Math.min(HOOK_TIMEOUT_SECONDS, SESSION_END_MAX_TIMEOUT_SECONDS)
    : HOOK_TIMEOUT_SECONDS;
}

const CLAUDE_EVENTS: ReadonlySet<string> = new Set(CLAUDE_HOOK_EVENTS);

/**
 * 拿掉我們自己寫進 Claude 不認得事件的 hook（cd4e753 曾誤裝 Interrupt、PostModelRequest，
 * 會讓 Claude Code 啟動時卡在設定錯誤對話框）。只動 command 是 `agent-board-hook <Event>` 的項目，
 * 別人的設定原樣保留；拿完變空的群組與事件鍵一併刪掉。
 */
function removeForeignEvents(hooks: Record<string, unknown>): boolean {
  let changed = false;
  for (const event of HookEventName.options) {
    if (CLAUDE_EVENTS.has(event)) continue;
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const command = `${HOOK_COMMAND} ${event}`;
    const next: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        next.push(group);
        continue;
      }
      const handlers = group.hooks as unknown[];
      const kept = handlers.filter((h) => !(isRecord(h) && h.command === command));
      if (kept.length === handlers.length) next.push(group);
      else if (kept.length > 0) next.push({ ...group, hooks: kept });
    }
    if (next.length === groups.length && next.every((g, i) => g === groups[i])) continue;
    changed = true;
    if (next.length === 0) delete hooks[event];
    else hooks[event] = next;
  }
  return changed;
}

/** 就地合併，回傳有沒有變動。不認得的內容一律原樣保留。 */
function mergeHooks(settings: Record<string, unknown>, path: string): boolean {
  const hooks = settings.hooks ?? {};
  if (!isRecord(hooks)) throw new HookSettingsError(path, '"hooks" is not an object');
  let changed = settings.hooks === undefined;
  settings.hooks = hooks;

  if (removeForeignEvents(hooks)) changed = true;

  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) {
      throw new HookSettingsError(path, `"hooks.${event}" is not an array`);
    }
    const command = `${HOOK_COMMAND} ${event}`;
    const timeout = timeoutFor(event);
    const existing = groups
      .flatMap((group: unknown) =>
        isRecord(group) && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : [],
      )
      .filter(isRecord)
      .filter((handler) => handler.command === command);

    if (existing.length === 0) {
      groups.push({ hooks: [{ type: 'command', command, timeout }] });
      hooks[event] = groups;
      changed = true;
      continue;
    }
    for (const handler of existing) {
      if (handler.timeout !== timeout) {
        handler.timeout = timeout;
        changed = true;
      }
    }
  }
  return changed;
}

async function writeAtomically(path: string, text: string, mode: number | null): Promise<void> {
  const tempPath = join(dirname(path), `.settings.local.json.${randomUUID()}.tmp`);
  try {
    const file = await open(tempPath, 'wx', mode ?? 0o644);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    // open 的 mode 會被 umask 遮罩，要維持原檔權限得明確設定。
    if (mode !== null) await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function installHooks(cwd: string): Promise<void> {
  const linkPath = join(cwd, '.claude', 'settings.local.json');
  // 設定檔可能是 symlink；rename 到連結路徑會把連結換成一般檔案。
  const path = await realpath(linkPath).catch((error: unknown) => {
    if (isNotFound(error)) return linkPath;
    throw error;
  });

  let raw: string | null = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  let settings: unknown = {};
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch (error) {
      throw new HookSettingsError(path, 'invalid JSON', { cause: error });
    }
    if (!isRecord(settings)) throw new HookSettingsError(path, 'top level is not an object');
  }

  const changed = mergeHooks(settings as Record<string, unknown>, path);
  if (raw !== null && !changed) return;

  await mkdir(dirname(path), { recursive: true });
  const mode = raw === null ? null : (await stat(path)).mode & 0o777;
  await writeAtomically(path, `${JSON.stringify(settings, null, 2)}\n`, mode);
}
