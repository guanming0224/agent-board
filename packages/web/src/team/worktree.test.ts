import type { Session } from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import { worktreeConflicts } from './worktree';

const session = (id: string, over: Partial<Session>): Session =>
  ({
    id,
    machineId: 'm1',
    cwd: '/r',
    worktreePath: null,
    status: 'running',
    endedAt: null,
    ...over,
  }) as Session;

describe('worktreeConflicts', () => {
  it('flags the same folder and nested folders on one machine', () => {
    const c = session('c', {});
    expect(worktreeConflicts(c, [session('a', {})]).map((s) => s.id)).toEqual(['a']);
    expect(worktreeConflicts(c, [session('a', { cwd: '/r/sub/' })]).map((s) => s.id)).toEqual([
      'a',
    ]);
    expect(worktreeConflicts(session('c', { cwd: '/r/sub' }), [session('a', {})])).toHaveLength(1);
  });

  it('allows own worktrees, other machines, siblings and ended members', () => {
    const c = session('c', {});
    expect(worktreeConflicts(c, [session('a', { worktreePath: '/wt/a' })])).toEqual([]);
    expect(worktreeConflicts(session('c', { worktreePath: '/wt/c' }), [session('a', {})])).toEqual(
      [],
    );
    expect(worktreeConflicts(c, [session('a', { machineId: 'm2' })])).toEqual([]);
    expect(worktreeConflicts(c, [session('a', { cwd: '/r2' })])).toEqual([]);
    expect(worktreeConflicts(c, [session('a', { endedAt: '2026-01-01T00:00:00Z' })])).toEqual([]);
    expect(worktreeConflicts(c, [session('a', { status: 'done' })])).toEqual([]);
    expect(worktreeConflicts(c, [c])).toEqual([]);
  });

  it('leaves sessions still starting to the hub, which can see their worktree setting', () => {
    const c = session('c', {});
    expect(worktreeConflicts(c, [session('a', { status: 'starting' })])).toEqual([]);
    expect(worktreeConflicts(session('c', { status: 'queued' }), [session('a', {})])).toEqual([]);
  });

  it('flags two sessions sharing one worktree', () => {
    const c = session('c', { worktreePath: '/wt/x' });
    expect(worktreeConflicts(c, [session('a', { worktreePath: '/wt/x' })])).toHaveLength(1);
  });
});

const base: Session = {
  id: 'a',
  machineId: 'm',
  projectId: null,
  name: 'a',
  cwd: '/r/a',
  branch: null,
  worktreePath: null,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  status: 'running',
  statusDetail: null,
  claudeSessionId: null,
  lastLines: [],
  lastOutputAt: null,
  statusSince: '2026-11-03T00:00:00Z',
  contextTokens: null,
  contextWindow: null,
  repoRoot: '/r',
  repoCommonDir: '/r/.git',
  createdAt: '2026-11-03T00:00:00Z',
  endedAt: null,
  archived: false,
};
const at = (over: Partial<Session>): Session => ({ ...base, ...over });

describe('worktreeConflicts：daemon 回報的 repo 根目錄', () => {
  it('同 repo 的不同子資料夾算衝突（依 daemon 回報的根目錄）', () => {
    const member = at({ id: 'b', name: 'b', cwd: '/r/b' });
    expect(worktreeConflicts(base, [member])).toEqual([member]);
  });

  it('同 repo 但各自在 linked worktree 不算；另一台機器也不算', () => {
    const linked = at({
      id: 'b',
      cwd: '/r/.wt/x',
      worktreePath: '/r/.wt/x',
      repoRoot: '/r/.wt/x',
    });
    const remote = at({ id: 'c', machineId: 'other', cwd: '/r/b' });
    expect(worktreeConflicts(base, [linked, remote])).toEqual([]);
  });

  it('根目錄還不知道時退回比資料夾', () => {
    const unknown = { repoRoot: null, repoCommonDir: null };
    const nested = at({ id: 'b', cwd: '/r/a/deep', ...unknown });
    const sibling = at({ id: 'c', cwd: '/r/b', ...unknown });
    expect(worktreeConflicts(at(unknown), [nested, sibling])).toEqual([nested]);
  });
});
