// 交接動畫的狀態：hub 的 handoff.* 事件 → 哪一條線正在「說話」、剛說過話。不碰 React，方便單元測試。
import type { SessionEvent } from '@agent-board/protocol';

export type HandoffKind = 'fired' | 'blocked' | 'dropped';
/** active：正在播動畫；recent：一分鐘內說過話，線維持淡淡的標記。 */
export type HandoffPhase = 'active' | 'recent';

export interface HandoffActivity {
  /** 和畫布交接線的 id 相同（teams.ts 的 `${source}->${target}`）。 */
  key: string;
  from: string;
  to: string;
  kind: HandoffKind;
  /** 擋下或取消的原因（hub 的 reason）；成功是 null。 */
  reason: string | null;
  /** 一句摘要（hub 送進目標終端機的那句）；舊版 hub 沒有。 */
  summary: string | null;
  /** 收到事件的時間（ms）。hub 的事件時間可能接在別台機器的時鐘後面，所以不用它。 */
  receivedAt: number;
  phase: HandoffPhase;
  /** 每收到一次就加一：同一條線連續觸發時，用來重播動畫。 */
  seq: number;
}

/** 成功的交接流動久一點，看得出方向；擋下只閃一下。 */
export const ACTIVE_MS: Record<HandoffKind, number> = { fired: 4000, blocked: 1800, dropped: 1800 };
/** 從收到起算，線維持「剛說過話」的時間。 */
export const RECENT_MS = 60_000;

const KIND_OF: Record<string, HandoffKind> = {
  'handoff.fired': 'fired',
  'handoff.blocked': 'blocked',
  'handoff.dropped': 'dropped',
};

export const activityKey = (from: string, to: string) => `${from}->${to}`;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/** 不是交接事件、或缺來源／目標就是 null。 */
export function parseHandoffEvent(
  event: Pick<SessionEvent, 'type' | 'payload' | 'sessionId'>,
): Omit<HandoffActivity, 'receivedAt' | 'phase' | 'seq'> | null {
  const kind = KIND_OF[event.type];
  if (!kind) return null;
  const from = text(event.payload.fromSessionId) ?? event.sessionId;
  const to = text(event.payload.toSessionId);
  if (!to || from === to) return null;
  return {
    key: activityKey(from, to),
    from,
    to,
    kind,
    reason: kind === 'fired' ? null : (text(event.payload.reason) ?? null),
    summary: text(event.payload.summary),
  };
}

export type ActivityMap = ReadonlyMap<string, HandoffActivity>;

/** 收到一筆事件。不是交接事件就原樣回傳。 */
export function recordHandoff(
  map: ActivityMap,
  event: Pick<SessionEvent, 'type' | 'payload' | 'sessionId'>,
  now: number,
): ActivityMap {
  const parsed = parseHandoffEvent(event);
  if (!parsed) return map;
  const seq = (map.get(parsed.key)?.seq ?? 0) + 1;
  const next = new Map(map);
  next.set(parsed.key, { ...parsed, receivedAt: now, phase: 'active', seq });
  return next;
}

/** 某個時間點這筆紀錄該在哪個階段；過期是 null。 */
export function phaseAt(
  activity: Pick<HandoffActivity, 'kind' | 'receivedAt'>,
  now: number,
): HandoffPhase | null {
  const elapsed = now - activity.receivedAt;
  if (elapsed < ACTIVE_MS[activity.kind]) return 'active';
  if (elapsed < RECENT_MS) return 'recent';
  return null;
}

/** 依時間推進每一筆的階段、清掉過期的。沒有變化就回傳同一個物件（store 不會觸發重繪）。 */
export function advance(map: ActivityMap, now: number): ActivityMap {
  let next: Map<string, HandoffActivity> | null = null;
  for (const [key, activity] of map) {
    const phase = phaseAt(activity, now);
    if (phase === activity.phase) continue;
    next ??= new Map(map);
    if (phase === null) next.delete(key);
    else next.set(key, { ...activity, phase });
  }
  return next ?? map;
}

/** 下一次有紀錄要換階段的時間（ms）；沒有就是 null。store 只在這些時間點更新，不每格重繪。 */
export function nextChangeAt(map: ActivityMap): number | null {
  let soonest: number | null = null;
  for (const activity of map.values()) {
    const at =
      activity.phase === 'active'
        ? activity.receivedAt + ACTIVE_MS[activity.kind]
        : activity.receivedAt + RECENT_MS;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

/** 卡片的接收光圈：有一筆成功交接正在播放、目標是這張卡。 */
export const isReceiving = (map: ActivityMap, sessionId: string): boolean =>
  [...map.values()].some((a) => a.to === sessionId && a.kind === 'fired' && a.phase === 'active');

/** 摘要只顯示第一行，太長截斷。 */
export function firstLine(summary: string | null, max = 120): string | null {
  const line = summary
    ?.split(/\r?\n/)
    .find((l) => l.trim() !== '')
    ?.trim();
  if (!line) return null;
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
}
