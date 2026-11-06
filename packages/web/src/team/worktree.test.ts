import type { Session } from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import { memberClashes, worktreeConflicts } from './worktree';

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
  archivedAt: null,
  readOnly: false,
  autoContinue: null,
  dispatchedBy: null,
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

describe('只讀成員（研究／審查 + 唯讀 session）可以共用資料夾', () => {
  type Role = 'lead' | 'worker' | 'researcher' | 'reviewer';
  const roleMap = (map: Record<string, Role>) => (id: string) => map[id] ?? 'worker';

  it('只讀的候選者可以和會改檔案的成員同資料夾；plan 模式不算', () => {
    const lead = at({ id: 'lead' });
    const reviewer = at({ id: 'rv', readOnly: true });
    const of = roleMap({});
    expect(worktreeConflicts(reviewer, [lead], { candidate: 'reviewer', of })).toEqual([]);
    // 審查但 session 不是唯讀（就算在 plan）：會改檔案，照樣擋。
    const planOnly = at({ id: 'rv', permissionMode: 'plan' });
    expect(worktreeConflicts(planOnly, [lead], { candidate: 'reviewer', of })).toEqual([lead]);
    // 唯讀 session 但角色是 worker：照樣擋。
    expect(worktreeConflicts(reviewer, [lead], { candidate: 'worker', of })).toEqual([lead]);
  });

  it('已有的只讀成員不擋會改檔案的候選者；兩個只讀也不互擋', () => {
    const researcher = at({ id: 'rs', readOnly: true });
    const of = roleMap({ rs: 'researcher' });
    const bd = at({ id: 'bd' });
    expect(worktreeConflicts(bd, [researcher], { candidate: 'worker', of })).toEqual([]);
    const reviewer = at({ id: 'rv', readOnly: true });
    expect(worktreeConflicts(reviewer, [researcher], { candidate: 'reviewer', of })).toEqual([]);
    // 研究成員被改成 worker 角色：變成會改檔案。
    expect(
      worktreeConflicts(bd, [researcher], { candidate: 'worker', of: roleMap({ rs: 'worker' }) }),
    ).toEqual([researcher]);
  });

  it('memberClashes：舊資料裡的衝突，兩邊的成員列都會提醒', () => {
    const lead = at({ id: 'lead' });
    const rv = at({ id: 'rv', readOnly: true });
    const of = roleMap({ lead: 'lead', rv: 'reviewer' });
    expect(memberClashes(rv, [lead, rv], of)).toEqual([]);
    expect(memberClashes(lead, [lead, rv], of)).toEqual([]);
    const writer = at({ id: 'rv' });
    expect(memberClashes(writer, [lead, writer], of)).toEqual([lead]);
    expect(memberClashes(lead, [lead, writer], of)).toEqual([writer]);
    // 各自有 worktree 的不提醒；已結束的不提醒。
    const own = at({ id: 'bd', worktreePath: '/wt/bd', repoRoot: '/wt/bd' });
    expect(memberClashes(own, [lead, own], of)).toEqual([]);
    expect(memberClashes({ ...writer, status: 'done' }, [lead], of)).toEqual([]);
  });
});
