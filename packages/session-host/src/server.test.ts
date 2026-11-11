// session host 伺服器＋客戶端：真的 node-pty、真的 Unix socket，agent 是假的（echoAgent.mjs）。
import { connect, createServer } from 'node:net';
import { localProof, newNonce, verifyLocalProof } from '@agent-board/protocol/local-auth';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HostToDaemon,
  SESSION_HOST_PROTOCOL,
  type HostSessionInfo,
} from '@agent-board/protocol/session-host';
import { HostConnectError, SessionHostClient } from './client';
import { hostEndpoint } from './endpoint';
import { HostAlreadyRunningError, SessionHostServer, type HostLogger } from './server';

const ECHO = fileURLToPath(new URL('./test-support/echoAgent.mjs', import.meta.url));
const quiet: HostLogger = { info: () => {}, warn: () => {}, error: () => {} };

async function waitUntil<T>(fn: () => T | null | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** 收一個 session 的事件，方便斷言。 */
function recorder() {
  const events: string[] = [];
  let text = '';
  const seqs: number[] = [];
  let attached: HostSessionInfo | null = null;
  let exit: { code: number; signal: number | null } | null = null;
  let gap = 0;
  let replayDone: number | null = null;
  return {
    events,
    get text() {
      return text;
    },
    get seqs() {
      return seqs;
    },
    get attached() {
      return attached;
    },
    get exit() {
      return exit;
    },
    get gap() {
      return gap;
    },
    get replayDone() {
      return replayDone;
    },
    handlers: {
      onAttached: (session: HostSessionInfo) => {
        attached = session;
        events.push('attached');
      },
      onOutput: (seq: number, data: Buffer) => {
        seqs.push(seq);
        text += data.toString('utf8');
      },
      onGap: (lost: number) => {
        gap = lost;
        events.push('gap');
      },
      onReplayDone: (seq: number) => {
        replayDone = seq;
        events.push('replayDone');
      },
      onExit: (code: number, signal: number | null) => {
        exit = { code, signal };
        events.push('exit');
      },
    },
  };
}

describe('session host', () => {
  let dataDir: string;
  let server: SessionHostServer;
  const clients: SessionHostClient[] = [];

  const connectClient = async () => {
    const client = await SessionHostClient.connect(hostEndpoint(dataDir));
    clients.push(client);
    return client;
  };

  const spawnEcho = (client: SessionHostClient, id: string) =>
    client.spawn({
      id,
      bin: process.execPath,
      args: [ECHO],
      // Windows 的程式少了 SystemRoot 會有系統 API 起不來（socket、加密）。
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
      cwd: dataDir,
      cols: 80,
      rows: 24,
    });

  beforeEach(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-host-')));
    server = new SessionHostServer({ dataDir, log: quiet, version: 'test' });
    await server.start();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Windows 沒有 Unix 檔案權限，pipe 也不是檔案（存取權限見 CONTRACTS §20.7）。
  it.skipIf(process.platform === 'win32')('socket 與 token 檔是 600、資料夾 700', () => {
    const endpoint = hostEndpoint(dataDir);
    expect(statSync(endpoint.path).mode & 0o777).toBe(0o600);
    expect(statSync(endpoint.tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('同一個資料夾不能開第二個 host', async () => {
    const second = new SessionHostServer({ dataDir, log: quiet });
    await expect(second.start()).rejects.toBeInstanceOf(HostAlreadyRunningError);
  });

  it('token 不對：hello.error unauthorized，連線被關', async () => {
    const endpoint = hostEndpoint(dataDir);
    writeFileSync(endpoint.tokenPath, 'wrong-token\n');
    const error = await SessionHostClient.connect(endpoint).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostConnectError);
    expect((error as HostConnectError).reason).toBe('unauthorized');
  });

  it('協定 1 的舊 daemon（hello 帶 token）：hello.error protocol_mismatch，不比對 token', async () => {
    const token = readFileSync(hostEndpoint(dataDir).tokenPath, 'utf8').trim();
    const reply = await new Promise<HostToDaemon>((resolve) => {
      const socket = connect(hostEndpoint(dataDir).path, () => {
        socket.write(`${JSON.stringify({ type: 'hello', protocol: 1, token })}\n`);
      });
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        resolve(HostToDaemon.parse(JSON.parse(chunk.split('\n')[0]!)));
        socket.destroy();
      });
    });
    expect(reply).toEqual({
      type: 'hello.error',
      protocol: SESSION_HOST_PROTOCOL,
      error: 'protocol_mismatch',
    });
  });

  it('沒有 token 檔：no_token；連不上：unreachable', async () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'ab-host-none-')));
    try {
      const noToken = await SessionHostClient.connect(hostEndpoint(other)).catch((e) => e);
      expect((noToken as HostConnectError).reason).toBe('no_token');
      writeFileSync(hostEndpoint(other).tokenPath, 'x\n');
      const unreachable = await SessionHostClient.connect(hostEndpoint(other)).catch((e) => e);
      expect((unreachable as HostConnectError).reason).toBe('unreachable');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  /** 用原始 socket 走一段握手，收集 host 回的每一行，直到斷線。 */
  const rawSession = (
    path: string,
    onLine: (message: Record<string, unknown>, write: (m: unknown) => void) => void,
    first: unknown,
  ) =>
    new Promise<Record<string, unknown>[]>((resolve) => {
      const lines: Record<string, unknown>[] = [];
      const socket = connect(path, () => socket.write(`${JSON.stringify(first)}\n`));
      const write = (m: unknown) => socket.write(`${JSON.stringify(m)}\n`);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const message = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
          buffer = buffer.slice(index + 1);
          lines.push(message);
          onLine(message, write);
          if (message.type === 'hello.ok') socket.destroy();
        }
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve(lines));
    });

  it('W5：host 先證明自己拿得到 token，daemon 證明對了才給清單；token 不經過 socket', async () => {
    const token = readFileSync(hostEndpoint(dataDir).tokenPath, 'utf8').trim();
    const nonce = newNonce();
    const sent: string[] = [];
    const lines = await rawSession(
      hostEndpoint(dataDir).path,
      (message, write) => {
        if (message.type !== 'hello.challenge') return;
        expect(verifyLocalProof(token, 'hostServer', nonce, message.proof)).toBe(true);
        const auth = {
          type: 'hello.auth',
          proof: localProof(token, 'hostClient', String(message.nonce)),
        };
        sent.push(JSON.stringify(auth));
        write(auth);
      },
      { type: 'hello', protocol: SESSION_HOST_PROTOCOL, nonce },
    );
    expect(lines.map((l) => l.type)).toEqual(['hello.challenge', 'hello.ok']);
    expect(sent.join('')).not.toContain(token);
  });

  it('W5：daemon 的證明不對 → unauthorized 斷線；同一個 nonce 重送 → unauthorized', async () => {
    const nonce = newNonce();
    const wrong = await rawSession(
      hostEndpoint(dataDir).path,
      (message, write) => {
        if (message.type === 'hello.challenge') {
          write({
            type: 'hello.auth',
            proof: localProof('not-the-token', 'hostClient', String(message.nonce)),
          });
        }
      },
      { type: 'hello', protocol: SESSION_HOST_PROTOCOL, nonce },
    );
    expect(wrong.map((l) => l.type)).toEqual(['hello.challenge', 'hello.error']);
    expect(wrong[1]).toMatchObject({ error: 'unauthorized' });
    const replay = await rawSession(hostEndpoint(dataDir).path, () => {}, {
      type: 'hello',
      protocol: SESSION_HOST_PROTOCOL,
      nonce,
    });
    expect(replay).toEqual([
      { type: 'hello.error', protocol: SESSION_HOST_PROTOCOL, error: 'unauthorized' },
    ]);
  });

  it('W5：沒收到 challenge 就送 hello.auth → 直接斷線', async () => {
    const lines = await rawSession(hostEndpoint(dataDir).path, () => {}, {
      type: 'hello.auth',
      proof: 'p'.repeat(43),
    });
    expect(lines).toEqual([]);
  });

  it('W5：假 host（不知道 token）先證明不了 → daemon 什麼都不送就斷（unauthorized）', async () => {
    const fakeDir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-host-fake-')));
    const endpoint = hostEndpoint(fakeDir);
    writeFileSync(endpoint.tokenPath, 'real-token\n');
    const received: string[] = [];
    const fake = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', (chunk: string) => {
        received.push(chunk);
        socket.write(
          `${JSON.stringify({ type: 'hello.challenge', protocol: SESSION_HOST_PROTOCOL, proof: localProof('guess', 'hostServer', newNonce()), nonce: newNonce() })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => fake.listen(endpoint.path, resolve));
    try {
      const error = await SessionHostClient.connect(endpoint).catch((e: unknown) => e);
      expect((error as HostConnectError).reason).toBe('unauthorized');
      await new Promise((resolve) => setTimeout(resolve, 50));
      // 只收到 hello（nonce），沒有 token、沒有 hello.auth。
      const all = received.join('');
      expect(all).not.toContain('real-token');
      expect(all).not.toContain('hello.auth');
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('新 daemon 連協定 1 的舊 host（回 error bad_message）→ protocol_mismatch', async () => {
    const oldDir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-host-old-')));
    const endpoint = hostEndpoint(oldDir);
    writeFileSync(endpoint.tokenPath, 'old-token\n');
    const old = createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => {
        socket.write(`${JSON.stringify({ type: 'error', id: null, error: 'bad_message' })}\n`);
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => old.listen(endpoint.path, resolve));
    try {
      const error = await SessionHostClient.connect(endpoint).catch((e: unknown) => e);
      expect((error as HostConnectError).reason).toBe('protocol_mismatch');
    } finally {
      await new Promise<void>((resolve) => old.close(() => resolve()));
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it('同名 pipe／socket 已經有人開著（EADDRINUSE）→ HostAlreadyRunningError', async () => {
    // Windows 的 named pipe 沒有「先連看看」那一步，直接 listen 撞到 EADDRINUSE；這裡用 kind: 'pipe' 跳過那一步模擬。
    const endpoint = { ...hostEndpoint(dataDir), kind: 'pipe' as const };
    const second = new SessionHostServer({ dataDir, endpoint, log: quiet });
    await expect(second.start()).rejects.toBeInstanceOf(HostAlreadyRunningError);
  });

  it('沒先 hello 就送指令：直接斷線', async () => {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(hostEndpoint(dataDir).path, () => {
        socket.write(`${JSON.stringify({ type: 'list', reqId: 'r1' })}\n`);
      });
      socket.on('close', () => resolve(true));
      socket.on('error', () => {});
    });
    expect(closed).toBe(true);
  });

  it('spawn、write、resize：輸出依序帶位元組序號', async () => {
    const client = await connectClient();
    const rec = recorder();
    client.register('s1', rec.handlers);
    const pid = await spawnEcho(client, 's1');
    expect(pid).toBeGreaterThan(0);
    await waitUntil(() => rec.text.includes('READY'), 'READY');
    client.write('s1', 'hello\r');
    await waitUntil(() => rec.text.includes('ECHO:hello'), 'echo');
    client.resize('s1', 100, 30);
    // agent 讀的是 Node 快取的尺寸，收到 SIGWINCH 才更新；機器忙時 size 可能比 SIGWINCH 先到、回舊尺寸。
    // 所以沒看到新尺寸就隔一下重問（全套並行時實際發生過）。
    // Windows（ConPTY）沒有 SIGWINCH，子程序的 columns 何時更新不保證：只看 host 記下的尺寸（下面的 list）。
    let asked = 0;
    if (process.platform !== 'win32')
      await waitUntil(() => {
        if (rec.text.includes('SIZE 100x30')) return true;
        if (Date.now() - asked > 200) {
          asked = Date.now();
          client.write('s1', 'size\r');
        }
        return false;
      }, 'size');
    // 序號＝之前所有輸出的位元組數。
    let expected = 0;
    const outputs = rec.seqs;
    expect(outputs[0]).toBe(0);
    expect(outputs.every((seq) => seq >= expected && ((expected = seq), true))).toBe(true);
    const [info] = await client.list();
    expect(info).toMatchObject({ id: 's1', alive: true, pid, cols: 100, rows: 30, seqStart: 0 });
    expect(info!.seqEnd).toBe(Buffer.byteLength(rec.text));
  });

  it('同一個 id 還活著不能再 spawn；bin 不存在：回錯誤或馬上以非 0 結束', async () => {
    const client = await connectClient();
    client.register('s1', recorder().handlers);
    await spawnEcho(client, 's1');
    await expect(spawnEcho(client, 's1')).rejects.toThrow('session_exists');
    const bad = recorder();
    client.register('s2', bad.handlers);
    // node-pty 在 macOS 上先 fork 再 exec：找不到程式不一定丟例外，而是子程序馬上失敗。
    const spawned = await client
      .spawn({
        id: 's2',
        bin: join(dataDir, 'no-such-bin'),
        args: [],
        env: {},
        cwd: join(dataDir, 'no-such-dir'),
        cols: 80,
        rows: 24,
      })
      .then(
        () => 'spawned',
        () => 'rejected',
      );
    if (spawned === 'spawned') {
      await waitUntil(() => bad.exit, 'bad exit');
      expect(bad.exit!.code).not.toBe(0);
    }
  });

  it('daemon 斷線 agent 照跑；新連線 attach 從頭重播、之後接即時輸出', async () => {
    const first = await connectClient();
    const before = recorder();
    first.register('s1', before.handlers);
    await spawnEcho(first, 's1');
    first.write('s1', 'one\r');
    await waitUntil(() => before.text.includes('ECHO:one'), 'one');
    first.close();

    // 沒人接的時候還有輸出：要進緩衝。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await connectClient();
    expect(second.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(second.sessions[0]!.alive).toBe(true);
    const after = recorder();
    second.register('s1', after.handlers);
    second.attach('s1', 0);
    await waitUntil(() => after.replayDone !== null, 'replay.done');
    expect(after.events.slice(0, 2)).toEqual(['attached', 'replayDone']);
    expect(after.text).toBe(before.text);
    expect(after.replayDone).toBe(Buffer.byteLength(before.text));

    second.write('s1', 'two\r');
    await waitUntil(() => after.text.includes('ECHO:two'), 'two');
  });

  it('agent 在沒人接時結束：attach 重播完再送 exit；release 後就不在清單', async () => {
    const first = await connectClient();
    const rec = recorder();
    first.register('s1', rec.handlers);
    await spawnEcho(first, 's1');
    await waitUntil(() => rec.text.includes('READY'), 'READY');
    first.close();
    // 用另一條連線叫它結束，但不接收（模擬 daemon 不在時 agent 自己離開）。
    const poke = await connectClient();
    poke.write('s1', 'exit 3\r');
    let info: HostSessionInfo | undefined;
    const deadline = Date.now() + 8_000;
    while (!(info = (await poke.list())[0]) || info.alive) {
      if (Date.now() > deadline) throw new Error('agent 沒有結束');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    poke.close();
    const second = await connectClient();
    expect(info).toMatchObject({ id: 's1', alive: false, exitCode: 3 });
    const after = recorder();
    second.register('s1', after.handlers);
    second.attach('s1', 0);
    await waitUntil(() => after.exit, 'exit');
    expect(after.events).toEqual(['attached', 'replayDone', 'exit']);
    expect(after.exit).toEqual({ code: 3, signal: null });
    expect(after.text).toContain('READY');
    second.release('s1');
    // 同一條連線依序處理：release 之後的 list 一定看得到結果。
    expect(await second.list()).toEqual([]);
  });

  it('緩衝不夠：attach 先送 replay.gap 缺多少位元組', async () => {
    await server.close();
    server = new SessionHostServer({ dataDir, log: quiet, bufferBytes: 512 });
    await server.start();
    const client = await connectClient();
    const rec = recorder();
    client.register('s1', rec.handlers);
    await spawnEcho(client, 's1');
    client.write('s1', 'flood 200\r');
    await waitUntil(() => rec.text.includes('FLOOD DONE'), 'flood');
    const again = recorder();
    client.register('s1', again.handlers);
    client.attach('s1', 0);
    await waitUntil(() => again.replayDone !== null, 'replay.done');
    expect(again.events.slice(0, 3)).toEqual(['attached', 'gap', 'replayDone']);
    const total = Buffer.byteLength(rec.text);
    expect(Buffer.byteLength(again.text)).toBeLessThanOrEqual(512);
    expect(again.gap + Buffer.byteLength(again.text)).toBe(total);
    // ConPTY 會在最後補游標控制碼，Windows 只確認最新的內容在。
    if (process.platform === 'win32') expect(again.text).toContain('FLOOD DONE');
    else expect(again.text.trimEnd().endsWith('FLOOD DONE')).toBe(true);
  });

  it('kill SIGTERM、SIGKILL 都收得掉；關閉 host 會結束所有 agent', async () => {
    const client = await connectClient();
    const a = recorder();
    const b = recorder();
    client.register('a', a.handlers);
    client.register('b', b.handlers);
    await spawnEcho(client, 'a');
    const pidB = await spawnEcho(client, 'b');
    await waitUntil(() => a.text.includes('READY') && b.text.includes('READY'), 'READY');
    client.kill('a', 'SIGKILL');
    await waitUntil(() => a.exit, 'a exit');
    client.kill('b', 'SIGTERM');
    await waitUntil(() => b.exit, 'b exit');
    expect(() => process.kill(pidB, 0)).toThrow();
    const c = recorder();
    client.register('c', c.handlers);
    const pid = await spawnEcho(client, 'c');
    await waitUntil(() => c.text.includes('READY'), 'c READY');
    let closed = false;
    client.onClose(() => (closed = true));
    await server.close();
    // 先收到 shutdown（客戶端當成連線中斷，之後的結束不轉給 daemon），agent 已被收掉。
    expect(closed).toBe(true);
    expect(c.exit).toBeNull();
    expect(() => process.kill(pid, 0)).toThrow();
    // afterEach 會再關一次，要能重複呼叫。
  });

  it('還沒 hello 的連線一行超過 4KB：直接斷線', async () => {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(hostEndpoint(dataDir).path, () => {
        socket.write('x'.repeat(8 * 1024));
      });
      socket.on('close', () => resolve(true));
      socket.on('error', () => {});
    });
    expect(closed).toBe(true);
  });

  it('背壓：daemon 讀不完、積著的輸出超過上限就斷線，輸出照樣進緩衝，重新 attach 補得回來', async () => {
    await server.close();
    server = new SessionHostServer({ dataDir, log: quiet, maxPendingWriteBytes: 16 * 1024 });
    await server.start();
    const client = await connectClient();
    const rec = recorder();
    client.register('s1', rec.handlers);
    await spawnEcho(client, 's1');
    await waitUntil(() => rec.text.includes('READY'), 'READY');
    let closed = false;
    client.onClose(() => (closed = true));
    // 不讀：socket 的接收端塞滿後 host 這邊的寫入會積起來。
    client['socket'].pause();
    client.write('s1', 'flood 100000\r');
    // 暫停讀取時客戶端看不到 EOF：從 host 那邊確認連線被切掉，再恢復讀取讓客戶端收到關閉。
    await waitUntil(() => server['connections'].size === 0, 'host 切斷連線');
    client['socket'].resume();
    await waitUntil(() => closed, '客戶端收到關閉');
    const again = await connectClient();
    // 等 agent 印完（seqEnd 不再變）再 attach 一次。
    let last = -1;
    for (let i = 0; i < 100; i += 1) {
      const end = (await again.list())[0]!.seqEnd;
      if (end === last) break;
      last = end;
      await new Promise((r) => setTimeout(r, 300));
    }
    const after = recorder();
    again.register('s1', after.handlers);
    again.attach('s1', 0);
    await waitUntil(() => after.replayDone !== null, 'replay');
    expect(after.text).toContain('FLOOD DONE');
  });

  it('host 關閉：客戶端收到 onClose，之後的請求立刻失敗', async () => {
    const client = await connectClient();
    let closed = false;
    client.onClose(() => (closed = true));
    await server.close();
    await waitUntil(() => closed, 'onClose');
    await expect(client.list()).rejects.toThrow();
  });
});
