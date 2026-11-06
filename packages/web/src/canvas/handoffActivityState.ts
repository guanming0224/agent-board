// 交接動畫的狀態：hub 的 handoff.*／dispatch.*／task.* 事件 → 哪一條線正在「說話」、剛說過話。不碰 React，方便單元測試。
import type { SessionEvent } from '@agent-board/protocol';

/**
 * fired：hub 決定交接、排進佇列（還沒打進目標）；delivered：真的送進目標終端機；
 * blocked：擋下；dropped：排隊中被取消；verdict：審查的判定（通過／退回），不是送字。
 */
export type HandoffKind = 'fired' | 'delivered' | 'blocked' | 'dropped' | 'verdict';
/** 事件屬於哪一類往來：畫布的篩選開關用（交接／派工／任務）。 */
export type Channel = 'handoff' | 'dispatch' | 'task';
export const CHANNELS: readonly Channel[] = ['handoff', 'dispatch', 'task'];
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
  /** 最後一筆事件的類別（交接／派工／任務）。 */
  channel: Channel;
  /** 最後一筆事件的 hub 事件名稱（例如 dispatch.send），用來挑「做了什麼」的字。 */
  type: string;
  /** 「做了什麼」的翻譯 key（canvas.link.what.*）。 */
  what: string;
  /** 同一件事的排入與送達用來對上的 id（workId／taskId／ruleId）；沒有是 null。 */
  ref: string | null;
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
  verdict: 2500,
};
/** 從收到起算，線維持「剛說過話」的時間。 */
export const RECENT_MS = 60_000;

interface EventSpec {
  kind: HandoffKind;
  channel: Channel;
  /** 事件記在哪一邊（hub 決定，比 payload 可信）：from＝來源、to＝目標。 */
  at: 'from' | 'to';
}

/**
 * 認得的事件。記在哪一邊照 hub：交接的 fired／blocked／dropped 記在來源、delivered 記在目標；
 * 任務的 dispatched（排入）與 delivered 都記在收的那一邊；審查判定記在審查（來源）。
 * 直接送給負責人的新任務沒有來源成員，不畫。
 */
const EVENT_SPEC: Record<string, EventSpec> = {
  'handoff.fired': { kind: 'fired', channel: 'handoff', at: 'from' },
  'handoff.delivered': { kind: 'delivered', channel: 'handoff', at: 'to' },
  'handoff.blocked': { kind: 'blocked', channel: 'handoff', at: 'from' },
  'handoff.dropped': { kind: 'dropped', channel: 'handoff', at: 'from' },
  'task.dispatched': { kind: 'fired', channel: 'task', at: 'to' },
  'task.delivered': { kind: 'delivered', channel: 'task', at: 'to' },
  'task.reviewed': { kind: 'verdict', channel: 'task', at: 'from' },
  'task.rejected': { kind: 'verdict', channel: 'task', at: 'from' },
  // session 派工（CONTRACTS §11）：spawn／delivered 記在成員、send 記在呼叫者；
  // 結果 result 記在成員（成員 → 呼叫者排入）、result_delivered 記在呼叫者。
  'dispatch.spawn': { kind: 'delivered', channel: 'dispatch', at: 'to' },
  'dispatch.send': { kind: 'fired', channel: 'dispatch', at: 'from' },
  'dispatch.delivered': { kind: 'delivered', channel: 'dispatch', at: 'to' },
  'dispatch.result': { kind: 'fired', channel: 'dispatch', at: 'from' },
  'dispatch.result_delivered': { kind: 'delivered', channel: 'dispatch', at: 'to' },
  'dispatch.blocked': { kind: 'blocked', channel: 'dispatch', at: 'from' },
};

/** 「做了什麼」：派工分成開成員、派工、回報結果；任務分成新任務、送審、退回、判定。 */
function whatOf(type: string, payload: Record<string, unknown>): string {
  if (type.startsWith('handoff.')) return 'canvas.link.what.handoff';
  if (type === 'dispatch.spawn') return 'canvas.link.what.spawn';
  if (type === 'dispatch.result' || type === 'dispatch.result_delivered') {
    return 'canvas.link.what.result';
  }
  if (type.startsWith('dispatch.')) return 'canvas.link.what.dispatch';
  if (type === 'task.reviewed') return 'canvas.link.what.pass';
  if (type === 'task.rejected') return 'canvas.link.what.reject';
  const kind = payload.kind;
  return kind === 'review' || kind === 'reject'
    ? `canvas.link.what.task_${kind}`
    : 'canvas.link.what.task';
}

/** 送出（排入或送達）比擋下重要；判定和排入同級。 */
const RANK: Record<HandoffKind, number> = {
  blocked: 0,
  dropped: 0,
  fired: 1,
  verdict: 1,
  delivered: 2,
};

export const activityKey = (from: string, to: string) => `${from}->${to}`;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

export type Parsed = Pick<
  HandoffActivity,
  | 'key'
  | 'from'
  | 'to'
  | 'kind'
  | 'channel'
  | 'type'
  | 'what'
  | 'ref'
  | 'reason'
  | 'summary'
  | 'round'
  | 'maxRounds'
>;

/**
 * 不是交接事件、或來源／目標對不上就是 null。
 * 事件屬於哪個 session 由 hub 決定，比 payload 可信：fired／blocked／dropped 記在來源，
 * delivered 記在目標；payload 和它不一致的不採用。
 */
export function parseHandoffEvent(
  event: Pick<SessionEvent, 'type' | 'payload' | 'sessionId'>,
): Parsed | null {
  const spec = EVENT_SPEC[event.type];
  if (!spec) return null;
  const { kind, channel } = spec;
  const claimedFrom = text(event.payload.fromSessionId);
  const claimedTo = text(event.payload.toSessionId);
  let from: string | null;
  let to: string | null;
  if (spec.at === 'to') {
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
    channel,
    type: event.type,
    what: whatOf(event.type, event.payload),
    ref:
      text(event.payload.workId) ??
      text(event.payload.taskId) ??
      text(event.payload.ruleId) ??
      null,
    reason: kind === 'blocked' || kind === 'dropped' ? text(event.payload.reason) : null,
    // 退回的判定沒有摘要，原因就是要講的那句。
    summary:
      text(event.payload.summary) ?? (kind === 'verdict' ? text(event.payload.reason) : null),
    round: count(event.payload.round),
    maxRounds: count(event.payload.maxRounds),
  };
}

export type ActivityMap = ReadonlyMap<string, HandoffActivity>;

const counted = (counts: HandoffCounts, kind: HandoffKind): HandoffCounts => {
  // 判定算一則送出（審查把結果交回負責人）。
  const key = kind === 'dropped' ? 'blocked' : kind === 'verdict' ? 'fired' : kind;
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

/** 有東西交過去（流動動畫）：排入、送達、判定。擋下與取消只閃一下。 */
export const isSent = (kind: HandoffKind) =>
  kind === 'fired' || kind === 'delivered' || kind === 'verdict';

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
    Partial<Pick<HandoffActivity, 'maxRounds' | 'what'>>,
  t: Translate,
  mask: (text: string) => string,
): string {
  let text: string;
  if (isSent(activity.kind)) {
    text =
      firstLine(activity.summary === null ? null : mask(activity.summary)) ??
      // 判定（審查通過）本身就是內容，沒有摘要時寫判定。
      (activity.kind === 'verdict' && activity.what
        ? t(activity.what)
        : t('canvas.talk.noSummary'));
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
