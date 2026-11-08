// 全域搜尋的深層（P3 ③b，docs/p3-spec.md §3.5–§3.7、CONTRACTS §16）：按 Enter 才跑。hub 依範圍挑出 session，
// 依機器分組，對每台在線且支援 `search.v1` 的 daemon 送一個 search.request；結果逐台串流轉給發起的那條連線。
// hub 不存終端機與對話內容（CONTRACTS §2）：片段只經過記憶體轉送，不建索引、不落地。
// 一個使用者同時只有一個深層搜尋（新的取消舊的）；每次搜尋結束（或取消）寫一筆 audit `search.deep`。
import {
  AbsolutePath,
  ClaudeSessionId,
  DAEMON_FEATURES,
  DeepSearchLimits,
  findTerms,
  foldCase,
  parseSearchTerms,
  SEARCH_DEEP_GRACE_MS,
  SEARCH_SINCE_MS,
  type DaemonToHub,
  type DeepSearchRequest,
  type DeepSearchState,
  type DeepSearchTarget,
  type HubToClient,
  type HubToDaemon,
  type SearchItem,
  type Session,
} from '@agent-board/protocol';
import { redactSecrets } from './audit';
import { searchScope } from './search';
import { maskSecrets } from './secretPatterns';
import type { Store } from './store';

/** hub 看得到的一台 daemon（只要知道功能旗標、能送訊息）。 */
export interface DeepSearchDaemon {
  readonly features: ReadonlySet<string>;
  send(message: HubToDaemon): void;
}

export interface DeepSearchDeps<C> {
  store: Store;
  /** 在線（已 hello）的 daemon；不在線回 null。 */
  daemon(machineId: string): DeepSearchDaemon | null;
  sendClient(client: C, message: HubToClient): void;
  audit(userId: string, action: string, detail: string): void;
  now(): number;
  /** 測試用：改上限與寬限時間。 */
  limits?: Partial<DeepSearchLimits>;
  graceMs?: number;
}

interface MachineRun {
  state: 'searching' | DeepSearchState;
  items: number;
  totalSessions: number;
  /** 這台機器上要搜的 session（daemon 回的結果只收這些）。 */
  sessions: ReadonlySet<string>;
  timer: NodeJS.Timeout | null;
}

interface Run<C> {
  searchId: string;
  client: C;
  userId: string;
  terms: string[];
  mask: boolean;
  /** audit 用：已經過 redactSecrets 的查詢字。 */
  query: string;
  machines: Map<string, MachineRun>;
}

/** 已經有結果、不會再變的機器狀態。 */
const settled = (m: MachineRun) => m.state !== 'searching';

/** 最後活動時間：輸出、狀態改變、結束三者取最新。 */
function lastActivity(session: Session): string | null {
  const times = [session.lastOutputAt, session.statusSince, session.endedAt].filter(
    (t): t is string => t !== null,
  );
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/** 資料庫裡的 accountProfile（舊資料可能是 '' 或相對路徑）：'' 當預設帳號；不是絕對路徑回 undefined（不搜，不猜）。 */
const absolute = (profile: string | null) =>
  !profile ? null : AbsolutePath.safeParse(profile).success ? profile : undefined;

/** 資料庫裡的 claude id 不合格式就當沒有：daemon 拿它組檔名。 */
function validClaudeId(id: string | null): string | null {
  if (id === null) return null;
  const parsed = ClaudeSessionId.safeParse(id);
  return parsed.success ? parsed.data : null;
}

export class DeepSearchEngine<C> {
  private readonly runs = new Map<string, Run<C>>();
  private readonly limits: DeepSearchLimits;
  private readonly graceMs: number;

  constructor(private readonly deps: DeepSearchDeps<C>) {
    this.limits = DeepSearchLimits.parse(deps.limits ?? {});
    this.graceMs = deps.graceMs ?? SEARCH_DEEP_GRACE_MS;
  }

  /**
   * 開始一次深層搜尋：取消這個使用者進行中的那個，挑出範圍內的 session、依機器分組，
   * 先告訴瀏覽器要搜哪幾台（search.deepStarted），失聯與舊版的機器立刻回 deepDone。
   */
  start(client: C, userId: string, request: DeepSearchRequest): void {
    for (const run of [...this.runs.values()]) {
      if (run.userId === userId || run.searchId === request.searchId) this.finish(run, true);
    }
    const terms = parseSearchTerms(request.q);
    const run: Run<C> = {
      searchId: request.searchId,
      client,
      userId,
      terms,
      mask: request.mask,
      query: redactSecrets(request.q),
      machines: new Map(),
    };
    if (terms.length === 0) {
      this.deps.sendClient(client, {
        type: 'search.deepStarted',
        searchId: request.searchId,
        machines: [],
      });
      return;
    }
    const sinceMs = this.deps.now() - SEARCH_SINCE_MS[request.since];
    const since = new Date(sinceMs).toISOString();
    const byMachine = new Map<string, DeepSearchTarget[]>();
    const { sessions } = searchScope(this.deps.store, request);
    for (const session of sessions.values()) {
      const target = this.targetOf(session, sinceMs);
      if (!target) continue;
      byMachine.set(session.machineId, [...(byMachine.get(session.machineId) ?? []), target]);
    }
    for (const [machineId, targets] of byMachine) {
      run.machines.set(machineId, {
        state: 'searching',
        items: 0,
        totalSessions: targets.length,
        sessions: new Set(targets.map((t) => t.sessionId)),
        timer: null,
      });
    }
    this.runs.set(run.searchId, run);
    this.deps.sendClient(client, {
      type: 'search.deepStarted',
      searchId: run.searchId,
      machines: [...run.machines].map(([machineId, m]) => ({
        machineId,
        totalSessions: m.totalSessions,
      })),
    });
    for (const [machineId, targets] of byMachine) {
      const daemon = this.deps.daemon(machineId);
      if (!daemon) {
        this.settle(run, machineId, 'offline', 0);
        continue;
      }
      if (!daemon.features.has(DAEMON_FEATURES.search)) {
        // 舊版 daemon 不認得 search.request（會丟掉並記 log）：不送，標「版本太舊不支援」。
        this.settle(run, machineId, 'unsupported', 0);
        continue;
      }
      daemon.send({
        type: 'search.request',
        searchId: run.searchId,
        terms,
        mask: run.mask,
        since,
        sessions: targets,
        limits: this.limits,
      });
      const machine = run.machines.get(machineId)!;
      machine.timer = setTimeout(() => {
        // daemon 自己的 deadline 過了還沒回：當成逾時，叫它停。
        this.deps.daemon(machineId)?.send({ type: 'search.cancel', searchId: run.searchId });
        this.settle(run, machineId, 'timeout', 0);
      }, this.limits.deadlineMs + this.graceMs);
      machine.timer.unref();
    }
    this.maybeFinish(run);
  }

  /** 瀏覽器取消（改字、再按 Enter、關視窗）：叫還在搜的 daemon 停下，寫 audit。 */
  cancel(client: C, searchId: string): void {
    const run = this.runs.get(searchId);
    if (run && run.client === client) this.finish(run, true);
  }

  onDaemonMessage(
    machineId: string,
    message: Extract<DaemonToHub, { type: 'search.result' | 'search.done' }>,
  ): void {
    const run = this.runs.get(message.searchId);
    const machine = run?.machines.get(machineId);
    if (!run || !machine || settled(machine)) {
      // 已取消或逾時的搜尋晚到的結果：丟掉；若 daemon 還在搜就叫它停。
      if (message.type === 'search.result' && !run) {
        this.deps.daemon(machineId)?.send({ type: 'search.cancel', searchId: message.searchId });
      }
      return;
    }
    if (message.type === 'search.done') {
      this.settle(run, machineId, message.state, message.scannedSessions);
      this.maybeFinish(run);
      return;
    }
    const room = this.limits.perMachine - machine.items;
    const items = message.items
      // daemon 只能回自己機器上、這次範圍內的 session。
      .filter((item) => item.sessionId !== undefined && machine.sessions.has(item.sessionId))
      .filter((item) => item.kind === 'transcript' || item.kind === 'screen')
      .slice(0, Math.max(0, room))
      .map((item) => this.sanitize(run, machineId, item));
    if (items.length === 0) return;
    machine.items += items.length;
    this.deps.sendClient(run.client, {
      type: 'search.deepResult',
      searchId: run.searchId,
      machineId,
      items,
    });
  }

  /** daemon 斷線：還在搜的那幾次，這台標失聯。 */
  onDaemonGone(machineId: string): void {
    for (const run of [...this.runs.values()]) {
      const machine = run.machines.get(machineId);
      if (!machine || settled(machine)) continue;
      this.settle(run, machineId, 'offline', 0);
      this.maybeFinish(run);
    }
  }

  /** 瀏覽器斷線：它的搜尋全部取消。 */
  onClientGone(client: C): void {
    for (const run of [...this.runs.values()]) {
      if (run.client === client) this.finish(run, true);
    }
  }

  dispose(): void {
    for (const run of [...this.runs.values()]) this.finish(run, true, false);
  }

  /** 進行中的搜尋數（測試用）。 */
  get active(): number {
    return this.runs.size;
  }

  private targetOf(session: Session, sinceMs: number): DeepSearchTarget | null {
    if (session.status === 'queued') return null; // 還沒開過：沒有畫面也沒有對話紀錄
    const accountProfile = absolute(session.accountProfile);
    if (accountProfile === undefined) return null;
    const alive = session.endedAt === null;
    const at = lastActivity(session);
    // 時間範圍內沒有活動的已結束 session：對話紀錄不會在範圍內被改過，不必叫 daemon 去找檔。
    if (!alive && (at === null || Date.parse(at) < sinceMs)) return null;
    const claudeSessionId = validClaudeId(session.claudeSessionId);
    if (!alive && claudeSessionId === null) return null;
    return {
      sessionId: session.id,
      claudeSessionId,
      accountProfile,
      lastActivityAt: at,
    };
  }

  /** 補 machineId；遮蔽模式再檢查一次（daemon 已遮好，這裡是第二道：舊規則或有問題的 daemon 不會把金鑰帶到裝置上）。 */
  private sanitize(run: Run<C>, machineId: string, item: SearchItem): SearchItem {
    const out: SearchItem = { ...item, machineId };
    if (!run.mask) return out;
    const masked = maskSecrets(item.snippet);
    if (masked === item.snippet) return out;
    return {
      ...out,
      snippet: masked,
      matchRanges: findTerms(foldCase(masked), run.terms) ?? [],
    };
  }

  private settle(run: Run<C>, machineId: string, state: DeepSearchState, scanned: number): void {
    const machine = run.machines.get(machineId);
    if (!machine || settled(machine)) return;
    if (machine.timer) clearTimeout(machine.timer);
    machine.timer = null;
    machine.state = state;
    this.deps.sendClient(run.client, {
      type: 'search.deepDone',
      searchId: run.searchId,
      machineId,
      state,
      scannedSessions: Math.min(scanned, machine.totalSessions),
      totalSessions: machine.totalSessions,
    });
  }

  private maybeFinish(run: Run<C>): void {
    if ([...run.machines.values()].every(settled)) this.finish(run, false);
  }

  /** 結束一次搜尋：取消時叫還在搜的 daemon 停下；寫一筆 audit。 */
  private finish(run: Run<C>, cancelled: boolean, audit = true): void {
    if (this.runs.get(run.searchId) !== run) return;
    this.runs.delete(run.searchId);
    for (const [machineId, machine] of run.machines) {
      if (machine.timer) clearTimeout(machine.timer);
      machine.timer = null;
      if (!settled(machine)) {
        this.deps.daemon(machineId)?.send({ type: 'search.cancel', searchId: run.searchId });
      }
    }
    if (!audit) return;
    const machines = [...run.machines].map(([machineId, m]) => ({
      machineId,
      state: settled(m) ? m.state : 'cancelled',
      items: m.items,
    }));
    this.deps.audit(
      run.userId,
      'search.deep',
      JSON.stringify({
        q: run.query,
        mask: run.mask,
        machines,
        timedOut: machines.some((m) => m.state === 'timeout'),
        cancelled,
      }),
    );
  }
}
