// 終端機資料流：seq 判斷、跳號重訂、看不見時的累積（CONTRACTS §6.1）。不碰 DOM，方便單元測試。
import type { TerminalServerMessage, TerminalStream } from '../shared/terminal-contract';

export type TerminalSnapshotMessage = Extract<TerminalServerMessage, { type: 'terminal.snapshot' }>;
export type TerminalSizeMessage = Extract<TerminalServerMessage, { type: 'terminal.size' }>;

export interface TerminalSink {
  snapshot(message: TerminalSnapshotMessage): void;
  output(data: string): void;
  /** 尺寸擁有者（CONTRACTS §6.1 第 6 點）。不分看不看得見都立刻交出去，由終端機決定何時套用。 */
  size(message: TerminalSizeMessage): void;
}

/** 看不見時最多累積這麼多字元，超過就丟掉，重新可見時改拿新快照。 */
export const HIDDEN_BUFFER_LIMIT = 1024 * 1024;

/** lastSeq 為 null 表示還沒收到快照：這時的 output 都已涵蓋在即將到來的快照裡。 */
export function judgeSeq(lastSeq: number | null, seq: number): 'write' | 'drop' | 'gap' {
  if (lastSeq === null || seq <= lastSeq) return 'drop';
  return seq === lastSeq + 1 ? 'write' : 'gap';
}

export class TerminalFeed {
  private unsubscribe: (() => void) | null = null;
  /** 舊訂閱晚到的訊息靠這個擋掉。 */
  private generation = 0;
  private lastSeq: number | null = null;
  private pendingSnapshot: TerminalSnapshotMessage | null = null;
  private pendingOutput: string[] = [];
  private pendingSize = 0;
  private overflowed = false;

  constructor(
    private readonly stream: TerminalStream,
    private readonly sessionId: string,
    private readonly sink: TerminalSink,
    private visible: boolean,
  ) {}

  start(): void {
    this.subscribe();
  }

  stop(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 丟掉畫面重拿快照（遮蔽模式切換時用）。 */
  resync(): void {
    this.clearPending();
    this.subscribe();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.flush();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastSeq = null;
    this.generation += 1;
    const generation = this.generation;
    const unsubscribe = this.stream.subscribe(this.sessionId, (message) => {
      if (generation === this.generation) this.handle(message);
    });
    // subscribe 可能同步回訊息，途中又重訂或停止時，這份訂閱已經過期。
    if (generation === this.generation) this.unsubscribe = unsubscribe;
    else unsubscribe();
  }

  private handle(message: TerminalServerMessage): void {
    if (message.sessionId !== this.sessionId) return;
    if (message.type === 'terminal.size') {
      this.sink.size(message);
      return;
    }
    if (message.type === 'terminal.snapshot') {
      this.lastSeq = message.seq;
      if (this.visible) {
        this.sink.snapshot(message);
      } else {
        this.clearPending();
        this.pendingSnapshot = message;
      }
      return;
    }
    const verdict = judgeSeq(this.lastSeq, message.seq);
    if (verdict === 'gap') {
      this.subscribe();
    } else if (verdict === 'write') {
      this.lastSeq = message.seq;
      if (this.visible) this.sink.output(message.data);
      else this.hold(message.data);
    }
  }

  private hold(data: string): void {
    if (this.overflowed) return;
    this.pendingSize += data.length;
    if (this.pendingSize > HIDDEN_BUFFER_LIMIT) {
      this.clearPending();
      this.overflowed = true;
    } else {
      this.pendingOutput.push(data);
    }
  }

  private flush(): void {
    if (this.overflowed) {
      this.clearPending();
      this.subscribe();
      return;
    }
    const snapshot = this.pendingSnapshot;
    const output = this.pendingOutput.join('');
    this.clearPending();
    if (snapshot) this.sink.snapshot(snapshot);
    if (output) this.sink.output(output);
  }

  private clearPending(): void {
    this.pendingSnapshot = null;
    this.pendingOutput = [];
    this.pendingSize = 0;
    this.overflowed = false;
  }
}
