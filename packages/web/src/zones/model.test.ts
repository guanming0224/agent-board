import { describe, expect, it } from 'vitest';
import type { Approval, Session, Team, TeamMember } from '@agent-board/protocol';
import { validZone, zoneOfSession, zonesOf, zoneWaitingCounts } from './model';

const team = (id: string, name: string, zoneId: string): Team => ({
  id,
  name,
  goal: '',
  doneCriteria: '',
  color: 'teal',
  contextMd: '',
  zoneId,
});

const s = (id: string, over: Partial<Session> = {}) =>
  ({
    id,
    zoneId: 'main',
    status: 'running',
    statusDetail: null,
    archived: false,
    ...over,
  }) as Session;

describe('工作區（zone）', () => {
  it('團隊成員跟著團隊；單獨 session 看自己的 zoneId', () => {
    const teams = [team('t1', 'B', 'z2'), team('t2', 'A', 'z3')];
    const members: TeamMember[] = [
      { teamId: 't1', sessionId: 'm', role: 'lead' },
      { teamId: 't1', sessionId: 'both', role: 'worker' },
      { teamId: 't2', sessionId: 'both', role: 'worker' },
    ];
    expect(zoneOfSession(s('m'), teams, members)).toBe('z2');
    expect(zoneOfSession(s('solo', { zoneId: 'z9' }), teams, members)).toBe('z9');
    // 同時在兩個團隊：取名稱排序第一個（和 hub 相同）。
    expect(zoneOfSession(s('both'), teams, members)).toBe('z3');
  });

  it('每個工作區的等你數（和頁首同一套定義：NEW 不算、有 approval 的算）', () => {
    const teams = [team('t1', 'T', 'b')];
    const members: TeamMember[] = [{ teamId: 't1', sessionId: 'ask', role: 'lead' }];
    const sessions = [
      s('ask', { status: 'waiting_input' }),
      s('new', { status: 'waiting_input', statusDetail: 'idle:start' }),
      s('perm', { status: 'running' }),
      s('run'),
    ];
    const approvals = [{ sessionId: 'perm' }] as Approval[];
    const counts = zoneWaitingCounts(sessions, approvals, teams, members);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('main')).toBe(1);
  });

  it('記住的工作區被刪了就用第一個；舊版 hub 沒有清單時只有預設工作區', () => {
    const zones = zonesOf([
      { id: 'b', name: 'B', createdAt: '2026-11-08T01:00:00Z', position: 1 },
      { id: 'main', name: '主要', createdAt: '2026-11-08T00:00:00Z', position: 0 },
    ]);
    expect(zones.map((z) => z.id)).toEqual(['main', 'b']);
    expect(validZone(zones, 'gone')).toBe('main');
    expect(validZone(zones, 'b')).toBe('b');
    expect(zonesOf(undefined).map((z) => z.id)).toEqual(['main']);
  });
});
