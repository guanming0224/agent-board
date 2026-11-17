// 「session host 輸入可能失效」的判定規則（事故 9，CONTRACTS §20.8）。
import { describe, expect, it } from 'vitest';
import { hasVisibleText, InputHealthMonitor } from './inputHealth';

function harness() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const events: string[] = [];
  const monitor = new InputHealthMonitor({
    windowMs: 5_000,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
    onSuspect: () => events.push('suspect'),
    onRecover: () => events.push('recover'),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { monitor, advance, events };
}

describe('hasVisibleText', () => {
  it('可見的字算；控制鍵、方向鍵、滑鼠、焦點、終端機回覆不算', () => {
    expect(hasVisibleText('a')).toBe(true);
    expect(hasVisibleText('你好')).toBe(true);
    expect(hasVisibleText('\x1b[200~貼上的字\x1b[201~')).toBe(true);
    expect(hasVisibleText('\r')).toBe(false);
    expect(hasVisibleText('\x7f\x7f')).toBe(false);
    expect(hasVisibleText('\x1b')).toBe(false);
    expect(hasVisibleText('\x1b[D\x1bOA')).toBe(false);
    expect(hasVisibleText('\x1b[MC!!\x1b[MCI!')).toBe(false);
    expect(hasVisibleText('\x1b[<35;10;5M\x1b[<0;1;1m')).toBe(false);
    expect(hasVisibleText('\x1b[I\x1b[O')).toBe(false);
    expect(hasVisibleText('\x1b[?1;2c\x1b[12;40R')).toBe(false);
    expect(hasVisibleText('\x1b]11;rgb:0000/0000/0000\x07')).toBe(false);
    expect(hasVisibleText(' ')).toBe(false);
  });
});

describe('InputHealthMonitor', () => {
  it('兩個 session 各一次沒回顯 → 可疑；之後有回顯 → 解除', () => {
    const { monitor, advance, events } = harness();
    monitor.onInput('a', 'hi', true);
    advance(5_000);
    expect(events).toEqual([]);
    monitor.onInput('b', 'hi', true);
    advance(5_000);
    expect(events).toEqual(['suspect']);
    expect(monitor.suspect).toBe(true);
    monitor.onInput('a', 'x', true);
    monitor.onOutput('a');
    expect(events).toEqual(['suspect', 'recover']);
    expect(monitor.suspect).toBe(false);
  });

  it('同一個 session 要 3 次', () => {
    const { monitor, advance, events } = harness();
    for (let i = 0; i < 2; i += 1) {
      monitor.onInput('a', 'hi', true);
      advance(5_000);
    }
    expect(events).toEqual([]);
    monitor.onInput('a', 'hi', true);
    advance(5_000);
    expect(events).toEqual(['suspect']);
  });

  it('有回顯就歸零；不合格的輸入（eligible=false、只有控制鍵）不算', () => {
    const { monitor, advance, events } = harness();
    monitor.onInput('a', 'hi', true);
    advance(5_000);
    monitor.onInput('b', 'hi', true);
    advance(1_000);
    monitor.onOutput('b');
    monitor.onInput('c', 'hi', false);
    monitor.onInput('d', '\x1b[MC!!', true);
    monitor.onInput('e', '\r', true);
    advance(10_000);
    monitor.onInput('a', 'hi', true);
    advance(5_000);
    expect(events).toEqual([]);
  });

  it('等回顯時再打字不重複算；輸出在時限內到就不算', () => {
    const { monitor, advance, events } = harness();
    monitor.onInput('a', 'h', true);
    monitor.onInput('a', 'i', true);
    advance(4_000);
    monitor.onOutput('a');
    advance(10_000);
    monitor.onInput('b', 'h', true);
    advance(5_000);
    expect(events).toEqual([]);
  });

  it('超過 10 分鐘的舊紀錄不算', () => {
    const { monitor, advance, events } = harness();
    monitor.onInput('a', 'hi', true);
    advance(5_000);
    advance(11 * 60_000);
    monitor.onInput('b', 'hi', true);
    advance(5_000);
    expect(events).toEqual([]);
  });

  it('forget／reset 不再等', () => {
    const { monitor, advance, events } = harness();
    monitor.onInput('a', 'hi', true);
    monitor.forget('a');
    monitor.onInput('b', 'hi', true);
    monitor.reset();
    advance(10_000);
    expect(events).toEqual([]);
  });
});
