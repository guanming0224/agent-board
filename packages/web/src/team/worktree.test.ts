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

  it('flags two sessions sharing one worktree', () => {
    const c = session('c', { worktreePath: '/wt/x' });
    expect(worktreeConflicts(c, [session('a', { worktreePath: '/wt/x' })])).toHaveLength(1);
  });
});
