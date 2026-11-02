import { describe, expect, it } from 'vitest';
import { COMPOSITION_DEDUPE_MS, ImeInputGuard, classifyKey, isOpenableLink } from './input';

const key = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('ImeInputGuard', () => {
  it('沒有組字時全部放行，包括連續相同的按鍵', () => {
    const guard = new ImeInputGuard();
    expect(guard.accept('a', 0)).toBe(true);
    expect(guard.accept('a', 1)).toBe(true);
  });

  it('組字中不送', () => {
    const guard = new ImeInputGuard();
    guard.compositionStart();
    expect(guard.accept('ㄋㄧˇ', 0)).toBe(false);
    guard.keyDown(229);
    expect(guard.accept('ㄋㄧˇ', 1)).toBe(false);
  });

  it('確定後只送一次：兩條路徑都送時擋掉第二筆', () => {
    const guard = new ImeInputGuard();
    guard.compositionStart();
    guard.compositionEnd(100);
    expect(guard.accept('你好', 100)).toBe(true);
    expect(guard.accept('你好', 101)).toBe(false);
    // 只擋一筆
    expect(guard.accept('你好', 102)).toBe(true);
  });

  it('input 事件先於 compositionend：組字中那筆被擋，之後只送一次', () => {
    const guard = new ImeInputGuard();
    guard.compositionStart();
    expect(guard.accept('你好', 100)).toBe(false);
    guard.compositionEnd(100);
    expect(guard.accept('你好', 101)).toBe(true);
  });

  it('連續兩次組字出同樣的字都要送', () => {
    const guard = new ImeInputGuard();
    guard.compositionStart();
    guard.compositionEnd(100);
    expect(guard.accept('好', 100)).toBe(true);
    guard.compositionStart();
    guard.compositionEnd(110);
    expect(guard.accept('好', 110)).toBe(true);
  });

  it('組字結束緊接著不同內容照送，過了時間窗也照送', () => {
    const guard = new ImeInputGuard();
    guard.compositionStart();
    guard.compositionEnd(100);
    expect(guard.accept('你好', 100)).toBe(true);
    expect(guard.accept('\r', 101)).toBe(true);
    expect(guard.accept('你好', 100 + COMPOSITION_DEDUPE_MS + 1)).toBe(true);
  });

  it('組字中按非組字鍵：xterm 立刻送出的那筆放行，compositionend 後的重複擋掉', () => {
    const guard = new ImeInputGuard();
    guard.compositionStart();
    guard.keyDown(13);
    expect(guard.accept('你好', 100)).toBe(true);
    expect(guard.accept('\r', 100)).toBe(true);
    guard.compositionStart();
    guard.keyDown(13);
    expect(guard.accept('嗎', 200)).toBe(true);
    guard.compositionEnd(201);
    expect(guard.accept('嗎', 201)).toBe(false);
  });
});

describe('classifyKey', () => {
  it('Cmd+W、Cmd+T 留給瀏覽器（所有平台）', () => {
    for (const isMac of [true, false]) {
      expect(classifyKey(key('w', { metaKey: true }), isMac)).toBe('browser');
      expect(classifyKey(key('t', { metaKey: true }), isMac)).toBe('browser');
      expect(classifyKey(key('T', { metaKey: true, shiftKey: true }), isMac)).toBe('browser');
    }
  });

  it('Ctrl+W、Ctrl+T：非 macOS 留給瀏覽器，macOS 照送', () => {
    expect(classifyKey(key('w', { ctrlKey: true }), false)).toBe('browser');
    expect(classifyKey(key('t', { ctrlKey: true }), false)).toBe('browser');
    expect(classifyKey(key('w', { ctrlKey: true }), true)).toBe('terminal');
    expect(classifyKey(key('t', { ctrlKey: true }), true)).toBe('terminal');
  });

  it('其他按鍵照送', () => {
    expect(classifyKey(key('w'), false)).toBe('terminal');
    expect(classifyKey(key('c', { ctrlKey: true }), false)).toBe('terminal');
    expect(classifyKey(key('v', { ctrlKey: true }), false)).toBe('terminal');
    expect(classifyKey(key('Escape'), true)).toBe('terminal');
    expect(classifyKey(key('w', { metaKey: true, altKey: true }), true)).toBe('terminal');
  });

  it('非 macOS 的 Ctrl+Shift+C／V 是複製貼上', () => {
    expect(classifyKey(key('C', { ctrlKey: true, shiftKey: true }), false)).toBe('copy');
    expect(classifyKey(key('V', { ctrlKey: true, shiftKey: true }), false)).toBe('browser');
    expect(classifyKey(key('C', { ctrlKey: true, shiftKey: true }), true)).toBe('terminal');
  });
});

describe('isOpenableLink', () => {
  it('只允許 http(s)', () => {
    expect(isOpenableLink('https://example.com/a')).toBe(true);
    expect(isOpenableLink('http://127.0.0.1:5173/')).toBe(true);
    expect(isOpenableLink('javascript:alert(1)')).toBe(false);
    expect(isOpenableLink('file:///etc/passwd')).toBe(false);
    expect(isOpenableLink('not a url')).toBe(false);
  });
});
