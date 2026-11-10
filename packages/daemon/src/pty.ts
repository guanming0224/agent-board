// PTY 後端：ManagedSession 只透過這個介面碰 agent 程序（docs/session-host-spec.md §4-1）。
// LocalPtyBackend＝daemon 自己用 node-pty 開（舊模式）；HostPtyBackend（hostPty.ts）＝交給 session host 養著。
import { spawn as spawnPty, type IPty } from 'node-pty';

export type PtySignal = 'SIGTERM' | 'SIGHUP' | 'SIGINT' | 'SIGKILL';

export interface PtySpawnOptions {
  /** board 的 session id；session host 用它當鍵，本機模式只用來寫紀錄。 */
  id: string;
  bin: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
}

/** 重新接上（attach）時 session host 回報的現況。 */
export interface PtyAttachInfo {
  alive: boolean;
  pid: number;
  exitCode: number | null;
  signal: number | null;
  cols: number;
  rows: number;
  /** 緩衝不夠、重播前就被丟掉的位元組數。 */
  lostBytes: number;
}

export interface PtyProcess {
  /** agent 的 pid；session host 模式在 spawn 回覆前是 0。 */
  readonly pid: number;
  /** 開起來了才 resolve；開不起來 reject（本機模式 spawn 失敗會直接丟例外，這裡一律 resolve）。 */
  readonly ready: Promise<void>;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /**
   * 送訊號。`SIGKILL` 是強制結束整個程序群組（PTY 子程序是 session leader，連它的子程序一起收）。
   * Windows 不支援指定訊號，一律直接結束。
   */
  kill(signal: PtySignal): void;
  /**
   * daemon 要關閉但 agent 要留著（只有 session host 模式做得到）：停止接收，不殺。
   * 本機模式沒有這個方法。
   */
  detach?(): void;
  /** 重新接上時：重播完（之後的資料都是即時的）。只有 attach 出來的才會呼叫。 */
  onReplayDone?(listener: (info: PtyAttachInfo) => void): void;
}

export interface PtyBackend {
  readonly kind: 'local' | 'host';
  spawn(options: PtySpawnOptions): PtyProcess;
  /** 接回 session host 裡還在跑（或剛結束、還沒 release）的 session，從緩衝開頭重播。 */
  attach?(id: string): PtyProcess;
  /** session 真的結束、daemon 處理完了：通知 host 丟掉緩衝。 */
  release?(id: string): void;
}

const SIGKILL = 9;

class LocalPtyProcess implements PtyProcess {
  readonly ready = Promise.resolve();
  constructor(private readonly pty: IPty) {}

  get pid(): number {
    return this.pty.pid;
  }

  onData(listener: (data: string) => void): void {
    this.pty.onData(listener);
  }

  onExit(listener: (event: { exitCode: number; signal: number }) => void): void {
    this.pty.onExit(({ exitCode, signal }) => listener({ exitCode, signal: signal ?? 0 }));
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(signal: PtySignal): void {
    // Windows 的 node-pty 不接受指定訊號。
    if (process.platform === 'win32') {
      this.pty.kill();
      return;
    }
    // PTY 子程序是 session leader，pid 即 process group，連子程序一起收。
    if (signal === 'SIGKILL') process.kill(-this.pty.pid, SIGKILL);
    else this.pty.kill(signal);
  }
}

/** 舊模式：daemon 自己開 node-pty，daemon 結束時 agent 跟著結束。 */
export const localPtyBackend: PtyBackend = {
  kind: 'local',
  spawn(options) {
    return new LocalPtyProcess(
      spawnPty(options.bin, options.args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      }),
    );
  },
};
