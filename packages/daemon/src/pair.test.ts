import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { credentialsPath, readCredentials, writeCredentials } from './credentials';
import { pairMachine, parsePairArgs } from './pair';
import { FAKE_CAPABILITIES } from './test-support/harness';

const TOKEN = 'very-secret-token';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'abp-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function server(handler: RequestListener): Promise<string> {
  const s = createServer(handler);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => s.close(() => resolve())));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const pair = (hub: string, dir = dataDir()) =>
  pairMachine({ hub, code: 'c', dataDir: dir, capabilities: FAKE_CAPABILITIES, retryDelayMs: 1 });

describe('pairMachine', () => {
  it('成功時檔案 0600（覆蓋舊的寬鬆權限檔也一樣），回傳值不含 token', async () => {
    const hub = await server((_req, res) => {
      res.end(JSON.stringify({ machineId: 'm1', token: TOKEN }));
    });
    const dir = dataDir();
    writeFileSync(credentialsPath(dir), 'old', { mode: 0o644 });
    const result = await pair(`${hub}/some/path`, dir);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(statSync(credentialsPath(dir)).mode & 0o777).toBe(0o600);
    expect(readCredentials(dir)?.hubUrl).toBe(hub); // 只存 origin
  });

  it.each([
    [401, '產生新的配對碼'],
    [404, '產生新的配對碼'],
    [500, 'hub 內部錯誤'],
  ])('HTTP %i：說明原因與做法，不留憑證', async (status, needle) => {
    const hub = await server((_req, res) => {
      res.statusCode = status;
      res.end('not json');
    });
    const dir = dataDir();
    await expect(pair(hub, dir)).rejects.toThrow(needle);
    expect(readCredentials(dir)).toBeNull();
  });

  it('429：帶 Retry-After 的秒數，不重試（配對碼不能重送）', async () => {
    let calls = 0;
    const hub = await server((_req, res) => {
      calls += 1;
      res.statusCode = 429;
      res.setHeader('retry-after', '42');
      res.end(JSON.stringify({ code: 'rate', message: '太快了' }));
    });
    await expect(pair(hub)).rejects.toThrow(/太快了.*等 42 秒/);
    expect(calls).toBe(1);
  });

  it('連不上：重試後說明怎麼辦；配對成功的回應格式不對也不會存檔', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    await expect(pair(`http://127.0.0.1:${port}`)).rejects.toThrow(
      /連不到 hub.*ECONNREFUSED.*確認/,
    );

    const hub = await server((_req, res) => {
      res.end(JSON.stringify({ machineId: 'm1' }));
    });
    const dir = dataDir();
    await expect(pair(hub, dir)).rejects.toThrow('回應格式不對');
    expect(readCredentials(dir)).toBeNull();
  });

  it('網址不合法直接報錯，不發請求', async () => {
    await expect(pair('not a url')).rejects.toThrow('不是合法網址');
    await expect(pair('ftp://h')).rejects.toThrow('只接受 http 或 https');
  });

  it('憑證寫不進去：說明已配對但要重來', async () => {
    const hub = await server((_req, res) => {
      res.end(JSON.stringify({ machineId: 'm1', token: TOKEN }));
    });
    const dir = dataDir();
    const blocked = join(dir, 'file');
    writeFileSync(blocked, '');
    await expect(pair(hub, join(blocked, 'sub'))).rejects.toThrow(/憑證寫不進.*配對碼/);
  });
});

describe('parsePairArgs', () => {
  it('解析與報錯', () => {
    expect(parsePairArgs(['--hub', 'http://h', '--code', 'c'])).toEqual({
      hub: 'http://h',
      code: 'c',
    });
    expect(() => parsePairArgs(['--code', 'c'])).toThrow('缺少');
    expect(() => parsePairArgs(['--nope'])).toThrow('用法');
  });
});

describe('loadConfig 讀配對檔', () => {
  const saved = { machineId: 'm', token: TOKEN, hubUrl: 'https://hub.example' };

  it('沒有環境變數就用配對檔；環境變數 token 優先', () => {
    const dir = dataDir();
    writeCredentials(dir, saved);
    expect(loadConfig({ AGENT_BOARD_DATA_DIR: dir })).toMatchObject({
      token: TOKEN,
      hubUrl: 'wss://hub.example/ws/daemon',
    });
    expect(
      loadConfig({
        AGENT_BOARD_DATA_DIR: dir,
        AGENT_BOARD_MACHINE_TOKEN: 'env',
        AGENT_BOARD_HUB_URL: 'http://other',
      }),
    ).toMatchObject({ token: 'env', hubUrl: 'ws://other/ws/daemon' });
  });

  it('環境變數指向別的 hub 但只有保存的 token：拒絕，不把 token 送過去', () => {
    const dir = dataDir();
    writeCredentials(dir, saved);
    expect(() =>
      loadConfig({ AGENT_BOARD_DATA_DIR: dir, AGENT_BOARD_HUB_URL: 'https://evil.example' }),
    ).toThrow('不會把保存的 token 送過去');
    expect(
      loadConfig({ AGENT_BOARD_DATA_DIR: dir, AGENT_BOARD_HUB_URL: 'https://hub.example/' }).token,
    ).toBe(TOKEN);
  });

  it('配對檔損壞：報錯說明怎麼辦，訊息不含檔案內容', () => {
    const dir = dataDir();
    writeFileSync(credentialsPath(dir), `{"token":"${TOKEN}"`);
    let message = '';
    try {
      loadConfig({ AGENT_BOARD_DATA_DIR: dir });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('重新執行 agent-board-daemon pair');
    expect(message).not.toContain(TOKEN);
  });
});
