// 分頁群組（CONTRACTS §25）的格式與純函式：hub、假後端、前端都用這一套。
import { describe, expect, it } from 'vitest';
import { HubToClient } from './ws';
import { routes } from './rest';
import {
  createZoneGroup,
  moveZoneBarItem,
  normalizeZoneGroups,
  patchZoneGroup,
  ungroupZoneGroup,
  ZoneGroupError,
  ZoneGroups,
  zoneBarItems,
} from './zoneGroups';

const Z = ['main', 'a', 'b', 'c', 'd'];
const g = (id: string, zoneIds: string[], name = id) => ({ id, name, color: 'teal', zoneIds });

describe('normalizeZoneGroups', () => {
  it('沒有資料：照工作區順序', () => {
    expect(normalizeZoneGroups(undefined, Z)).toEqual({ groups: [], order: Z });
  });

  it('拿掉不存在的工作區、重複的成員、重複或不存在的順序；漏掉的接在最後', () => {
    const out = normalizeZoneGroups(
      {
        groups: [g('g1', ['a', 'gone', 'a', 'b']), g('g2', ['b', 'c']), g('g1', ['d'])],
        order: ['d', 'nope', 'b', 'd', 'g2'],
      },
      Z,
    );
    expect(out.groups).toEqual([g('g1', ['a', 'b']), g('g2', ['c'])]);
    // b 已在群組裡，不能同時出現在頂部列；g1 沒列到 → 接在最後；main 也是。
    expect(out.order).toEqual(['d', 'g2', 'g1', 'main']);
  });

  it('群組 id 和工作區 id 撞名：群組不算', () => {
    expect(normalizeZoneGroups({ groups: [g('a', ['b'])], order: [] }, Z).groups).toEqual([]);
  });
});

describe('zoneBarItems', () => {
  it('依順序展開成分頁與群組', () => {
    const zones = Z.map((id) => ({ id }));
    const items = zoneBarItems({ groups: [g('g1', ['c', 'a'])], order: ['main', 'g1'] }, zones);
    expect(
      items.map((i) =>
        i.kind === 'zone' ? i.zone.id : `${i.group.id}:${i.zones.map((z) => z.id).join(',')}`,
      ),
    ).toEqual(['main', 'g1:c,a', 'b', 'd']);
  });
});

describe('移動與建立', () => {
  const base = { groups: [g('g1', ['b', 'c'])], order: ['main', 'a', 'g1', 'd'] };

  it('放進群組指定位置、移出群組（沒指定位置＝群組右邊）、在頂部列排序', () => {
    let s = moveZoneBarItem(base, Z, { kind: 'zone', id: 'a', groupId: 'g1', before: 'c' });
    expect(s.groups[0]!.zoneIds).toEqual(['b', 'a', 'c']);
    expect(s.order).toEqual(['main', 'g1', 'd']);
    s = moveZoneBarItem(s, Z, { kind: 'zone', id: 'b', groupId: null });
    expect(s.order).toEqual(['main', 'g1', 'b', 'd']);
    s = moveZoneBarItem(s, Z, { kind: 'zone', id: 'd', before: 'main' });
    expect(s.order).toEqual(['d', 'main', 'g1', 'b']);
    s = moveZoneBarItem(s, Z, { kind: 'group', id: 'g1', before: null });
    expect(s.order).toEqual(['d', 'main', 'b', 'g1']);
  });

  it('不存在的工作區或群組丟 ZoneGroupError', () => {
    expect(() => moveZoneBarItem(base, Z, { kind: 'zone', id: 'x' })).toThrow(ZoneGroupError);
    expect(() => moveZoneBarItem(base, Z, { kind: 'zone', id: 'a', groupId: 'x' })).toThrow(
      /Unknown zone group/,
    );
    expect(() => moveZoneBarItem(base, Z, { kind: 'group', id: 'x' })).toThrow(ZoneGroupError);
  });

  it('新群組放在第一個成員原本的位置；成員原本在別的群組＝那個群組右邊；沒成員＝最後', () => {
    let s = createZoneGroup(base, Z, { id: 'g2', name: 'G2', color: 'lime', zoneIds: ['a', 'd'] });
    expect(s.order).toEqual(['main', 'g2', 'g1']);
    expect(s.groups[1]).toEqual({ id: 'g2', name: 'G2', color: 'lime', zoneIds: ['a', 'd'] });
    s = createZoneGroup(base, Z, { id: 'g3', name: 'G3', color: 'teal', zoneIds: ['c'] });
    expect(s.order).toEqual(['main', 'a', 'g1', 'g3', 'd']);
    expect(s.groups[0]!.zoneIds).toEqual(['b']);
    s = createZoneGroup(base, Z, { id: 'g4', name: 'G4', color: 'teal', zoneIds: [] });
    expect(s.order.at(-1)).toBe('g4');
    expect(() =>
      createZoneGroup(base, Z, { id: 'g5', name: 'x', color: 'teal', zoneIds: ['nope'] }),
    ).toThrow(/Unknown workspace/);
  });

  it('取消群組：成員回到群組原本的位置；改名換色', () => {
    expect(ungroupZoneGroup(base, Z, 'g1')).toEqual({
      groups: [],
      order: ['main', 'a', 'b', 'c', 'd'],
    });
    expect(patchZoneGroup(base, Z, 'g1', { color: 'sand' }).groups[0]).toEqual({
      ...g('g1', ['b', 'c']),
      color: 'sand',
    });
    expect(() => ungroupZoneGroup(base, Z, 'x')).toThrow(ZoneGroupError);
  });
});

describe('格式相容', () => {
  it('舊版 hub 的快照沒有 zoneGroups：undefined；新版快照帶 zoneGroups 也能解析', () => {
    const old = HubToClient.parse({
      type: 'board.state',
      machines: [],
      sessions: [],
      approvals: [],
    });
    expect(old.type === 'board.state' && old.zoneGroups).toBeUndefined();
    const next = HubToClient.parse({
      type: 'board.state',
      machines: [],
      sessions: [],
      approvals: [],
      zoneGroups: { groups: [{ id: 'g', name: 'G', zoneIds: ['main'] }], order: ['g'] },
    });
    // 顏色沒給＝teal；未來多的欄位不擋（非 strict）。
    expect(next.type === 'board.state' && next.zoneGroups?.groups[0]?.color).toBe('teal');
    expect(
      ZoneGroups.parse({ groups: [], order: [], futureField: 1 } as unknown as ZoneGroups),
    ).toEqual({ groups: [], order: [] });
  });

  it('zone.groups 訊息與 REST 路由', () => {
    expect(
      HubToClient.safeParse({ type: 'zone.groups', zoneGroups: { groups: [], order: [] } }).success,
    ).toBe(true);
    expect(routes.zoneGroupsCreate.body.parse({ name: ' 美股 ' })).toEqual({
      name: '美股',
      color: 'teal',
      zoneIds: [],
    });
    expect(routes.zoneGroupsCreate.body.safeParse({ name: 'x'.repeat(41) }).success).toBe(false);
    expect(routes.zoneGroupsUpdate.body.safeParse({}).success).toBe(false);
    expect(
      routes.zoneGroupsMove.body.safeParse({ kind: 'group', id: 'g', groupId: 'x' }).success,
    ).toBe(true);
    expect(routes.zoneGroupsMove.body.safeParse({ kind: 'tab', id: 'g' }).success).toBe(false);
  });
});
