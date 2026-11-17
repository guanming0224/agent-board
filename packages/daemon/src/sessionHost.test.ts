// session host 模式（CONTRACTS §20）：真的 session host（同一個程序裡）、真的 node-pty、假 claude、假 hub。
// 驗證 daemon 重啟時 agent 不中斷、畫面重播、狀態快照、停機期間結束、退回舊模式、審批交回終端機。
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonToHub, SessionRuntime } from '@agent-board/protocol';
import { hostEndpoint, SessionHostClient } from '@agent-board/session-host';
import { SessionHostServer } from '@agent-board/session-host/server';
import { readSnapshot, stateDir } from './sessionState';
import { HookClient, Harness, waitUntil } from './test-support/harness';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const mode = (path: string) => statSync(path).mode & 0o777;

let h: Harness;
let host: SessionHostServer | null;

beforeEach(async () => {
  h = new Harness();
  host = new SessionHostServer({ dataDir: h.dataDir, log: quiet, version: 'test-host' });
  await host.start();
});

afterEach(async () => {
  await h.cleanup();
  await host?.close();
  host = null;
});

const input = (sessionId: string, text: string) =>
  h.hub.send({ type: 'terminal.input', sessionId, data: `${text}\r` });

function runtimes(id: string): SessionRuntime[] {
  return h.hub.received
    .filter(
      (m): m is Extract<DaemonToHub, { type: 'session.runtime' }> =>
        m.type === 'session.runtime' && m.session.id === id,
    )
    .map((m) => m.session);
}

/** 重啟後重新訂閱：只看新的快照與之後的輸出。 */
async function resubscribe(sessionId: string): Promise<() => string> {
  const from = h.hub.received.length;
  h.hub.send({ type: 'terminal.subscribe', sessionId });
  await h.hub.waitFor(
    'terminal.snapshot',
    (m) => m.sessionId === sessionId && h.hub.received.indexOf(m) >= from,
  );
  return () =>
    h.hub.received
      .slice(from)
      .filter(
        (m): m is Extract<DaemonToHub, { type: 'terminal.snapshot' | 'terminal.output' }> =>
          (m.type === 'terminal.snapshot' || m.type === 'terminal.output') &&
          m.sessionId === sessionId,
      )
      .map((m) => m.data)
      .join('');
}

describe('session host 模式', () => {
  it('daemon 重啟：agent 不中斷（不用 --resume 重開）、畫面重播不缺、之後的輸入照常', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    expect(host!.sessionCount).toBe(1);
    input('s1', 'before-restart');
    await h.waitForOutput('s1', 'INPUT:before-restart');

    await h.restartDaemon();
    // 假 claude 只啟動過一次：沒有被殺、也沒有 --resume 再開一次。
    expect(h.runs()).toHaveLength(1);
    const hello = h.hellos().at(-1)!;
    expect(hello.sessions.map((s) => s.id)).toEqual(['s1']);

    const screen = await resubscribe('s1');
    expect(screen()).toContain('FAKE READY');
    expect(screen()).toContain('INPUT:before-restart');
    input('s1', 'after-restart');
    await waitUntil(() => screen().includes('INPUT:after-restart'), '重啟後的輸入');
  });

  it('狀態快照：狀態變化就寫（600／資料夾 700）；重啟後 hello 帶回原狀態，tracker 載入快照', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    const hooks = await HookClient.connect(h.daemons[0]!.hookSocketPath);
    await hooks.request('s1', 'UserPromptSubmit', { prompt: 'x' });
    await waitUntil(() => readSnapshot(h.dataDir, 's1')?.status === 'running', '快照寫入');
    expect(mode(join(stateDir(h.dataDir), 's1.json'))).toBe(0o600);
    expect(mode(stateDir(h.dataDir))).toBe(0o700);
    const since = readSnapshot(h.dataDir, 's1')!.statusSince;
    hooks.close();

    await h.restartDaemon();
    const session = h
      .hellos()
      .at(-1)!
      .sessions.find((s) => s.id === 's1')!;
    expect(session.status).toBe('running');
    expect(session.statusSince).toBe(since);
    expect(h.trackers.created.at(-1)!.restored).toMatchObject({ status: 'running' });
  });

  it('停機期間 agent 結束：接回時重播完才算結束，結果送給 hub、清單與快照都清掉、host 丟掉緩衝', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    for (const daemon of h.daemons.splice(0)) await daemon.stop();

    // daemon 不在：直接叫 agent 結束（像使用者在終端機打 /exit）。
    const poke = await SessionHostClient.connect(hostEndpoint(h.dataDir));
    poke.write('s1', 'exit 3\r');
    const deadline = Date.now() + 8_000;
    while ((await poke.list())[0]?.alive !== false) {
      if (Date.now() > deadline) throw new Error('agent 沒有結束');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    poke.close();

    await h.startDaemon();
    await waitUntil(() => runtimes('s1').some((r) => r.endedAt !== null), '結束結果');
    const ended = runtimes('s1').find((r) => r.endedAt !== null)!;
    expect(ended.status).toBe('error');
    expect(ended.lastLines.join('\n')).toContain('FAKE READY');
    expect(h.hellos().at(-1)!.sessions).toEqual([]);
    await waitUntil(() => readSnapshot(h.dataDir, 's1') === null, '快照刪除');
    await waitUntil(() => host!.sessionCount === 0, 'host release');
    const store = JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')) as {
      sessions: unknown[];
    };
    expect(store.sessions).toEqual([]);
  });

  it('等待中的審批：daemon 停止時交回終端機（hub 收到 by terminal、hook 拿到空答案），狀態留著', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    const hooks = await HookClient.connect(h.daemons[0]!.hookSocketPath);
    const answer = hooks.request('s1', 'PermissionRequest', {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    const requested = await h.hub.waitFor(
      'approval.requested',
      (m) => m.approval.sessionId === 's1',
    );
    await waitUntil(() => readSnapshot(h.dataDir, 's1')?.status === 'waiting_permission', '快照');

    for (const daemon of h.daemons.splice(0)) await daemon.stop();
    expect((await answer).output).toBeNull();
    const resolved = h.hub.received.find(
      (m) => m.type === 'approval.resolved' && m.approvalId === requested.approval.id,
    );
    expect(resolved).toMatchObject({ by: 'terminal' });
    expect(readSnapshot(h.dataDir, 's1')!.pendingApprovalIds).toEqual([requested.approval.id]);

    await h.startDaemon();
    const session = h
      .hellos()
      .at(-1)!
      .sessions.find((s) => s.id === 's1')!;
    expect(session.status).toBe('waiting_permission');
    expect(h.hellos().at(-1)!.pendingApprovals).toEqual([]);
  });

  it('MCP 密鑰檔：daemon 停止時不刪，接回後舊密鑰照樣有效；session 真的結束才刪', async () => {
    h.mcpServer = join(h.root, 'fake-mcp.mjs');
    writeFileSync(h.mcpServer, '');
    h.hub.dispatch = true;
    await h.start();
    await h.createAndSubscribe('s1');
    const keyFile = join(h.dataDir, 'mcp', 's1.key');
    const secret = readFileSync(keyFile, 'utf8').trim();

    await h.restartDaemon();
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(secret);
    expect(h.daemons[0]!['mcpSecrets'].get('s1')).toBe(secret);

    input('s1', 'exit 0');
    await waitUntil(() => runtimes('s1').some((r) => r.endedAt !== null), '結束');
    await waitUntil(() => {
      try {
        statSync(keyFile);
        return false;
      } catch {
        return true;
      }
    }, '密鑰檔刪除');
  });

  it('daemon 停止時留停止記號，下次啟動清掉（hook CLI 看它決定要不要重試）', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    // 停止記號只在 daemon 停止時還連著 host 才寫（daemon.ts stop）。先確認這個前提：負載很高時若連 host 逾時、
    // 退回舊模式，失敗訊息會指在這裡，而不是後面看起來像檔案沒寫好的 ENOENT。
    expect(h.daemons[0]!['backend'].kind).toBe('host');
    const marker = `${h.daemons[0]!.hookSocketPath}.down`;
    for (const daemon of h.daemons.splice(0)) await daemon.stop();
    expect(mode(marker)).toBe(0o600);
    await h.startDaemon();
    expect(() => statSync(marker)).toThrow();
  });

  it('host 關閉（換版、停服務，agent 跟著結束）：session 不算結束，daemon 改用 --resume 重開', async () => {
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    // 等不到 host 回來（這裡不會回來）才退回舊模式；測試把等待縮短。
    await h.startDaemon({ sessionHostRecoverWaitMs: 300 });
    await h.createAndSubscribe('s1');
    const resumeId = h.runs()[0]!.argv[h.runs()[0]!.argv.indexOf('--session-id') + 1]!;
    // 假裝有對話紀錄，重開時才會用 --resume。
    const projects = join(h.claudeDir, 'projects', 'p');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${resumeId}.jsonl`), '{}\n');

    await host!.close();
    host = null;
    await waitUntil(() => h.runs().length === 2, '用 --resume 重開');
    expect(h.runs()[1]!.argv.slice(0, 2)).toEqual(['--resume', resumeId]);
    expect(runtimes('s1').every((r) => r.endedAt === null)).toBe(true);
    // 沒有 host 了：新的 PTY 由 daemon 自己開（舊模式），之後照常能用。
    await resubscribe('s1');
    input('s1', 'still-here');
    await h.waitForOutput('s1', 'INPUT:still-here');
  });
});

describe('退回舊模式（host 連不上或不相容時絕不能開不了 session）', () => {
  it('token 不對：退回舊模式，session 照樣開、由 daemon 自己開 PTY', async () => {
    writeFileSync(hostEndpoint(h.dataDir).tokenPath, 'sk-ant-demo-wrong-token\n');
    await h.start();
    await h.createAndSubscribe('s1');
    expect(host!.sessionCount).toBe(0);
    expect(h.daemons[0]!['backend'].kind).toBe('local');
  });

  it('沒有 host：退回舊模式，daemon 重啟時照舊用 --resume 接回', async () => {
    await host!.close();
    host = null;
    await h.start();
    await h.createAndSubscribe('s1');
    await h.restartDaemon();
    await waitUntil(() => h.runs().length === 2, '重開');
  });

  it('AGENT_BOARD_SESSION_HOST=off：host 在跑也不用', async () => {
    const config = {
      hubUrl: '',
      token: 'test-machine-token',
      dataDir: h.dataDir,
      claudeBin: h.bin,
      hookBin: h.hookBin,
      machineName: 'test-machine',
      claudeConfigDir: h.claudeDir,
      sessionHost: 'off' as const,
    };
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    config.hubUrl = h.hub.url;
    await h.startDaemon({ config });
    await h.createAndSubscribe('s1');
    expect(host!.sessionCount).toBe(0);
  });
});

describe('host 沒在跑：daemon 自己拉起來', () => {
  const configWithService = () => ({
    hubUrl: h.hub.url,
    token: 'test-machine-token',
    dataDir: h.dataDir,
    claudeBin: h.bin,
    hookBin: h.hookBin,
    machineName: 'test-machine',
    claudeConfigDir: h.claudeDir,
    sessionHostService: 'com.agent-board.session-host',
  });

  it('叫服務管理程式拉起（launchctl kickstart 的替身），等它能連就用 host 模式', async () => {
    await host!.close();
    host = null;
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    const launched: string[] = [];
    await h.startDaemon({
      config: configWithService(),
      launchSessionHost: async (service) => {
        launched.push(service);
        // 像 launchd 一樣過一下才起來。
        setTimeout(() => {
          host = new SessionHostServer({ dataDir: h.dataDir, log: quiet });
          void host.start();
        }, 300);
        return true;
      },
    });
    expect(launched).toEqual(['com.agent-board.session-host']);
    expect(h.daemons[0]!['backend'].kind).toBe('host');
    await h.createAndSubscribe('s1');
    expect(host!.sessionCount).toBe(1);
  });

  it('拉不起來：等到上限就退回舊模式，session 照樣能開', async () => {
    await host!.close();
    host = null;
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    await h.startDaemon({
      config: configWithService(),
      launchSessionHost: async () => false,
      sessionHostLaunchWaitMs: 300,
    });
    expect(h.daemons[0]!['backend'].kind).toBe('local');
    await h.createAndSubscribe('s1');
  });
});

// 事故 9（CONTRACTS §20.8）：host 被重啟、host 輸入失效的偵測、機器面板的重啟指令。
describe('session host 重啟與輸入健康', () => {
  const statuses = () =>
    h.hub.received.filter(
      (m): m is Extract<DaemonToHub, { type: 'sessionHost.status' }> =>
        m.type === 'sessionHost.status',
    );

  it('host 被重啟（socket 暫時不在）：daemon 等它回來、接回 host 模式，不退回舊模式', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    expect(h.hellos().at(-1)!.sessionHost).toEqual({
      mode: 'host',
      inputSuspect: false,
      canRestart: false,
    });
    await host!.close();
    host = null;
    // 像 launchd：host 結束 agent、過一陣子才重開（比舊的 5 秒等待久）。
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    host = new SessionHostServer({ dataDir: h.dataDir, log: quiet, version: 'test-host-2' });
    await host.start();
    await waitUntil(() => h.runs().length === 2, '重開', 20_000);
    expect(h.daemons[0]!['backend'].kind).toBe('host');
    await waitUntil(() => host!.sessionCount === 1, '新的 agent 由 host 養');
    expect(statuses().map((m) => m.state.mode)).not.toContain('legacy');
  }, 40_000);

  it('舊模式下 host 回來：自動切回 host，之後新開的 session 由 host 養', async () => {
    await host!.close();
    host = null;
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    await h.startDaemon({ sessionHostReturnIntervalMs: 200 });
    expect(h.daemons[0]!['backend'].kind).toBe('local');
    expect(h.hellos().at(-1)!.sessionHost?.mode).toBe('legacy');
    await h.createAndSubscribe('s1');
    host = new SessionHostServer({ dataDir: h.dataDir, log: quiet });
    await host.start();
    await waitUntil(() => h.daemons[0]!['backend'].kind === 'host', '切回 host');
    await waitUntil(() => statuses().some((m) => m.state.mode === 'host'), '回報 host 模式');
    // 舊模式開的 session 照常能用；新開的由 host 養。
    input('s1', 'still-local');
    await h.waitForOutput('s1', 'INPUT:still-local');
    await h.createAndSubscribe('s2');
    expect(host.sessionCount).toBe(1);
  });

  it('送了輸入完全沒輸出、跨兩個 session：daemon.alert＋inputSuspect；之後有回顯就解除', async () => {
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    await h.startDaemon({ inputEchoWindowMs: 300 });
    await h.createAndSubscribe('s1');
    await h.createAndSubscribe('s2');
    const daemon = h.daemons[0]!;
    for (const id of ['s1', 's2']) {
      // 假 claude 沒有輸入框：直接當成在等輸入。
      Object.defineProperty(daemon['sessions'].get(id), 'awaitingTyping', { get: () => true });
    }
    // 模擬 host 的輸入失效：寫入被吞掉（輸出、spawn 照常）。
    const hostSessions = host!['sessions'] as Map<
      string,
      { writer: { write: (d: string) => void } }
    >;
    const originals = new Map<string, (d: string) => void>();
    for (const id of ['s1', 's2']) {
      const writer = hostSessions.get(id)!.writer;
      originals.set(id, writer.write.bind(writer));
      writer.write = () => {};
    }
    input('s1', 'hello');
    await new Promise((resolve) => setTimeout(resolve, 500));
    input('s2', 'hello');
    const alert = await h.hub.waitFor('daemon.alert', (m) => m.code === 'session_host_input_stuck');
    expect(alert.message).not.toContain('hello');
    await waitUntil(() => statuses().some((m) => m.state.inputSuspect), 'inputSuspect');
    // 恢復：有回顯就解除。
    for (const id of ['s1', 's2']) hostSessions.get(id)!.writer.write = originals.get(id)!;
    input('s1', 'again');
    await h.waitForOutput('s1', 'INPUT:again');
    await waitUntil(() => statuses().at(-1)?.state.inputSuspect === false, '解除');
  });

  it('面板「重啟 session host」：daemon 叫服務管理程式重啟，host 回來後 --resume 接回', async () => {
    const restarted: string[] = [];
    mkdirSync(h.workDir, { recursive: true });
    await h.hub.start();
    await h.startDaemon({
      config: {
        hubUrl: h.hub.url,
        token: 'test-machine-token',
        dataDir: h.dataDir,
        claudeBin: h.bin,
        hookBin: h.hookBin,
        machineName: 'test-machine',
        claudeConfigDir: h.claudeDir,
        sessionHostService: 'com.agent-board.session-host',
      },
      sessionHostRecoverWaitMs: 10_000,
      restartSessionHost: async (service) => {
        restarted.push(service);
        await host!.close();
        setTimeout(() => {
          host = new SessionHostServer({ dataDir: h.dataDir, log: quiet });
          void host.start();
        }, 1_000);
        return true;
      },
    });
    const hello = h.hellos().at(-1)!;
    expect(hello.features).toContain('sessionHost.restart');
    expect(hello.sessionHost?.canRestart).toBe(
      process.platform === 'darwin' || process.platform === 'linux',
    );
    if (!hello.sessionHost?.canRestart) return;
    await h.createAndSubscribe('s1');
    const resumeId = h.runs()[0]!.argv[h.runs()[0]!.argv.indexOf('--session-id') + 1]!;
    const projects = join(h.claudeDir, 'projects', 'p');
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, `${resumeId}.jsonl`), '{}\n');
    h.hub.send({ type: 'sessionHost.restart' });
    await waitUntil(() => h.runs().length === 2, '--resume 重開', 20_000);
    expect(restarted).toEqual(['com.agent-board.session-host']);
    expect(h.runs()[1]!.argv.slice(0, 2)).toEqual(['--resume', resumeId]);
    expect(h.daemons[0]!['backend'].kind).toBe('host');
    expect(runtimes('s1').every((r) => r.endedAt === null)).toBe(true);
  }, 40_000);
});
