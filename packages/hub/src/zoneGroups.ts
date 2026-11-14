// 分頁群組（GM 2026-11-14，CONTRACTS §25）：群組與頂部列順序全 hub 共用，存在 settings 表的 `zoneGroups` 鍵
// （不升 schema，仿 teamHold:／staffActivity）。每次寫入：純函式（protocol zoneGroups.ts）算出新的一份 → 版本 +1 存 →
// audit（只記解析後的實際結果，不原樣記使用者送來的字串）→ 整份推 WS zone.groups。
// 讀出來一律先整理（刪掉的工作區拿掉、新的工作區接在最後）；壞掉的群組只丟那一個。
// 權限和工作區相同（REST auth 'user'）。
import { randomUUID } from 'node:crypto';
import {
  createZoneGroup,
  groupOfZone,
  moveZoneBarItem,
  normalizeZoneGroups,
  parseZoneGroups,
  patchZoneGroup,
  ungroupZoneGroup,
  ZoneGroupError,
  type User,
  type ZoneBarMove,
  type ZoneGroup,
  type ZoneGroupCreate,
  type ZoneGroupPatch,
  type ZoneGroups,
} from '@agent-board/protocol';
import { HttpError } from './errors';
import type { Store } from './store';

/** settings 表的鍵。 */
export const ZONE_GROUPS_KEY = 'zoneGroups';

export interface ZoneGroupDeps {
  store: Store;
  audit(userId: string | null, sessionId: string | null, action: string, detail: string): void;
  /** 群組資料變了：整份推給每個 client（WS zone.groups）。 */
  changed(zoneGroups: ZoneGroups): void;
}

function attempt(fn: () => ZoneGroups): ZoneGroups {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ZoneGroupError) {
      const status =
        error.code === 'unknown_zone' ? 400 : error.code === 'unknown_group' ? 404 : 409;
      throw new HttpError(status, error.code, error.message);
    }
    throw error;
  }
}

/** 移動後這一格實際在哪裡（audit 用）：所在的群組（null＝頂部列）與位置。 */
function placeOf(state: ZoneGroups, kind: 'zone' | 'group', id: string) {
  if (kind === 'zone') {
    const group = groupOfZone(state, id);
    if (group) return { groupId: group.id, index: group.zoneIds.indexOf(id) };
  }
  return { groupId: null, index: state.order.indexOf(id) };
}

export class ZoneGroupStore {
  constructor(private readonly deps: ZoneGroupDeps) {}

  private zoneIds(): string[] {
    return this.deps.store.listZones().map((z) => z.id);
  }

  /** 存的原始資料（壞掉的群組、順序裡壞掉的 id 只丟那一個；整個讀不懂＝沒有群組）。 */
  private raw(): ZoneGroups {
    return parseZoneGroups(this.deps.store.getRawJson(ZONE_GROUPS_KEY));
  }

  /** 整理過的一份（快照、GET、每次寫入的回應）。 */
  get(): ZoneGroups {
    return normalizeZoneGroups(this.raw(), this.zoneIds());
  }

  /** 存：版本 +1（前端用來丟掉亂序到達的舊資料）。 */
  private save(next: ZoneGroups): ZoneGroups {
    const rev = (this.raw().rev ?? 0) + 1;
    const clean: ZoneGroups = { ...normalizeZoneGroups(next, this.zoneIds()), rev };
    this.deps.store.setRawJson(ZONE_GROUPS_KEY, clean);
    this.deps.changed(clean);
    return clean;
  }

  create(input: ZoneGroupCreate, user: User): { group: ZoneGroup; zoneGroups: ZoneGroups } {
    const id = `zg-${randomUUID()}`;
    const zoneGroups = this.save(
      attempt(() => createZoneGroup(this.raw(), this.zoneIds(), { id, ...input })),
    );
    const group = zoneGroups.groups.find((g) => g.id === id)!;
    // 只記存進去的結果（名稱已去空白限長、顏色是色票、工作區都已確認存在）。
    this.deps.audit(
      user.id,
      null,
      'zoneGroup.create',
      JSON.stringify({ id, name: group.name, color: group.color, zoneIds: group.zoneIds }),
    );
    return { group, zoneGroups };
  }

  update(id: string, patch: ZoneGroupPatch, user: User): ZoneGroups {
    const before = this.get().groups.find((g) => g.id === id);
    const zoneGroups = this.save(
      attempt(() => patchZoneGroup(this.raw(), this.zoneIds(), id, patch)),
    );
    const after = zoneGroups.groups.find((g) => g.id === id)!;
    this.deps.audit(
      user.id,
      null,
      'zoneGroup.update',
      JSON.stringify({
        id,
        from: { name: before?.name, color: before?.color },
        to: { name: after.name, color: after.color },
      }),
    );
    return zoneGroups;
  }

  /** 取消群組：只拿掉群組，工作區（畫布）留著、回到頂部列。 */
  ungroup(id: string, user: User): ZoneGroups {
    const before = this.get().groups.find((g) => g.id === id);
    const zoneGroups = this.save(attempt(() => ungroupZoneGroup(this.raw(), this.zoneIds(), id)));
    this.deps.audit(
      user.id,
      null,
      'zoneGroup.delete',
      JSON.stringify({ id, name: before?.name, zoneIds: before?.zoneIds ?? [] }),
    );
    return zoneGroups;
  }

  move(move: ZoneBarMove, user: User): ZoneGroups {
    const zoneGroups = this.save(attempt(() => moveZoneBarItem(this.raw(), this.zoneIds(), move)));
    // id 已確認存在；記移動後實際的位置，不記送來的 before／groupId 字串。
    this.deps.audit(
      user.id,
      null,
      'zoneGroup.move',
      JSON.stringify({ kind: move.kind, id: move.id, ...placeOf(zoneGroups, move.kind, move.id) }),
    );
    return zoneGroups;
  }

  /**
   * 工作區被刪了：從群組與順序拿掉（存回去）並推給每個 client。沒有存過群組資料就什麼都不做。
   * 建立工作區不用存：讀的時候自然接在最後。
   */
  zoneDeleted(): void {
    if (this.deps.store.getRawJson(ZONE_GROUPS_KEY) === null) return;
    this.save(this.raw());
  }
}
