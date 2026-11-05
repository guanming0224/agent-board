import { describe, expect, it } from 'vitest';
import type { Session } from '@agent-board/protocol';
import { breadcrumbs, childPath, parentPath, recentFolders } from './folders';

describe('breadcrumbs', () => {
  it('POSIX：根目錄是 /，每段都能點', () => {
    expect(breadcrumbs('/home/me/project/', '/')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'me', path: '/home/me' },
      { label: 'project', path: '/home/me/project' },
    ]);
    expect(breadcrumbs('/', '/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('Windows：磁碟機是第一段，用 \\', () => {
    expect(breadcrumbs('C:\\Users\\me', '\\')).toEqual([
      { label: 'C:\\', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'me', path: 'C:\\Users\\me' },
    ]);
    expect(breadcrumbs('C:\\', '\\')).toEqual([{ label: 'C:\\', path: 'C:\\' }]);
  });

  it('~ 開頭（還沒展開）', () => {
    expect(breadcrumbs('~/code', '/')).toEqual([
      { label: '~', path: '~' },
      { label: 'code', path: '~/code' },
    ]);
  });
});

describe('parentPath／childPath', () => {
  it('最上層沒有上一層', () => {
    expect(parentPath('/home/me', '/')).toBe('/home');
    expect(parentPath('/home', '/')).toBe('/');
    expect(parentPath('/', '/')).toBeNull();
    expect(parentPath('C:\\Users', '\\')).toBe('C:\\');
    expect(parentPath('~', '/')).toBeNull();
  });

  it('不會多一個分隔符', () => {
    expect(childPath('/', 'etc', '/')).toBe('/etc');
    expect(childPath('/home/', 'me', '/')).toBe('/home/me');
    expect(childPath('C:\\', 'Users', '\\')).toBe('C:\\Users');
  });
});

describe('recentFolders', () => {
  const s = (id: string, machineId: string, cwd: string, minutes: number) =>
    ({
      id,
      machineId,
      cwd,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString(),
    }) as Session;

  it('同一台機器、新到舊、去重、最多 5 個', () => {
    const list = [
      s('1', 'a', '/x', 1),
      s('2', 'a', '/y', 2),
      s('3', 'b', '/z', 3),
      s('4', 'a', '/x', 4),
      ...[5, 6, 7, 8, 9].map((n) => s(String(n), 'a', `/p${n}`, n)),
    ];
    expect(recentFolders(list, 'a')).toEqual(['/p9', '/p8', '/p7', '/p6', '/p5']);
    expect(recentFolders(list.slice(0, 4), 'a')).toEqual(['/x', '/y']);
  });
});
