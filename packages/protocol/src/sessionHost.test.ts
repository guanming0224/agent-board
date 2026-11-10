import { describe, expect, it } from 'vitest';
import { DaemonToHost, HostToDaemon, SESSION_HOST_BUFFER_BYTES } from './sessionHost';

describe('session host 協定', () => {
  it('每個 session 的緩衝是 2 MB（GM 2026-11-10）', () => {
    expect(SESSION_HOST_BUFFER_BYTES).toBe(2 * 1024 * 1024);
  });

  it('daemon → host：合法訊息都收', () => {
    const messages = [
      { type: 'hello', protocol: 1, token: 't' },
      {
        type: 'spawn',
        reqId: 'r',
        id: 's',
        bin: '/bin/claude',
        args: ['--name', 'x'],
        env: { PATH: '/bin' },
        cwd: '/tmp',
        cols: 120,
        rows: 32,
      },
      { type: 'attach', id: 's', fromSeq: 0 },
      { type: 'write', id: 's', data: 'hi\r' },
      { type: 'resize', id: 's', cols: 80, rows: 24 },
      { type: 'kill', id: 's', signal: 'SIGKILL' },
      { type: 'list', reqId: 'r' },
      { type: 'release', id: 's' },
    ];
    for (const message of messages) expect(DaemonToHost.parse(message)).toEqual(message);
  });

  it('daemon → host：不認得的訊號、負的序號、缺 token 都拒絕', () => {
    expect(DaemonToHost.safeParse({ type: 'kill', id: 's', signal: 'SIGUSR1' }).success).toBe(
      false,
    );
    expect(DaemonToHost.safeParse({ type: 'attach', id: 's', fromSeq: -1 }).success).toBe(false);
    expect(DaemonToHost.safeParse({ type: 'hello', protocol: 1, token: '' }).success).toBe(false);
    expect(DaemonToHost.safeParse({ type: 'exec', id: 's' }).success).toBe(false);
  });

  it('host → daemon：重播相關訊息', () => {
    const info = {
      id: 's',
      pid: 10,
      alive: false,
      exitCode: 3,
      signal: null,
      seqStart: 100,
      seqEnd: 300,
      cols: 80,
      rows: 24,
    };
    for (const message of [
      { type: 'hello.ok', protocol: 1, hostVersion: '0.0.0', sessions: [info] },
      { type: 'attached', session: info },
      { type: 'replay.gap', id: 's', lostBytes: 100 },
      { type: 'output', id: 's', seq: 100, data: 'aGk=' },
      { type: 'replay.done', id: 's', seq: 300 },
      { type: 'exit', id: 's', code: 3, signal: null },
      { type: 'result', reqId: 'r', ok: true, error: null, pid: 10 },
    ]) {
      expect(HostToDaemon.parse(message)).toEqual(message);
    }
    expect(HostToDaemon.safeParse({ type: 'replay.gap', id: 's', lostBytes: 0 }).success).toBe(
      false,
    );
  });
});
