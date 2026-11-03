import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResizeGate, SizeOwnership, debounce, followScale } from './resize';

describe('SizeOwnership', () => {
  it('沒收過 terminal.size 時照舊自己決定尺寸，也不需要搶', () => {
    const size = new SizeOwnership();
    expect(size.following).toBe(false);
    expect(size.claim()).toBe(false);
  });

  it('尺寸屬於別人時照遠端顯示；打字或點擊才搶，而且只搶一次', () => {
    const size = new SizeOwnership();
    size.update('other', 200, 50);
    expect(size.following).toBe(true);
    expect(size.remote).toEqual({ cols: 200, rows: 50 });
    expect(size.claim()).toBe(true);
    expect(size.following).toBe(false);
    expect(size.claim()).toBe(false);
  });

  it('you 與 none 都自己 fit', () => {
    const size = new SizeOwnership();
    size.update('none', 120, 32);
    expect(size.following).toBe(false);
    size.update('you', 90, 30);
    expect(size.following).toBe(false);
    expect(size.claim()).toBe(false);
  });
});

describe('followScale', () => {
  it('遠端比較大就等比縮小到放得進去', () => {
    expect(followScale({ width: 1600, height: 800 }, { width: 800, height: 600 })).toBe(0.5);
    expect(followScale({ width: 1000, height: 1200 }, { width: 800, height: 600 })).toBe(0.5);
  });

  it('遠端比較小不放大（留白），量不到尺寸時不縮放', () => {
    expect(followScale({ width: 400, height: 300 }, { width: 800, height: 600 })).toBe(1);
    expect(followScale({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(1);
  });
});

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

  it('reset 後同尺寸也送一次', () => {
    const gate = new ResizeGate();
    gate.sync(120, 40);
    gate.reset();
    expect(gate.shouldSend(120, 40)).toBe(true);
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
