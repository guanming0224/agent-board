import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeGate, debounce } from './resize';

describe('ResizeGate', () => {
  it('第一次一定送，之後尺寸沒變不送', () => {
    const gate = new ResizeGate();
    expect(gate.shouldSend(80, 24)).toBe(true);
    expect(gate.shouldSend(80, 24)).toBe(false);
    expect(gate.shouldSend(81, 24)).toBe(true);
    expect(gate.shouldSend(81, 25)).toBe(true);
    expect(gate.shouldSend(81, 25)).toBe(false);
  });

  it('sync 後以快照的尺寸為準', () => {
    const gate = new ResizeGate();
    expect(gate.shouldSend(120, 40)).toBe(true);
    // 別的 client 把 PTY 改小了，自己的尺寸沒變也要再送一次
    gate.sync(80, 24);
    expect(gate.shouldSend(120, 40)).toBe(true);
    gate.sync(120, 40);
    expect(gate.shouldSend(120, 40)).toBe(false);
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('連續呼叫只在最後一次之後執行一次', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.call();
    vi.advanceTimersByTime(60);
    d.call();
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel 後不執行', () => {
    const fn = vi.fn();
    const d = debounce(fn, 100);
    d.call();
    d.cancel();
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});
