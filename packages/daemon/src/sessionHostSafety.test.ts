// 審查後補的安全性（S1、S2、W2、W6、W7）：同一個對話不能有兩個 agent、接不回時不殺、重入、崩潰後的審批、重畫。
// 真的 session host（同一個程序裡）、真的 node-pty、假 claude、假 hub。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonToHub, SessionRuntime } from '@agent-board/protocol';
import { hostEndpoint, SessionHostClient } from '@agent-board/session-host';
import { SessionHostServer } from '@agent-board/session-host/server';
import { Daemon } from './daemon';
import { agentStillRunning, processStartTime } from './processCheck';
import { readSnapshot, stateDir } from './sessionState';
import { HookClient, Harness, waitUntil } from './test-support/harness';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

let h: Harness;
let host: SessionHostServer | null;
const orphans: number[] = [];

beforeEach(async () => {
  h = new Harness();
  host = new SessionHostServer({ dataDir: h.dataDir, log: quiet, version: 'test-host' });
  await host.start();
});

afterEach(async () => {
  await h.cleanup();
  await host?.close();
  host = null;
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已經不在
    }
  }
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

const helloSession = (id: string) =>
  h
    .hellos()
    .at(-1)!
    .sessions.find((s) => s.id === id);

async function stopDaemons(): Promise<void> {
  for (const daemon of h.daemons.splice(0)) await daemon.stop();
}

async function hostSessions() {
  const client = await SessionHostClient.connect(hostEndpoint(h.dataDir));
  try {
    return await client.list();
  } finally {
    client.close();
  }
}

const baseConfig = () => ({
  hubUrl: h.hub.url,
  token: 'test-machine-token',
  dataDir: h.dataDir,
  claudeBin: h.bin,
  hookBin: h.hookBin,
  machineName: 'test-machine',
  claudeConfigDir: h.claudeDir,
});

describe('S1：host 可能還活著時不自動重開（同一個對話不能有兩個 agent）', () => {
  it('host 活著但 token 不符：上一輪的 session 不重開、回報錯誤與原因；新的照樣能開；網頁停止才移除', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await stopDaemons();
    writeFileSync(hostEndpoint(h.dataDir).tokenPath, 'sk-ant-demo-wrong-token\n');

    await h.startDaemon({ sessionHostLaunchWaitMs: 200 });
    expect(h.runs()).toHaveLength(1);
    const blocked = helloSession('s1')!;
    expect(blocked.status).toBe('error');
    expect(blocked.endedAt).toBeNull();
    expect(blocked.statusDetail).toMatch(/沒有重開/);
    // 審查 W3：host 證明不了自己 → 報機器警示給 hub（不只寫 log）。
    const alert = await h.hub.waitFor(
      'daemon.alert',
      (m) => m.code === 'session_host_unauthorized',
    );
    expect(alert.message).toMatch(/證明不了自己/);
    expect(alert.message).not.toContain('sk-ant-demo-wrong-token');
    expect((await hostSessionsWithToken())[0]).toMatchObject({ id: 's1', alive: true });

    // 新的 session 不受影響（daemon 自己開）。
    await h.createAndSubscribe('s2');
    expect(h.runs()).toHaveLength(2);

    h.hub.send({ type: 'session.stop', sessionId: 's1' });
    await waitUntil(() => runtimes('s1').some((r) => r.endedAt !== null), '停止後算結束');
    const store = JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')) as {
      sessions: { sessionId: string }[];
    };
    expect(store.sessions.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('協定不相容（例如安裝了新 daemon、舊 host 沒重啟）：不重開，原因說明要 --restart-session-host', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await stopDaemons();
    await h.startDaemon({
      config: { ...baseConfig(), sessionHostTestProtocol: 999 },
      sessionHostLaunchWaitMs: 200,
    });
    expect(h.runs()).toHaveLength(1);
    expect(helloSession('s1')).toMatchObject({ status: 'error' });
    expect(helloSession('s1')!.statusDetail).toMatch(/協定不相容.*--restart-session-host/);
    expect(h.daemons[0]!['backend'].kind).toBe('local');
  });

  it('AGENT_BOARD_SESSION_HOST=off 但 host 還養著 s1：s1 不重開', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await stopDaemons();
    await h.startDaemon({ config: { ...baseConfig(), sessionHost: 'off' } });
    expect(h.runs()).toHaveLength(1);
    expect(helloSession('s1')).toMatchObject({ status: 'error' });
  });

  it('確定沒有 host、但快照記的 agent（pid＋啟動時間）還在跑：不重開', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    // 停止時寫快照（含 agent 的 pid 與啟動時間）。
    await stopDaemons();
    const pid = readSnapshot(h.dataDir, 's1')!.agentPid!;
    orphans.push(pid);
    // 模擬 host 被殺但 agent 沒跟著走（孤兒）。
    await host!.close({ killSessions: false });
    host = null;
    expect(await agentStillRunning(pid, readSnapshot(h.dataDir, 's1')!.agentStartedAt)).toBe(true);

    await h.startDaemon();
    expect(h.runs()).toHaveLength(1);
    expect(helloSession('s1')!.statusDetail).toMatch(new RegExp(`pid ${pid}`));
  });

  it('agentStillRunning：pid 在而且啟動時間對得上才算；pid 被重用（時間不對）、不在都不算', async () => {
    const started = (await processStartTime(process.pid))!;
    expect(started).toBeInstanceOf(Date);
    expect(await agentStillRunning(process.pid, started.toISOString())).toBe(true);
    expect(
      await agentStillRunning(process.pid, new Date(started.getTime() - 3_600_000).toISOString()),
    ).toBe(false);
    expect(await agentStillRunning(2 ** 22 + 12345, new Date().toISOString())).toBe(false);
    expect(await agentStillRunning(null, null)).toBe(false);
  });
});

/** token 檔被改壞了：用 host 自己的 token 連。 */
async function hostSessionsWithToken() {
  writeFileSync(hostEndpoint(h.dataDir).tokenPath, `${host!['token']}\n`);
  return hostSessions();
}

describe('S2：接不回時不殺、不刪', () => {
  it('重播一直逾時：重試一次後標成錯誤，agent 留在 host、清單留著；下次重啟就接回', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await stopDaemons();
    // host 不回應 attach（卡住）：每次都逾時。
    const attach = host!['attach'];
    host!['attach'] = () => {};
    await h.startDaemon({ sessionHostAttachTimeoutMs: 200 });
    host!['attach'] = attach;
    expect(helloSession('s1')).toMatchObject({ status: 'error' });
    expect(helloSession('s1')!.statusDetail).toMatch(/接不回/);
    expect((await hostSessions())[0]).toMatchObject({ id: 's1', alive: true });
    expect(h.runs()).toHaveLength(1);

    await h.restartDaemon();
    expect(helloSession('s1')!.status).not.toBe('error');
    input('s1', 'back-again');
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    await h.waitForOutput('s1', 'INPUT:back-again');
  });

  it('host 回 session_exists：不從清單刪掉，標成錯誤', async () => {
    const daemon = await h.start();
    await h.createAndSubscribe('s1');
    // 模擬 daemon 以為 s1 不在、想重開，但 host 裡還活著。
    const session = daemon['sessions'].get('s1')!;
    session.detach();
    daemon['sessions'].delete('s1');
    await daemon['resumePersistedSessions']();
    expect(daemon['blocked'].has('s1')).toBe(true);
    const store = JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')) as {
      sessions: { sessionId: string }[];
    };
    expect(store.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(h.runs()).toHaveLength(1);
  });
});

describe('W2：host 斷線接回的重入', () => {
  it('接回途中又斷一次：這一輪做完再跑一輪', async () => {
    const daemon = (await h.start()) as Daemon;
    let calls = 0;
    daemon['connectSessionHost'] = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 50));
      return { kind: 'absent' as const };
    };
    daemon['resumePersistedSessions'] = async () => {};
    const first = daemon['recoverFromHostLoss']();
    void daemon['recoverFromHostLoss']();
    await first;
    expect(calls).toBe(2);
  });

  it('reattach 每一輪確認 host 沒換：途中換掉就停，剩下的交給下一輪', async () => {
    const daemon = (await h.start()) as Daemon;
    let attached = 0;
    daemon['attachSession'] = async () => {
      attached += 1;
      daemon['host'] = null;
    };
    const entry = (id: string) => ({
      id,
      pid: 1,
      alive: true,
      exitCode: null,
      signal: null,
      seqStart: 0,
      seqEnd: 0,
      cols: 80,
      rows: 24,
    });
    daemon['store'].upsert({
      sessionId: 'a',
      spec: h.spec(),
      claudeSessionId: null,
      cwd: h.workDir,
      branch: null,
      worktreePath: null,
      pendingFirstPrompt: null,
      createdAt: new Date().toISOString(),
    });
    daemon['store'].upsert({
      sessionId: 'b',
      spec: h.spec(),
      claudeSessionId: null,
      cwd: h.workDir,
      branch: null,
      worktreePath: null,
      pendingFirstPrompt: null,
      createdAt: new Date().toISOString(),
    });
    await daemon['reattachHostSessions']([entry('a'), entry('b')]);
    expect(attached).toBe(1);
  });
});

describe('W6：daemon 崩潰時還在等的審批', () => {
  it('接回後放進 hello、welcome 後標成在終端機處理', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await stopDaemons();
    // 模擬崩潰前寫下的快照：還有一筆在等、沒有交回終端機。
    const file = join(stateDir(h.dataDir), 's1.json');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({
        ...snapshot,
        status: 'waiting_permission',
        approvalsHandedOff: false,
        pendingApprovalIds: ['stale-approval'],
        pendingApprovals: [
          {
            id: 'stale-approval',
            kind: 'permission',
            toolName: 'Bash',
            matchedRule: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await h.startDaemon();
    const hello = h.hellos().at(-1)!;
    expect(hello.pendingApprovals.map((a) => a.id)).toEqual(['stale-approval']);
    expect(hello.pendingApprovals[0]!.toolInput).toBeNull();
    await h.hub.waitFor(
      'approval.resolved',
      (m) => m.approvalId === 'stale-approval' && m.by === 'terminal',
    );
  });

  it('正常停止已經交回過的，接回時不再送一次', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    const hooks = await HookClient.connect(h.daemons[0]!.hookSocketPath);
    void hooks.request('s1', 'PermissionRequest', { tool_name: 'Bash', tool_input: {} });
    const requested = await h.hub.waitFor('approval.requested', () => true);
    await stopDaemons();
    hooks.close();
    expect(readSnapshot(h.dataDir, 's1')!.approvalsHandedOff).toBe(true);
    await h.startDaemon();
    expect(h.hellos().at(-1)!.pendingApprovals).toEqual([]);
    const resolved = h.hub.received.filter(
      (m) => m.type === 'approval.resolved' && m.approvalId === requested.approval.id,
    );
    expect(resolved).toHaveLength(1);
  });
});

describe('W7：接回後微調尺寸讓 TUI 重畫', () => {
  it('重播完對 agent 送 cols-1 再改回（agent 收到兩次 SIGWINCH），最後尺寸不變', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await h.restartDaemon();
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    await h.waitForOutput('s1', 'RESIZED 119x32');
    await h.waitForOutput('s1', 'RESIZED 120x32');
    expect((await hostSessions())[0]).toMatchObject({ cols: 120, rows: 32 });
    input('s1', 'size');
    await h.waitForOutput('s1', 'SIZE 120x32');
  });
});

describe('N1：被擋住的 session 停止與接續', () => {
  it('停止：舊 agent 還在（host 不能用）就先收掉它的程序群組，確定沒了才移除；之後接續只會有一個 agent', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await stopDaemons();
    const pid = readSnapshot(h.dataDir, 's1')!.agentPid!;
    writeFileSync(hostEndpoint(h.dataDir).tokenPath, 'sk-ant-demo-wrong-token\n');
    await h.startDaemon({ sessionHostLaunchWaitMs: 200 });
    expect(helloSession('s1')).toMatchObject({ status: 'error' });
    expect(await agentStillRunning(pid, readSnapshot(h.dataDir, 's1')!.agentStartedAt)).toBe(true);

    h.hub.send({ type: 'session.stop', sessionId: 's1' });
    await waitUntil(() => runtimes('s1').some((r) => r.endedAt !== null), '停止後算結束');
    expect(await agentStillRunning(pid, null)).toBe(false);
    expect(readSnapshot(h.dataDir, 's1')).toBeNull();

    // 接續：舊的已經收掉，開一個新的。
    h.hub.send({ type: 'session.create', requestId: 'resume-s1', sessionId: 's1', spec: h.spec() });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'resume-s1');
    await waitUntil(() => h.runs().length === 2, '新的 agent 開起來');
  });

  it('接續前檢查：快照記的舊 agent 還在跑就拒絕，回清楚的錯誤，不開第二個', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    await stopDaemons();
    const pid = readSnapshot(h.dataDir, 's1')!.agentPid!;
    orphans.push(pid);
    // host 被殺但 agent 沒跟著走（孤兒）：daemon 判斷沒有 host、但 pid 還在 → 擋住。
    await host!.close({ killSessions: false });
    host = null;
    await h.startDaemon();
    h.hub.send({ type: 'session.create', requestId: 'again', sessionId: 's1', spec: h.spec() });
    const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'again');
    expect(failed.error).toMatch(new RegExp(`pid ${pid}.*還在跑`));
    expect(h.runs()).toHaveLength(1);
  });
});

describe('N5：啟動接回途中 host 斷線', () => {
  it('恢復流程進行中：不清 MCP 密鑰檔（那些 session 還沒接回）', async () => {
    const mcp = join(h.dataDir, 'mcp');
    mkdirSync(mcp, { recursive: true });
    writeFileSync(join(mcp, 'ghost.key'), 'sk-ant-demo-secret\n');
    writeFileSync(join(mcp, 'ghost.json'), '{}');
    const proto = Daemon.prototype as unknown as Record<string, unknown>;
    const original = proto.reattachHostSessions;
    proto.reattachHostSessions = async function (this: Record<string, unknown>) {
      this.host = null;
      this.recoveringHost = true;
    };
    try {
      await h.start();
    } finally {
      proto.reattachHostSessions = original;
    }
    expect(existsSync(join(mcp, 'ghost.key'))).toBe(true);
    expect(existsSync(join(mcp, 'ghost.json'))).toBe(true);
    h.daemons[0]!['recoveringHost'] = false;
  });
});
