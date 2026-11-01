import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HookServer, type HookHandler } from './hookServer';
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
    expect(statSync(server.path).mode & 0o777).toBe(0o600);
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

  it('資料夾路徑太長時改用暫存資料夾，關閉後清掉', async () => {
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
  });

  it('另一個 daemon 還活著就拒絕啟動；殘留的 socket 檔會清掉', async () => {
    const { dir } = await setup(async () => null);
    await expect(new HookServer(dir, async () => null).start()).rejects.toThrow('已有 daemon');

    const staleDir = makeTempDir();
    cleanups.push(() => rmSync(staleDir, { recursive: true, force: true }));
    writeFileSync(join(staleDir, 'hook.sock'), '');
    const server = new HookServer(staleDir, async () => null);
    await server.start();
    cleanups.push(() => server.close());
    expect(statSync(server.path).isSocket()).toBe(true);
  });
});
