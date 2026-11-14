// 分頁群組（GM 2026-11-14，CONTRACTS §25）：真的 hub。群組 CRUD、移動、權限（和工作區相同：登入就能改）、
// 刪工作區時從群組拿掉、刪群組不刪工作區、WS 推 zone.groups、快照帶 zoneGroups、重啟後還在、舊資料沒群組時正常。
import { afterEach, describe, expect, it } from 'vitest';
import type { ZoneGroups } from '@agent-board/protocol';
import { connect, PASSWORD, startHub, type TestHub } from './helpers';
import { ZONE_GROUPS_KEY } from '../zoneGroups';

let hub: TestHub;
afterEach(async () => {
  await hub?.stop();
});

const auditRows = (action: string) =>
  hub.running.db
    .prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY rowid')
    .all(action) as { detail: string }[];

async function zone(cookie: string, name: string): Promise<string> {
  const res = await hub.api('POST', '/api/zones', { cookie, body: { name } });
  expect(res.status).toBe(200);
  return res.body.id as string;
}

async function snapshot(cookie: string) {
  const peer = await connect(`ws://127.0.0.1:${hub.port}/ws/client`, { cookie, origin: hub.url });
  const state = await peer.next('board.state');
  peer.close();
  return state;
}

describe('分頁群組', () => {
  it('舊資料沒有群組：GET 回整理過的順序（照 position），快照帶 zoneGroups', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const a = await zone(cookie, 'A');
    const res = await hub.api('GET', '/api/zone-groups', { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groups: [], order: ['main', a] });
    // 沒寫過就不存（不在 settings 表多一列）。
    expect(hub.running.store.getRawJson(ZONE_GROUPS_KEY)).toBeNull();
    const state = await snapshot(cookie);
    expect(state.zoneGroups).toEqual({ groups: [], order: ['main', a] });
  });

  it('建立（帶工作區）、改名、換色、移動、取消群組；每次都推 zone.groups、寫 audit；重啟後還在', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const client = await hub.client(cookie);
    const a = await zone(cookie, 'A');
    const b = await zone(cookie, 'B');
    const c = await zone(cookie, 'C');

    const created = await hub.api('POST', '/api/zone-groups', {
      cookie,
      body: { name: ' AI專案 ', color: 'indigo', zoneIds: [b, c] },
    });
    expect(created.status).toBe(200);
    const gid = created.body.group.id as string;
    expect(created.body.group).toEqual({
      id: gid,
      name: 'AI專案',
      color: 'indigo',
      zoneIds: [b, c],
    });
    // 群組放在第一個工作區（B）原本的位置。
    expect(created.body.zoneGroups.order).toEqual(['main', a, gid]);
    const pushed = await client.next('zone.groups');
    expect((pushed.zoneGroups as ZoneGroups).groups[0]!.name).toBe('AI專案');

    const renamed = await hub.api('PATCH', `/api/zone-groups/${gid}`, {
      cookie,
      body: { name: '伺服器', color: 'lime' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.groups[0]).toMatchObject({ name: '伺服器', color: 'lime' });
    await client.next(
      'zone.groups',
      (m) => (m.zoneGroups as ZoneGroups).groups[0]?.name === '伺服器',
    );

    // 把 A 放進群組最前面；把 C 移出群組（沒指定位置＝群組右邊）；群組移到最前面。
    let moved = await hub.api('POST', '/api/zone-groups/move', {
      cookie,
      body: { kind: 'zone', id: a, groupId: gid, before: b },
    });
    expect(moved.body.groups[0].zoneIds).toEqual([a, b, c]);
    moved = await hub.api('POST', '/api/zone-groups/move', {
      cookie,
      body: { kind: 'zone', id: c, groupId: null },
    });
    expect(moved.body.groups[0].zoneIds).toEqual([a, b]);
    expect(moved.body.order).toEqual(['main', gid, c]);
    moved = await hub.api('POST', '/api/zone-groups/move', {
      cookie,
      body: { kind: 'group', id: gid, before: 'main' },
    });
    expect(moved.body.order).toEqual([gid, 'main', c]);
    // 版本：每次存 +1（建立 1、改名 2、移動 3–5）。
    expect(moved.body.rev).toBe(5);
    // audit 只記移動後的實際位置，不原樣記送來的 before／groupId。
    expect(JSON.parse(auditRows('zoneGroup.move').at(-1)!.detail)).toEqual({
      kind: 'group',
      id: gid,
      groupId: null,
      index: 0,
    });
    expect(JSON.parse(auditRows('zoneGroup.move')[0]!.detail)).toEqual({
      kind: 'zone',
      id: a,
      groupId: gid,
      index: 0,
    });

    // 重啟後還在（存在 settings 表）。
    const { dbPath } = hub;
    await hub.running.close();
    hub = await startHub({ dbPath });
    const again = await hub.api('POST', '/api/auth/login', {
      body: { name: 'owner', password: PASSWORD },
    });
    const cookie2 = again.headers.get('set-cookie')!.split(';')[0]!;
    const after = await hub.api('GET', '/api/zone-groups', { cookie: cookie2 });
    expect(after.body).toEqual({
      groups: [{ id: gid, name: '伺服器', color: 'lime', zoneIds: [a, b] }],
      order: [gid, 'main', c],
      rev: 5,
    });

    // 取消群組：工作區回到群組原本的位置，畫布都還在。
    const ungrouped = await hub.api('DELETE', `/api/zone-groups/${gid}`, { cookie: cookie2 });
    expect(ungrouped.status).toBe(200);
    expect(ungrouped.body).toEqual({ groups: [], order: [a, b, 'main', c], rev: 6 });
    const zones = await hub.api('GET', '/api/zones', { cookie: cookie2 });
    expect(zones.body).toHaveLength(4);

    expect(auditRows('zoneGroup.create')).toHaveLength(1);
    expect(auditRows('zoneGroup.update')).toHaveLength(1);
    expect(auditRows('zoneGroup.move')).toHaveLength(3);
    expect(auditRows('zoneGroup.delete')).toHaveLength(1);
  });

  it('刪工作區：從群組與順序拿掉並推 zone.groups；群組留著（空的也留）', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const client = await hub.client(cookie);
    const a = await zone(cookie, 'A');
    const b = await zone(cookie, 'B');
    const gid = (
      await hub.api('POST', '/api/zone-groups', {
        cookie,
        body: { name: 'G', color: 'teal', zoneIds: [a, b] },
      })
    ).body.group.id as string;
    await client.next('zone.groups');

    expect((await hub.api('DELETE', `/api/zones/${a}`, { cookie })).status).toBe(200);
    const pushed = await client.next('zone.groups');
    expect((pushed.zoneGroups as ZoneGroups).groups[0]!.zoneIds).toEqual([b]);
    expect(
      (hub.running.store.getRawJson(ZONE_GROUPS_KEY) as ZoneGroups).groups[0]!.zoneIds,
    ).toEqual([b]);
    expect((await hub.api('DELETE', `/api/zones/${b}`, { cookie })).status).toBe(200);
    const res = await hub.api('GET', '/api/zone-groups', { cookie });
    expect(res.body).toMatchObject({
      groups: [{ id: gid, name: 'G', color: 'teal', zoneIds: [] }],
      order: ['main', gid],
    });
    // 新建的工作區接在最後。
    const c = await zone(cookie, 'C');
    expect((await hub.api('GET', '/api/zone-groups', { cookie })).body.order).toEqual([
      'main',
      gid,
      c,
    ]);
  });

  it('錯誤：不存在的工作區 400、不存在的群組 404、名稱空白或顏色怪字串 400', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const bad = await hub.api('POST', '/api/zone-groups', {
      cookie,
      body: { name: 'G', color: 'teal', zoneIds: ['nope'] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('unknown_zone');
    expect(
      (await hub.api('PATCH', '/api/zone-groups/zg-x', { cookie, body: { name: 'x' } })).status,
    ).toBe(404);
    expect((await hub.api('DELETE', '/api/zone-groups/zg-x', { cookie })).status).toBe(404);
    expect(
      (
        await hub.api('POST', '/api/zone-groups/move', {
          cookie,
          body: { kind: 'zone', id: 'main', groupId: 'zg-x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await hub.api('POST', '/api/zone-groups', { cookie, body: { name: ' ', color: 'teal' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await hub.api('POST', '/api/zone-groups', {
          cookie,
          body: { name: 'G', color: 'red); background: url(x' },
        })
      ).status,
    ).toBe(400);
    // 顏色只收色票（寫入用 enum）；id 長度有上限（不讓超長字串進 audit）。
    expect(
      (await hub.api('POST', '/api/zone-groups', { cookie, body: { name: 'G', color: 'red' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await hub.api('POST', '/api/zone-groups/move', {
          cookie,
          body: { kind: 'zone', id: 'main', before: 'x'.repeat(129) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await hub.api('POST', '/api/zone-groups', {
          cookie,
          body: { name: 'G', zoneIds: Array.from({ length: 501 }, () => 'main') },
        })
      ).status,
    ).toBe(400);
    expect(hub.running.store.getRawJson(ZONE_GROUPS_KEY)).toBeNull();
    expect(auditRows('zoneGroup.create')).toHaveLength(0);
  });

  it('權限和工作區相同：沒登入 401；一般成員（member）可以建立、改、刪群組', async () => {
    hub = await startHub();
    const owner = await hub.setupOwner();
    const member = await hub.createMember(owner);
    expect((await hub.api('GET', '/api/zone-groups')).status).toBe(401);
    expect(
      (await hub.api('POST', '/api/zone-groups', { body: { name: 'G', color: 'teal' } })).status,
    ).toBe(401);
    // 工作區本身也是 member 可建立（同一套規則）。
    expect(
      (await hub.api('POST', '/api/zones', { cookie: member.cookie, body: { name: 'M' } })).status,
    ).toBe(200);
    const created = await hub.api('POST', '/api/zone-groups', {
      cookie: member.cookie,
      body: { name: 'G', color: 'teal', zoneIds: ['main'] },
    });
    expect(created.status).toBe(200);
    const gid = created.body.group.id as string;
    expect(
      (
        await hub.api('PATCH', `/api/zone-groups/${gid}`, {
          cookie: member.cookie,
          body: { color: 'sand' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await hub.api('DELETE', `/api/zone-groups/${gid}`, { cookie: member.cookie })).status,
    ).toBe(200);
  });

  it('存的資料只壞一個群組：只丟那一個，其他群組與順序保留；下一次寫入不會把好的蓋掉', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    const a = await zone(cookie, 'A');
    hub.running.store.setRawJson(ZONE_GROUPS_KEY, {
      groups: [
        { id: 'zg-good', name: 'G', color: 'lime', zoneIds: [a] },
        { id: 'zg-bad', name: '', zoneIds: 'oops' },
      ],
      order: ['zg-good', 42, 'main'],
      rev: 7,
    });
    expect((await hub.api('GET', '/api/zone-groups', { cookie })).body).toEqual({
      groups: [{ id: 'zg-good', name: 'G', color: 'lime', zoneIds: [a] }],
      order: ['zg-good', 'main'],
      rev: 7,
    });
    const renamed = await hub.api('PATCH', '/api/zone-groups/zg-good', {
      cookie,
      body: { name: 'H' },
    });
    expect(renamed.body).toEqual({
      groups: [{ id: 'zg-good', name: 'H', color: 'lime', zoneIds: [a] }],
      order: ['zg-good', 'main'],
      rev: 8,
    });
  });

  it('存的資料壞掉：當成沒有群組，不讓快照或 GET 失敗', async () => {
    hub = await startHub();
    const cookie = await hub.setupOwner();
    hub.running.store.setRawJson(ZONE_GROUPS_KEY, { groups: 'oops', order: 3 });
    expect((await hub.api('GET', '/api/zone-groups', { cookie })).body).toEqual({
      groups: [],
      order: ['main'],
    });
    const state = await snapshot(cookie);
    expect(state.zoneGroups).toEqual({ groups: [], order: ['main'] });
  });
});
