import { describe, expect, it } from 'vitest';
import { activeMention, parseCommand, sortRoster } from './broadcast';

const members = [
  { id: 'a', name: 'tw-lead' },
  { id: 'b', name: 'tw-review' },
  { id: 'c', name: 'Fix login' },
];

describe('parseCommand（群發 @ 點名）', () => {
  it('沒有點名＝整組，文字原樣（多餘空白收掉）', () => {
    expect(parseCommand('  先停下，回報目前進度 ', members)).toEqual({
      text: '先停下，回報目前進度',
      targets: [],
      unknown: [],
    });
  });

  it('@名稱 只送給點到的，送出的文字拿掉 @名稱', () => {
    expect(parseCommand('@tw-review 再看一次', members)).toEqual({
      text: '再看一次',
      targets: ['b'],
      unknown: [],
    });
  });

  it('可以點名多位、名稱有空白、大小寫不拘；重複點名只算一次', () => {
    expect(parseCommand('@fix login @tw-lead 一起看 @tw-lead', members)).toEqual({
      text: '一起看',
      targets: ['c', 'a'],
      unknown: [],
    });
  });

  it('不是本團隊成員的 @名稱 列出來（送出鈕停用）', () => {
    expect(parseCommand('@nobody 看一下', members).unknown).toEqual(['nobody']);
  });

  it('@角色（中文、縮寫、英文代碼）點名這個角色的成員；有好幾位就全部點名；名稱優先於角色', () => {
    const team = [
      { id: 'a', name: 'tw-lead', roles: ['隊長', 'LD', 'lead'] },
      { id: 'b', name: 'tw-review', roles: ['審查', 'RV', 'reviewer'] },
      { id: 'w1', name: 'tw-impl-1', roles: ['成員', 'BD', 'worker'] },
      { id: 'w2', name: 'tw-impl-2', roles: ['成員', 'BD', 'worker'] },
      { id: 'n', name: 'RV', roles: ['測試', 'QA', 'tester'] },
    ];
    expect(parseCommand('@審查 這版再看一次', team)).toEqual({
      text: '這版再看一次',
      targets: ['b'],
      unknown: [],
    });
    expect(parseCommand('@reviewer 再看', team).targets).toEqual(['b']);
    expect(parseCommand('@bd 跑測試', team).targets).toEqual(['w1', 'w2']);
    // 有成員剛好叫「RV」：名稱優先。
    expect(parseCommand('@rv 看', team).targets).toEqual(['n']);
    expect(parseCommand('@研究 看', team).unknown).toEqual(['研究']);
  });

  it('信箱、字中間的 @ 不算點名；名稱要完整（tw-reviewer 不是 tw-review）', () => {
    expect(parseCommand('寄到 a@b.c', members)).toMatchObject({ targets: [], unknown: [] });
    expect(parseCommand('@tw-reviewer hi', members).unknown).toEqual(['tw-reviewer']);
  });
});

describe('全形 ＠ 和半形 @ 一樣', () => {
  it('parseCommand：全形點名成員、角色，可以和半形混用', () => {
    expect(parseCommand('＠tw-review 再看一次', members)).toEqual({
      text: '再看一次',
      targets: ['b'],
      unknown: [],
    });
    expect(parseCommand('＠Fix login 和 @tw-lead 一起看', members).targets).toEqual(['c', 'a']);
    const team = [{ id: 'r', name: 'rv-1', roles: ['審查'] }];
    expect(parseCommand('＠審查 這版再看一次', team).targets).toEqual(['r']);
    expect(parseCommand('＠nobody 看一下', members).unknown).toEqual(['nobody']);
  });

  it('緊貼中文的 ＠／@ 也算點名；英數字後面的（email）不算', () => {
    expect(parseCommand('請＠tw-review 再看一次', members)).toEqual({
      text: '請 再看一次',
      targets: ['b'],
      unknown: [],
    });
    expect(parseCommand('請@tw-lead 看', members).targets).toEqual(['a']);
    expect(parseCommand('寄到 a@tw-lead 就好', members)).toEqual({
      text: '寄到 a@tw-lead 就好',
      targets: [],
      unknown: [],
    });
    expect(activeMention('請＠tw', 4)).toEqual({ start: 1, query: 'tw' });
    expect(activeMention('mail a@tw', 9)).toBeNull();
  });

  it('activeMention：全形 ＠ 也會開成員選單', () => {
    expect(activeMention('＠tw', 3)).toEqual({ start: 0, query: 'tw' });
    expect(activeMention('先看 ＠fi', 7)).toEqual({ start: 3, query: 'fi' });
  });
});

describe('activeMention', () => {
  it('游標前是還沒打完的 @ 點名才算', () => {
    expect(activeMention('@tw', 3)).toEqual({ start: 0, query: 'tw' });
    expect(activeMention('hi @', 4)).toEqual({ start: 3, query: '' });
    expect(activeMention('@tw-lead hi', 11)).toBeNull();
    expect(activeMention('a@b', 3)).toBeNull();
  });
});

describe('sortRoster', () => {
  it('隊長在最上，其餘依角色（成員、研究、審查、測試），同角色依名稱', () => {
    const rows = [
      { name: 'z', role: 'tester' as const },
      { name: 'b', role: 'worker' as const },
      { name: 'r', role: 'reviewer' as const },
      { name: 'a', role: 'worker' as const },
      { name: 'q', role: 'researcher' as const },
      { name: 'x', role: 'lead' as const },
    ];
    expect(sortRoster(rows).map((r) => r.name)).toEqual(['x', 'a', 'b', 'q', 'r', 'z']);
  });
});
