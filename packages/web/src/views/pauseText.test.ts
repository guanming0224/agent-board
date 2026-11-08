// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { BoardInterruptResult, Session } from '@agent-board/protocol';
import { translate } from '../shared/i18n';
import {
  heldParts,
  interruptText,
  notSentNames,
  releasedText,
  releaseText,
  runningCount,
} from './pauseText';
import './messages';

const zh = (key: string, vars?: Record<string, string | number>) => translate('zh-TW', key, vars);
const en = (key: string, vars?: Record<string, string | number>) => translate('en', key, vars);

const held = (over: Partial<Record<'deliveries' | 'sessions' | 'autoContinues', number>> = {}) => ({
  deliveries: 0,
  sessions: 0,
  sessionsWaiting: 0,
  autoContinues: 0,
  ...over,
});

describe('全部繼續前的「會放出」', () => {
  it('數字為 0 的項目不顯示', () => {
    expect(releaseText(held({ deliveries: 2, autoContinues: 1 }), zh)).toBe(
      '會放出：排隊送字 2 則、到期的自動接續 1 個',
    );
    expect(releaseText(held({ sessions: 3 }), zh)).toBe('會放出：排隊 session 3 個');
    expect(heldParts(held(), zh)).toBeNull();
  });

  it('全部是 0 時明講沒有排隊中的，不留空', () => {
    expect(releaseText(held(), zh)).toBe('會放出：沒有排隊中的');
    expect(releasedText(held(), zh)).toBe('已繼續（沒有排隊中的）');
  });

  it('英文也有', () => {
    expect(releaseText(held({ deliveries: 1, sessions: 2 }), en)).toBe(
      'Will release: 1 queued messages, 2 queued sessions',
    );
  });
});

describe('立刻中斷的結果', () => {
  const r = (name: string, result: BoardInterruptResult['result']): BoardInterruptResult => ({
    sessionId: name,
    name,
    result,
  });

  it('「已中斷 7 個；1 個失聯沒送到」', () => {
    const results = [
      ...Array.from({ length: 7 }, (_, i) => r(`s${i}`, 'requested')),
      r('x', 'offline'),
    ];
    expect(interruptText(results, zh)).toBe('已中斷 7 個；1 個失聯沒送到');
    expect(notSentNames(results)).toEqual(['x']);
  });

  it('daemon 太舊沒送的另列，並說怎麼辦', () => {
    expect(interruptText([r('a', 'unsupported')], zh)).toBe(
      '已中斷 0 個；1 個 daemon 版本太舊沒送（更新該機器的 daemon 後再按一次）',
    );
  });
});

describe('會被 Esc 的 RUN 數', () => {
  const s = (status: Session['status'], extra: Partial<Session> = {}) =>
    ({ status, archived: false, endedAt: null, ...extra }) as Session;

  it('只算還在跑的 RUN，PERM／ASK／結束／封存都不算', () => {
    expect(
      runningCount([
        s('running'),
        s('running'),
        s('waiting_permission'),
        s('waiting_input'),
        s('running', { endedAt: '2026-11-08T00:00:00.000Z' }),
        s('running', { archived: true }),
      ]),
    ).toBe(2);
  });
});
