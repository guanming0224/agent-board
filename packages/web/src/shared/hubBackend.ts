// 真後端：REST 走 routes 表，其餘走 /ws/client（CONTRACTS.md §6、§7）。登入後才連 WebSocket。
import {
  HubToClient,
  routes,
  SEARCH_DEEP_DEADLINE_MS,
  SEARCH_DEEP_GRACE_MS,
  WS_PATHS,
} from '@agent-board/protocol';
import { progressOwnerKey, progressOwnerOf } from '@agent-board/protocol';
import type {
  BoardPauseState,
  Broadcast,
  ProgressCard,
  ProgressOwner,
  ClientToHub,
  ResourceSample,
  SessionEvent,
  RouteBody,
  RouteName,
  RouteQuery,
  RouteResponse,
  TeamActivity,
  StaffRequest,
  Review,
  User,
} from '@agent-board/protocol';
import type {
  BoardBackend,
  BoardListener,
  BoardSnapshot,
  DeepSearchEvent,
  DeepSearchHandle,
  TeamChange,
} from './backend';
import type { TerminalServerMessage, TerminalStream } from './terminal-contract';

/** LoginPage 依這三個欄位決定訊息。 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    /** ApiError.detail（例如 progress_conflict 的 ProgressConflict）。 */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface CallOptions<N extends RouteName> {
  params?: Record<string, string>;
  body?: RouteBody<N>;
  query?: RouteQuery<N>;
}

async function call<N extends RouteName>(
  name: N,
  options: CallOptions<N> = {},
): Promise<RouteResponse<N>> {
  return (await request(name, options).then((res) => res.json())) as RouteResponse<N>;
}

/** 送出並檢查狀態碼，回傳原始 Response；不是 JSON 的路由（audit 匯出）直接用這個。 */
async function request<N extends RouteName>(
  name: N,
  options: CallOptions<N> = {},
): Promise<Response> {
  const route = routes[name];
  let path: string = route.path;
  for (const [key, value] of Object.entries(options.params ?? {})) {
    path = path.replace(`:${key}`, encodeURIComponent(value));
  }
  if (options.query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    path += `?${search}`;
  }
  const res = await fetch(path, {
    method: route.method,
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
      detail?: Record<string, unknown>;
    } | null;
    const retry = Number(res.headers.get('retry-after'));
    // 登入過期：回登入頁。登入本身的 401 由 LoginPage 顯示。
    if (res.status === 401 && route.auth !== 'public') location.hash = '#/login';
    throw new ApiRequestError(
      res.status,
      error?.code ?? 'request_failed',
      error?.message ?? `HTTP ${res.status}`,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
      error?.detail,
    );
  }
  return res;
}

/** 深層搜尋：送出後多久沒收到 hub 的 search.deepStarted 就當 hub 沒收下（舊版 hub、訊息被拒）。 */
export const DEEP_START_TIMEOUT_MS = 5_000;
/** 深層搜尋整次最多等多久（各台的時間上限＋hub 的寬限＋網路餘裕）。 */
export const DEEP_TOTAL_TIMEOUT_MS = SEARCH_DEEP_DEADLINE_MS + SEARCH_DEEP_GRACE_MS + 5_000;
const RECONNECT_MAX_MS = 30_000;

class HubConnection implements TerminalStream {
  private ws: WebSocket | null = null;
  private wanted = false;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private state: BoardSnapshot | null = null;
  private boardListeners = new Set<BoardListener>();
  private connectionListeners = new Set<(connected: boolean) => void>();
  private resourceListeners = new Set<(sample: ResourceSample) => void>();
  private eventListeners = new Set<(event: SessionEvent) => void>();
  private teamListeners = new Set<(change: TeamChange) => void>();
  private terminalListeners = new Map<string, Set<(m: TerminalServerMessage) => void>>();
  /** 進行中的深層搜尋（searchId → 畫面的 listener）。hub 只把結果推給發起的這條連線。 */
  private searchListeners = new Map<string, (event: DeepSearchEvent) => void>();
  /** 還沒回 deepDone 的機器。 */
  private searchWaiting = new Map<string, Set<string>>();
  private searchSeq = 0;
  /** 深層搜尋的看門狗計時器（hub 沒回就當失敗，畫面不會一直停在「搜尋中」）。 */
  private searchTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

  start(): void {
    this.wanted = true;
    if (!this.ws) this.open();
  }

  stop(): void {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.state = null;
    this.setConnected(false);
  }

  watchBoard(listener: BoardListener): () => void {
    this.boardListeners.add(listener);
    if (this.state) listener(this.state);
    return () => this.boardListeners.delete(listener);
  }

  watchConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.ws?.readyState === WebSocket.OPEN);
    return () => this.connectionListeners.delete(listener);
  }

  watchTeamChanges(listener: (change: TeamChange) => void): () => void {
    this.teamListeners.add(listener);
    return () => this.teamListeners.delete(listener);
  }

  watchEvents(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  watchResources(listener: (sample: ResourceSample) => void): () => void {
    this.resourceListeners.add(listener);
    if (this.resourceListeners.size === 1) this.send({ type: 'resources.watch', watching: true });
    return () => {
      this.resourceListeners.delete(listener);
      if (this.resourceListeners.size === 0) {
        this.send({ type: 'resources.watch', watching: false });
      }
    };
  }

  subscribe(sessionId: string, onMessage: (message: TerminalServerMessage) => void) {
    const listeners = this.terminalListeners.get(sessionId) ?? new Set();
    listeners.add(onMessage);
    this.terminalListeners.set(sessionId, listeners);
    // 每次都送：hub 不存畫面，新的訂閱者要靠這個拿快照（CONTRACTS §6.1 第 7 點）。
    this.send({ type: 'terminal.subscribe', sessionId });
    return () => {
      listeners.delete(onMessage);
      if (listeners.size === 0) {
        this.terminalListeners.delete(sessionId);
        this.send({ type: 'terminal.unsubscribe', sessionId });
      }
    };
  }

  /** 深層搜尋（P3 ③b）：送 search.deep；送不出去（沒連上）立刻回 failed。 */
  deepSearch(
    request: Parameters<BoardBackend['deepSearch']>[0],
    listener: (event: DeepSearchEvent) => void,
  ): DeepSearchHandle {
    // 不用 crypto.randomUUID：hub 可能是 http（非 secure context）時沒有這個函式。
    this.searchSeq += 1;
    const searchId = `ds-${Date.now().toString(36)}-${this.searchSeq}-${Math.random().toString(36).slice(2, 8)}`;
    this.searchListeners.set(searchId, listener);
    if (!this.send({ type: 'search.deep', searchId, ...request })) {
      this.searchListeners.delete(searchId);
      queueMicrotask(() =>
        listener({ type: 'search.deepFailed', searchId, error: 'disconnected' }),
      );
    } else {
      // hub 收下會立刻回 deepStarted；各台最晚在時間上限＋寬限後回 deepDone。都沒等到就當失敗並叫 hub 停。
      this.searchTimers.set(searchId, [
        setTimeout(() => {
          if (!this.searchWaiting.has(searchId)) this.failSearch(searchId);
        }, DEEP_START_TIMEOUT_MS),
        setTimeout(() => this.failSearch(searchId), DEEP_TOTAL_TIMEOUT_MS),
      ]);
    }
    return {
      searchId,
      cancel: () => {
        this.clearSearch(searchId);
        if (this.searchListeners.delete(searchId)) this.send({ type: 'search.cancel', searchId });
      },
    };
  }

  /** 看門狗到了還沒結束：告訴畫面失敗、叫 hub 停（hub 若根本沒收下，這則只是多送）。 */
  private failSearch(searchId: string): void {
    const listener = this.searchListeners.get(searchId);
    this.clearSearch(searchId);
    if (!listener) return;
    this.searchListeners.delete(searchId);
    this.send({ type: 'search.cancel', searchId });
    listener({ type: 'search.deepFailed', searchId, error: 'no_reply' });
  }

  private clearSearch(searchId: string): void {
    for (const timer of this.searchTimers.get(searchId) ?? []) clearTimeout(timer);
    this.searchTimers.delete(searchId);
    this.searchWaiting.delete(searchId);
  }

  send(message: ClientToHub): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private open(): void {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}${WS_PATHS.client}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.setConnected(true);
      for (const sessionId of this.terminalListeners.keys()) {
        this.send({ type: 'terminal.subscribe', sessionId });
      }
      if (this.resourceListeners.size > 0) this.send({ type: 'resources.watch', watching: true });
    };
    ws.onmessage = (event) => {
      const parsed = HubToClient.safeParse(JSON.parse(String(event.data)));
      if (parsed.success) this.handle(parsed.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      // 深層搜尋綁在這條連線上：斷了就不會再有結果（hub 也已取消），告訴畫面。
      const searches = [...this.searchListeners];
      this.searchListeners.clear();
      for (const searchId of [...this.searchTimers.keys()]) this.clearSearch(searchId);
      this.searchWaiting.clear();
      for (const [searchId, listener] of searches) {
        listener({ type: 'search.deepFailed', searchId, error: 'disconnected' });
      }
      if (!this.wanted) return;
      this.retryTimer = setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    };
  }

  private setConnected(connected: boolean): void {
    this.connectionListeners.forEach((l) => l(connected));
  }

  private handle(message: HubToClient): void {
    switch (message.type) {
      case 'board.state':
        this.pauseSeq++;
        this.publish({
          machines: message.machines,
          sessions: message.sessions,
          approvals: message.approvals,
          waitingLimit: message.waitingLimit,
          zones: message.zones,
          broadcasts: mergeAfterReconnect(this.state?.broadcasts ?? [], message.broadcasts),
          pause: message.pause,
          progress: message.progress,
          presets: message.presets,
          teamActivity: message.teamActivity,
          reviews: message.reviews,
          staffRequests: message.staffRequests,
        });
        return;
      case 'staff.requests':
        return this.setStaffRequests(message.items);
      case 'review.updated':
        return this.applyReview(message.review);
      case 'team.activity':
        return this.setTeamActivity(message.items);
      case 'board.pause':
        this.pauseSeq++;
        return this.patch((s) => ({ ...s, pause: message.pause }));
      case 'progress.updated':
        return this.patch((s) => ({ ...s, progress: upsertCard(s.progress ?? [], message.card) }));
      case 'zone.list':
        return this.patch((s) => ({ ...s, zones: message.zones }));
      case 'preset.list':
        return this.patch((s) => ({ ...s, presets: message.presets }));
      case 'broadcast.updated':
        return this.patch((s) => ({
          ...s,
          broadcasts: upsert(s.broadcasts ?? [], message.broadcast),
        }));
      case 'team.updated':
        this.teamListeners.forEach((l) => l({ team: message.team }));
        return;
      case 'team.removed':
        this.teamListeners.forEach((l) => l({ removed: message.teamId }));
        return;
      case 'board.waitingLimit':
        return this.patch((s) => ({ ...s, waitingLimit: message.waitingLimit }));
      case 'terminal.snapshot':
      case 'terminal.output':
      case 'terminal.size':
        this.terminalListeners.get(message.sessionId)?.forEach((l) => l(message));
        return;
      case 'resources':
        this.resourceListeners.forEach((l) => l(message.sample));
        return;
      case 'session.updated':
        return this.patch((s) => ({
          ...s,
          sessions: upsert(s.sessions, message.session),
        }));
      case 'session.removed':
        return this.patch((s) => ({
          ...s,
          sessions: s.sessions.filter((x) => x.id !== message.sessionId),
        }));
      case 'machine.updated':
        return this.patch((s) => ({ ...s, machines: upsert(s.machines, message.machine) }));
      case 'machine.removed':
        return this.patch((s) => ({
          ...s,
          machines: s.machines.filter((m) => m.id !== message.machineId),
          sessions: s.sessions.filter((x) => x.machineId !== message.machineId),
        }));
      case 'approval.requested':
        return this.patch((s) => ({ ...s, approvals: upsert(s.approvals, message.approval) }));
      case 'approval.resolved':
        return this.patch((s) => ({
          ...s,
          approvals: s.approvals.filter((a) => a.id !== message.approvalId),
        }));
      case 'session.event':
        this.eventListeners.forEach((l) => l(message.event));
        return;
      case 'search.deepStarted':
      case 'search.deepResult':
      case 'search.deepDone': {
        const listener = this.searchListeners.get(message.searchId);
        if (!listener) return;
        // 每台都結束了：這次搜尋完成，之後的 cancel 不必再送。
        if (message.type === 'search.deepStarted') {
          this.searchWaiting.set(
            message.searchId,
            new Set(message.machines.map((m) => m.machineId)),
          );
        } else if (message.type === 'search.deepDone') {
          this.searchWaiting.get(message.searchId)?.delete(message.machineId);
        }
        if (this.searchWaiting.get(message.searchId)?.size === 0) {
          this.clearSearch(message.searchId);
          this.searchListeners.delete(message.searchId);
        }
        listener(message);
        return;
      }
      case 'error':
        console.warn(`hub: ${message.code}: ${message.message}`);
        return;
      default:
        return;
    }
  }

  /**
   * 收到幾次 hub 推來的暫停狀態（board.state／board.pause）。REST 回應只在送出後這個數字沒變
   * （WebSocket 還沒到）時才當後備套用；WebSocket 已經更新過就不拿較舊的 REST 回應蓋掉。
   */
  pauseSeq = 0;

  /** REST 回來的暫停狀態：只在 seq 之後 WebSocket 還沒推過新狀態時套上。 */
  setPauseIfUnchanged(seq: number, pause: BoardPauseState): void {
    if (this.pauseSeq !== seq) return;
    this.patch((s) => ({ ...s, pause }));
  }

  /** REST 寫入的回應：WebSocket 的 progress.updated 還沒到也先套上（較舊的不蓋較新的）。 */
  applyCard(card: ProgressCard): void {
    const clean = { ...card };
    delete clean.merged;
    this.patch((s) => ({ ...s, progress: upsertCard(s.progress ?? [], clean) }));
  }

  /** 交叉審查（WS review.updated 或 REST 回應）：同 id 換掉，新的放最前面。 */
  applyReview(review: Review): void {
    this.patch((s) => ({ ...s, reviews: upsertReview(s.reviews ?? [], review) }));
  }

  /** 交叉審查清單（REST 標已讀的回應）：整份換掉。 */
  setReviews(reviews: Review[]): void {
    this.patch((s) => ({ ...s, reviews }));
  }

  /** 待處理的加開申請（WS staff.requests）：整份換掉。 */
  setStaffRequests(items: StaffRequest[]): void {
    this.patch((s) => ({ ...s, staffRequests: items }));
  }

  /** REST 處理完一件申請：先從畫面拿掉（WS 的 staff.requests 隨後也會到）。 */
  dropStaffRequest(id: string): void {
    this.patch((s) => ({
      ...s,
      staffRequests: (s.staffRequests ?? []).filter((r) => r.id !== id),
    }));
  }

  /** 團隊動態（WS team.activity 或 REST 回應）：整份換掉。 */
  setTeamActivity(items: TeamActivity[]): void {
    this.patch((s) => ({ ...s, teamActivity: items }));
  }

  private patch(update: (state: BoardSnapshot) => BoardSnapshot): void {
    if (this.state) this.publish(update(this.state));
  }

  private publish(state: BoardSnapshot): void {
    this.state = state;
    this.boardListeners.forEach((l) => l(state));
  }
}

/**
 * 重連時 hub 送來的群發清單：hub 重啟過的話，原本還在排隊的就不在裡面了（只在記憶體）。
 * 那些對象標成「沒送出（hub 重啟）」留著給畫面交代，不默默消失（P2 §2.8）。
 */
export function mergeAfterReconnect(previous: Broadcast[], current: Broadcast[]): Broadcast[] {
  const known = new Set(current.map((b) => b.id));
  const lost = previous
    .filter((b) => !known.has(b.id) && b.targets.some((t) => t.state === 'queued'))
    .map((b) => ({
      ...b,
      targets: b.targets.map((t) =>
        t.state === 'queued' ? { ...t, state: 'failed' as const, reason: 'hub_restarted' } : t,
      ),
    }));
  return [...lost, ...current];
}

/** 同一個擁有者只有一張卡；較舊的版本不蓋掉較新的（REST 回應與 WS 推送可能前後顛倒）。 */
export function upsertCard(list: ProgressCard[], card: ProgressCard): ProgressCard[] {
  const key = progressOwnerKey(progressOwnerOf(card));
  const index = list.findIndex((c) => progressOwnerKey(progressOwnerOf(c)) === key);
  if (index === -1) return [...list, card];
  const current = list[index]!;
  // 同一版只有鎖定可能不同（鎖定不加版本）：一樣接受新的。
  if (current.revision > card.revision) return list;
  return list.map((c, i) => (i === index ? card : c));
}

const progressPath = (owner: ProgressOwner) =>
  'teamId' in owner
    ? ({ team: true, id: owner.teamId } as const)
    : ({ team: false, id: owner.sessionId } as const);

/** 交叉審查：同 id 換掉（位置不變）；新的放最前面（清單新的在前）。 */
export function upsertReview(list: readonly Review[], review: Review): Review[] {
  return list.some((r) => r.id === review.id)
    ? list.map((r) => (r.id === review.id ? review : r))
    : [review, ...list];
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

/** prompt 和 Enter 分開送，黏在一起 TUI 會當成貼上（和 daemon 的 firstPrompt 相同）。 */
const PROMPT_ENTER_DELAY_MS = 100;

export function createHubBackend() {
  const hub = new HubConnection();
  const signedIn = (user: User): User => {
    hub.start();
    return user;
  };

  const backend = {
    terminal: hub,
    watchBoard: (listener) => hub.watchBoard(listener),
    watchConnection: (listener) => hub.watchConnection(listener),
    watchEvents: (listener) => hub.watchEvents(listener),
    watchTeamChanges: (listener) => hub.watchTeamChanges(listener),
    watchResources: (listener) => hub.watchResources(listener),
    deepSearch: (request, listener) => hub.deepSearch(request, listener),

    needsSetup: async () => (await call('authStatus')).needsSetup,
    async currentUser() {
      const { user } = await call('authStatus');
      if (user) hub.start();
      return user;
    },
    setup: async (input) => signedIn(await call('authSetup', { body: input })),
    login: async (input) => signedIn(await call('authLogin', { body: input })),
    async logout() {
      await call('authLogout');
      hub.stop();
    },
    async changePassword({ userId, currentPassword, password }) {
      await call('usersUpdate', { params: { id: userId }, body: { currentPassword, password } });
    },
    async saveLocale(locale) {
      // 每次先問目前是誰：切換帳號後不會改到上一個人的設定。
      const { user } = await call('authStatus');
      if (user) await call('usersUpdate', { params: { id: user.id }, body: { locale } });
    },

    createSession: (input) => call('sessionsCreate', { body: input }),
    updateSession: (id, patch) => call('sessionsUpdate', { params: { id }, body: patch }),
    stopSession: (id) => call('sessionsStop', { params: { id } }),
    resumeSession: (id) => call('sessionsResume', { params: { id } }),
    listArchivedSessions: () => call('sessionsList', { query: { archived: 'true' } }),
    inspectSession: (id) => call('sessionInspect', { params: { id } }),
    search: ({ archived, mask, zoneId, ...rest }) =>
      call('search', {
        query: {
          ...rest,
          ...(zoneId === undefined ? {} : { zoneId }),
          archived: archived ? '1' : '0',
          mask: mask ? '1' : '0',
        },
      }),
    sessionTranscript: (id, query) => call('sessionTranscript', { params: { id }, query }),
    deleteSession: async (id, options) =>
      (await call('sessionsDelete', { params: { id }, body: options })).result,
    sendPrompt(sessionId, text) {
      hub.send({ type: 'terminal.input', sessionId, data: text });
      setTimeout(
        () => hub.send({ type: 'terminal.input', sessionId, data: '\r' }),
        PROMPT_ENTER_DELAY_MS,
      );
    },
    async pauseBoard(mode) {
      const seq = hub.pauseSeq;
      const result = await call('boardPause', { body: { mode } });
      hub.setPauseIfUnchanged(seq, result.state);
      return result;
    },
    async resumeBoard() {
      const seq = hub.pauseSeq;
      const result = await call('boardResume');
      hub.setPauseIfUnchanged(seq, result.state);
      return result;
    },
    async decideApproval(approval, decision) {
      const sent = hub.send({
        type: 'approval.decide',
        approvalId: approval.id,
        sessionId: approval.sessionId,
        decision,
      });
      if (!sent) throw new Error('連不到 hub，恢復連線後再試一次。');
    },

    listProjects: () => call('projectsList'),
    listTemplates: () => call('templatesList'),
    saveTemplate: (input) => call('templatesCreate', { body: input }),
    browseDirectory: (id, path) => call('machineBrowse', { params: { id }, query: { path } }),
    makeDirectory: (id, parent, name) =>
      call('machineMkdir', { params: { id }, body: { parent, name } }),
    createProject: (input) => call('projectsCreate', { body: input }),
    createPairingCode: () => call('pairingCreate'),
    async removeMachine(id) {
      await call('machinesDelete', { params: { id } });
    },
    machineUsage: (id) => call('machineUsage', { params: { id } }),
    usageReport: () => call('usageReport'),
    releases: () => call('releasesOverview'),
    checkReleases: () => call('releasesCheck'),
    promoteRelease: (version, confirm) => call('releasesPromote', { body: { version, confirm } }),
    setReleaseRepo: (repo) => call('releasesConfig', { body: { repo } }),
    setMachineChannel: (id, channel) =>
      call('machineChannel', { params: { id }, body: { channel } }),
    updateMachine: (id) => call('machineUpdate', { params: { id } }),
    rollbackMachine: (id) => call('machineRollback', { params: { id } }),
    setMachineAllowUnverified: (id, allow, confirm) =>
      call('machineAllowUnverified', { params: { id }, body: { allow, confirm } }),

    getLayouts: (workspace) => call('layoutsGet', { query: { workspace } }),
    async saveLayouts(layouts) {
      await call('layoutsPut', { body: layouts });
    },
    getNotes: (zoneId) => call('notesList', { query: { zoneId } }),
    async readTeamActivity(ids) {
      const items = await call('teamActivityRead', { body: ids ? { ids } : {} });
      hub.setTeamActivity(items);
      return items;
    },
    async clearTeamActivity(ids) {
      const items = await call('teamActivityClear', { body: ids ? { ids } : {} });
      hub.setTeamActivity(items);
      return items;
    },
    async approveStaffRequest(id) {
      const request = await call('staffRequestApprove', { params: { id } });
      hub.dropStaffRequest(id);
      return request;
    },
    async rejectStaffRequest(id) {
      const request = await call('staffRequestReject', { params: { id } });
      hub.dropStaffRequest(id);
      return request;
    },
    async getReview(id) {
      const review = await call('reviewGet', { params: { id } });
      hub.applyReview(review);
      return review;
    },
    async prepareReview(target, reason) {
      const review = await call('reviewPrepare', {
        body: { target, ...(reason ? { reason } : {}) },
      });
      hub.applyReview(review);
      return review;
    },
    async startReview(id) {
      const review = await call('reviewStart', { params: { id } });
      hub.applyReview(review);
      return review;
    },
    async cancelReview(id) {
      const review = await call('reviewCancel', { params: { id } });
      hub.applyReview(review);
      return review;
    },
    async readReviews(ids) {
      const reviews = await call('reviewRead', { body: ids ? { ids } : {} });
      hub.setReviews(reviews);
      return reviews;
    },
    getSettings: () => call('settingsGet'),
    updateSettings: (patch) => call('settingsUpdate', { body: patch }),
    pushVapidKey: async () => (await call('pushVapidKey')).publicKey,
    async pushSubscribe(subscription) {
      await call('pushSubscribe', { body: subscription });
    },
    async pushUnsubscribe(endpoint) {
      await call('pushUnsubscribe', { body: { endpoint } });
    },
    listAudit: (filter) => call('auditList', { query: { limit: 100, ...filter } }),
    // 用 blob 保留 hub 加的 BOM（Excel 才認得 UTF-8 中文）；text() 會把它吃掉。
    async exportAudit(filter = {}) {
      // limit 只對列表有意義；匯出要符合條件的全部。
      const query = { ...filter };
      delete query.limit;
      return (await request('auditExport', { query })).blob();
    },

    listTeams: () => call('teamsList'),
    createTeam: (input) => call('teamsCreate', { body: input }),
    updateTeam: (id, patch) => call('teamsUpdate', { params: { id }, body: patch }),
    async deleteTeam(id) {
      await call('teamsDelete', { params: { id } });
    },
    holdTeam: (id, mode) => call('teamHold', { params: { id }, body: { mode } }),
    resumeTeam: (id) => call('teamResume', { params: { id } }),
    listTeamMembers: (id) => call('teamMembersList', { params: { id } }),
    putTeamMember: (id, sessionId, role, kind) =>
      call('teamMembersPut', {
        params: { id, sessionId },
        body: kind ? { role, kind } : { role },
      }),
    async deleteTeamMember(id, sessionId) {
      await call('teamMembersDelete', { params: { id, sessionId } });
    },
    listTasks: (id) => call('tasksList', { params: { id } }),
    createTask: (id, input) => call('tasksCreate', { params: { id }, body: input }),
    updateTask: (id, patch) => call('tasksUpdate', { params: { id }, body: patch }),
    async deleteTask(id) {
      await call('tasksDelete', { params: { id } });
    },
    listHandoffRules: (id) => call('handoffRulesList', { params: { id } }),
    createHandoffRule: (id, input) => call('handoffRulesCreate', { params: { id }, body: input }),
    updateHandoffRule: (id, patch) => call('handoffRulesUpdate', { params: { id }, body: patch }),
    async deleteHandoffRule(id) {
      await call('handoffRulesDelete', { params: { id } });
    },
    sessionEvents: (id) => call('sessionEvents', { params: { id } }),
    broadcastToTeam: (id, text, targets) =>
      call('teamBroadcast', { params: { id }, body: targets ? { text, targets } : { text } }),
    cancelBroadcast: (id, sessionId) =>
      call('broadcastCancel', { params: { id }, body: { sessionId } }),
    getProgress(owner) {
      const { team, id } = progressPath(owner);
      return call(team ? 'progressTeamGet' : 'progressSessionGet', { params: { id } });
    },
    async saveProgress(owner, body) {
      const { team, id } = progressPath(owner);
      const card = await call(team ? 'progressTeamPut' : 'progressSessionPut', {
        params: { id },
        body,
      });
      hub.applyCard(card);
      return card;
    },
    progressRevisions(owner) {
      const { team, id } = progressPath(owner);
      return call(team ? 'progressTeamRevisions' : 'progressSessionRevisions', { params: { id } });
    },
    async restoreProgress(owner, revision) {
      const { team, id } = progressPath(owner);
      const card = await call(team ? 'progressTeamRestore' : 'progressSessionRestore', {
        params: { id },
        body: { revision },
      });
      hub.applyCard(card);
      return card;
    },
    deliverProgress(owner, sessionId) {
      const { team, id } = progressPath(owner);
      return call(team ? 'progressTeamDeliver' : 'progressSessionDeliver', {
        params: { id },
        body: { sessionId },
      });
    },
    askProgressUpdate: (teamId) => call('progressAskUpdate', { params: { id: teamId } }),
    createZone: (name) => call('zonesCreate', { body: { name } }),
    renameZone: (id, name) => call('zonesUpdate', { params: { id }, body: { name } }),
    async deleteZone(id) {
      await call('zonesDelete', { params: { id } });
    },
    listTeamPresets: () => call('teamPresetsList'),
    createTeamPreset: (input) => call('teamPresetsCreate', { body: input }),
    updateTeamPreset: (id, patch) => call('teamPresetsUpdate', { params: { id }, body: patch }),
    async deleteTeamPreset(id) {
      await call('teamPresetsDelete', { params: { id } });
    },
    teamPresetUsed: (id, result) => call('teamPresetsUsed', { params: { id }, body: result }),

    // 設定頁以選用方式使用（flows/settingsParts.tsx 的 OptionalAdmin）
    listUsers: () => call('usersList'),
    createUser: (input: RouteBody<'usersCreate'>) => call('usersCreate', { body: input }),
    async deleteUser(id: string) {
      await call('usersDelete', { params: { id } });
    },
    /** 管理員重設別人的密碼（不需要對方的舊密碼）；對方所有裝置登出。 */
    async resetUserPassword(id: string, password: string) {
      await call('usersResetPassword', { params: { id }, body: { password } });
    },
    async deleteTemplate(id: string) {
      await call('templatesDelete', { params: { id } });
    },
  } satisfies BoardBackend & Record<string, unknown>;
  return backend;
}
