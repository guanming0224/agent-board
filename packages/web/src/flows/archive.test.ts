import { describe, expect, it } from 'vitest';
import type { Machine, Session } from '@agent-board/protocol';
import { formatBytes, matchesArchived, sortArchived, stopsOnArchive } from './archive';

describe('formatBytes', () => {
  it('KB／MB', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(348_160)).toBe('340 KB');
    expect(formatBytes(1_843_200)).toBe('1.8 MB');
  });
});

const base = {
  machineId: 'm',
  projectId: null,
  cwd: '/work/api',
  branch: 'ab/x',
  worktreePath: null,
  createdAt: '2026-01-01T00:00:00.000Z',
} as const;

describe('sortArchived', () => {
  it('封存時間新到舊，沒有封存時間的排最後', () => {
    const list = [
      { ...base, id: 'old', name: 'a', archivedAt: null, createdAt: '2026-01-02T00:00:00.000Z' },
      { ...base, id: 'b', name: 'b', archivedAt: '2026-02-01T00:00:00.000Z' },
      { ...base, id: 'c', name: 'c', archivedAt: '2026-03-01T00:00:00.000Z' },
      { ...base, id: 'older', name: 'd', archivedAt: null },
    ] as unknown as Session[];
    expect(sortArchived(list).map((s) => s.id)).toEqual(['c', 'b', 'old', 'older']);
  });
});

describe('matchesArchived', () => {
  const machines = [{ id: 'm', name: 'rig-a' }] as Machine[];
  const projects = [{ id: 'p', name: '記帳', color: '' }];
  const s = { ...base, id: 's', name: 'Fix login', projectId: 'p' } as unknown as Session;
  it('名稱、呼號、資料夾、專案，不分大小寫', () => {
    for (const q of ['fix', 'RIG-A', '/work', '記帳', 'ab/x', '']) {
      expect(matchesArchived(s, q, machines, projects)).toBe(true);
    }
    expect(matchesArchived(s, 'nope', machines, projects)).toBe(false);
  });
});

describe('stopsOnArchive', () => {
  it('還沒結束的要確認；done／error／offline 或已結束的不用', () => {
    expect(stopsOnArchive({ status: 'running', endedAt: null })).toBe(true);
    expect(stopsOnArchive({ status: 'queued', endedAt: null })).toBe(true);
    expect(stopsOnArchive({ status: 'waiting_input', endedAt: null })).toBe(true);
    expect(stopsOnArchive({ status: 'done', endedAt: null })).toBe(false);
    expect(stopsOnArchive({ status: 'error', endedAt: null })).toBe(false);
    expect(stopsOnArchive({ status: 'offline', endedAt: null })).toBe(false);
    expect(stopsOnArchive({ status: 'running', endedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
  });
});
