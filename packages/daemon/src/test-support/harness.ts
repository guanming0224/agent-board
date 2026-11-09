// 端對端測試環境：臨時資料夾、假 claude、假 hub。不碰 ~/.claude、~/.agent-board。
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type {
  DaemonToHub,
  HookEventName,
  HookReply,
  MachineCapabilities,
  SessionSpec,
} from '@agent-board/protocol';
import type { Terminal as TerminalType } from '@xterm/headless';
import { Daemon, type DaemonDeps } from '../daemon';
import { FakeHub } from './fakeHub';
import { stubTrackerFactory } from './stubTracker';

const require = createRequire(import.meta.url);
export const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

const FAKE_CLAUDE = fileURLToPath(new URL('./fakeClaude.mjs', import.meta.url));

export const FAKE_CAPABILITIES: MachineCapabilities = {
  hasGpu: false,
  gpuName: null,
  cpuCores: 4,
  memoryBytes: 1024,
  claudeVersion: '9.9.9',
};

export function makeTempDir(): string {
  // macOS 的 /var 是符號連結；git 與 process.cwd() 回報的都是實際路徑。
  return realpathSync(mkdtempSync(join(tmpdir(), 'abd-')));
}

export function writeFakeClaude(dir: string): string {
  const bin = join(dir, 'fake-claude');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** 假 hook：只要檔名對、可執行就通過檢查，測試不會真的呼叫它。 */
export function writeFakeHook(dir: string, name = 'agent-board-hook'): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

export interface FakeClaudeRun {
  argv: string[];
  cwd: string;
  env: Record<string, string | null>;
}

export async function waitUntil<T>(
  fn: () => T | undefined | null | false,
  what: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export class Harness {
  readonly root = makeTempDir();
  readonly dataDir = join(this.root, 'data');
  readonly workDir = join(this.root, 'work');
  readonly claudeDir = join(this.root, 'claude-config');
  readonly logFile = join(this.root, 'fake-claude.log');
  readonly bin = writeFakeClaude(this.root);
  readonly hookDir = join(this.root, 'hook-bin');
  readonly hookBin = writeFakeHook(this.hookDir);
  readonly hub = new FakeHub();
  readonly trackers = stubTrackerFactory();
  readonly daemons: Daemon[] = [];
  readonly installHookCalls: string[] = [];
  extraEnv: Record<string, string> = {};
  /** 派工 MCP server 的路徑（DaemonConfig.mcpServer）；null＝找不到，不掛。 */
  mcpServer: string | null = null;
  installHooks: DaemonDeps['installHooks'] = async (cwd) => {
    this.installHookCalls.push(cwd);
  };

  async start(): Promise<Daemon> {
    mkdirSync(this.workDir, { recursive: true });
    await this.hub.start();
    return this.startDaemon();
  }

  async startDaemon(overrides: Partial<DaemonDeps> = {}): Promise<Daemon> {
    const daemon = new Daemon({
      config: {
        hubUrl: this.hub.url,
        token: 'test-machine-token',
        dataDir: this.dataDir,
        claudeBin: this.bin,
        // Codex 也用同一支假程式（它只記 argv、照輸入印字）。
        codexBin: this.bin,
        hookBin: this.hookBin,
        machineName: 'test-machine',
        claudeConfigDir: this.claudeDir,
        mcpServer: this.mcpServer,
      },
      createStatusTracker: this.trackers.create,
      installHooks: (cwd) => this.installHooks(cwd),
      baseEnv: {
        PATH: process.env.PATH,
        HOME: this.root,
        FAKE_CLAUDE_LOG: this.logFile,
        AGENT_BOARD_MACHINE_TOKEN: 'test-machine-token',
        ...this.extraEnv,
      },
      capabilities: FAKE_CAPABILITIES,
      runtimeThrottleMs: 20,
      terminateGraceMs: 300,
      ...overrides,
    });
    this.daemons.push(daemon);
    await daemon.start();
    // 等連上才回傳，否則測試接著送的指令會在 daemon 連上前被丟掉。
    if (this.hub.autoWelcome) await waitUntil(() => daemon['hub'].connected, 'daemon 連上 hub');
    return daemon;
  }

  /** 模擬 daemon 程序重啟：關掉舊的（PTY 一起結束），再用同一份資料夾開新的。 */
  async restartDaemon(overrides: Partial<DaemonDeps> = {}): Promise<Daemon> {
    for (const daemon of this.daemons.splice(0)) await daemon.stop();
    return this.startDaemon(overrides);
  }

  hellos(): Extract<DaemonToHub, { type: 'daemon.hello' }>[] {
    return this.hub.received.filter(
      (m): m is Extract<DaemonToHub, { type: 'daemon.hello' }> => m.type === 'daemon.hello',
    );
  }

  runs(): FakeClaudeRun[] {
    if (!existsSync(this.logFile)) return [];
    return readFileSync(this.logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as FakeClaudeRun);
  }

  spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
    return {
      name: 'test session',
      projectId: null,
      cwd: this.workDir,
      useWorktree: false,
      permissionMode: 'default',
      model: null,
      accountProfile: null,
      resumeClaudeSessionId: null,
      firstPrompt: null,
      readOnly: false,
      ...overrides,
    };
  }

  /** 開一個 session 並等到假 claude 就緒、訂閱完成。 */
  async createAndSubscribe(sessionId: string, overrides: Partial<SessionSpec> = {}): Promise<void> {
    const requestId = `req-${sessionId}`;
    this.hub.send({ type: 'session.create', requestId, sessionId, spec: this.spec(overrides) });
    await this.hub.waitFor('session.created', (m) => m.requestId === requestId);
    this.hub.send({ type: 'terminal.subscribe', sessionId });
    await this.waitForOutput(sessionId, 'FAKE READY');
  }

  /** 把這個 session 目前收到的快照 + 輸出串起來。 */
  outputText(sessionId: string): string {
    let text = '';
    for (const message of this.hub.received) {
      if (
        (message.type === 'terminal.output' || message.type === 'terminal.snapshot') &&
        message.sessionId === sessionId
      ) {
        text += message.data;
      }
    }
    return text;
  }

  waitForOutput(sessionId: string, needle: string): Promise<true> {
    return waitUntil(
      () => this.outputText(sessionId).includes(needle),
      `輸出包含 ${needle}；目前：${JSON.stringify(this.outputText(sessionId).slice(-200))}`,
    );
  }

  async cleanup(): Promise<void> {
    for (const daemon of this.daemons) await daemon.stop().catch(() => {});
    await this.hub.stop().catch(() => {});
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** 像 agent-board-hook 一樣連 socket 送一則 HookRequest。 */
export class HookClient {
  private buffer = '';
  private readonly replies = new Map<string, (reply: HookReply) => void>();
  private constructor(readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const reply = JSON.parse(this.buffer.slice(0, newline)) as HookReply;
        this.buffer = this.buffer.slice(newline + 1);
        this.replies.get(reply.requestId)?.(reply);
        newline = this.buffer.indexOf('\n');
      }
    });
  }

  static connect(path: string): Promise<HookClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path, () => resolve(new HookClient(socket)));
      socket.once('error', reject);
    });
  }

  request(
    sessionId: string,
    event: HookEventName,
    fields: Record<string, unknown> = {},
    agent?: 'claude' | 'codex',
  ): Promise<HookReply> {
    const requestId = `hook-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      this.replies.set(requestId, resolve);
      this.socket.write(
        `${JSON.stringify({
          type: 'hook',
          requestId,
          sessionId,
          event,
          payload: { session_id: 'claude-reported', hook_event_name: event, ...fields },
          ...(agent ? { agent } : {}),
        })}\n`,
      );
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

/** 等 write 佇列清空。 */
export function flushTerm(term: TerminalType): Promise<void> {
  return new Promise((resolve) => term.write('', resolve));
}

/** 畫面逐格比對用：含文字、前景色、背景色、粗體。 */
export function dumpScreen(term: TerminalType): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [`cursor=${buffer.cursorX},${buffer.cursorY} type=${buffer.type}`];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    let row = '';
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell) continue;
      row += `${cell.getChars() || ' '}${cell.getFgColor()}/${cell.getBgColor()}/${cell.isBold()}|`;
    }
    rows.push(row);
  }
  return rows;
}
