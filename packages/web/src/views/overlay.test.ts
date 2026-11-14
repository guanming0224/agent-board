// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  closeStep,
  gitInitHash,
  gitInitTarget,
  isSearchHash,
  MACHINES_HASH,
  parseHash,
  resolve,
  rightHash,
} from './overlay';

describe('網址規則（P2 §1.4）', () => {
  it('畫布、收件匣、團隊、設定、新增、封存細節', () => {
    expect(parseHash('')).toEqual({ kind: 'board', right: null, modal: null });
    expect(parseHash('#/canvas')).toEqual({ kind: 'board', right: null, modal: null });
    expect(parseHash('#/whatever')).toEqual({ kind: 'board', right: null, modal: null });
    expect(parseHash('#/inbox')).toEqual({
      kind: 'board',
      right: { kind: 'inbox', target: null },
      modal: null,
    });
    expect(parseHash('#/inbox/s%201')).toEqual({
      kind: 'board',
      right: { kind: 'inbox', target: 's 1' },
      modal: null,
    });
    expect(parseHash('#/team')).toEqual({
      kind: 'board',
      right: { kind: 'team', teamId: null },
      modal: null,
    });
    expect(parseHash('#/team/t1')).toEqual({
      kind: 'board',
      right: { kind: 'team', teamId: 't1' },
      modal: null,
    });
    expect(parseHash('#/settings/notify')).toEqual({
      kind: 'board',
      right: 'keep',
      modal: 'settings',
    });
    expect(parseHash('#/new')).toEqual({ kind: 'board', right: 'keep', modal: 'new' });
    expect(parseHash('#/archive/s1')).toEqual({ kind: 'board', right: 'keep', modal: 'archive' });
    // 用量詳情（GM 2026-11-09）：置中次畫面，疊在右側面板上。
    expect(parseHash('#/usage')).toEqual({ kind: 'board', right: 'keep', modal: 'usage' });
    // 機器面板（發版與自動更新）：同樣是置中次畫面，疊在右側面板上。
    expect(parseHash('#/machines')).toEqual({ kind: 'board', right: 'keep', modal: 'machines' });
    expect(parseHash(MACHINES_HASH)).toEqual({ kind: 'board', right: 'keep', modal: 'machines' });
    const inbox = { kind: 'inbox', target: null } as const;
    expect(resolve('#/machines', inbox).right).toEqual(inbox);
    // 從收件匣開機器面板、關掉：上一筆就是收件匣，直接上一頁
    expect(closeStep('#/inbox', 'modal', inbox, 'machines')).toEqual({ back: true });
    // 推播直接開 #/machines（沒有上一筆）：關掉回畫布、不跳出 app
    expect(closeStep(null, 'modal', null, 'machines')).toEqual({ back: false, to: '#/canvas' });
  });

  it('終端機、登入、首次引導照舊是整頁', () => {
    expect(parseHash('#/terminal/s1')).toEqual({ kind: 'page', page: 'terminal' });
    expect(parseHash('#/login')).toEqual({ kind: 'page', page: 'login' });
    expect(parseHash('#/onboarding')).toEqual({ kind: 'page', page: 'onboarding' });
  });

  it('舊網址轉址：待處理 → 收件匣（依組別）、審核中心 → 收件匣、封存 → 設定的封存分類', () => {
    expect(parseHash('#/queue')).toEqual({ kind: 'redirect', to: '#/inbox', inboxSort: 'group' });
    expect(parseHash('#/review')).toEqual({ kind: 'redirect', to: '#/inbox' });
    expect(parseHash('#/review/s%201')).toEqual({ kind: 'redirect', to: '#/inbox/s%201' });
    expect(parseHash('#/archive')).toEqual({ kind: 'redirect', to: '#/settings/archived' });
  });

  it('壞掉的百分比編碼不讓整頁掛掉', () => {
    expect(parseHash('#/inbox/%E0')).toEqual({
      kind: 'board',
      right: { kind: 'inbox', target: null },
      modal: null,
    });
  });

  it('設定疊在右側面板上：沿用上一個畫面的面板；回畫布就收掉', () => {
    const inbox = resolve('#/inbox', null).right;
    expect(inbox).toEqual({ kind: 'inbox', target: null });
    expect(resolve('#/settings', inbox).right).toEqual(inbox);
    expect(resolve('#/new', inbox).right).toEqual(inbox);
    expect(resolve('#/canvas', inbox).right).toBeNull();
    // 收件匣與團隊互斥：開團隊就換掉收件匣
    expect(resolve('#/team/t1', inbox).right).toEqual({ kind: 'team', teamId: 't1' });
  });

  it('關設定回到右側面板；關面板回畫布', () => {
    expect(rightHash(null)).toBe('#/canvas');
    expect(rightHash({ kind: 'inbox', target: 'x' })).toBe('#/inbox');
    expect(rightHash({ kind: 'team', teamId: 't 1' })).toBe('#/team/t%201');
  });

  it('上一筆就是要回去的畫面才上一頁，否則 replace（不跳出 app、不回到舊網址）', () => {
    // 開頁就是 #/inbox（沒有上一筆）：replace 成畫布
    expect(closeStep(null, 'right', null)).toEqual({ back: false, to: '#/canvas' });
    expect(closeStep('#/canvas', 'right', null)).toEqual({ back: true });
    // 沒有 hash 的網址就是畫布
    expect(closeStep('', 'right', null)).toEqual({ back: true });
    // 從團隊換到收件匣：上一筆是團隊，不能上一頁
    expect(closeStep('#/team/t1', 'right', null)).toEqual({ back: false, to: '#/canvas' });
    const inbox = { kind: 'inbox', target: null } as const;
    expect(closeStep('#/inbox', 'modal', inbox)).toEqual({ back: true });
    expect(closeStep('#/inbox/s1', 'modal', inbox)).toEqual({ back: true });
    expect(closeStep('#/canvas', 'modal', null)).toEqual({ back: true });
    // 上一筆是畫布、面板是後來才在設定底下換的：replace 回面板
    expect(closeStep('#/canvas', 'modal', inbox)).toEqual({ back: false, to: '#/inbox' });
    // 上一筆是另一個次畫面
    expect(closeStep('#/settings', 'modal', null)).toEqual({ back: false, to: '#/canvas' });

    // 搜尋 ⌘Enter 開的對話紀錄：關掉回到搜尋（上一頁，結果與查詢字都還在）
    expect(closeStep('#/search?q=risk', 'modal', null, 'transcript')).toEqual({ back: true });
    expect(closeStep('#/search', 'modal', inbox, 'transcript')).toEqual({ back: true });
    // 不是從搜尋來的對話紀錄、或關的是別的次畫面：照舊
    expect(closeStep('#/settings', 'modal', null, 'transcript')).toEqual({
      back: false,
      to: '#/canvas',
    });
    expect(closeStep('#/search', 'modal', null, 'settings')).toEqual({
      back: false,
      to: '#/canvas',
    });
    expect(isSearchHash('#/search?q=a')).toBe(true);
    expect(isSearchHash('#/transcript/s1')).toBe(false);
    expect(isSearchHash(null)).toBe(false);
  });
});

describe('session 的 git init 次畫面（CONTRACTS §24.5）', () => {
  it('#/git-init/<id> 是疊在畫布上的次畫面，沿用右側面板；沒帶 id 當畫布', () => {
    expect(gitInitHash('s 1')).toBe('#/git-init/s%201');
    expect(parseHash(gitInitHash('s 1'))).toEqual({
      kind: 'board',
      right: 'keep',
      modal: 'gitInit',
    });
    expect(parseHash('#/git-init')).toEqual({ kind: 'board', right: null, modal: null });
    expect(gitInitTarget('#/git-init/s%201')).toBe('s 1');
    expect(gitInitTarget('#/git-init/%E0%A4%A')).toBeNull();
    expect(gitInitTarget('#/canvas')).toBeNull();
    const right = { kind: 'inbox' as const, target: null };
    expect(resolve(gitInitHash('a'), right).right).toEqual(right);
  });
});
