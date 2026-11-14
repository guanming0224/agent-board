// 分頁群組（GM 2026-11-14，CONTRACTS §25）：把同類的工作區（畫布分頁）收進一個有名稱、有顏色、可收合的群組，
// 取代原本「超過 6 個收進『更多』」。群組與頂部列的排列全 hub 共用（存在 settings 表的 `zoneGroups` 鍵，不升 schema）；
// 展開／收合每台裝置自己記（前端 localStorage）。
//
// 這裡只有資料格式與純函式：hub、前端假後端、前端畫面都用同一套，排出來才一樣。
import { z } from 'zod';

export const ZONE_GROUP_NAME_MAX = 40;
/** 群組數上限（防呆，正常用不到）。 */
export const ZONE_GROUPS_MAX = 50;
/** 群組、工作區 id 的長度上限（hub 產生的是 uuid；使用者送來的字串一律有上限，audit 也不會被灌爆）。 */
export const ZONE_REF_MAX = 128;
/** 寫入時一次最多帶幾個工作區。 */
export const ZONE_GROUP_WRITE_ZONES_MAX = 500;
/** 讀取（存的資料、快照）時陣列的上限：遠大於實際會有的，只防壞資料。 */
const READ_LIST_MAX = 5000;

/** 群組或工作區的 id（有長度上限）。 */
export const ZoneRef = z.string().min(1).max(ZONE_REF_MAX);

export const ZoneGroupName = z.string().trim().min(1).max(ZONE_GROUP_NAME_MAX);
/**
 * 群組顏色：團隊框同一組色票（STYLE §4，避開狀態色）。web `team/colors.ts` 的 TEAM_COLORS 和這裡相同（web 單元測試比對）。
 * 寫入只收這 8 個；讀取寬鬆（id 格式即可，前端不認得的當 teal，不把任意字串放進 CSS），舊資料或未來新增的顏色不會讓整份讀不出來。
 */
export const ZONE_GROUP_COLORS = [
  'teal',
  'lime',
  'indigo',
  'apricot',
  'ice',
  'sand',
  'plum',
  'violet',
] as const;
export const ZoneGroupColorId = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/);
export const ZoneGroupColor = ZoneGroupColorId.default('teal');
/** 寫入用（建立、改顏色）。 */
export const ZoneGroupColorInput = z.enum(ZONE_GROUP_COLORS);

export const ZoneGroup = z.object({
  id: ZoneRef,
  name: ZoneGroupName,
  color: ZoneGroupColor,
  /** 群組裡的工作區，照顯示順序。一個工作區最多在一個群組裡。 */
  zoneIds: z.array(ZoneRef).max(READ_LIST_MAX).default([]),
});
export type ZoneGroup = z.infer<typeof ZoneGroup>;

export const ZoneGroups = z.object({
  groups: z.array(ZoneGroup).max(READ_LIST_MAX).default([]),
  /**
   * 頂部列由左到右的順序：群組 id 或「沒分組的工作區」id 混在一起。沒列到的（新建的工作區、舊資料）
   * 由 normalizeZoneGroups 接在最後面，照工作區的 position。
   */
  order: z.array(ZoneRef).max(READ_LIST_MAX).default([]),
  /**
   * 版本：hub 每次存都 +1。REST 回應與 WS 推送可能亂序到達（兩條連線），前端只收比手上新的（`rev` 較大）。
   * 選填：舊版 hub 沒有＝不比較。
   */
  rev: z.number().int().nonnegative().optional(),
});
export type ZoneGroups = z.infer<typeof ZoneGroups>;

export const EMPTY_ZONE_GROUPS: ZoneGroups = { groups: [], order: [] };

/**
 * 讀存的資料（hub settings 表）：壞掉的群組只丟那一個，順序裡壞掉的 id 只丟那一個，不要整份當空（之後一寫就把好的也蓋掉）。
 * 整個都不是物件＝沒有群組。
 */
export function parseZoneGroups(value: unknown): ZoneGroups {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_ZONE_GROUPS;
  const raw = value as { groups?: unknown; order?: unknown; rev?: unknown };
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v.slice(0, READ_LIST_MAX) : []);
  const groups = list(raw.groups).flatMap((g) => {
    const parsed = ZoneGroup.safeParse(g);
    return parsed.success ? [parsed.data] : [];
  });
  const order = list(raw.order).flatMap((t) => {
    const parsed = ZoneRef.safeParse(t);
    return parsed.success ? [parsed.data] : [];
  });
  const rev = z.number().int().nonnegative().safeParse(raw.rev);
  return rev.success ? { groups, order, rev: rev.data } : { groups, order };
}

/** 頂部列上的一格：沒分組的工作區，或一個群組（帶它的工作區）。 */
export type ZoneBarItem<Z extends { id: string }> =
  { kind: 'zone'; zone: Z } | { kind: 'group'; group: ZoneGroup; zones: Z[] };

/** 移動一格：工作區（放進某個群組或頂部列）或整個群組（只在頂部列）。before＝放在誰前面，null／沒給＝最後面。 */
export const ZoneBarMove = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('zone'),
    id: ZoneRef,
    /** 放進哪個群組；null／沒給＝頂部列（沒分組）。 */
    groupId: ZoneRef.nullable().optional(),
    before: ZoneRef.nullable().optional(),
  }),
  z.object({ kind: z.literal('group'), id: ZoneRef, before: ZoneRef.nullable().optional() }),
]);
export type ZoneBarMove = z.infer<typeof ZoneBarMove>;

export const ZoneGroupCreate = z.object({
  name: ZoneGroupName,
  color: ZoneGroupColorInput.default('teal'),
  /** 建立時一起放進去的工作區（例如分頁選單「加入群組 → 新群組…」帶這一個）。 */
  zoneIds: z.array(ZoneRef).max(ZONE_GROUP_WRITE_ZONES_MAX).default([]),
});
export type ZoneGroupCreate = z.infer<typeof ZoneGroupCreate>;

export const ZoneGroupPatch = z
  .object({ name: ZoneGroupName.optional(), color: ZoneGroupColorInput.optional() })
  .refine((p) => p.name !== undefined || p.color !== undefined, 'name or color required');
export type ZoneGroupPatch = z.infer<typeof ZoneGroupPatch>;

/** 建立群組的回應：新群組與整份群組資料。 */
export const ZoneGroupCreated = z.object({ group: ZoneGroup, zoneGroups: ZoneGroups });
export type ZoneGroupCreated = z.infer<typeof ZoneGroupCreated>;

/**
 * 前端收到新的一份（REST 回應或 WS 推送）時要不要換上：兩邊都有 rev 才比，只收比手上新的；任一邊沒有（舊版 hub）就換。
 */
export function isNewerZoneGroups(
  current: Pick<ZoneGroups, 'rev'> | null | undefined,
  next: Pick<ZoneGroups, 'rev'>,
): boolean {
  if (current?.rev === undefined || next.rev === undefined) return true;
  return next.rev > current.rev;
}

/** 純函式丟出的錯誤（hub 轉成 HTTP：unknown_zone 400、unknown_group 404、too_many_groups 409）。 */
export class ZoneGroupError extends Error {
  readonly code: 'unknown_zone' | 'unknown_group' | 'too_many_groups';
  constructor(code: ZoneGroupError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 整理成一致的樣子（hub 讀出來、前端收到時都先過一次）：
 * - 不存在的工作區（被刪了）從群組與順序拿掉；同一個工作區出現在兩個群組，只留第一個。
 * - order 只留存在的群組與「沒分組的工作區」，重複的拿掉；沒列到的群組、工作區接在最後（工作區照 zoneIds 的順序）。
 * - 空的群組保留（GM 自己刪）。
 * zoneIds 要照工作區的 position 排好（hub listZones、前端 zonesOf 都是）。
 */
export function normalizeZoneGroups(
  state: ZoneGroups | null | undefined,
  zoneIds: readonly string[],
): ZoneGroups {
  const known = new Set(zoneIds);
  const grouped = new Set<string>();
  const groupIds = new Set<string>();
  const groups: ZoneGroup[] = [];
  for (const g of state?.groups ?? []) {
    if (groupIds.has(g.id) || known.has(g.id)) continue;
    groupIds.add(g.id);
    const members = g.zoneIds.filter((id) => known.has(id) && !grouped.has(id));
    // 同一個群組裡重複的也拿掉。
    const unique = [...new Set(members)];
    unique.forEach((id) => grouped.add(id));
    groups.push({ ...g, zoneIds: unique });
  }
  const order: string[] = [];
  const placed = new Set<string>();
  for (const token of state?.order ?? []) {
    if (placed.has(token)) continue;
    if (groupIds.has(token) || (known.has(token) && !grouped.has(token))) {
      order.push(token);
      placed.add(token);
    }
  }
  for (const g of groups) if (!placed.has(g.id)) order.push(g.id);
  for (const id of zoneIds) {
    if (!grouped.has(id) && !placed.has(id)) {
      order.push(id);
      placed.add(id);
    }
  }
  // 版本照帶（hub 存檔時才 +1）。
  return state?.rev === undefined ? { groups, order } : { groups, order, rev: state.rev };
}

/** 頂部列由左到右要畫什麼。zones 照 position 排好。 */
export function zoneBarItems<Z extends { id: string }>(
  state: ZoneGroups | null | undefined,
  zones: readonly Z[],
): ZoneBarItem<Z>[] {
  const norm = normalizeZoneGroups(
    state,
    zones.map((z) => z.id),
  );
  const byId = new Map(zones.map((z) => [z.id, z]));
  const groups = new Map(norm.groups.map((g) => [g.id, g]));
  return norm.order.flatMap((token): ZoneBarItem<Z>[] => {
    const group = groups.get(token);
    if (group) {
      return [{ kind: 'group', group, zones: group.zoneIds.map((id) => byId.get(id)!) }];
    }
    const zone = byId.get(token);
    return zone ? [{ kind: 'zone', zone }] : [];
  });
}

/** 某個工作區在哪個群組（沒分組＝null）。 */
export function groupOfZone(state: ZoneGroups, zoneId: string): ZoneGroup | null {
  return state.groups.find((g) => g.zoneIds.includes(zoneId)) ?? null;
}

function insertBefore(list: string[], id: string, before: string | null | undefined): string[] {
  const rest = list.filter((x) => x !== id);
  const at = before && before !== id ? rest.indexOf(before) : -1;
  if (at < 0) return [...rest, id];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** 把工作區從群組與頂部列拿掉（移動、放進新群組前用）。 */
function detach(state: ZoneGroups, zoneId: string): ZoneGroups {
  return {
    groups: state.groups.map((g) =>
      g.zoneIds.includes(zoneId) ? { ...g, zoneIds: g.zoneIds.filter((x) => x !== zoneId) } : g,
    ),
    order: state.order.filter((x) => x !== zoneId),
  };
}

/** 移動一格（拖曳、選單的「加入群組」「移出群組」「往左／往右移」都走這裡）。 */
export function moveZoneBarItem(
  state: ZoneGroups | null | undefined,
  zoneIds: readonly string[],
  move: ZoneBarMove,
): ZoneGroups {
  const norm = normalizeZoneGroups(state, zoneIds);
  if (move.kind === 'group') {
    if (!norm.groups.some((g) => g.id === move.id)) {
      throw new ZoneGroupError('unknown_group', `Unknown zone group ${move.id}`);
    }
    return { ...norm, order: insertBefore(norm.order, move.id, move.before) };
  }
  if (!zoneIds.includes(move.id)) {
    throw new ZoneGroupError('unknown_zone', `Unknown workspace ${move.id}`);
  }
  const target = move.groupId ?? null;
  if (target !== null && !norm.groups.some((g) => g.id === target)) {
    throw new ZoneGroupError('unknown_group', `Unknown zone group ${target}`);
  }
  // 原本在哪個群組（移出群組時放回群組原本的位置後面，不跑到最後）。
  const from = groupOfZone(norm, move.id);
  const out = detach(norm, move.id);
  if (target === null) {
    let before = move.before;
    if (before === undefined && from) {
      // 沒指定位置的「移出群組」：放在群組右邊。
      const at = out.order.indexOf(from.id);
      before = out.order[at + 1] ?? null;
    }
    return { ...out, order: insertBefore(out.order, move.id, before) };
  }
  return {
    ...out,
    groups: out.groups.map((g) =>
      g.id === target ? { ...g, zoneIds: insertBefore(g.zoneIds, move.id, move.before) } : g,
    ),
  };
}

/**
 * 新群組：帶的工作區從原本的地方拿出來放進去。群組放在第一個工作區原本的位置（它原本在別的群組裡＝那個群組右邊），
 * 沒帶工作區就放最後。
 */
export function createZoneGroup(
  state: ZoneGroups | null | undefined,
  zoneIds: readonly string[],
  input: { id: string; name: string; color: string; zoneIds: readonly string[] },
): ZoneGroups {
  let norm = normalizeZoneGroups(state, zoneIds);
  if (norm.groups.length >= ZONE_GROUPS_MAX) {
    throw new ZoneGroupError('too_many_groups', `At most ${ZONE_GROUPS_MAX} zone groups`);
  }
  for (const id of input.zoneIds) {
    if (!zoneIds.includes(id)) throw new ZoneGroupError('unknown_zone', `Unknown workspace ${id}`);
  }
  const members = [...new Set(input.zoneIds)];
  const first = members[0];
  let at = norm.order.length;
  if (first !== undefined) {
    const own = norm.order.indexOf(first);
    if (own >= 0) at = own;
    else {
      const from = groupOfZone(norm, first);
      if (from) at = norm.order.indexOf(from.id) + 1;
    }
  }
  const memberSet = new Set(members);
  // 放在「原本位置之後第一個不是要搬走的」前面。
  const before = norm.order.slice(at).find((t) => !memberSet.has(t)) ?? null;
  for (const id of members) norm = detach(norm, id);
  const group: ZoneGroup = {
    id: input.id,
    name: input.name,
    color: input.color,
    zoneIds: members,
  };
  return {
    groups: [...norm.groups, group],
    order: insertBefore(norm.order, group.id, before),
  };
}

/** 取消群組（「取消群組」「刪除群組」都是這個）：群組不見，裡面的工作區照原順序回到頂部列、放在群組原本的位置。 */
export function ungroupZoneGroup(
  state: ZoneGroups | null | undefined,
  zoneIds: readonly string[],
  groupId: string,
): ZoneGroups {
  const norm = normalizeZoneGroups(state, zoneIds);
  const group = norm.groups.find((g) => g.id === groupId);
  if (!group) throw new ZoneGroupError('unknown_group', `Unknown zone group ${groupId}`);
  return {
    groups: norm.groups.filter((g) => g.id !== groupId),
    order: norm.order.flatMap((t) => (t === groupId ? group.zoneIds : [t])),
  };
}

/** 改名、換顏色。 */
export function patchZoneGroup(
  state: ZoneGroups | null | undefined,
  zoneIds: readonly string[],
  groupId: string,
  patch: { name?: string | undefined; color?: string | undefined },
): ZoneGroups {
  const norm = normalizeZoneGroups(state, zoneIds);
  if (!norm.groups.some((g) => g.id === groupId)) {
    throw new ZoneGroupError('unknown_group', `Unknown zone group ${groupId}`);
  }
  return {
    ...norm,
    groups: norm.groups.map((g) =>
      g.id === groupId
        ? {
            ...g,
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.color === undefined ? {} : { color: patch.color }),
          }
        : g,
    ),
  };
}
