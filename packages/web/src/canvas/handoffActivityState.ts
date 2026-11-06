// 交接動畫的狀態：hub 的 handoff.* 事件 → 哪一條線正在「說話」、剛說過話。不碰 React，方便單元測試。
import type { SessionEvent } from '@agent-board/protocol';

/**
 * fired：hub 決定交接、排進佇列（還沒打進目標）；delivered：真的送進目標終端機；
 * blocked：擋下；dropped：排隊中被取消。
 */
export type HandoffKind = 'fired' | 'delivered' | 'blocked' | 'dropped';
/** active：正在播動畫；recent：一分鐘內說過話，線維持淡淡的標記。 */
export type HandoffPhase = 'active' | 'recent';

/** 同一波（動畫還在播時陸續收到的）事件數。同一對 session 可能有好幾條規則。 */
export interface HandoffCounts {
  fired: number;
  delivered: number;
  /** 擋下＋取消。 */
  blocked: number;
}

export interface HandoffActivity {
  /** 和畫布交接線的 id 相同（teams.ts 的 `${source}->${target}`）。 */
  key: string;
  from: string;
  to: string;
  /** 這一波要顯示的結果：送出的優先，後來的擋下不會蓋掉它。 */
  kind: HandoffKind;
  /** 擋下或取消的原因（hub 的 reason）；成功是 null。 */
  reason: string | null;
  /** 一句摘要（hub 送進目標終端機的那句）；舊版 hub 沒有。 */
  summary: string | null;
  /** 雙向交接（規則有 maxRounds）的第幾輪與上限；單向規則與舊版 hub 是 null。 */
  round: number | null;
  maxRounds: number | null;
  counts: HandoffCounts;
  /** 收到事件的時間（ms）。hub 的事件時間可能接在別台機器的時鐘後面，所以不用它。 */
  receivedAt: number;
  phase: HandoffPhase;
  /** 開始新的一波時加一：用來重播動畫。 */
  seq: number;
}

/** 成功的交接流動久一點，看得出方向；擋下只閃一下。 */
export const ACTIVE_MS: Record<HandoffKind, number> = {
  fired: 4000,
  delivered: 4000,
  blocked: 1800,
  dropped: 1800,
};
/** 從收到起算，線維持「剛說過話」的時間。 */
export const RECENT_MS = 60_000;

const KIND_OF: Record<string, HandoffKind> = {
  'handoff.fired': 'fired',
  'handoff.delivered': 'delivered',
  'handoff.blocked': 'blocked',
  'handoff.dropped': 'dropped',
  // 任務自動執行的送審（負責人 → 審查）與退回（審查 → 負責人）也走同一條線；
  // 直接送給負責人的新任務沒有來源成員，不畫。
  'task.delivered': 'delivered',
  // session 派工（CONTRACTS §11）：spawn／delivered 記在成員、send 記在呼叫者；
  // 結果 result 記在成員（成員 → 呼叫者排入）、result_delivered 記在呼叫者。
  'dispatch.spawn': 'delivered',
  'dispatch.send': 'fired',
  'dispatch.delivered': 'delivered',
  'dispatch.result': 'fired',
  'dispatch.result_delivered': 'delivered',
  'dispatch.blocked': 'blocked',
};

/** 送出（排入或送達）比擋下重要。 */
const RANK: Record<HandoffKind, number> = { blocked: 0, dropped: 0, fired: 1, delivered: 2 };

export const activityKey = (from: string, to: string) => `${from}->${to}`;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

type Parsed = Pick<
  HandoffActivity,
  'key' | 'from' | 'to' | 'kind' | 'reason' | 'summary' | 'round' | 'maxRounds'
>;

/**
 * 不是交接事件、或來源／目標對不上就是 null。
 * 事件屬於哪個 session 由 hub 決定，比 payload 可信：fired／blocked／dropped 記在來源，
 * delivered 記在目標；payload 和它不一致的不採用。
 */
export function parseHandoffEvent(
  event: Pick<SessionEvent, 'type' | 'payload' | 'sessionId'>,
): Parsed | null {
  const kind = KIND_OF[event.type];
  if (!kind) return null;
  const claimedFrom = text(event.payload.fromSessionId);
  const claimedTo = text(event.payload.toSessionId);
  let from: string | null;
  let to: string | null;
  if (kind === 'delivered') {
    if (claimedTo !== event.sessionId) return null;
    from = claimedFrom;
    to = event.sessionId;
  } else {
    if (claimedFrom !== null && claimedFrom !== event.sessionId) return null;
    from = event.sessionId;
    to = claimedTo;
  }
  if (!from || !to || from === to) return null;
  return {
    key: activityKey(from, to),
    from,
    to,
    kind,
    reason: kind === 'blocked' || kind === 'dropped' ? text(event.payload.reason) : null,
    summary: text(event.payload.summary),
    round: count(event.payload.round),
    maxRounds: count(event.payload.maxRounds),
  };
}

export type ActivityMap = ReadonlyMap<string, HandoffActivity>;

const counted = (counts: HandoffCounts, kind: HandoffKind): HandoffCounts => {
  const key = kind === 'dropped' ? 'blocked' : kind;
  return { ...counts, [key]: counts[key] + 1 };
};

/**
 * 收到一筆事件。不是交接事件就原樣回傳。
 * 同一條線動畫還在播時收到的算同一波：累加次數，擋下不蓋掉送出；送達會把排入升級（目標卡亮起）。
 */
export function recordHandoff(
  map: ActivityMap,
  event: Pick<SessionEvent, 'type' | 'payload' | 'sessionId'>,
  now: number,
): ActivityMap {
  const parsed = parseHandoffEvent(event);
  if (!parsed) return map;
  const prev = map.get(parsed.key);
  const next = new Map(map);
  if (!prev || prev.phase !== 'active') {
    next.set(parsed.key, {
      ...parsed,
      counts: counted({ fired: 0, delivered: 0, blocked: 0 }, parsed.kind),
      receivedAt: now,
      phase: 'active',
      seq: (prev?.seq ?? 0) + 1,
    });
    return next;
  }
  const counts = counted(prev.counts, parsed.kind);
  if (RANK[parsed.kind] < RANK[prev.kind]) {
    next.set(parsed.key, { ...prev, counts });
  } else if (RANK[parsed.kind] === RANK[prev.kind] && parsed.kind === prev.kind) {
    // 同類再來一筆：換成最新的內容，重新計時，但不重播（seq 不變）。
    next.set(parsed.key, { ...prev, ...parsed, counts, receivedAt: now });
  } else {
    // 升級（擋下 → 送出、排入 → 送達）：摘要沒有就沿用前一筆的。
    next.set(parsed.key, {
      ...prev,
      ...parsed,
      summary: parsed.summary ?? prev.summary,
      counts,
      receivedAt: now,
      seq: RANK[prev.kind] === 0 ? prev.seq + 1 : prev.seq,
    });
  }
  return next;
}

/** 這一波送出幾則（排入和送達是同一則的兩個階段，取大的）。 */
export const sentCount = (counts: HandoffCounts) => Math.max(counts.fired, counts.delivered);

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

/** 卡片的接收光圈：交接真的送進這張卡（送達），而且還在播放。只是排入不算。 */
export const isReceiving = (map: ActivityMap, sessionId: string): boolean =>
  [...map.values()].some(
    (a) => a.to === sessionId && a.kind === 'delivered' && a.phase === 'active',
  );

/** 「第 2/3 輪」：只有雙向交接有。擋下的輪數會超過上限，顯示上限就好。 */
export function roundLabel(
  activity: Pick<HandoffActivity, 'round' | 'maxRounds' | 'kind'>,
  t: Translate,
): string | null {
  if (activity.round === null || activity.maxRounds === null) return null;
  return t('canvas.talk.round', {
    n: Math.min(activity.round, activity.maxRounds),
    max: activity.maxRounds,
  });
}

/** 摘要只顯示第一行，太長截斷。先遮蔽再截斷，金鑰才不會被切在邊界上漏出一半。 */
export function firstLine(summary: string | null, max = 120): string | null {
  const line = summary
    ?.split(/\r?\n/)
    .find((l) => l.trim() !== '')
    ?.trim();
  if (!line) return null;
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : line;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * 說明框的內容（不含來源、目標與時間）：成功寫摘要第一行，擋下寫原因；
 * 同一波有好幾則時加上「1 則送出、1 則擋下」。摘要與原因都先過 mask 再截斷。
 */
export function describeTalk(
  activity: Pick<HandoffActivity, 'kind' | 'reason' | 'summary' | 'counts'> &
    Partial<Pick<HandoffActivity, 'maxRounds'>>,
  t: Translate,
  mask: (text: string) => string,
): string {
  let text: string;
  if (activity.kind === 'fired' || activity.kind === 'delivered') {
    text =
      firstLine(activity.summary === null ? null : mask(activity.summary)) ??
      t('canvas.talk.noSummary');
  } else {
    const key = `canvas.talk.${activity.kind}.${activity.reason ?? ''}`;
    const reason = t(key, { max: activity.maxRounds ?? '?' });
    // 沒翻譯的新原因：照 hub 給的代碼顯示，不吞掉。
    text = mask(reason === key ? (activity.reason ?? activity.kind) : reason);
  }
  const sent = sentCount(activity.counts);
  const { blocked } = activity.counts;
  if (sent + blocked <= 1) return text;
  const parts = [
    ...(sent > 0 ? [t('canvas.talk.countSent', { n: sent })] : []),
    ...(blocked > 0 ? [t('canvas.talk.countBlocked', { n: blocked })] : []),
  ];
  return t('canvas.talk.withCounts', { text, counts: parts.join(t('canvas.talk.countSep')) });
}
