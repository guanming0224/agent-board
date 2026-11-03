import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agent-board/protocol';
import {
  clearState,
  DISMISSED_LIMIT,
  hintKey,
  markedFromWaiting,
  showsDoneHint,
  useDoneHints,
} from './doneHintState';
import { sessionFromHash, terminalHash } from './terminalRoute';

const status = (from: string, to: string, at = '2026-11-03T00:00:00.000Z'): SessionEvent => ({
  id: crypto.randomUUID(),
  sessionId: 's',
  type: 'status',
  payload: { from, to, reason: 'test' },
  at,
});

describe('完成提示', () => {
  it('只在 done 且沒封存時出現', () => {
    expect(showsDoneHint({ status: 'done', archived: false })).toBe(true);
    expect(showsDoneHint({ status: 'done', archived: true })).toBe(false);
    expect(showsDoneHint({ status: 'waiting_input', archived: false })).toBe(false);
  });

  it('同一個 session 重新完成會換一個 key', () => {
    expect(hintKey({ id: 'a', statusSince: '1' })).not.toBe(hintKey({ id: 'a', statusSince: '2' }));
  });

  it('看最後一次變成 done 之前的狀態', () => {
    expect(markedFromWaiting([])).toBe(false);
    expect(markedFromWaiting([status('running', 'waiting_input')])).toBe(false);
    expect(markedFromWaiting([status('waiting_input', 'done')])).toBe(true);
    expect(markedFromWaiting([status('running', 'done')])).toBe(false);
    // 第一次在等輸入時完成，之後 resume 又在工作中被標記完成：以最後一次為準。
    expect(
      markedFromWaiting([
        status('waiting_input', 'done'),
        status('done', 'starting'),
        status('running', 'done'),
      ]),
    ).toBe(false);
    expect(
      markedFromWaiting([
        status('running', 'done'),
        { ...status('x', 'y'), type: 'hook' },
        status('waiting_input', 'done'),
      ]),
    ).toBe(true);
  });

  it('/clear 只在 PTY 還活著、連得到、標記前在等輸入時才能送', () => {
    const alive = { endedAt: null };
    const ok = { connected: true, machineOnline: true, waitingBeforeDone: true };
    expect(clearState(alive, ok)).toBe('ready');
    expect(clearState({ endedAt: '2026-11-03T00:00:00.000Z' }, ok)).toBe('ended');
    expect(clearState(alive, { ...ok, connected: false })).toBe('unreachable');
    expect(clearState(alive, { ...ok, machineOnline: false })).toBe('unreachable');
    expect(clearState(alive, { ...ok, waitingBeforeDone: false })).toBe('busy');
    expect(clearState(alive, { ...ok, waitingBeforeDone: null })).toBe('checking');
  });

  it('關掉的提示沒有 localStorage 也記得，數量有上限', () => {
    const { dismiss } = useDoneHints.getState();
    dismiss('a@1');
    dismiss('a@1');
    expect(useDoneHints.getState().dismissed.filter((k) => k === 'a@1')).toHaveLength(1);
    for (let i = 0; i < DISMISSED_LIMIT + 5; i += 1) dismiss(`x@${i}`);
    const { dismissed } = useDoneHints.getState();
    expect(dismissed).toHaveLength(DISMISSED_LIMIT);
    expect(dismissed.at(-1)).toBe(`x@${DISMISSED_LIMIT + 4}`);
  });
});

describe('全尺寸終端機網址', () => {
  it('來回轉換，含需要編碼的 id', () => {
    expect(sessionFromHash(terminalHash('s-auth'))).toBe('s-auth');
    expect(sessionFromHash(terminalHash('a/b c'))).toBe('a/b c');
  });

  it('其他頁面或壞掉的編碼回 null', () => {
    expect(sessionFromHash('#/canvas')).toBeNull();
    expect(sessionFromHash('#/terminal')).toBeNull();
    expect(sessionFromHash('#/terminal/%E0%A4%A')).toBeNull();
    expect(sessionFromHash('#/review/s-auth')).toBeNull();
  });
});
