import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS, HOOK_TIMEOUT_SECONDS } from '@agent-board/protocol';
import { HookSettingsError, installHooks } from './index';

interface Handler {
  type: string;
  command: string;
  timeout: number;
}
interface Settings {
  hooks: Record<string, { matcher?: string; hooks: Handler[] }[]>;
  [key: string]: unknown;
}

describe('installHooks', () => {
  let cwd: string;
  let path: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'ab-settings-'));
    path = join(cwd, '.claude', 'settings.local.json');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function seed(content: string): Promise<void> {
    await mkdir(join(cwd, '.claude'), { recursive: true });
    await writeFile(path, content);
  }

  async function read(): Promise<Settings> {
    return JSON.parse(await readFile(path, 'utf8')) as Settings;
  }

  function commands(settings: Settings, event: string): string[] {
    return (settings.hooks[event] ?? []).flatMap((group) => group.hooks.map((h) => h.command));
  }

  it('沒有設定檔時建立資料夾與檔案，每個事件都裝好', async () => {
    await installHooks(cwd);
    const settings = await read();
    // 只裝 Claude Code 認得的事件：多一個不認得的名稱，Claude 啟動就卡在設定錯誤對話框。
    expect(Object.keys(settings.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        {
          hooks: [
            {
              type: 'command',
              command: `agent-board-hook ${event}`,
              timeout: event === 'SessionEnd' ? 60 : HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ]);
    }
  });

  it('拿掉先前誤裝在 Claude 不認得事件上的 agent-board-hook，別人的 hook 原樣保留', async () => {
    await mkdir(join(cwd, '.claude'), { recursive: true });
    const theirs = { type: 'command', command: 'my-tool interrupt' };
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          Interrupt: [
            {
              hooks: [
                { type: 'command', command: 'agent-board-hook Interrupt', timeout: 600 },
                theirs,
              ],
            },
          ],
          PostModelRequest: [
            {
              hooks: [
                { type: 'command', command: 'agent-board-hook PostModelRequest', timeout: 600 },
              ],
            },
          ],
        },
      }),
    );
    await installHooks(cwd);
    const settings = await read();
    expect(settings.hooks.PostModelRequest).toBeUndefined();
    expect(settings.hooks.Interrupt).toEqual([{ hooks: [theirs] }]);
    expect(commands(settings, 'SessionStart')).toEqual(['agent-board-hook SessionStart']);
  });

  it('SessionEnd 的 timeout 不超過 60', async () => {
    await installHooks(cwd);
    expect((await read()).hooks.SessionEnd?.[0]?.hooks[0]?.timeout).toBe(60);
  });

  it('保留使用者原有的設定與 hook', async () => {
    const userStop = {
      matcher: 'x',
      hooks: [{ type: 'command', command: 'my-own-stop.sh', timeout: 5 }],
    };
    const original = {
      permissions: { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'] },
      model: 'opus',
      env: { FOO: 'bar' },
      hooks: {
        Stop: [userStop],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'lint.sh' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'sub.sh' }] }],
      },
    };
    await seed(JSON.stringify(original));
    await installHooks(cwd);
    const settings = await read();

    expect(settings.permissions).toEqual(original.permissions);
    expect(settings.model).toBe('opus');
    expect(settings.env).toEqual(original.env);
    expect(settings.hooks.SubagentStop).toEqual(original.hooks.SubagentStop);
    expect(commands(settings, 'PostToolUse')).toEqual(['lint.sh', 'agent-board-hook PostToolUse']);
    expect(settings.hooks.Stop?.[0]).toEqual(userStop);
    expect(commands(settings, 'Stop')).toEqual(['my-own-stop.sh', 'agent-board-hook Stop']);
  });

  it('保留看不懂的 hook 項目', async () => {
    await seed(JSON.stringify({ hooks: { Stop: ['weird', { nothooks: 1 }, { hooks: 'x' }] } }));
    await installHooks(cwd);
    const stop = (await read()).hooks.Stop as unknown[];
    expect(stop.slice(0, 3)).toEqual(['weird', { nothooks: 1 }, { hooks: 'x' }]);
    expect(stop).toHaveLength(4);
  });

  it('冪等：跑兩次內容一樣，第二次不重寫檔案', async () => {
    await seed(JSON.stringify({ permissions: { allow: [] }, hooks: { Stop: [] } }));
    await installHooks(cwd);
    const first = await readFile(path, 'utf8');
    const firstStat = await stat(path);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await installHooks(cwd);
    expect(await readFile(path, 'utf8')).toBe(first);
    expect((await stat(path)).ino).toBe(firstStat.ino);
    expect(commands(await read(), 'Stop')).toEqual(['agent-board-hook Stop']);
  });

  it.each(['PostToolUse', 'PostToolUseFailure'])('%s 有安裝，重複安裝不會多一筆', async (event) => {
    await installHooks(cwd);
    await installHooks(cwd);
    expect((await read()).hooks[event]).toEqual([
      {
        hooks: [
          { type: 'command', command: `agent-board-hook ${event}`, timeout: HOOK_TIMEOUT_SECONDS },
        ],
      },
    ]);
  });

  it('舊版設定（沒有新事件）升級時補上新事件，原有的不重複', async () => {
    await installHooks(cwd);
    const settings = await read();
    delete settings.hooks.PostToolUse;
    delete settings.hooks.PostToolUseFailure;
    await writeFile(path, JSON.stringify(settings));
    await installHooks(cwd);
    const upgraded = await read();
    expect(commands(upgraded, 'PostToolUse')).toEqual(['agent-board-hook PostToolUse']);
    expect(commands(upgraded, 'PostToolUseFailure')).toEqual([
      'agent-board-hook PostToolUseFailure',
    ]);
    expect(commands(upgraded, 'Stop')).toEqual(['agent-board-hook Stop']);
  });

  it('自己的 hook 和別的 hook 放在同一群組也認得出來，timeout 舊了會更新', async () => {
    await seed(
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'mine.sh' },
                { type: 'command', command: 'agent-board-hook Stop', timeout: 1 },
              ],
            },
          ],
        },
      }),
    );
    await installHooks(cwd);
    const stop = (await read()).hooks.Stop;
    expect(stop).toHaveLength(1);
    expect(stop?.[0]?.hooks[0]).toEqual({ type: 'command', command: 'mine.sh' });
    expect(stop?.[0]?.hooks[1]?.timeout).toBe(HOOK_TIMEOUT_SECONDS);
  });

  it('command 相似但不相同的使用者 hook 不算我們的', async () => {
    await seed(
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop --x' }] }] },
      }),
    );
    await installHooks(cwd);
    expect(commands(await read(), 'Stop')).toEqual([
      'agent-board-hook Stop --x',
      'agent-board-hook Stop',
    ]);
  });

  it.each([
    ['壞掉的 JSON', '{ "permissions": ', /invalid JSON/],
    ['空檔案', '', /invalid JSON/],
    ['頂層是陣列', '[1,2]', /top level/],
    ['頂層是 null', 'null', /top level/],
    ['hooks 不是物件', '{"hooks":[]}', /"hooks"/],
    ['事件不是陣列', '{"hooks":{"Stop":{}}}', /hooks\.Stop/],
  ])('%s：不動原檔並丟明確錯誤', async (_name, content, message) => {
    await seed(content);
    const error = await installHooks(cwd).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HookSettingsError);
    expect((error as HookSettingsError).message).toMatch(message);
    expect((error as HookSettingsError).path).toContain('settings.local.json');
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(await readdir(join(cwd, '.claude'))).toEqual(['settings.local.json']);
  });

  it('不留暫存檔', async () => {
    await installHooks(cwd);
    expect(await readdir(join(cwd, '.claude'))).toEqual(['settings.local.json']);
  });

  it('寫入失敗時原檔不變，暫存檔清掉，錯誤往外丟', async () => {
    await seed('{"model":"opus"}');
    await chmod(join(cwd, '.claude'), 0o500);
    try {
      await expect(installHooks(cwd)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('{"model":"opus"}');
    } finally {
      await chmod(join(cwd, '.claude'), 0o700);
    }
    expect(await readdir(join(cwd, '.claude'))).toEqual(['settings.local.json']);
  });

  it('保留原檔權限', async () => {
    await seed('{}');
    await chmod(path, 0o600);
    await installHooks(cwd);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('設定檔是 symlink 時寫到目標，連結不被換掉', async () => {
    const target = join(cwd, 'real-settings.json');
    await writeFile(target, '{"model":"opus"}');
    await mkdir(join(cwd, '.claude'));
    await symlink(target, path);
    await installHooks(cwd);
    const written = JSON.parse(await readFile(target, 'utf8')) as Settings;
    expect(written.model).toBe('opus');
    expect(commands(written, 'Stop')).toEqual(['agent-board-hook Stop']);
    expect(await readFile(path, 'utf8')).toBe(await readFile(target, 'utf8'));
    expect(await readdir(join(cwd, '.claude'))).toEqual(['settings.local.json']);
  });

  it('同時安裝的結果仍然完整且冪等', async () => {
    await seed('{"model":"opus"}');
    await Promise.all([installHooks(cwd), installHooks(cwd), installHooks(cwd)]);
    const settings = await read();
    expect(settings.model).toBe('opus');
    expect(commands(settings, 'Stop')).toEqual(['agent-board-hook Stop']);
  });
});
