// 交接規則引擎（DISPATCH §6、§8-2）：送給目標 session 的內容只有一句摘要＋改過的檔案＋分支，絕不貼完整對話。
// 規則存在資料庫；等待中的交接與迴圈鏈只在記憶體，hub 重啟會遺失（audit 留有 handoff.fired）。
import type { HandoffRule, Session, SessionEvent } from '@agent-board/protocol';
import type { Store } from './store';

const SUMMARY_MAX_CHARS = 240;
const MIN_SENTENCE_CHARS = 12;
const MAX_LISTED_FILES = 20;
/** 第二道防迴圈：鏈被使用者輸入重設時，單條規則也不能無限觸發。 */
const RULE_MAX_FIRES = 10;
const RULE_WINDOW_MS = 10 * 60 * 1000;
/** 送出後目標一直沒離開 waiting_input（輸入被吃掉）就不再等它，下一筆才有機會送。 */
const ACK_TIMEOUT_MS = 60 * 1000;

const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|.)/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** 要打進別人的 TUI：控制字元（特別是 \r、ESC）一個都不能留。 */
export function cleanLine(text: string): string {
  return text.replace(ANSI, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

export function oneSentence(text: string): string {
  const clean = cleanLine(text).replace(/^[#>*\-\s]+/, '');
  const pattern = new RegExp(`^.{${MIN_SENTENCE_CHARS},}?(?:[。！？]|[.!?](?=\\s|$))`, 'u');
  const sentence = pattern.exec(clean)?.[0] ?? clean;
  const chars = [...sentence];
  return chars.length > SUMMARY_MAX_CHARS
    ? `${chars.slice(0, SUMMARY_MAX_CHARS).join('')}…`
    : sentence;
}

/**
 * 只有這三項。開頭固定是 `[Handoff]`：內容來自另一個模型的輸出，
 * 不能讓它以 `/` 或 `!` 開頭被 TUI 當成指令。
 */
export function handoffMessage(input: {
  summary: string;
  files: readonly string[];
  branch: string | null;
}): string {
  const listed = input.files.slice(0, MAX_LISTED_FILES).map(cleanLine);
  const more = input.files.length - listed.length;
  const files = listed.length === 0 ? 'none detected' : listed.join(', ');
  return [
    `[Handoff] Summary: ${input.summary || 'none reported'}`,
    // 只看得到 Write、Edit、MultiEdit、NotebookEdit：不能讓對方以為清單就是全部，空的也不代表沒改。
    `Detected file edits (shell changes not tracked): ${files}${more > 0 ? ` (+${more} more)` : ''}`,
    `Branch: ${input.branch ? cleanLine(input.branch) : 'unknown'}`,
  ].join(' | ');
}

/** `*`、`**`、`?`；比對路徑結尾，所以 `src/**` 和 `*.sql` 對絕對路徑也有效。空字串表示任何檔案。 */
export function matchesFilePattern(pattern: string | undefined, path: string): boolean {
  if (!pattern) return true;
  const body = pattern
    .replace(/\*{3,}/g, '**')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/|\*\*|\*|\?/g, (token) => {
      if (token === '**/') return '(?:.*/)?';
      if (token === '**') return '.*';
      return token === '*' ? '[^/]*' : '[^/]';
    });
  return new RegExp(`(?:^|/)${body}$`).test(path);
}

export type HandoffBlockReason = 'loop' | 'rate_limit' | 'target_ended';

interface Pending {
  rule: HandoffRule;
  message: string;
  /** 這則交接一路經過的 session；目標之後再往外交接時用來判斷迴圈。 */
  chain: string[];
}

export interface HandoffDeps {
  store: Store;
  now(): Date;
  enterDelayMs: number;
  audit(sessionId: string, action: string, detail: string): void;
  addEvent(sessionId: string, type: string, payload: Record<string, unknown>, at?: string): void;
  isReachable(sessionId: string): boolean;
  sendInput(sessionId: string, data: string): void;
  guarded(label: string, fn: () => void): void;
}

export class HandoffEngine {
  /** key 是規則 id：同一條規則還沒送出又觸發，新的蓋舊的。 */
  private readonly pending = new Map<string, Pending>();
  private readonly chains = new Map<string, string[]>();
  private readonly fires = new Map<string, number[]>();
  private readonly awaitingAck = new Map<string, number>();
  private readonly stopped = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: HandoffDeps) {}

  /** on_done、on_file 都在回合結束時判斷：改到一半的檔案不該觸發，摘要也要等這時才有。 */
  onEvent(event: SessionEvent): void {
    if (event.type !== 'hook' || event.payload.event !== 'Stop') return;
    const source = this.deps.store.getSession(event.sessionId);
    // plan 模式下的 Stop 可能只是提問或計畫被拒（docs/claude-code-notes.md），不算完成。
    if (!source || source.permissionMode === 'plan') return;
    this.fire(source, (rule, files) => {
      if (rule.trigger === 'on_done') return true;
      if (rule.trigger !== 'on_file') return false;
      return files.some((file) => matchesFilePattern(rule.action.filePattern, file));
    });
  }

  /** 由 hub 在 session 每次變動時呼叫；`entered` 表示這是要通知使用者的新狀態。 */
  onSessionChange(prev: Session, next: Session, entered: boolean): void {
    if (prev.status !== next.status) {
      if (prev.status === 'waiting_input') this.awaitingAck.delete(next.id);
      if (next.status === 'waiting_input') this.deliverNext(next.id);
      if (isGone(next)) this.dropPendingTo(next.id);
    }
    const stoppedByUser = this.stopped.has(next.id);
    if (next.endedAt !== null) this.stopped.delete(next.id);
    // 開不起來的 session 沒有成果可交接；使用者自己按停止也不是失敗。
    if (!entered || next.status !== 'error' || prev.status === 'starting' || stoppedByUser) return;
    this.fire(next, (rule) => rule.trigger === 'on_fail', next.statusDetail);
  }

  /** 使用者親自下指令，接下來的工作就不是上一條交接鏈的延續。 */
  onUserInput(sessionId: string): void {
    this.chains.delete(sessionId);
  }

  onUserStop(sessionId: string): void {
    this.stopped.add(sessionId);
  }

  /** 心跳時呼叫：機器重連、確認逾時之後，沒有狀態變化也要繼續送。 */
  flush(): void {
    const now = this.deps.now().getTime();
    for (const [sessionId, at] of this.awaitingAck) {
      if (now - at > ACK_TIMEOUT_MS) this.awaitingAck.delete(sessionId);
    }
    const targets = new Set([...this.pending.values()].map((p) => p.rule.action.toSessionId));
    for (const target of targets) this.deliverNext(target);
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private rulesFrom(sessionId: string): HandoffRule[] {
    const { store } = this.deps;
    return store
      .listTeams()
      .flatMap((team) => store.listRules(team.id))
      .filter((rule) => rule.enabled && rule.fromSessionId === sessionId);
  }

  /** 從事件取得最後一則回覆、以及上次交接之後改過的檔案。hub 重啟後一樣查得到。 */
  private report(sessionId: string) {
    let reply: string | null = null;
    let lastDaemonAt: string | null = null;
    let collecting = true;
    const files: string[] = [];
    for (const event of this.deps.store.listEvents(sessionId).reverse()) {
      if (event.type === 'handoff.fired') collecting = false;
      if (event.type === 'file.changed' || event.type === 'hook') lastDaemonAt ??= event.at;
      if (event.type === 'file.changed' && collecting) {
        const path = event.payload.path;
        if (typeof path === 'string' && !files.includes(path)) files.push(path);
      }
      const text = event.payload.last_assistant_message;
      if (reply === null && event.type === 'hook' && typeof text === 'string') reply = text;
    }
    return { reply, files: files.reverse(), lastDaemonAt };
  }

  private fire(
    source: Session,
    applies: (rule: HandoffRule, files: readonly string[]) => boolean,
    failure: string | null = null,
  ): void {
    const rules = this.rulesFrom(source.id);
    if (rules.length === 0) return;
    const { reply, files, lastDaemonAt } = this.report(source.id);
    const matched = rules.filter((rule) => applies(rule, files));
    if (matched.length === 0) return;
    const summary = oneSentence(
      failure === null ? (reply ?? '') : `Failed: ${failure}. ${reply ?? ''}`,
    );
    const message = handoffMessage({ summary, files, branch: source.branch });
    const chain = [...(this.chains.get(source.id) ?? []), source.id];
    for (const rule of matched) this.fireRule(rule, source, message, chain, lastDaemonAt);
  }

  private fireRule(
    rule: HandoffRule,
    source: Session,
    message: string,
    chain: string[],
    boundaryAt: string | null,
  ): void {
    const { store, audit, addEvent } = this.deps;
    const targetId = rule.action.toSessionId;
    const target = store.getSession(targetId);
    const summary = {
      ruleId: rule.id,
      teamId: rule.teamId,
      trigger: rule.trigger,
      fromSessionId: source.id,
      toSessionId: targetId,
    };
    const blocked = this.blockReason(rule, target, chain);
    if (blocked) {
      audit(source.id, 'handoff.blocked', JSON.stringify({ ...summary, reason: blocked }));
      addEvent(source.id, 'handoff.blocked', { ...summary, reason: blocked });
      return;
    }
    audit(source.id, 'handoff.fired', JSON.stringify({ ...summary, message }));
    // 這筆事件是「改過的檔案」的分界。時間要接在 daemon 事件之後：各台機器的時鐘不一定和 hub 相同。
    addEvent(source.id, 'handoff.fired', summary, boundaryAt ?? undefined);
    this.pending.set(rule.id, { rule, message, chain });
    this.deliverNext(targetId);
  }

  private blockReason(
    rule: HandoffRule,
    target: Session | null,
    chain: readonly string[],
  ): HandoffBlockReason | null {
    if (!target || isGone(target)) return 'target_ended';
    if (chain.includes(target.id)) return 'loop';
    const now = this.deps.now().getTime();
    const recent = (this.fires.get(rule.id) ?? []).filter((at) => now - at < RULE_WINDOW_MS);
    if (recent.length >= RULE_MAX_FIRES) return 'rate_limit';
    this.fires.set(rule.id, [...recent, now]);
    return null;
  }

  private dropPendingTo(targetId: string): void {
    for (const [ruleId, pending] of this.pending) {
      if (pending.rule.action.toSessionId !== targetId) continue;
      this.pending.delete(ruleId);
      this.deps.audit(
        pending.rule.fromSessionId,
        'handoff.dropped',
        JSON.stringify({ ruleId, toSessionId: targetId, reason: 'target_ended' }),
      );
    }
  }

  /**
   * 只在目標等輸入時才送：其他狀態下畫面可能是權限對話框，Enter 會直接選到「允許」。
   * 文字和 Enter 分開送（黏在一起 TUI 會當成貼上），送 Enter 前再確認一次狀態。
   */
  private deliverNext(targetId: string): void {
    const { deps } = this;
    const target = deps.store.getSession(targetId);
    if (!target || isGone(target)) {
      this.dropPendingTo(targetId);
      return;
    }
    if (
      target.status !== 'waiting_input' ||
      this.awaitingAck.has(targetId) ||
      !deps.isReachable(targetId)
    ) {
      return;
    }
    const next = this.takeNext(targetId);
    if (!next) return;
    this.awaitingAck.set(targetId, deps.now().getTime());
    deps.sendInput(targetId, next.message);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      deps.guarded('handoff enter', () => this.pressEnter(targetId, next));
    }, deps.enterDelayMs);
    timer.unref();
    this.timers.add(timer);
  }

  /** 排隊期間規則可能被關掉或改了目標（例如全隊暫停），這些不送。 */
  private takeNext(targetId: string): Pending | null {
    for (const [ruleId, pending] of this.pending) {
      if (pending.rule.action.toSessionId !== targetId) continue;
      this.pending.delete(ruleId);
      const rule = this.deps.store.getRule(ruleId);
      if (rule?.enabled && rule.action.toSessionId === targetId) return pending;
      this.deps.audit(
        pending.rule.fromSessionId,
        'handoff.dropped',
        JSON.stringify({ ruleId, toSessionId: targetId, reason: 'rule_disabled' }),
      );
    }
    return null;
  }

  private pressEnter(targetId: string, pending: Pending): void {
    const { store, audit, addEvent, isReachable, sendInput } = this.deps;
    const { rule, message, chain } = pending;
    const detail = { ruleId: rule.id, fromSessionId: rule.fromSessionId, toSessionId: targetId };
    const current = store.getSession(targetId);
    if (current?.status !== 'waiting_input' || !isReachable(targetId)) {
      this.awaitingAck.delete(targetId);
      audit(rule.fromSessionId, 'handoff.enter_aborted', JSON.stringify(detail));
      addEvent(rule.fromSessionId, 'handoff.blocked', { ...detail, reason: 'target_busy' });
      return;
    }
    this.chains.set(targetId, chain);
    sendInput(targetId, '\r');
    audit(targetId, 'terminal.input', message);
    addEvent(targetId, 'handoff.delivered', detail);
  }
}

const isGone = (session: Session): boolean =>
  session.endedAt !== null || session.status === 'done' || session.archived;
