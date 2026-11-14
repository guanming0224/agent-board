// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NOT_GIT_BLOCKED_EVENT, type Session } from '@agent-board/protocol';
import { needsGitInit, recordNotGit } from './gitInitState';

const base: Pick<Session, 'repoRoot' | 'worktreePath' | 'archived' | 'status'> = {
  repoRoot: null,
  worktreePath: null,
  archived: false,
  status: 'waiting_input',
};

describe('卡片上的 git init（CONTRACTS §24.5）', () => {
  it('只有不是 git、不是自己的 worktree、還在跑的 session 要顯示', () => {
    expect(needsGitInit(base)).toBe(true);
    expect(needsGitInit({ ...base, status: 'running' })).toBe(true);
    expect(needsGitInit({ ...base, status: 'queued' })).toBe(true);
    // 已經是 git（git init 成功後 hub 推來新的 repoRoot）：提示消失。
    expect(needsGitInit({ ...base, repoRoot: '/r' })).toBe(false);
    expect(needsGitInit({ ...base, worktreePath: '/wt/x' })).toBe(false);
    expect(needsGitInit({ ...base, archived: true })).toBe(false);
    // daemon 不會替失聯或已結束的 session 重算，提示消不掉，不顯示。
    expect(needsGitInit({ ...base, status: 'offline' })).toBe(false);
    expect(needsGitInit({ ...base, status: 'done' })).toBe(false);
  });

  it('只記 hub 的 dispatch.not_git，其他事件原樣回傳', () => {
    const at = '2026-11-14T03:00:00.000Z';
    const empty = {};
    expect(recordNotGit(empty, { type: 'dispatch.blocked', sessionId: 's1', at })).toBe(empty);
    const map = recordNotGit(empty, { type: NOT_GIT_BLOCKED_EVENT, sessionId: 's1', at });
    expect(map).toEqual({ s1: Date.parse(at) });
    expect(recordNotGit(map, { type: NOT_GIT_BLOCKED_EVENT, sessionId: 's2', at })).toEqual({
      s1: Date.parse(at),
      s2: Date.parse(at),
    });
  });
});
