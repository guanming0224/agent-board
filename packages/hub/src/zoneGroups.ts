// 分頁群組（GM 2026-11-14，CONTRACTS §25）：群組與頂部列順序全 hub 共用，存在 settings 表的 `zoneGroups` 鍵
// （不升 schema，仿 teamHold:／staffActivity）。每次寫入：純函式（protocol zoneGroups.ts）算出新的一份 → 存 →
// audit → 整份推 WS zone.groups。讀出來一律先整理（刪掉的工作區拿掉、新的工作區接在最後）。
// 權限和工作區相同（REST auth 'user'）。
import { randomUUID } from 'node:crypto';
import {
  createZoneGroup,
  EMPTY_ZONE_GROUPS,
  moveZoneBarItem,
  normalizeZoneGroups,
  patchZoneGroup,
  ungroupZoneGroup,
  ZoneGroupError,
  ZoneGroups,
  type User,
  type ZoneBarMove,
  type ZoneGroup,
  type ZoneGroupCreate,
  type ZoneGroupPatch,
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

function toHttp(error: unknown): never {
  if (error instanceof ZoneGroupError) {
    const status = error.code === 'unknown_zone' ? 400 : error.code === 'unknown_group' ? 404 : 409;
    throw new HttpError(status, error.code, error.message);
  }
  throw error;
}

export class ZoneGroupStore {
  constructor(private readonly deps: ZoneGroupDeps) {}

  private zoneIds(): string[] {
    return this.deps.store.listZones().map((z) => z.id);
  }

  /** 存的原始資料（讀不懂＝沒有群組，不讓頂部列壞掉）。 */
  private raw(): ZoneGroups {
    const parsed = ZoneGroups.safeParse(this.deps.store.getRawJson(ZONE_GROUPS_KEY));
    return parsed.success ? parsed.data : EMPTY_ZONE_GROUPS;
  }

  /** 整理過的一份（快照、GET、每次寫入的回應）。 */
  get(): ZoneGroups {
    return normalizeZoneGroups(this.raw(), this.zoneIds());
  }

  private save(next: ZoneGroups): ZoneGroups {
    const clean = normalizeZoneGroups(next, this.zoneIds());
    this.deps.store.setRawJson(ZONE_GROUPS_KEY, clean);
    this.deps.changed(clean);
    return clean;
  }

  create(input: ZoneGroupCreate, user: User): { group: ZoneGroup; zoneGroups: ZoneGroups } {
    const id = `zg-${randomUUID()}`;
    let next: ZoneGroups;
    try {
      next = createZoneGroup(this.raw(), this.zoneIds(), { id, ...input });
    } catch (e) {
      toHttp(e);
    }
    const zoneGroups = this.save(next);
    this.deps.audit(
      user.id,
      null,
      'zoneGroup.create',
      JSON.stringify({ id, name: input.name, color: input.color, zoneIds: input.zoneIds }),
    );
    return { group: zoneGroups.groups.find((g) => g.id === id)!, zoneGroups };
  }

  update(id: string, patch: ZoneGroupPatch, user: User): ZoneGroups {
    const before = this.get().groups.find((g) => g.id === id);
    let next: ZoneGroups;
    try {
      next = patchZoneGroup(this.raw(), this.zoneIds(), id, patch);
    } catch (e) {
      toHttp(e);
    }
    const zoneGroups = this.save(next);
    this.deps.audit(
      user.id,
      null,
      'zoneGroup.update',
      JSON.stringify({ id, from: { name: before?.name, color: before?.color }, to: patch }),
    );
    return zoneGroups;
  }

  /** 取消群組／刪除群組：只拿掉群組，工作區（畫布）留著、回到頂部列。 */
  ungroup(id: string, user: User): ZoneGroups {
    const before = this.get().groups.find((g) => g.id === id);
    let next: ZoneGroups;
    try {
      next = ungroupZoneGroup(this.raw(), this.zoneIds(), id);
    } catch (e) {
      toHttp(e);
    }
    const zoneGroups = this.save(next);
    this.deps.audit(
      user.id,
      null,
      'zoneGroup.delete',
      JSON.stringify({ id, name: before?.name, zoneIds: before?.zoneIds ?? [] }),
    );
    return zoneGroups;
  }

  move(move: ZoneBarMove, user: User): ZoneGroups {
    let next: ZoneGroups;
    try {
      next = moveZoneBarItem(this.raw(), this.zoneIds(), move);
    } catch (e) {
      toHttp(e);
    }
    const zoneGroups = this.save(next);
    this.deps.audit(user.id, null, 'zoneGroup.move', JSON.stringify(move));
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
