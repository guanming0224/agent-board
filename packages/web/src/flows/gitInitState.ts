// session 卡片與全尺寸頁上的「在這裡 git init」（GM 2026-11-14，CONTRACTS §24.5）：哪些 session 要顯示、
// 隊長開成員因為不是 git 被擋的提示。畫面在 SessionGitInit.tsx。
import { useEffect } from 'react';
import { create } from 'zustand';
import { NOT_GIT_BLOCKED_EVENT, type Session, type SessionEvent } from '@agent-board/protocol';
import type { BoardBackend } from '../shared/backend';

/**
 * 這個 session 的資料夾不是 git、而且 git init 之後 daemon 會讓它即時換上 repo：
 * 沒封存、`repoRoot` 為 null、不是自己的 worktree、PTY 還在（失聯與已結束的 daemon 不會重算，提示消不掉）。
 */
export function needsGitInit(
  session: Pick<Session, 'repoRoot' | 'worktreePath' | 'archived' | 'status'>,
): boolean {
  return (
    !session.archived &&
    session.repoRoot === null &&
    session.worktreePath === null &&
    session.status !== 'offline' &&
    session.status !== 'done'
  );
}

/** 隊長開成員因為不是 git 被擋的時間（sessionId → ms）。只記這個瀏覽器分頁開著時收到的事件。 */
export type NotGitBlocked = Readonly<Record<string, number>>;

/** 收到一筆事件：只認 hub 記在呼叫者身上的 `dispatch.not_git`，其他原樣回傳。 */
export function recordNotGit(
  map: NotGitBlocked,
  event: Pick<SessionEvent, 'type' | 'sessionId' | 'at'>,
): NotGitBlocked {
  if (event.type !== NOT_GIT_BLOCKED_EVENT) return map;
  const at = Date.parse(event.at);
  return { ...map, [event.sessionId]: Number.isNaN(at) ? Date.now() : at };
}

interface NotGitState {
  blocked: NotGitBlocked;
  record(event: SessionEvent): void;
}

export const useNotGitBlocked = create<NotGitState>((set, get) => ({
  blocked: {},
  record(event) {
    const next = recordNotGit(get().blocked, event);
    if (next !== get().blocked) set({ blocked: next });
  },
}));

/** 聽後端的即時事件（畫布、全尺寸頁各掛一次；同一個事件記兩次結果一樣）。 */
export function useNotGitEvents(backend: BoardBackend) {
  useEffect(() => {
    if (!backend.watchEvents) return;
    const { record } = useNotGitBlocked.getState();
    return backend.watchEvents(record);
  }, [backend]);
}
