// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AuditEntry, Session, SessionEvent, Team } from '@agent-board/protocol';
import { fakeSearch, type FakeSearchData } from '../shared/fakeSearch';
import { parseHash, searchHash, searchQueryOf } from '../views/overlay';
import { isSearchShortcut, readPrefs } from './prefs';

/** 假的元素：closest 只認得給定的選擇器。 */
const el = (matches: string[] = [], editable = false) => ({
  isContentEditable: editable,
  closest: (selector: string) =>
    matches.some((m) => selector.split(',').some((s) => s.trim() === m)) ? {} : null,
});
const key = (k: string, over: Partial<Parameters<typeof isSearchShortcut>[0]> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  target: el() as unknown as EventTarget,
  ...over,
});

describe('快捷鍵（§3.3、驗收 14）', () => {
  it('⌘K、Ctrl+K 隨時開；/ 只在不是打字時開', () => {
    expect(isSearchShortcut(key('k', { metaKey: true }))).toBe(true);
    expect(isSearchShortcut(key('K', { ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key('/'))).toBe(true);
    expect(isSearchShortcut(key('/', { target: el(['input']) as unknown as EventTarget }))).toBe(
      false,
    );
    expect(isSearchShortcut(key('k', { metaKey: true, target: el(['input']) as never }))).toBe(
      true,
    );
    expect(isSearchShortcut(key('k'))).toBe(false);
    expect(isSearchShortcut(key('/', { isComposing: true }))).toBe(false);
  });

  it('焦點在終端機（xterm）：⌘K 與 / 都交給終端機', () => {
    const term = el(['.xterm']) as unknown as EventTarget;
    expect(isSearchShortcut(key('k', { metaKey: true, target: term }))).toBe(false);
    expect(isSearchShortcut(key('k', { ctrlKey: true, target: term }))).toBe(false);
    expect(isSearchShortcut(key('/', { target: term }))).toBe(false);
  });
});

describe('網址', () => {
  it('#/search 是置中次畫面（手機全螢幕頁），?q= 是查詢字', () => {
    expect(parseHash('#/search')).toEqual({ kind: 'board', right: 'keep', modal: 'search' });
    expect(parseHash('#/search?q=risk.py')).toEqual({
      kind: 'board',
      right: 'keep',
      modal: 'search',
    });
    expect(searchHash('手續費 0.1425')).toBe(`#/search?q=${encodeURIComponent('手續費 0.1425')}`);
    expect(searchQueryOf(searchHash('手續費 0.1425'))).toBe('手續費 0.1425');
    expect(searchQueryOf('#/search')).toBe('');
  });
});

describe('偏好（每台裝置自己記）', () => {
  it('預設全部工作區、7 天、不含封存；壞掉的值回預設', () => {
    expect(readPrefs(null)).toEqual({ scope: 'all', since: '7d', archived: false });
    expect(readPrefs('{"scope":"zone","since":"30d","archived":true}')).toEqual({
      scope: 'zone',
      since: '30d',
      archived: true,
    });
    expect(readPrefs('{"scope":"x","since":1}')).toEqual({
      scope: 'all',
      since: '7d',
      archived: false,
    });
    expect(readPrefs('not json')).toEqual({ scope: 'all', since: '7d', archived: false });
  });
});

describe('假後端的快速層（和 hub 同規則）', () => {
  const now = Date.parse('2026-11-08T12:00:00.000Z');
  const ago = (m: number) => new Date(now - m * 60_000).toISOString();
  const session = (id: string, status: Session['status'], archived = false) =>
    ({
      id,
      name: id,
      machineId: 'm1',
      cwd: '/repo',
      repoRoot: '/repo',
      worktreePath: null,
      branch: null,
      lastLines: [],
      status,
      statusDetail: null,
      statusSince: ago(10),
      lastOutputAt: null,
      archived,
      zoneId: 'main',
    }) as unknown as Session;
  const event = (sessionId: string, type: string, payload: object, m: number): SessionEvent => ({
    id: `${sessionId}-${m}-${type}`,
    sessionId,
    type,
    payload: { ...payload },
    at: ago(m),
  });
  const data = (over: Partial<FakeSearchData> = {}): FakeSearchData => ({
    sessions: [session('a', 'running'), session('b', 'done'), session('c', 'done', true)],
    events: [
      event('b', 'file.changed', { path: '/repo/src/risk.py' }, 60 * 20),
      event('a', 'file.changed', { path: '/repo/src/risk.py' }, 5),
      event('a', 'file.changed', { path: '/repo/src/risk.py' }, 7),
      event('c', 'file.changed', { path: '/repo/src/risk.py' }, 9),
      event('b', 'hook', { last_assistant_message: 'token: sk-ant-demo03-abcdefghijklmnop ok' }, 3),
    ],
    teams: [] as Team[],
    members: [],
    tasks: [],
    audit: [
      {
        id: 'x',
        userId: 'u',
        sessionId: 'a',
        action: 'terminal.input',
        detail: 'fix risk.py',
        at: ago(1),
      } as AuditEntry,
    ],
    role: 'owner',
    now,
    ...over,
  });
  const q = (text: string, over: object = {}) => ({
    q: text,
    scope: 'all' as const,
    since: '7d' as const,
    archived: false,
    mask: false,
    ...over,
  });

  it('檔案改動：RUN 在前、附次數；封存的要勾「含封存」', () => {
    const files = fakeSearch(q('risk.py'), data()).groups.find((g) => g.kind === 'file')!;
    expect(files.items.map((i) => [i.sessionId, i.count, i.snippet])).toEqual([
      ['a', 2, 'src/risk.py'],
      ['b', 1, 'src/risk.py'],
    ]);
    const withArchived = fakeSearch(q('risk.py', { archived: true }), data());
    expect(withArchived.groups[0]?.items.map((i) => i.sessionId)).toEqual(['a', 'c', 'b']);
  });

  it('遮蔽：片段裡沒有金鑰；只有 owner 有送出的指令', () => {
    const masked = fakeSearch(q('token', { mask: true }), data());
    expect(JSON.stringify(masked)).not.toContain('sk-ant');
    expect(fakeSearch(q('fix risk'), data()).groups.map((g) => g.kind)).toEqual(['input']);
    expect(fakeSearch(q('fix risk'), data({ role: 'member' })).groups).toEqual([]);
  });
});

describe('字串', () => {
  it('中英文 key 一致、變數一致；程式用到的 search.* key 都有定義', async () => {
    const { en, zhTW } = await import('./messages');
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, value] of Object.entries(zhTW))
      expect(vars(en[key] ?? ''), key).toEqual(vars(value));
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./SearchPanel.tsx', import.meta.url), 'utf8');
    const used = [...source.matchAll(/'(search\.[\w.]+)'/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((key) => !(key in en))).toEqual([]);
  });
});
