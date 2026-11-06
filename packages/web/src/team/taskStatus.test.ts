import { describe, expect, it } from 'vitest';
import type { Task } from '@agent-board/protocol';
import { translate } from '../shared/i18n';
import { dropReasonKey, shortName, taskStatusLines } from './taskStatus';
import './messages';

const at = '2026-11-06T00:00:00.000Z';
const base: Pick<Task, 'auto' | 'rejectCount' | 'reviewerSessionId' | 'needsUser'> = {
  auto: null,
  rejectCount: 0,
  reviewerSessionId: null,
  needsUser: false,
};
const names: Record<string, string> = { bd: 'BD1', rv: 'RV' };
const nameOf = (id: string | null) => (id ? (names[id] ?? null) : null);
const zh = (lines: ReturnType<typeof taskStatusLines>) =>
  lines.map(({ key, params }) => translate('zh-TW', key, params)).join('・');

describe('task card status', () => {
  it('shortens <team>-BD1 to BD1 and leaves other names alone', () => {
    expect(shortName('登入重構-BD1', '登入重構')).toBe('BD1');
    expect(shortName('Fix login', '登入重構')).toBe('Fix login');
    expect(shortName('登入重構-', '登入重構')).toBe('登入重構-');
  });

  it('shows nothing for a task automation never touched', () => {
    expect(taskStatusLines(base, nameOf)).toEqual([]);
  });

  it('says who it was sent to and how many times review sent it back', () => {
    const sent = { ...base, auto: { state: 'sent' as const, sessionId: 'bd', at } };
    expect(zh(taskStatusLines(sent, nameOf))).toBe('已送給 BD1・等回覆');
    const again = { ...sent, rejectCount: 1, reviewerSessionId: 'rv' };
    expect(zh(taskStatusLines(again, nameOf))).toBe('已送給 BD1・等回覆・RV 退回 1/3');
    const limit = {
      ...base,
      rejectCount: 3,
      reviewerSessionId: 'rv',
      needsUser: true,
      auto: { state: 'limit' as const, sessionId: 'rv', note: 'no test', at },
    };
    expect(zh(taskStatusLines(limit, nameOf))).toBe('RV 退回 3/3・等你決定');
    const gone = { ...base, auto: { state: 'review_sent' as const, sessionId: 'x', at } };
    expect(zh(taskStatusLines(gone, nameOf))).toBe('已送給 ? 審查・等回覆');
  });

  it('dropped keeps the reason code for the screen to translate', () => {
    const dropped = {
      ...base,
      auto: { state: 'dropped' as const, sessionId: 'bd', note: 'hub_restarted', at },
    };
    expect(taskStatusLines(dropped, nameOf)).toEqual([
      { key: 'team.tasks.auto.dropped', params: { name: 'BD1', reason: 'hub_restarted' } },
    ]);
    expect(dropReasonKey('hub_restarted')).toBe('team.tasks.drop.hub_restarted');
    expect(dropReasonKey('weird')).toBe('team.tasks.drop.unknown');
    for (const locale of ['zh-TW', 'en'] as const) {
      expect(translate(locale, 'team.tasks.drop.hub_restarted')).not.toBe(
        'team.tasks.drop.hub_restarted',
      );
    }
  });
});
