import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newNonce, verifyLocalProof } from '@agent-board/protocol/local-auth';
import { ensureHookKey, HookServer, proveDaemon, type HookHandler } from './hookServer';
import { HookClient, makeTempDir, waitUntil } from './test-support/harness';

describe('HookServer', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  async function setup(handler: HookHandler, dir = makeTempDir()) {
    const server = new HookServer(dir, handler);
    await server.start();
    cleanups.push(
      () => server.close(),
      () => rmSync(dir, { recursive: true, force: true }),
    );
    return { server, dir };
  }

  it('收 HookRequest、回 HookReply；socket 權限 0600', async () => {
    const { server } = await setup(async (request) => ({ got: request.event }));
    // Windows 是 named pipe，沒有檔案權限（§20.7）。
    if (process.platform !== 'win32') expect(statSync(server.path).mode & 0o777).toBe(0o600);
    const client = await HookClient.connect(server.path);
    cleanups.push(() => client.close());
    const reply = await client.request('s1', 'Stop');
    expect(reply).toMatchObject({ type: 'hook.reply', output: { got: 'Stop' } });
  });

  it('NDJSON 分段到達、一次多行都能處理', async () => {
    const seen: string[] = [];
    const { server } = await setup(async (request) => {
      seen.push(request.requestId);
      return null;
    });
    const socket = connect(server.path);
    cleanups.push(() => void socket.destroy());
    await new Promise((resolve) => socket.once('connect', resolve));
    const line = (id: string) =>
      `${JSON.stringify({
        type: 'hook',
        requestId: id,
        sessionId: 's',
        event: 'Stop',
        payload: { session_id: 'c', hook_event_name: 'Stop' },
      })}\n`;
    const first = line('a');
    socket.write(first.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.write(first.slice(10) + line('b') + line('c'));
    await waitUntil(() => seen.length === 3, '三則請求');
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('壞 JSON 丟棄不斷線；不合協定但有 requestId 的回 output:null', async () => {
    const { server } = await setup(async () => ({ ok: true }));
    const socket = connect(server.path);
    socket.setEncoding('utf8');
    cleanups.push(() => void socket.destroy());
    let received = '';
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.write('not json\n');
    socket.write(`${JSON.stringify({ type: 'hook', requestId: 'bad', event: 'Nope' })}\n`);
    await waitUntil(() => received.includes('\n'), '回覆');
    expect(JSON.parse(received.trim())).toEqual({
      type: 'hook.reply',
      requestId: 'bad',
      output: null,
    });
  });

  it('handler 丟例外時回 output:null，不會讓 hook 空等', async () => {
    const { server } = await setup(async () => {
      throw new Error('boom');
    });
    const client = await HookClient.connect(server.path);
    cleanups.push(() => client.close());
    expect((await client.request('s', 'Stop')).output).toBeNull();
  });

  it('非阻擋事件送完就關（socket.end）或立刻斷線：事件照收，回寫失敗不影響 server', async () => {
    const seen: string[] = [];
    const { server } = await setup(async (request) => {
      seen.push(request.requestId);
      // 等對方真的關了才回寫，製造 EPIPE 的時機。
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ignored: true };
    });
    const line = (id: string) =>
      `${JSON.stringify({
        type: 'hook',
        requestId: id,
        sessionId: 's',
        event: 'Stop',
        payload: { session_id: 'c', hook_event_name: 'Stop' },
      })}\n`;
    const ended = connect(server.path);
    ended.on('error', () => {});
    ended.end(line('ended'));
    const destroyed = connect(server.path);
    destroyed.on('error', () => {});
    destroyed.write(line('destroyed'), () => destroyed.destroy());
    await waitUntil(() => seen.length === 2, '兩則都收到');
    await new Promise((resolve) => setTimeout(resolve, 60));

    const client = await HookClient.connect(server.path);
    cleanups.push(() => client.close());
    expect((await client.request('s', 'Stop')).output).toEqual({ ignored: true });
  });

  it('socket 發生 EPIPE／ECONNRESET 不會變成 uncaught exception', async () => {
    const { server } = await setup(async () => ({ ok: true }));
    const client = await HookClient.connect(server.path);
    cleanups.push(() => client.close());
    await client.request('s', 'Stop');
    const [accepted] = [...server['sockets']];
    if (!accepted) throw new Error('沒有連線');
    // 沒有 error listener 時 emit 會直接丟例外，相當於 daemon 崩潰。
    expect(() =>
      accepted.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
    ).not.toThrow();
  });

  it('連線關閉時 abort 等待中的請求', async () => {
    let aborted = false;
    const { server } = await setup(
      (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve(null);
          });
        }),
    );
    const client = await HookClient.connect(server.path);
    void client.request('s', 'PermissionRequest');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aborted).toBe(false);
    client.close();
    await waitUntil(() => aborted, 'abort');
  });

  // Windows 是 named pipe，沒有路徑長度的問題。
  it.skipIf(process.platform === 'win32')(
    '資料夾路徑太長時改用暫存資料夾，關閉後清掉',
    async () => {
      const dir = join(makeTempDir(), 'x'.repeat(80), 'y'.repeat(80));
      mkdirSync(dir, { recursive: true });
      const server = new HookServer(dir, async () => null);
      await server.start();
      const { path } = server;
      expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100);
      expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
      const client = await HookClient.connect(path);
      expect((await client.request('s', 'Stop')).output).toBeNull();
      client.close();
      await server.close();
      expect(() => statSync(path)).toThrow();
    },
  );

  it('另一個 daemon 還活著就拒絕啟動；殘留的 socket 檔會清掉', async () => {
    const { dir } = await setup(async () => null);
    if (process.platform === 'win32') {
      // 同名 pipe 已開：EADDRINUSE → 啟動失敗並說明（§20.7）。Windows 沒有殘留檔。
      await expect(new HookServer(dir, async () => null).start()).rejects.toThrow('已有 daemon');
      return;
    }
    await expect(new HookServer(dir, async () => null).start()).rejects.toThrow('已有 daemon');

    const staleDir = makeTempDir();
    cleanups.push(() => rmSync(staleDir, { recursive: true, force: true }));
    writeFileSync(join(staleDir, 'hook.sock'), '');
    const server = new HookServer(staleDir, async () => null);
    await server.start();
    cleanups.push(() => server.close());
    expect(statSync(server.path).isSocket()).toBe(true);
  });

  /** 原始連線：送幾行，收回所有行，直到對方斷線或 waitMs 到。 */
  function exchange(path: string, lines: unknown[], waitMs = 300): Promise<unknown[]> {
    return new Promise((resolve) => {
      const got: unknown[] = [];
      let buffer = '';
      const socket = connect(path, () => {
        for (const line of lines) socket.write(`${JSON.stringify(line)}\n`);
      });
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) !== -1) {
          got.push(JSON.parse(buffer.slice(0, index)));
          buffer = buffer.slice(index + 1);
        }
      });
      socket.on('error', () => {});
      const timer = setTimeout(() => socket.destroy(), waitMs);
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(got);
      });
    });
  }

  it('W5：hook.key（600）建一次就沿用；auth.challenge 回正確的 auth.proof，之後同一條連線照常送請求', async () => {
    const { server, dir } = await setup(async (request) => ({ got: request.event }));
    expect(server.keyPath).toBe(join(dir, 'hook.key'));
    const key = readFileSync(server.keyPath, 'utf8').trim();
    expect(key.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== 'win32') expect(statSync(server.keyPath).mode & 0o777).toBe(0o600);
    expect(ensureHookKey(dir)).toBe(key);

    const nonce = newNonce();
    const got = await exchange(server.path, [
      { type: 'auth.challenge', nonce },
      {
        type: 'hook',
        requestId: 'r1',
        sessionId: 's',
        event: 'Stop',
        payload: { session_id: 'c', hook_event_name: 'Stop' },
      },
    ]);
    expect(got).toHaveLength(2);
    const proof = got[0] as { type: string; proof: string };
    expect(proof.type).toBe('auth.proof');
    expect(verifyLocalProof(key, 'hookServer', nonce, proof.proof)).toBe(true);
    expect(got[1]).toEqual({ type: 'hook.reply', requestId: 'r1', output: { got: 'Stop' } });
  });

  it('W5：nonce 格式不對或重送 → 不回證明、直接斷線', async () => {
    const { server } = await setup(async () => null);
    expect(await exchange(server.path, [{ type: 'auth.challenge', nonce: 'bad' }])).toEqual([]);
    const nonce = newNonce();
    expect(await exchange(server.path, [{ type: 'auth.challenge', nonce }])).toHaveLength(1);
    expect(await exchange(server.path, [{ type: 'auth.challenge', nonce }])).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'W6：每次啟動都把資料夾改回 700（「沒給密鑰檔的舊 agent 不驗證」靠的是這一層）',
    async () => {
      const dir = makeTempDir();
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, 'hook.key'), `${'k'.repeat(43)}\n`, { mode: 0o600 });
      chmodSync(dir, 0o755);
      const server = new HookServer(dir, async () => null);
      await server.start();
      cleanups.push(() => server.close());
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );

  /** 測試用的位置：Windows 用 pipe，其他用 tmp 裡的 Unix socket（指定 location 會略過殘留檔處理，模擬 Windows）。 */
  const testLocation = (dir: string, name: string) =>
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agent-board-hook-test-${name}-${Math.random().toString(16).slice(2)}`
      : join(dir, `${name}.sock`);

  it('W3：位置被別的程式占了（證明不了自己是 daemon）→ 改用備用名稱照常啟動、記下來報警示', async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testLocation(dir, 'squat');
    // 占位的程式：連得上但什麼都不回。
    const held = new Set<Socket>();
    const squatter = createServer((socket) => {
      held.add(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => squatter.listen(path, resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of held) socket.destroy();
          squatter.close(() => resolve());
        }),
    );
    const server = new HookServer(dir, async (request) => ({ got: request.event }), null, {
      location: path,
    });
    await server.start();
    cleanups.push(() => server.close());
    expect(server.squattedPath).toBe(path);
    expect(server.path).not.toBe(path);
    expect(server.path.startsWith(`${path}-`)).toBe(true);
    const client = await HookClient.connect(server.path);
    cleanups.push(() => client.close());
    expect((await client.request('s', 'Stop')).output).toEqual({ got: 'Stop' });
  });

  it('W3：位置上是另一個真的 daemon（證明得了）→ 不搶，啟動失敗', async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testLocation(dir, 'twin');
    const first = new HookServer(dir, async () => null, null, { location: path });
    await first.start();
    cleanups.push(() => first.close());
    expect(await proveDaemon(path, readFileSync(first.keyPath, 'utf8').trim())).toBe(true);
    expect(await proveDaemon(path, 'w'.repeat(43))).toBe(false);
    const second = new HookServer(dir, async () => null, null, { location: path });
    await expect(second.start()).rejects.toThrow('已有 daemon');
  });

  it('W5：daemon 重啟後沿用同一把密鑰（活著的 agent 還拿著同一個路徑）', async () => {
    const dir = makeTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = new HookServer(dir, async () => null);
    await first.start();
    const key = readFileSync(first.keyPath, 'utf8');
    await first.close();
    const second = new HookServer(dir, async () => null);
    await second.start();
    cleanups.push(() => second.close());
    expect(readFileSync(second.keyPath, 'utf8')).toBe(key);
  });
});
