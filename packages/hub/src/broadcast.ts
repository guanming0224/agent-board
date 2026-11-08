// 團隊群發（P2 項目二，GM 2026-11-08）：團隊面板底部的指令框，一次送給整組或 @ 點名的成員，不跳確認。
// 送字一律走 delivery.ts（只在對象等輸入時送，RUN、PERM 等排隊，絕不把字打進權限對話框），瀏覽器不逐一送。
// 這是 GM 親手下的指令：全部暫停不擋（Q6，DeliveryItem.manual），畫面另外提示「目前全部暫停中」。
// 結果只放在記憶體（和送字佇列一樣），hub 重啟就沒有；前端把重啟前還在排隊的標成「沒送出（hub 重啟）」。
import { randomUUID } from 'node:crypto';
import type {
  Broadcast,
  BroadcastKind,
  BroadcastTarget,
  Session,
  User,
} from '@agent-board/protocol';
import { isGone, type SafeDelivery } from './delivery';
import { HttpError, notFound } from './errors';
import type { Store } from './store';

/** 記憶體裡最多留幾則（舊的先丟；排隊中的不丟）。 */
const KEEP = 50;
const KEY_PREFIX = 'broadcast:';

export const isBroadcastKey = (key: string): boolean => key.startsWith(KEY_PREFIX);
const keyOf = (broadcastId: string, sessionId: string) =>
  `${KEY_PREFIX}${broadcastId}:${sessionId}`;

export interface BroadcastDeps {
  store: Store;
  now(): Date;
  delivery: SafeDelivery;
  audit(userId: string | null, sessionId: string | null, action: string, detail: string): void;
  paused(): boolean;
  /** 一則群發的狀態變了：推給每個 client。 */
  changed(broadcast: Broadcast): void;
  /** Enter 已送出：照使用者自己打字處理（重設交接鏈、取消這次限流的自動接續）。 */
  userInput(sessionId: string): void;
}

/** 對象為什麼直接略過；null 表示可以送（或排隊）。 */
function skipReason(session: Session): string | null {
  if (session.archived) return 'archived';
  if (isGone(session)) return 'ended';
  return null;
}

export class BroadcastEngine {
  private readonly items = new Map<string, Broadcast>();
  /** 每則的 audit 動作名稱（群發 team.broadcast、進度卡 progress.deliver／progress.ask_update）。 */
  private readonly actions = new Map<string, string>();

  constructor(private readonly deps: BroadcastDeps) {}

  list(): Broadcast[] {
    return [...this.items.values()];
  }

  /**
   * 建立並送出。targets 沒給＝整組（不含已封存的成員）；有給＝點名，每個都要是本團隊成員。
   * audit：每個對象一筆 team.broadcast（含團隊、全文、是否點名、當下結果）；送出 Enter 時另寫 team.broadcast.delivered。
   */
  send(teamId: string, text: string, targets: string[] | undefined, user: User): Broadcast {
    const { store } = this.deps;
    const team = store.getTeam(teamId);
    if (!team) throw notFound('Team');
    const memberIds = store.listTeamMembers(teamId).map((m) => m.sessionId);
    const mentioned = targets !== undefined;
    const wanted = mentioned ? [...new Set(targets)] : memberIds;
    const strangers = wanted.filter((id) => !memberIds.includes(id));
    if (strangers.length > 0) {
      throw new HttpError(400, 'not_member', `Not members of this team: ${strangers.join(', ')}`);
    }
    const sessions = wanted.flatMap((id) => {
      const s = store.getSession(id);
      // 整組時已封存的成員不算對象（畫布上看不到）；點名的照實回報略過。
      return s && (mentioned || !s.archived) ? [s] : [];
    });
    if (sessions.length === 0) {
      throw new HttpError(400, 'no_targets', 'This team has no members to send to');
    }
    return this.start(
      { teamId, kind: 'team', cardKey: null, text, mentioned, sessions },
      user,
      'team.broadcast',
    );
  }

  /**
   * 進度卡的送字（P3 項目一）：「帶入進度卡」送給任一個 session、「請隊長更新」送給隊長。和群發同一條
   * SafeDelivery（manual：只在等輸入時送、忙就排隊、全部暫停不擋）與同一套結果格式。
   * audit：建立時 `<action>`（user，detail 同群發），送出 Enter 時 `<action>.delivered`、沒送出 `<action>.dropped`。
   */
  direct(
    input: {
      teamId: string | null;
      kind: Exclude<BroadcastKind, 'team'>;
      cardKey: string;
      text: string;
      session: Session;
    },
    user: User,
    action: string,
  ): Broadcast {
    return this.start(
      {
        teamId: input.teamId,
        kind: input.kind,
        cardKey: input.cardKey,
        text: input.text,
        mentioned: true,
        sessions: [input.session],
      },
      user,
      action,
    );
  }

  private start(
    input: Pick<Broadcast, 'teamId' | 'kind' | 'cardKey' | 'text' | 'mentioned'> & {
      sessions: Session[];
    },
    user: User,
    action: string,
  ): Broadcast {
    const { teamId, text, mentioned, sessions } = input;
    const now = this.deps.now().toISOString();
    const broadcast: Broadcast = {
      id: randomUUID(),
      teamId,
      kind: input.kind,
      cardKey: input.cardKey,
      text,
      mentioned,
      by: user.id,
      byName: user.name,
      at: now,
      boardPaused: this.deps.paused(),
      targets: sessions.map((s) => {
        const reason = skipReason(s);
        return {
          sessionId: s.id,
          name: s.name,
          state: reason ? 'skipped' : 'queued',
          reason,
          at: now,
        } satisfies BroadcastTarget;
      }),
    };
    this.items.set(broadcast.id, broadcast);
    this.actions.set(broadcast.id, action);
    this.trim();
    for (const target of broadcast.targets) {
      if (target.state !== 'queued') continue;
      this.deps.delivery.enqueue({
        key: keyOf(broadcast.id, target.sessionId),
        targetId: target.sessionId,
        message: text,
        manual: true,
        check: () => null,
        dropped: (reason) => this.finish(broadcast.id, target.sessionId, 'failed', reason, user),
        aborted: () => this.finish(broadcast.id, target.sessionId, 'failed', 'not_waiting', user),
        delivered: () => {
          this.finish(broadcast.id, target.sessionId, 'sent', null, user);
          this.deps.userInput(target.sessionId);
        },
      });
      // 拿出來就是已經打字了（只差 Enter）：畫面上算「已送出」，Enter 沒按成再改成沒送出。
      if (!this.deps.delivery.has(keyOf(broadcast.id, target.sessionId))) {
        const current = this.target(broadcast.id, target.sessionId);
        if (current?.state === 'queued')
          this.setState(broadcast.id, target.sessionId, 'sent', null);
      }
    }
    const result = this.items.get(broadcast.id) ?? broadcast;
    for (const target of result.targets) {
      this.deps.audit(
        user.id,
        target.sessionId,
        action,
        JSON.stringify({
          teamId,
          broadcastId: broadcast.id,
          ...(input.cardKey ? { card: input.cardKey } : {}),
          text,
          mentioned,
          state: target.state,
          ...(target.reason ? { reason: target.reason } : {}),
          ...(broadcast.boardPaused ? { boardPaused: true } : {}),
        }),
      );
    }
    this.deps.changed(result);
    return result;
  }

  /** 取消某個對象還在排隊的送字。已送出、已略過的不變。 */
  cancel(broadcastId: string, sessionId: string, user: User): Broadcast {
    const broadcast = this.items.get(broadcastId);
    if (!broadcast) throw notFound('Broadcast');
    const target = broadcast.targets.find((t) => t.sessionId === sessionId);
    if (!target) throw notFound('Broadcast target');
    if (target.state === 'queued' && this.deps.delivery.cancel(keyOf(broadcastId, sessionId))) {
      this.setState(broadcastId, sessionId, 'cancelled', null);
      this.deps.audit(
        user.id,
        sessionId,
        `${this.actions.get(broadcastId) ?? 'team.broadcast'}.cancelled`,
        JSON.stringify({ teamId: broadcast.teamId, broadcastId }),
      );
      this.emit(broadcastId);
    }
    return this.items.get(broadcastId)!;
  }

  private finish(
    broadcastId: string,
    sessionId: string,
    state: 'sent' | 'failed',
    reason: string | null,
    user: User,
  ): void {
    const broadcast = this.items.get(broadcastId);
    if (!broadcast) return;
    this.setState(broadcastId, sessionId, state, reason);
    this.deps.audit(
      user.id,
      sessionId,
      `${this.actions.get(broadcastId) ?? 'team.broadcast'}.${state === 'sent' ? 'delivered' : 'dropped'}`,
      JSON.stringify({ teamId: broadcast.teamId, broadcastId, ...(reason ? { reason } : {}) }),
    );
    this.emit(broadcastId);
  }

  private target(broadcastId: string, sessionId: string): BroadcastTarget | undefined {
    return this.items.get(broadcastId)?.targets.find((t) => t.sessionId === sessionId);
  }

  private setState(
    broadcastId: string,
    sessionId: string,
    state: BroadcastTarget['state'],
    reason: string | null,
  ): void {
    const broadcast = this.items.get(broadcastId);
    if (!broadcast) return;
    const at = this.deps.now().toISOString();
    this.items.set(broadcastId, {
      ...broadcast,
      targets: broadcast.targets.map((t) =>
        t.sessionId === sessionId ? { ...t, state, reason, at } : t,
      ),
    });
  }

  private emit(broadcastId: string): void {
    const broadcast = this.items.get(broadcastId);
    if (broadcast) this.deps.changed(broadcast);
  }

  /** 超過 KEEP 則時丟最舊的、已經沒有排隊對象的。 */
  private trim(): void {
    if (this.items.size <= KEEP) return;
    for (const [id, broadcast] of this.items) {
      if (this.items.size <= KEEP) return;
      if (broadcast.targets.some((t) => t.state === 'queued')) continue;
      this.items.delete(id);
      this.actions.delete(id);
    }
  }
}
