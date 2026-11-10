// session host 模式的 PTY 後端（CONTRACTS §20）：agent 是 session host 的子程序，daemon 重啟時不會跟著結束。
import type { SessionHostClient } from '@agent-board/session-host';
import type { PtyAttachInfo, PtyBackend, PtyProcess, PtySignal, PtySpawnOptions } from './pty';

/** 重播 2 MB 進 headless 用不了多久；超過就當接不回來（daemon 改用 --resume）。 */
const ATTACH_TIMEOUT_MS = 15_000;

type ExitEvent = { exitCode: number; signal: number };

/** 緩衝不夠時，重播最前面插一行提示（畫布上看得到，docs/session-host-spec.md §3.5）。 */
export function gapNotice(lostBytes: number): string {
  const kb = Math.max(1, Math.round(lostBytes / 1024));
  return `\x1b[2m[Agent Board] 重新接上前有 ${kb} KB 輸出未保留\x1b[0m\r\n`;
}

class HostPtyProcess implements PtyProcess {
  pid = 0;
  readonly ready: Promise<void>;
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((event: ExitEvent) => void)[] = [];
  private readonly replayListeners: ((info: PtyAttachInfo) => void)[] = [];
  /** 輸出是位元組；一塊可能切在多位元組字中間，用串流解碼。 */
  private readonly decoder = new TextDecoder('utf-8');
  private detached = false;
  private exited = false;
  private lostBytes = 0;
  private attachInfo: Omit<PtyAttachInfo, 'lostBytes'> | null = null;

  constructor(
    private readonly client: SessionHostClient,
    private readonly id: string,
    mode: { spawn: PtySpawnOptions } | { attach: true },
  ) {
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // 沒人等 ready 時不要變成 unhandled rejection。
    this.ready.catch(() => {});
    let attachTimer: NodeJS.Timeout | undefined;
    client.register(id, {
      onAttached: (session) => {
        this.pid = session.pid;
        this.attachInfo = {
          alive: session.alive,
          pid: session.pid,
          exitCode: session.exitCode,
          signal: session.signal,
          cols: session.cols,
          rows: session.rows,
        };
      },
      onGap: (lostBytes) => {
        this.lostBytes = lostBytes;
        this.emitData(gapNotice(lostBytes));
      },
      onOutput: (_seq, data) => this.emitData(this.decoder.decode(data, { stream: true })),
      onReplayDone: () => {
        clearTimeout(attachTimer);
        const info = this.attachInfo;
        if (!info) {
          rejectReady(new Error('session host 沒有回報 session 現況'));
          return;
        }
        resolveReady();
        for (const listener of this.replayListeners)
          listener({ ...info, lostBytes: this.lostBytes });
      },
      onExit: (code, signal) => {
        const tail = this.decoder.decode();
        if (tail) this.emitData(tail);
        this.exited = true;
        client.unregister(id);
        if (this.detached) return;
        for (const listener of this.exitListeners)
          listener({ exitCode: code, signal: signal ?? 0 });
      },
      onError: (error) => rejectReady(new Error(`session host：${error}`)),
    });
    if ('spawn' in mode) {
      client.spawn(mode.spawn).then(
        (pid) => {
          this.pid = pid;
          resolveReady();
        },
        (error: unknown) => {
          client.unregister(id);
          rejectReady(error instanceof Error ? error : new Error(String(error)));
        },
      );
    } else {
      attachTimer = setTimeout(
        () => rejectReady(new Error('session host 重播逾時')),
        ATTACH_TIMEOUT_MS,
      );
      attachTimer.unref();
      client.attach(id, 0);
    }
  }

  private emitData(data: string): void {
    if (this.detached || data.length === 0) return;
    for (const listener of this.dataListeners) listener(data);
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (event: ExitEvent) => void): void {
    this.exitListeners.push(listener);
  }

  onReplayDone(listener: (info: PtyAttachInfo) => void): void {
    this.replayListeners.push(listener);
  }

  write(data: string): void {
    if (!this.exited) this.client.write(this.id, data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.client.resize(this.id, cols, rows);
  }

  kill(signal: PtySignal): void {
    if (!this.exited) this.client.kill(this.id, signal);
  }

  /** daemon 要走了：不再收這個 session 的事件，agent 留在 host 繼續跑。 */
  detach(): void {
    this.detached = true;
    if (!this.exited) this.client.unregister(this.id);
  }
}

export class HostPtyBackend implements PtyBackend {
  readonly kind = 'host' as const;
  constructor(readonly client: SessionHostClient) {}

  spawn(options: PtySpawnOptions): PtyProcess {
    return new HostPtyProcess(this.client, options.id, { spawn: options });
  }

  attach(id: string): PtyProcess {
    return new HostPtyProcess(this.client, id, { attach: true });
  }

  release(id: string): void {
    if (this.client.connected) this.client.release(id);
  }
}
