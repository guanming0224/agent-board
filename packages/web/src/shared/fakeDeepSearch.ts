// 假後端的深層搜尋（P3 ③b）：模擬 hub 扇出給各台 daemon。demo 資料有三台機器：
// demo-studio 300ms 回結果、demo-gpu 慢（1.5 秒）、demo-laptop 失聯（「失聯沒搜到」）。
// 比對、片段、遮蔽用和 hub／daemon 同一份純函式（protocol 的 makeSnippet、security/secretPatterns）。
import {
  makeSnippet,
  parseSearchTerms,
  SEARCH_DEEP_PER_MACHINE,
  SEARCH_DEEP_PER_SESSION,
  SEARCH_SINCE_MS,
  type DeepSearchRequest,
  type DeepSearchState,
  type Machine,
  type SearchItem,
  type Session,
  type TranscriptEntry,
} from '@agent-board/protocol';
import { maskSecrets } from '../security/secretPatterns';
import type { DeepSearchEvent, DeepSearchHandle } from './backend';
import { fakeScope, type FakeSearchData } from './fakeSearch';

/** 每台在線機器多久回結果（沒列的用 FAKE_DEEP_DEFAULT_DELAY_MS）。 */
export const FAKE_DEEP_DELAYS: Record<string, number> = { 'm-studio': 300, 'm-gpu': 1500 };
const FAKE_DEEP_DEFAULT_DELAY_MS = 300;

export interface FakeDeepData extends Pick<FakeSearchData, 'sessions' | 'teams' | 'members'> {
  machines: readonly Machine[];
  /** claudeSessionId → 對話紀錄（和 sessionTranscript 讀的是同一份）。 */
  transcripts: ReadonlyMap<string, readonly TranscriptEntry[]>;
  /** 活著的 session 的畫面（邏輯行）。 */
  screens: ReadonlyMap<string, readonly string[]>;
  /** 舊版 daemon（沒有 search.v1）的機器。 */
  unsupported?: ReadonlySet<string>;
  now: number;
}

/** 同 hub：還沒開過的不搜；已結束且時間範圍內沒活動的不搜。 */
function searchable(session: Session, sinceMs: number): boolean {
  if (session.status === 'queued') return false;
  if (session.endedAt === null) return true;
  if (!session.claudeSessionId) return false;
  const last = [session.lastOutputAt, session.statusSince, session.endedAt]
    .filter((t): t is string => t !== null)
    .map((t) => Date.parse(t));
  return last.length > 0 && Math.max(...last) >= sinceMs;
}

/** 一台機器上的搜尋（同 daemon 的 deepSearch.ts：畫面先、每 session 最多 3 筆、對話紀錄留最新的）。 */
function searchMachine(
  machineId: string,
  sessions: readonly Session[],
  terms: readonly string[],
  mask: boolean,
  sinceMs: number,
  data: FakeDeepData,
): SearchItem[] {
  const match = (text: string) => makeSnippet(mask ? maskSecrets(text) : text, terms);
  const items: SearchItem[] = [];
  for (const session of sessions) {
    const found: SearchItem[] = [];
    const screen = session.endedAt === null ? data.screens.get(session.id) : undefined;
    for (const line of [...(screen ?? [])].reverse()) {
      if (found.length >= SEARCH_DEEP_PER_SESSION) break;
      const hit = match(line);
      if (hit) found.push({ kind: 'screen', sessionId: session.id, ...hit, machineId });
    }
    const transcript = session.claudeSessionId
      ? data.transcripts.get(session.claudeSessionId)
      : undefined;
    const hits: SearchItem[] = [];
    for (const entry of transcript ?? []) {
      if (entry.at !== null && Date.parse(entry.at) < sinceMs) continue;
      const hit = match(entry.text);
      if (!hit) continue;
      hits.push({
        kind: 'transcript',
        sessionId: session.id,
        ...hit,
        ...(entry.at !== null ? { at: entry.at } : {}),
        machineId,
        transcriptIndex: entry.index,
      });
    }
    found.push(...hits.slice(-Math.max(0, SEARCH_DEEP_PER_SESSION - found.length)));
    items.push(...found);
  }
  return items.slice(0, SEARCH_DEEP_PER_MACHINE);
}

export function fakeDeepSearch(
  request: Omit<DeepSearchRequest, 'searchId'>,
  data: FakeDeepData,
  listener: (event: DeepSearchEvent) => void,
): DeepSearchHandle {
  const searchId = crypto.randomUUID();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cancelled = false;
  const emit = (event: DeepSearchEvent, delayMs = 0) => {
    timers.push(
      setTimeout(() => {
        if (!cancelled) listener(event);
      }, delayMs),
    );
  };
  const terms = parseSearchTerms(request.q);
  const sinceMs = data.now - SEARCH_SINCE_MS[request.since];
  const byMachine = new Map<string, Session[]>();
  if (terms.length > 0) {
    for (const session of fakeScope(request, data).sessions.values()) {
      if (!searchable(session, sinceMs)) continue;
      byMachine.set(session.machineId, [...(byMachine.get(session.machineId) ?? []), session]);
    }
  }
  emit({
    type: 'search.deepStarted',
    searchId,
    machines: [...byMachine].map(([machineId, list]) => ({
      machineId,
      totalSessions: list.length,
    })),
  });
  for (const [machineId, list] of byMachine) {
    const done = (state: DeepSearchState, scanned: number, delayMs: number) =>
      emit(
        {
          type: 'search.deepDone',
          searchId,
          machineId,
          state,
          scannedSessions: scanned,
          totalSessions: list.length,
        },
        delayMs,
      );
    const online = data.machines.find((m) => m.id === machineId)?.online ?? false;
    if (!online) {
      done('offline', 0, 0);
      continue;
    }
    if (data.unsupported?.has(machineId)) {
      done('unsupported', 0, 0);
      continue;
    }
    const delay = FAKE_DEEP_DELAYS[machineId] ?? FAKE_DEEP_DEFAULT_DELAY_MS;
    const items = searchMachine(machineId, list, terms, request.mask, sinceMs, data);
    if (items.length > 0) emit({ type: 'search.deepResult', searchId, machineId, items }, delay);
    done('done', list.length, delay);
  }
  return {
    searchId,
    cancel: () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
