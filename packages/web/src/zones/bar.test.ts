// 分頁群組頂部列（§25）：排列、往左／往右移、拖曳放下、捲動到目前分頁、滾輪轉橫向、收合狀態（每台裝置各自記）。
import { describe, expect, it } from 'vitest';
import {
  moveZoneBarItem,
  ZONE_GROUP_COLORS,
  zoneBarItems,
  type Zone,
  type ZoneGroups,
} from '@agent-board/protocol';
import { TEAM_COLORS } from '../team/colors';
import {
  COLLAPSED_KEY,
  dropMove,
  groupOpen,
  MENU_MARGIN,
  placeMenu,
  pruneCollapsed,
  readCollapsed,
  WHEEL_LINE_PX,
  revealScroll,
  stepMove,
  wheelToHorizontal,
  writeCollapsed,
} from './bar';

const zone = (id: string, position: number): Zone => ({
  id,
  name: id.toUpperCase(),
  createdAt: '2026-11-14T00:00:00.000Z',
  position,
});
const ZONES = ['main', 'a', 'b', 'c', 'd', 'e'].map(zone);
const IDS = ZONES.map((z) => z.id);
const STATE: ZoneGroups = {
  groups: [
    { id: 'g1', name: 'AI', color: 'indigo', zoneIds: ['b', 'c'] },
    { id: 'g2', name: '伺服器', color: 'lime', zoneIds: ['e'] },
  ],
  order: ['main', 'a', 'g1', 'd', 'g2'],
};
const items = (state: ZoneGroups = STATE) => zoneBarItems(state, ZONES);
const shape = (state: ZoneGroups) =>
  zoneBarItems(state, ZONES).map((i) =>
    i.kind === 'zone' ? i.zone.id : `${i.group.id}[${i.zones.map((z) => z.id).join(',')}]`,
  );

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}
const broken = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('排列', () => {
  it('沒有群組資料（舊版 hub）：照 position 全部是分頁，沒有數量上限', () => {
    const many = Array.from({ length: 12 }, (_, i) => zone(`z${i}`, i));
    const bar = zoneBarItems(undefined, many);
    expect(bar).toHaveLength(12);
    expect(bar.every((i) => i.kind === 'zone')).toBe(true);
  });

  it('群組與沒分組的分頁照共用順序排', () => {
    expect(shape(STATE)).toEqual(['main', 'a', 'g1[b,c]', 'd', 'g2[e]']);
  });
});

describe('往左／往右移（拖曳的鍵盤／觸控替代）', () => {
  it('頂部列的分頁與群組、群組裡的分頁各自在自己那一排換位置；最邊邊回 null', () => {
    const apply = (m: ReturnType<typeof stepMove>) => shape(moveZoneBarItem(STATE, IDS, m!));
    expect(apply(stepMove(items(), { kind: 'zone', id: 'a' }, -1))).toEqual([
      'a',
      'main',
      'g1[b,c]',
      'd',
      'g2[e]',
    ]);
    expect(apply(stepMove(items(), { kind: 'group', id: 'g1' }, 1))).toEqual([
      'main',
      'a',
      'd',
      'g1[b,c]',
      'g2[e]',
    ]);
    expect(apply(stepMove(items(), { kind: 'zone', id: 'b' }, 1))).toEqual([
      'main',
      'a',
      'g1[c,b]',
      'd',
      'g2[e]',
    ]);
    expect(stepMove(items(), { kind: 'zone', id: 'main' }, -1)).toBeNull();
    expect(stepMove(items(), { kind: 'group', id: 'g2' }, 1)).toBeNull();
    expect(stepMove(items(), { kind: 'zone', id: 'c' }, 1)).toBeNull();
    expect(stepMove(items(), { kind: 'zone', id: 'nope' }, 1)).toBeNull();
  });
});

describe('拖曳放下', () => {
  const apply = (m: ReturnType<typeof dropMove>) => shape(moveZoneBarItem(STATE, IDS, m!));

  it('分頁放到群組裡的分頁右半＝放進群組、排在它後面；放到群組標籤＝加到群組最後', () => {
    expect(
      apply(dropMove(items(), { kind: 'zone', id: 'a' }, { kind: 'zone', id: 'b' }, 'after')),
    ).toEqual(['main', 'g1[b,a,c]', 'd', 'g2[e]']);
    expect(
      apply(dropMove(items(), { kind: 'zone', id: 'main' }, { kind: 'group', id: 'g2' }, 'before')),
    ).toEqual(['a', 'g1[b,c]', 'd', 'g2[e,main]']);
  });

  it('群組裡的分頁放到頂部列分頁左半＝移出群組、排在它前面；放到最後面空白＝移出群組排最後', () => {
    expect(
      apply(dropMove(items(), { kind: 'zone', id: 'c' }, { kind: 'zone', id: 'main' }, 'before')),
    ).toEqual(['c', 'main', 'a', 'g1[b]', 'd', 'g2[e]']);
    expect(apply(dropMove(items(), { kind: 'zone', id: 'b' }, { kind: 'end' }, 'after'))).toEqual([
      'main',
      'a',
      'g1[c]',
      'd',
      'g2[e]',
      'b',
    ]);
  });

  it('群組只在頂部列排序：放到別的群組裡的分頁上＝那個群組的前後；放回自己身上＝null', () => {
    expect(
      apply(dropMove(items(), { kind: 'group', id: 'g2' }, { kind: 'zone', id: 'c' }, 'before')),
    ).toEqual(['main', 'a', 'g2[e]', 'g1[b,c]', 'd']);
    expect(
      apply(dropMove(items(), { kind: 'group', id: 'g1' }, { kind: 'zone', id: 'd' }, 'after')),
    ).toEqual(['main', 'a', 'd', 'g1[b,c]', 'g2[e]']);
    expect(
      dropMove(items(), { kind: 'group', id: 'g1' }, { kind: 'zone', id: 'b' }, 'after'),
    ).toBeNull();
    expect(
      dropMove(items(), { kind: 'zone', id: 'a' }, { kind: 'zone', id: 'a' }, 'after'),
    ).toBeNull();
  });
});

describe('捲動到目前分頁', () => {
  const view = { scrollLeft: 100, clientWidth: 400 };
  it('看得到就不動', () => {
    expect(revealScroll(view, { left: 150, width: 80 })).toBeNull();
  });
  it('在左邊看不到：捲到它左緣再留一點', () => {
    expect(revealScroll(view, { left: 40, width: 80 })).toBe(16);
    expect(revealScroll(view, { left: 10, width: 80 })).toBe(0);
  });
  it('在右邊看不到：捲到它右緣剛好進來再留一點', () => {
    expect(revealScroll(view, { left: 600, width: 100 })).toBe(600 + 100 + 24 - 400);
  });
  it('比可見範圍還寬：對齊左緣', () => {
    expect(revealScroll(view, { left: 900, width: 390 })).toBe(876);
  });
});

describe('滾輪轉橫向', () => {
  it('放不下且直向為主才轉；觸控板的橫向滑動與放得下時不攔', () => {
    const scroll = { scrollWidth: 1200, clientWidth: 600 };
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 120 }, scroll)).toBe(120);
    expect(wheelToHorizontal({ deltaX: 40, deltaY: 5 }, scroll)).toBeNull();
    expect(
      wheelToHorizontal({ deltaX: 0, deltaY: 120 }, { scrollWidth: 600, clientWidth: 600 }),
    ).toBeNull();
  });
});

describe('收合狀態（每台裝置各自記）', () => {
  it('寫進 localStorage、讀回來；展開＝拿掉記錄', () => {
    const storage = memoryStorage();
    let state = writeCollapsed(storage, {}, 'g1', true);
    state = writeCollapsed(storage, state, 'g2', true);
    expect(readCollapsed(storage)).toEqual({ g1: true, g2: true });
    state = writeCollapsed(storage, state, 'g1', false);
    expect(state).toEqual({ g2: true });
    expect(JSON.parse(storage.data.get(COLLAPSED_KEY)!)).toEqual({ g2: true });
  });

  it('讀不到、壞掉、型別不對：全部展開；存不了只在這次有效、不丟錯', () => {
    expect(readCollapsed(broken)).toEqual({});
    expect(readCollapsed(null)).toEqual({});
    expect(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '{oops' }))).toEqual({});
    expect(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '["g1"]' }))).toEqual({});
    expect(readCollapsed(memoryStorage({ [COLLAPSED_KEY]: '{"g1":true,"g2":1}' }))).toEqual({
      g1: true,
    });
    expect(writeCollapsed(broken, {}, 'g1', true)).toEqual({ g1: true });
  });

  it('收合的群組：拖著東西經過時暫時展開（peek）；經過好幾個都保持展開到拖曳結束（N3）', () => {
    expect(groupOpen('g1', {}, [])).toBe(true);
    expect(groupOpen('g1', { g1: true }, [])).toBe(false);
    expect(groupOpen('g1', { g1: true }, ['g1'])).toBe(true);
    expect(groupOpen('g1', { g1: true }, ['g2'])).toBe(false);
    expect(groupOpen('g1', { g1: true, g2: true }, ['g1', 'g2'])).toBe(true);
    expect(groupOpen('g2', { g1: true, g2: true }, ['g1', 'g2'])).toBe(true);
  });

  it('收合記錄只留現有群組（N6）', () => {
    expect(pruneCollapsed({ g1: true, gone: true }, ['g1', 'g2'])).toEqual({ g1: true });
    expect(pruneCollapsed({ g1: true }, [])).toEqual({});
  });
});

describe('審查後補：滾輪 deltaMode（W4）、選單位置（W5）、色票（N1）', () => {
  const scroll = { scrollWidth: 1200, clientWidth: 600 };
  it('deltaMode 1（Firefox 的行）×16、2（頁）×可見寬度、0 照像素', () => {
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 3, deltaMode: 1 }, scroll)).toBe(
      3 * WHEEL_LINE_PX,
    );
    expect(wheelToHorizontal({ deltaX: 0, deltaY: -1, deltaMode: 2 }, scroll)).toBe(-600);
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 100, deltaMode: 0 }, scroll)).toBe(100);
  });

  const view = { width: 400, height: 800 };
  it('下面放得下：開在分頁下面；右邊放不下往左推', () => {
    expect(placeMenu({ left: 10, top: 40, bottom: 76 }, { width: 200, height: 300 }, view)).toEqual(
      {
        left: 10,
        top: 78,
        maxHeight: 800 - 76 - 2 - MENU_MARGIN,
      },
    );
    expect(
      placeMenu({ left: 350, top: 40, bottom: 76 }, { width: 200, height: 300 }, view).left,
    ).toBe(400 - 200 - MENU_MARGIN);
  });
  it('下面放不下、上面空間比較大：往上翻，高度夾在視窗內', () => {
    const p = placeMenu({ left: 10, top: 700, bottom: 736 }, { width: 200, height: 300 }, view);
    expect(p.top).toBe(700 - 2 - 300);
    expect(p.maxHeight).toBe(700 - 2 - MENU_MARGIN);
    // 比上面空間還高：從頂端留邊開始、自己捲。
    const tall = placeMenu({ left: 10, top: 300, bottom: 336 }, { width: 200, height: 2000 }, view);
    expect(tall.top).toBe(336 + 2);
    expect(tall.maxHeight).toBe(800 - 336 - 2 - MENU_MARGIN);
  });
  it('矮視窗、選單太高：maxHeight 不超過可用高度', () => {
    const p = placeMenu(
      { left: 0, top: 100, bottom: 136 },
      { width: 200, height: 900 },
      { width: 400, height: 300 },
    );
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(300 - MENU_MARGIN);
  });
  it('web 的團隊色票和 protocol 寫入用的群組色票相同', () => {
    expect([...TEAM_COLORS]).toEqual([...ZONE_GROUP_COLORS]);
  });
});
