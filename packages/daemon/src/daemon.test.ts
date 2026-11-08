import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { DaemonToHub } from '@agent-board/protocol';
import type { Daemon } from './daemon';
import { hookSettingsLockKey, withFileLock } from './fileLock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dumpScreen,
  flushTerm,
  Harness,
  HookClient,
  Terminal,
  waitUntil,
  writeFakeHook,
} from './test-support/harness';

const require = createRequire(import.meta.url);
const { SerializeAddon } =
  require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  await h.cleanup();
  expect(h.hub.invalid).toEqual([]); // daemon 送的每一則都要符合協定
});

type Runtime = Extract<DaemonToHub, { type: 'session.runtime' }>['session'];

const input = (sessionId: string, text: string) =>
  h.hub.send({ type: 'terminal.input', sessionId, data: `${text}\r` });

const persisted = () =>
  JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')) as {
    sessions: {
      sessionId: string;
      claudeSessionId: string;
      pendingFirstPrompt: string | null;
      spec: { readOnly: boolean };
    }[];
  };

const persistedEnded = () =>
  (
    JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8')) as {
      endedRuntimes: Runtime[];
    }
  ).endedRuntimes;

const lastRuntime = (sessionId: string): Runtime | undefined =>
  h.hub.received
    .filter(
      (m): m is Extract<DaemonToHub, { type: 'session.runtime' }> =>
        m.type === 'session.runtime' && m.session.id === sessionId,
    )
    .at(-1)?.session;

const newTerminal = (size: { cols: number; rows: number }) =>
  new Terminal({ cols: size.cols, rows: size.rows, scrollback: 5000, allowProposedApi: true });

/** 第一個快照 + 之後每個 seq 的 output 各一次，重建出應有的畫面。 */
async function replayFromStart(sessionId: string, size: { cols: number; rows: number }) {
  const first = h.hub.received.find(
    (m): m is Extract<DaemonToHub, { type: 'terminal.snapshot' }> =>
      m.type === 'terminal.snapshot' && m.sessionId === sessionId,
  );
  if (!first) throw new Error('沒有快照');
  const term = newTerminal(size);
  term.write(first.data);
  const seen = new Set<number>();
  for (const m of h.hub.received) {
    if (m.type === 'terminal.output' && m.sessionId === sessionId && m.seq > first.seq) {
      if (!seen.has(m.seq)) term.write(m.data);
      seen.add(m.seq);
    }
  }
  await flushTerm(term);
  return term;
}

/** 假的對話紀錄：真的 claude 說過話才會有，daemon 重啟時 --resume 才接得回來。 */
function writeTranscript(claudeId: string, configDir = h.claudeDir): void {
  const project = join(configDir, 'projects', 'p');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${claudeId}.jsonl`), '{}\n');
}

describe('session 建立', () => {
  beforeEach(() => h.start().then(() => undefined));

  it('hello 先到；開假 claude，參數、env、cwd 符合合約，token 不外洩給子程序', async () => {
    expect(h.hub.received[0]?.type).toBe('daemon.hello');
    await h.createAndSubscribe('s1');
    const [run] = h.runs();
    expect(run?.cwd).toBe(h.workDir);
    expect(run?.argv.slice(0, 1)).toEqual(['--session-id']);
    expect(run?.argv[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(run?.argv.slice(2)).toEqual(['--permission-mode', 'manual', '--name', 'test session']);
    expect(run?.argv).toContain('--permission-mode');
    expect(run?.argv[run.argv.indexOf('--permission-mode') + 1]).toBe('manual');
    expect(run?.env).toMatchObject({
      AGENT_BOARD_SESSION_ID: 's1',
      AGENT_BOARD_MACHINE_TOKEN: null,
      CLAUDE_CONFIG_DIR: null,
      TERM: 'xterm-256color',
    });
    expect(run?.env.AGENT_BOARD_SOCKET).toBeTruthy();

    const created = await h.hub.waitFor('session.created', (m) => m.requestId === 'req-s1');
    expect(created.session).toMatchObject({
      id: 's1',
      cwd: h.workDir,
      status: 'starting',
      claudeSessionId: run?.argv[1],
      endedAt: null,
    });
    expect(h.installHookCalls).toEqual([h.workDir]);
  });

  it('從 Claude Code 裡啟動 daemon 時，不把 session 標記與憑證傳給 claude，使用者的設定照傳', async () => {
    h.extraEnv.CLAUDE_CODE_CHILD_SESSION = '1';
    h.extraEnv.CLAUDE_CODE_MESSAGING_TOKEN = 'secret-token';
    h.extraEnv.CLAUDE_CODE_USE_BEDROCK = '1';
    await h.restartDaemon();
    await h.createAndSubscribe('s9');
    expect(h.runs().at(-1)?.env).toMatchObject({
      CLAUDE_CODE_CHILD_SESSION: null,
      CLAUDE_CODE_MESSAGING_TOKEN: null,
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
  });

  it('permissionMode、model、name、accountProfile、resumeClaudeSessionId 都會傳進去', async () => {
    const profile = join(h.root, 'profile-2');
    await h.createAndSubscribe('s2', {
      name: '第二個',
      permissionMode: 'plan',
      model: 'opus',
      accountProfile: profile,
      resumeClaudeSessionId: '0a1b2c3d-0000-4000-8000-00000000c0de',
    });
    const [run] = h.runs();
    expect(run?.argv).toEqual([
      '--resume',
      '0a1b2c3d-0000-4000-8000-00000000c0de',
      '--permission-mode',
      'plan',
      '--model',
      'opus',
      '--name',
      '第二個',
    ]);
    expect(run?.env.CLAUDE_CONFIG_DIR).toBe(profile);
    const created = await h.hub.waitFor('session.created', (m) => m.requestId === 'req-s2');
    expect(created.session.claudeSessionId).toBe('0a1b2c3d-0000-4000-8000-00000000c0de');
  });

  it('重送同一個 session.create 不會開第二個 PTY', async () => {
    const spec = h.spec();
    h.hub.send({ type: 'session.create', requestId: 'a', sessionId: 'dup', spec });
    h.hub.send({ type: 'session.create', requestId: 'b', sessionId: 'dup', spec });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'a');
    await h.hub.waitFor('session.created', (m) => m.requestId === 'b');
    await waitUntil(() => h.runs().length >= 1, '假 claude 啟動');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.runs()).toHaveLength(1);
  });

  it('cwd 不存在或 claude 不存在：createFailed，且不留在本機清單', async () => {
    h.hub.send({
      type: 'session.create',
      requestId: 'bad-cwd',
      sessionId: 'x1',
      spec: h.spec({ cwd: join(h.root, 'nope') }),
    });
    const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'bad-cwd');
    expect(failed.error).toContain('工作資料夾不存在');

    await h.restartDaemon({
      config: {
        hubUrl: h.hub.url,
        token: 't',
        dataDir: h.dataDir,
        claudeBin: join(h.root, 'no-such-claude'),
        hookBin: h.hookBin,
        machineName: 'm',
        claudeConfigDir: h.claudeDir,
      },
    });
    h.hub.send({ type: 'session.create', requestId: 'bad-bin', sessionId: 'x2', spec: h.spec() });
    const noBin = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'bad-bin');
    expect(noBin.error).toContain('找不到可執行');
    expect(h.runs()).toEqual([]);
  });

  it('hook 設定壞掉：createFailed、不開 PTY、訊息說明怎麼修；剛建的 worktree 收掉', async () => {
    h.installHooks = async () => {
      throw new Error('settings.local.json 不是合法 JSON');
    };
    for (const permissionMode of ['default', 'bypassPermissions', 'dontAsk'] as const) {
      const requestId = `broken-${permissionMode}`;
      h.hub.send({
        type: 'session.create',
        requestId,
        sessionId: requestId,
        spec: h.spec({ permissionMode }),
      });
      const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === requestId);
      expect(failed.error).toContain('settings.local.json');
      expect(failed.error).toContain('請修好');
    }
    expect(h.runs()).toEqual([]);
    expect(h.trackers.created).toEqual([]);

    const repo = join(h.root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'f.txt'), 'x');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        stdio: 'ignore',
      });
    git('init', '-b', 'main');
    git('add', '.');
    git('commit', '-m', 'init');
    h.hub.send({
      type: 'session.create',
      requestId: 'broken-wt',
      sessionId: 'broken-wt',
      spec: h.spec({ cwd: repo, useWorktree: true, name: 'x' }),
    });
    await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'broken-wt');
    expect(existsSync(join(h.root, '.agent-board-wt', 'x-brokenwt'))).toBe(false);
  });

  it('useWorktree：真的 git repo 建 worktree，claude 開在裡面；非 repo 回 createFailed', async () => {
    const repo = join(h.root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'f.txt'), 'x');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        stdio: 'ignore',
      });
    git('init', '-b', 'main');
    git('add', '.');
    git('commit', '-m', 'init');

    await h.createAndSubscribe('wt1', { cwd: repo, useWorktree: true, name: 'My Feature' });
    const created = await h.hub.waitFor('session.created', (m) => m.requestId === 'req-wt1');
    const expected = join(h.root, '.agent-board-wt', 'my-feature-wt1');
    expect(created.session).toMatchObject({
      cwd: expected,
      worktreePath: expected,
      branch: 'ab/my-feature-wt1',
    });
    expect(h.runs()[0]?.cwd).toBe(expected);
    expect(h.installHookCalls).toEqual([expected]);
    // 開在 linked worktree：根目錄是 worktree 自己，commonDir 是原 repo 的（同 repo 判斷用）。
    expect(created.session.repoRoot).toBe(realpathSync(expected));
    expect(created.session.repoCommonDir).toBe(join(realpathSync(repo), '.git'));

    h.hub.send({
      type: 'session.create',
      requestId: 'wt-fail',
      sessionId: 'wt2',
      spec: h.spec({ useWorktree: true }),
    });
    await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'wt-fail');
  });
});

describe('終端機串流', () => {
  beforeEach(() => h.start().then(() => undefined));

  it('快照後 output 的 seq 連續遞增，輸入有送進 PTY', async () => {
    await h.createAndSubscribe('s1');
    input('s1', 'hello');
    await h.waitForOutput('s1', 'INPUT:hello');
    const messages = h.hub.received.filter(
      (m) => m.type === 'terminal.snapshot' || m.type === 'terminal.output',
    );
    expect(messages[0]?.type).toBe('terminal.snapshot');
    const seqs = messages.map((m) => (m as { seq: number }).seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe((seqs[i - 1] as number) + 1);
  });

  it('大量輸出途中重新訂閱：快照 + 之後的 output 與從頭重播逐格相同', async () => {
    await h.createAndSubscribe('s1');
    input('s1', 'flood 3000');
    await waitUntil(() => h.outputText('s1').includes('flood line 200'), '輸出開始');
    const before = h.hub.received.length;
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    await waitUntil(
      () => h.hub.received.slice(before).some((m) => m.type === 'terminal.snapshot'),
      '新快照',
    );
    await h.waitForOutput('s1', 'FLOOD DONE');

    const after = h.hub.received.slice(before);
    const snap = after.find((m) => m.type === 'terminal.snapshot');
    if (snap?.type !== 'terminal.snapshot') throw new Error('沒有收到快照');
    const following = after
      .slice(after.indexOf(snap) + 1)
      .filter(
        (m): m is Extract<DaemonToHub, { type: 'terminal.output' }> => m.type === 'terminal.output',
      );
    // 快照之後收到的 output 必須從 seq+1 開始、無跳號。
    expect(following.length).toBeGreaterThan(0);
    following.forEach((m, i) => expect(m.seq).toBe(snap.seq + 1 + i));

    const restored = newTerminal(snap);
    restored.write(snap.data);
    for (const m of following) restored.write(m.data);
    await flushTerm(restored);

    // 獨立基準：第一個快照 + 所有 output 依 seq 從頭重播。
    const reference = await replayFromStart('s1', snap);
    expect(dumpScreen(restored)).toEqual(dumpScreen(reference));
    restored.dispose();
    reference.dispose();
  });

  it('輸出恰好落在訂閱與快照之間：先送快照，該輸出接在後面且不跳號', async () => {
    await h.createAndSubscribe('s1');
    const session = h.daemons[0]?.['sessions'].get('s1');
    if (!session) throw new Error('沒有 session');
    const before = h.hub.received.length;
    // subscribe 的快照要等 xterm 下一輪才產生；同一輪注入輸出，確定落在窗口內。
    session.subscribe();
    session['handleData']('in-the-gap\r\n');
    await waitUntil(
      () => h.hub.received.slice(before).some((m) => m.type === 'terminal.output'),
      '窗口內的輸出',
    );
    const messages = h.hub.received
      .slice(before)
      .filter((m) => m.type === 'terminal.snapshot' || m.type === 'terminal.output');
    const [snap, output] = messages;
    if (snap?.type !== 'terminal.snapshot') throw new Error(`第一則不是快照：${snap?.type}`);
    if (output?.type !== 'terminal.output') throw new Error('第二則不是 output');
    expect(output.seq).toBe(snap.seq + 1);
    expect(output.data).toBe('in-the-gap\r\n');
    expect(snap.data).not.toContain('in-the-gap');
  });

  it('hub 斷線重連：session 不中斷，斷線期間的輸出在新快照裡，畫面逐格相同', async () => {
    await h.createAndSubscribe('s1');
    input('s1', 'paint');
    await h.waitForOutput('s1', 'positioned');
    // 斷線前的基準，之後補上斷線期間的輸出。
    const reference = await replayFromStart('s1', { cols: 120, rows: 32 });

    h.hub.dropConnection();
    await waitUntil(() => h.hellos().length === 2, '重連');
    await waitUntil(() => h.daemons[0]?.['hub'].connected, '連上');
    const hello = h.hellos()[1];
    expect(hello?.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(hello?.sessions[0]?.endedAt).toBeNull();
    expect(h.runs()).toHaveLength(1); // 沒有重開 claude

    // 重連前的訂閱已失效：沒重新訂閱不該收到輸出，但 PTY 與 headless 繼續跑。
    const countBefore = h.hub.received.length;
    input('s1', 'while-unsubscribed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.hub.received.slice(countBefore).some((m) => m.type === 'terminal.output')).toBe(false);

    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const snap = await h.hub.waitFor(
      'terminal.snapshot',
      (m) => m.data.includes('while-unsubscribed'),
      { includePast: false },
    );
    expect(snap.seq).toBeGreaterThan(0);

    const restored = newTerminal(snap);
    const serializer = new SerializeAddon();
    restored.loadAddon(serializer);
    restored.write(snap.data);
    await flushTerm(restored);

    reference.write('INPUT:while-unsubscribed\r\n');
    await flushTerm(reference);
    expect(dumpScreen(restored)).toEqual(dumpScreen(reference));

    // 確認比對的不只是純文字：顏色、粗體與游標都還原了。
    const screen = restored.buffer.active;
    const red = screen.getLine(0)?.getCell(0);
    expect(red?.getChars()).toBe('r');
    expect(red?.isFgPalette()).toBeTruthy();
    expect(red?.getFgColor()).toBe(1);
    expect(screen.getLine(1)?.getCell(0)?.isBold()).toBeTruthy();
    expect(screen.getLine(2)?.translateToString(true)).toBe('-rewritten-e');
    expect(screen.getLine(4)?.translateToString(true)).toBe('         positioned');

    // 對還原結果再序列化，應與 daemon 新產生的快照完全相同。
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const again = await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    expect(serializer.serialize({ scrollback: 5000 })).toBe(again.data);
    restored.dispose();
    reference.dispose();
  });

  it('unsubscribe 後不再送輸出，headless 仍持續更新', async () => {
    await h.createAndSubscribe('s1');
    h.hub.send({ type: 'terminal.unsubscribe', sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const count = h.hub.received.filter((m) => m.type === 'terminal.output').length;
    input('s1', 'silent');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.hub.received.filter((m) => m.type === 'terminal.output').length).toBe(count);
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const snap = await h.hub.waitFor('terminal.snapshot', (m) => m.data.includes('INPUT:silent'), {
      includePast: false,
    });
    expect(snap.data).toContain('INPUT:silent');
  });

  it('resize 同步到 PTY 與快照尺寸，超大尺寸會被限制', async () => {
    await h.createAndSubscribe('s1');
    h.hub.send({ type: 'terminal.resize', sessionId: 's1', cols: 90, rows: 30 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    input('s1', 'size');
    await h.waitForOutput('s1', 'SIZE 90x30');
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const snap = await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    expect([snap.cols, snap.rows]).toEqual([90, 30]);

    h.hub.send({ type: 'terminal.resize', sessionId: 's1', cols: 99999, rows: 99999 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    input('s1', 'size');
    await h.waitForOutput('s1', 'SIZE 500x200');
  });

  it('沒人看之後回到預設尺寸；有人在寬限內回來就不動', async () => {
    await h.cleanup();
    h = new Harness();
    await h.hub.start();
    mkdirSync(h.workDir, { recursive: true });
    await h.startDaemon({ idleResizeMs: 150 });
    await h.createAndSubscribe('s1');
    h.hub.send({ type: 'terminal.resize', sessionId: 's1', cols: 300, rows: 90 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 退訂後在寬限內重新訂閱：尺寸不變
    h.hub.send({ type: 'terminal.unsubscribe', sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    input('s1', 'size');
    await h.waitForOutput('s1', 'SIZE 300x90');

    // 真的沒人看：時間到回到 120x32
    h.hub.send({ type: 'terminal.unsubscribe', sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const snap = await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    expect([snap.cols, snap.rows]).toEqual([120, 32]);
    input('s1', 'size');
    await h.waitForOutput('s1', 'SIZE 120x32');
  });

  it('signal：escape、ctrl_c 送控制字元', async () => {
    await h.createAndSubscribe('s1');
    h.hub.send({ type: 'terminal.signal', sessionId: 's1', signal: 'escape' });
    await h.waitForOutput('s1', 'GOT:ESC');
    h.hub.send({ type: 'terminal.signal', sessionId: 's1', signal: 'ctrl_c' });
    await h.waitForOutput('s1', 'GOT:CTRL_C');
  });

  it('lastLines 是去 ANSI 的最後 4 行，lastOutputAt 會更新', async () => {
    await h.createAndSubscribe('s1');
    input('s1', 'paint');
    await h.waitForOutput('s1', 'positioned');
    const runtime = await waitUntil(() => {
      const r = lastRuntime('s1');
      return r?.lastLines.at(-1)?.includes('positioned') ? r : null;
    }, 'lastLines 更新');
    expect(runtime.lastLines).toHaveLength(4);
    expect(runtime.lastLines[0]).toBe('red plain');
    expect(runtime.lastLines[1]).toBe('bold-on-blue');
    expect(runtime.lastLines.join('')).not.toContain('\x1b');
    expect(runtime.lastOutputAt).not.toBeNull();
  });

  it('不認得的 session 只記錄不出事', async () => {
    h.hub.send({ type: 'terminal.subscribe', sessionId: 'ghost' });
    h.hub.send({ type: 'terminal.input', sessionId: 'ghost', data: 'x' });
    h.hub.send({ type: 'session.stop', sessionId: 'ghost' });
    await h.createAndSubscribe('s1');
  });
});

describe('結束', () => {
  beforeEach(() => h.start().then(() => undefined));

  const exitedRuntime = (sessionId: string) =>
    h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === sessionId && m.session.endedAt !== null,
    );

  it('exit 非 0：tracker 收到 exit code，狀態 error，移出本機清單，已結束的畫面還能看', async () => {
    await h.createAndSubscribe('s1');
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['s1']);
    input('s1', 'exit 3');
    const { session } = await exitedRuntime('s1');
    expect(session.status).toBe('error');
    expect(h.trackers.created[0]?.exitCode).toBe(3);
    await waitUntil(() => h.trackers.created[0]?.disposed, 'tracker 釋放');
    expect(persisted().sessions).toEqual([]);
    await h.hub.waitFor(
      'session.event',
      (m) => m.event.type === 'exit' && m.event.payload.exitCode === 3,
    );
    await h.hub.waitFor(
      'session.event',
      (m) => m.event.type === 'status' && m.event.payload.to === 'error',
    );

    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const snap = await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    expect(snap.data).toContain('FAKE READY');
  });

  it('exit 0：tracker 收到 0，移出清單，重連的 hello 不再列它', async () => {
    await h.createAndSubscribe('s1');
    input('s1', 'exit 0');
    await exitedRuntime('s1');
    expect(h.trackers.created[0]?.exitCode).toBe(0);
    h.hub.dropConnection();
    await waitUntil(() => h.hellos().length === 2, '重連');
    expect(h.hellos()[1]?.sessions).toEqual([]);
  });

  it('PTY 剛結束 daemon 就關閉：不會被當成活著的 session 接回', async () => {
    await h.createAndSubscribe('s1');
    const stopping = waitUntil(() => h.trackers.created[0]?.exitCode === 0, 'PTY 結束').then(() =>
      Promise.all(h.daemons.splice(0).map((daemon) => daemon.stop())),
    );
    input('s1', 'exit 0');
    await stopping;
    expect(persisted().sessions).toEqual([]);
    await h.startDaemon();
    expect(h.hellos().at(-1)?.sessions).toEqual([]);
    expect(h.runs()).toHaveLength(1);
  });

  it('session.stop 送 SIGTERM，不算錯誤', async () => {
    await h.createAndSubscribe('s1');
    h.hub.send({ type: 'session.stop', sessionId: 's1' });
    await exitedRuntime('s1');
    expect(h.trackers.created[0]?.exitCode).toBe(0);
  });

  it('terminate：程式忽略 SIGTERM 時時間到改 SIGKILL', async () => {
    h.extraEnv.FAKE_CLAUDE_IGNORE_TERM = '1';
    await h.restartDaemon();
    await h.createAndSubscribe('s1');
    h.hub.send({ type: 'terminal.signal', sessionId: 's1', signal: 'terminate' });
    const { session } = await exitedRuntime('s1');
    expect(session.endedAt).not.toBeNull();
    expect(h.trackers.created.at(-1)?.exitCode).toBe(0);
  });

  it('順序：先 tracker.onExit 再 dispose；exit 0→done、非 0→error，都有 endedAt', async () => {
    await h.createAndSubscribe('zero');
    await h.createAndSubscribe('fail');
    input('zero', 'exit 0');
    input('fail', 'exit 4');
    const [zero, fail] = h.trackers.created;
    await waitUntil(() => zero?.disposed && fail?.disposed, 'tracker 釋放');
    // stub 和 B 一樣，dispose 之後的 onExit 會被忽略；順序錯了 exitCode 會是 null。
    expect(zero?.exitCode).toBe(0);
    expect(fail?.exitCode).toBe(4);
    const runtimeOf = (id: string) => lastRuntime(id);
    await waitUntil(() => runtimeOf('zero')?.status === 'done', 'done');
    await waitUntil(() => runtimeOf('fail')?.status === 'error', 'error');
    expect(runtimeOf('zero')?.endedAt).not.toBeNull();
    expect(runtimeOf('fail')?.endedAt).not.toBeNull();
  });

  it('連線正常時結束：結果送出後不留在待補送清單', async () => {
    await h.createAndSubscribe('s1');
    input('s1', 'exit 0');
    await exitedRuntime('s1');
    await waitUntil(() => h.trackers.created[0]?.disposed, 'tracker 釋放');
    await waitUntil(() => persistedEnded().length === 0, '清單清空');
  });

  it('斷線期間 exit 0：重連後先 hello，welcome 後才補送 done 與 endedAt；送完才移除', async () => {
    await h.createAndSubscribe('s1');
    h.hub.autoWelcome = false;
    h.hub.dropConnection();
    await waitUntil(() => !h.daemons[0]?.['hub'].connected, '斷線');
    h.daemons[0]?.['sessions'].get('s1')?.write('exit 0\r');
    await waitUntil(() => h.trackers.created[0]?.disposed, 'PTY 結束');
    expect(persistedEnded().map((r) => [r.id, r.status])).toEqual([['s1', 'done']]);

    const before = h.hub.received.length;
    await waitUntil(() => h.hellos().length === 2, '重連', 15_000);
    expect(h.hellos()[1]?.sessions).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 還沒 welcome：不可送，也不可移除。
    expect(
      h.hub.received.slice(before).some((m) => m.type === 'session.runtime' && m.session.endedAt),
    ).toBe(false);
    expect(persistedEnded()).toHaveLength(1);

    h.hub.send({ type: 'hub.welcome', machineId: 'm', dangerRules: [], stuckMinutes: 5 });
    const { session } = await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 's1' && m.session.endedAt !== null,
      { includePast: false },
    );
    expect(session.status).toBe('done');
    const after = h.hub.received.slice(before);
    expect(after[0]?.type).toBe('daemon.hello');
    await waitUntil(() => persistedEnded().length === 0, '送完才移除');
    await h.hub.waitFor('session.event', (m) => m.event.type === 'exit');
  });

  it('補送的 error：statusDetail 寫真實 exit code、帶 endedAt（重啟後也一樣）', async () => {
    await h.createAndSubscribe('s1');
    h.hub.autoWelcome = false;
    h.hub.dropConnection();
    await waitUntil(() => !h.daemons[0]?.['hub'].connected, '斷線');
    h.daemons[0]?.['sessions'].get('s1')?.write('exit 7\r');
    await waitUntil(() => h.trackers.created[0]?.disposed, 'PTY 結束');
    // stub 的 detail 是 null，這裡驗的是 daemon 自己補上的原因。
    const [saved] = persistedEnded();
    expect(saved?.status).toBe('error');
    expect(saved?.statusDetail).toContain('7');
    expect(saved?.endedAt).not.toBeNull();

    await h.restartDaemon();
    h.hub.autoWelcome = true;
    h.hub.dropConnection();
    const { session } = await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 's1' && m.session.endedAt !== null,
      { includePast: false, timeoutMs: 15_000 },
    );
    expect(session.status).toBe('error');
    expect(session.statusDetail).toContain('7');
    expect(session.statusDetail).not.toContain('不明');
    expect(session.endedAt).not.toBeNull();
  });

  it('被訊號殺掉：statusDetail 寫得出原因；exit 0 的 done 不硬塞原因', async () => {
    await h.createAndSubscribe('killed');
    await h.createAndSubscribe('clean');
    const pid = h.daemons[0]?.['sessions'].get('killed')?.['pty'].pid as number;
    process.kill(pid, 'SIGKILL');
    input('clean', 'exit 0');
    await waitUntil(() => lastRuntime('killed')?.status === 'error', 'killed→error');
    expect(lastRuntime('killed')?.statusDetail).toContain('137');
    await waitUntil(() => lastRuntime('clean')?.status === 'done', 'clean→done');
    expect(lastRuntime('clean')?.statusDetail).toBeNull();
  });

  it('斷線中結束、daemon 又重啟：紀錄不會丟，不會被接回，welcome 後補送一次', async () => {
    await h.createAndSubscribe('s1');
    h.hub.autoWelcome = false;
    h.hub.dropConnection();
    await waitUntil(() => !h.daemons[0]?.['hub'].connected, '斷線');
    h.daemons[0]?.['sessions'].get('s1')?.write('exit 6\r');
    await waitUntil(() => h.trackers.created[0]?.exitCode === 6, 'PTY 結束');

    // 這時立刻重啟，最後一次畫面更新也可能還沒跑完。
    await h.restartDaemon();
    expect(h.runs()).toHaveLength(1);
    const before = h.hub.received.length;
    await waitUntil(() => h.hellos().at(-1)?.sessions.length === 0, '新 daemon hello');
    h.hub.autoWelcome = true;
    expect(persistedEnded().map((r) => r.status)).toEqual(['error']);
    h.hub.dropConnection();
    const { session } = await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 's1' && m.session.endedAt !== null,
      { includePast: false, timeoutMs: 15_000 },
    );
    expect(session.status).toBe('error');
    await waitUntil(() => persistedEnded().length === 0, '送完才移除');
    expect(h.hub.received.slice(before).filter((m) => m.type === 'session.created')).toEqual([]);

    // 再重啟一次，不會重複補送，也不會接回。
    await h.restartDaemon();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.hellos().at(-1)?.sessions).toEqual([]);
    expect(h.runs()).toHaveLength(1);
  });

  it('待補送的舊結果在接續同一個 session 後不會蓋掉新狀態', async () => {
    await h.createAndSubscribe('s1');
    h.hub.autoWelcome = false;
    h.hub.dropConnection();
    await waitUntil(() => !h.daemons[0]?.['hub'].connected, '斷線');
    h.daemons[0]?.['sessions'].get('s1')?.write('exit 0\r');
    await waitUntil(() => persistedEnded().length === 1, '結果記下');
    await h.hub.waitFor('daemon.hello', () => true, { includePast: false, timeoutMs: 15_000 });
    const session = h.daemons[0];
    await session?.['createSession'](
      'r2',
      's1',
      h.spec({ resumeClaudeSessionId: '0a1b2c3d-0000-4000-8000-0000000000aa' }),
    );
    expect(persistedEnded()).toEqual([]);
    h.hub.send({ type: 'hub.welcome', machineId: 'm', dangerRules: [], stuckMinutes: 5 });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'r2');
    expect(
      h.hub.received.filter(
        (m, i) =>
          i > 0 && m.type === 'session.runtime' && m.session.id === 's1' && !!m.session.endedAt,
      ),
    ).toEqual([]);
  });
});

describe('daemon 重啟', () => {
  beforeEach(() => h.start().then(() => undefined));

  it('用 --resume 接回，先標 starting；hello 帶回 session；輸入輸出照常', async () => {
    await h.createAndSubscribe('s1', {
      permissionMode: 'acceptEdits',
      model: 'sonnet',
      name: 'keep me',
    });
    const claudeId = h.runs()[0]?.argv[1] as string;
    const hookCalls = h.installHookCalls.length;
    writeTranscript(claudeId);

    const countBefore = h.hub.received.length;
    await h.restartDaemon();
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['s1']); // 關閉不算結束

    const hello = h.hellos().at(-1);
    if (!hello) throw new Error('沒有 hello');
    expect(hello.sessions).toHaveLength(1);
    expect(hello.sessions[0]).toMatchObject({
      id: 's1',
      status: 'starting',
      claudeSessionId: claudeId,
      endedAt: null,
    });
    expect(h.hub.received.slice(countBefore)[0]?.type).toBe('daemon.hello');

    await waitUntil(() => h.runs().length === 2, '第二次啟動');
    expect(h.runs()[1]?.argv).toEqual([
      '--resume',
      claudeId,
      '--permission-mode',
      'acceptEdits',
      '--model',
      'sonnet',
      '--name',
      'keep me',
    ]);
    expect(h.installHookCalls.length).toBe(hookCalls + 1);

    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    input('s1', 'after-restart');
    await h.waitForOutput('s1', 'INPUT:after-restart');
  });

  it('唯讀 session：拿掉改檔工具；記在清單裡，重啟接回時照樣帶', async () => {
    await h.createAndSubscribe('ro', { readOnly: true, permissionMode: 'plan', name: 'rv' });
    const tools = ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit'];
    const claudeId = h.runs()[0]?.argv[1] as string;
    expect(h.runs()[0]?.argv.slice(2)).toEqual([
      '--permission-mode',
      'plan',
      ...tools,
      '--name',
      'rv',
    ]);
    expect(persisted().sessions[0]?.spec.readOnly).toBe(true);

    writeTranscript(claudeId);
    await h.restartDaemon();
    await waitUntil(() => h.runs().length === 2, '第二次啟動');
    expect(h.runs()[1]?.argv).toEqual([
      '--resume',
      claudeId,
      '--permission-mode',
      'plan',
      ...tools,
      '--name',
      'rv',
    ]);
  });

  it('/clear 換了 claude session id 之後，重啟用新的 id', async () => {
    await h.createAndSubscribe('s1');
    const client = await HookClient.connect(h.daemons[0]?.hookSocketPath as string);
    await client.request('s1', 'SessionStart', {
      session_id: '0a1b2c3d-0000-4000-8000-0000000c1ea7',
    });
    client.close();
    await waitUntil(
      () => persisted().sessions[0]?.claudeSessionId === '0a1b2c3d-0000-4000-8000-0000000c1ea7',
      '清單更新',
    );
    writeTranscript('0a1b2c3d-0000-4000-8000-0000000c1ea7');

    await h.restartDaemon();
    await waitUntil(() => h.runs().length === 2, '第二次啟動');
    expect(h.runs()[1]?.argv.slice(0, 2)).toEqual([
      '--resume',
      '0a1b2c3d-0000-4000-8000-0000000c1ea7',
    ]);
  });

  it('已結束的 session 不會被接回；cwd 消失的從清單移除，不會擋住其他 session', async () => {
    const gone = join(h.root, 'gone');
    mkdirSync(gone);
    await h.createAndSubscribe('alive');
    await h.createAndSubscribe('moved', { cwd: gone });
    await h.createAndSubscribe('ended');
    input('ended', 'exit 0');
    await h.hub.waitFor('session.runtime', (m) => m.session.id === 'ended' && !!m.session.endedAt);

    for (const daemon of h.daemons.splice(0)) await daemon.stop();
    rmSync(gone, { recursive: true });
    const runsBefore = h.runs().length;
    await h.startDaemon();
    expect(
      h
        .hellos()
        .at(-1)
        ?.sessions.map((s) => s.id),
    ).toEqual(['alive']);
    await waitUntil(() => h.runs().length === runsBefore + 1, '只重開一個');
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['alive']);
  });

  it('重啟時 hook 設定壞掉：不開 PTY、清單保留；修好後接回', async () => {
    await h.createAndSubscribe('s1');
    h.installHooks = async () => {
      throw new Error('壞了');
    };
    await h.restartDaemon();
    expect(h.hellos().at(-1)?.sessions).toEqual([]);
    expect(h.runs()).toHaveLength(1);
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['s1']);

    h.installHooks = async () => {};
    await h.restartDaemon();
    expect(
      h
        .hellos()
        .at(-1)
        ?.sessions.map((s) => s.id),
    ).toEqual(['s1']);
    await waitUntil(() => h.runs().length === 2, '接回');
  });

  it('壞掉的 sessions.json 不擋啟動', async () => {
    for (const daemon of h.daemons.splice(0)) await daemon.stop();
    writeFileSync(join(h.dataDir, 'sessions.json'), 'garbage');
    await h.startDaemon();
    expect(h.hellos().at(-1)?.sessions).toEqual([]);
  });

  it('hub 連不上時也用上次下發的 dangerRules 比對', async () => {
    h.hub.autoWelcome = false; // 新 daemon 拿不到 welcome，只能靠本機保存的規則
    h.hub.dangerRules = [];
    const daemon = await h.restartDaemon();
    const client = await HookClient.connect(daemon.hookSocketPath);
    const reply = client.request('anything', 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force' },
    });
    await waitUntil(() => daemon['approvals'].pending().length === 1, 'danger approval');
    expect(daemon['approvals'].pending()[0]?.matchedRule).toBe('git push --force');
    client.close();
    void reply;
  });
});

describe('hook 與 approval（走真的 socket）', () => {
  let client: HookClient;
  beforeEach(async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    client = await HookClient.connect(h.daemons[0]?.hookSocketPath as string);
  });
  afterEach(() => client.close());

  it('hook 事件轉給 tracker、onChange 變成 status 事件與 runtime，非阻擋事件立刻回', async () => {
    const reply = await client.request('s1', 'UserPromptSubmit', { prompt: 'secret prompt' });
    expect(reply.output).toBeNull();
    const tracker = h.trackers.created[0];
    expect(tracker?.hooks.map((x) => x.event)).toEqual(['UserPromptSubmit']);
    expect(tracker?.outputs.join('')).toContain('FAKE READY');

    const status = await h.hub.waitFor(
      'session.event',
      (m) => m.event.type === 'status' && m.event.payload.to === 'running',
    );
    expect(status.event.payload).toMatchObject({
      from: 'starting',
      reason: 'hook:UserPromptSubmit',
    });
    await waitUntil(() => lastRuntime('s1')?.status === 'running', 'runtime 更新');

    const hookEvent = await h.hub.waitFor('session.event', (m) => m.event.type === 'hook');
    expect(JSON.stringify(hookEvent.event)).not.toContain('secret prompt'); // prompt 不進事件
  });

  it('PostToolUse、PostToolUseFailure：轉給 tracker、立刻回 null、不建 approval、不送 hook 事件', async () => {
    for (const event of ['PostToolUse', 'PostToolUseFailure'] as const) {
      const reply = await client.request('s1', event, {
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      expect(reply.output).toBeNull();
    }
    expect(h.trackers.created[0]?.hooks.map((x) => x.event)).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
    ]);
    expect(h.hub.received.some((m) => m.type === 'approval.requested')).toBe(false);
    expect(h.hub.received.some((m) => m.type === 'session.event' && m.event.type === 'hook')).toBe(
      false,
    );
  });

  it('改檔工具成功後送 file.changed，payload 只有路徑；Bash 與失敗的工具不送', async () => {
    const changed = () =>
      h.hub.received.flatMap((m) =>
        m.type === 'session.event' && m.event.type === 'file.changed' ? [m.event] : [],
      );
    const secret = { content: 'secret file body', old_string: 'secret', new_string: 'secret' };
    for (const [tool_name, tool_input] of [
      ['Write', { file_path: '/r/write.ts', ...secret }],
      ['Edit', { file_path: '/r/edit.ts', ...secret }],
      ['MultiEdit', { file_path: '/r/multi.ts', edits: [secret] }],
      ['NotebookEdit', { notebook_path: '/r/book.ipynb', new_source: 'secret' }],
    ] as const) {
      const reply = await client.request('s1', 'PostToolUse', { tool_name, tool_input });
      expect(reply.output).toBeNull();
    }
    await waitUntil(() => changed().length === 4, 'file.changed 事件');
    expect(changed().map((e) => e.payload)).toEqual([
      { path: '/r/write.ts' },
      { path: '/r/edit.ts' },
      { path: '/r/multi.ts' },
      { path: '/r/book.ipynb' },
    ]);
    expect(JSON.stringify(changed())).not.toContain('secret');
    expect(changed()[0]?.sessionId).toBe('s1');

    await client.request('s1', 'PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'sed -i s/a/b/ /r/x.ts', file_path: '/r/x.ts' },
    });
    await client.request('s1', 'PostToolUse', { tool_name: 'Write', tool_input: {} });
    await client.request('s1', 'PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: '/r/y' },
    });
    await client.request('s1', 'PostToolUseFailure', {
      tool_name: 'Write',
      tool_input: { file_path: '/r/failed.ts' },
    });
    // 同一條連線、依序處理：標記事件到了，前面的都已經處理完。
    await client.request('s1', 'PostToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: '/r/end.ts' },
    });
    await waitUntil(() => changed().length === 5, '結尾事件');
    expect(changed()[4]?.payload).toEqual({ path: '/r/end.ts' });
  });

  it('SessionStart：更新 contextTokens、claudeSessionId；firstPrompt 只送一次且送完清掉', async () => {
    await h.createAndSubscribe('fp', { firstPrompt: 'do the thing' });
    expect(persisted().sessions.find((s) => s.sessionId === 'fp')?.pendingFirstPrompt).toBe(
      'do the thing',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.outputText('fp')).not.toContain('INPUT:do the thing'); // SessionStart 之前不送

    await client.request('fp', 'SessionStart', { session_id: 'real-id', context_tokens: 1234 });
    await client.request('fp', 'SessionStart', { session_id: 'real-id', context_tokens: 1300 });
    await h.waitForOutput('fp', 'INPUT:do the thing');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.outputText('fp').match(/INPUT:do the thing/g)).toHaveLength(1);
    expect(persisted().sessions.find((s) => s.sessionId === 'fp')?.pendingFirstPrompt).toBeNull();
    await waitUntil(() => lastRuntime('fp')?.contextTokens === 1300, 'contextTokens');
    expect(lastRuntime('fp')?.claudeSessionId).toBe('real-id');
  });

  it('context 上限：SessionStart 的 model 決定；Stop 時從對話紀錄更新用量與模型', async () => {
    await h.createAndSubscribe('cw', { model: 'opus' });
    // 別名推不出上限，不猜。
    expect(lastRuntime('cw')?.contextWindow ?? null).toBeNull();
    expect(lastRuntime('cw')?.repoRoot ?? null).toBeNull(); // workDir 不是 git

    await client.request('cw', 'SessionStart', { session_id: 'c', model: 'claude-opus-4-6[1m]' });
    await waitUntil(() => lastRuntime('cw')?.contextWindow === 1_000_000, '[1m] → 1M');

    const transcript = join(h.root, 'cw.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 40_000,
            cache_creation_input_tokens: 0,
          },
        },
      }) + '\n',
    );
    await client.request('cw', 'Stop', { session_id: 'c', transcript_path: transcript });
    await waitUntil(() => lastRuntime('cw')?.contextTokens === 40_005, '用量來自對話紀錄');
    // hook 的模型帶 [1m]，對話紀錄只寫基本 id，上限維持 1M。
    expect(lastRuntime('cw')?.contextWindow).toBe(1_000_000);
  });

  it('PermissionRequest → approval.requested → approval.decide → hook 拿到決定', async () => {
    const pending = client.request('s1', 'PermissionRequest', {
      tool_name: 'Write',
      tool_input: { file_path: 'x' },
      permission_suggestions: [{ rule: 'Write' }],
    });
    const { approval } = await h.hub.waitFor('approval.requested');
    expect(approval).toMatchObject({ kind: 'permission', toolName: 'Write', sessionId: 's1' });
    h.hub.send({
      type: 'approval.decide',
      approvalId: approval.id,
      sessionId: 's1',
      decision: { behavior: 'allow', remember: true },
    });
    expect((await pending).output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [{ rule: 'Write' }] },
      },
    });
    const resolved = await h.hub.waitFor('approval.resolved');
    expect(resolved).toMatchObject({ approvalId: approval.id, by: 'web' });
  });

  it('危險指令：用 hub.welcome 的規則，命中卡住等決定；未命中立刻 null', async () => {
    const safe = await client.request('s1', 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    expect(safe.output).toBeNull();

    const pending = client.request('s1', 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'git   push   --force origin main' },
    });
    const { approval } = await h.hub.waitFor('approval.requested');
    expect(approval).toMatchObject({ kind: 'danger', matchedRule: 'git push --force' });
    h.hub.send({
      type: 'approval.decide',
      approvalId: approval.id,
      sessionId: 's1',
      decision: { behavior: 'deny', reason: '不行' },
    });
    expect((await pending).output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '不行',
      },
    });
  });

  it('危險指令命中：tracker 依序收到 PreToolUse、PermissionRequest，狀態顯示等人；未命中不多送', async () => {
    const command = (text: string) => ({ tool_name: 'Bash', tool_input: { command: text } });
    await client.request('s1', 'PreToolUse', command('ls'));
    const tracker = h.trackers.created[0];
    expect(tracker?.hooks.map((x) => x.event)).toEqual(['PreToolUse']);

    const pending = client.request('s1', 'PreToolUse', command('rm -rf /'));
    const { approval } = await h.hub.waitFor('approval.requested');
    expect(tracker?.hooks.map((x) => x.event)).toEqual([
      'PreToolUse',
      'PreToolUse',
      'PermissionRequest',
    ]);
    const forwarded = tracker?.hooks.at(-1)?.payload;
    expect(forwarded?.hook_event_name).toBe('PermissionRequest');
    expect(forwarded?.tool_name).toBe('Bash');
    expect(tracker?.status).toBe('waiting_permission');
    await waitUntil(() => lastRuntime('s1')?.status === 'waiting_permission', 'runtime');
    // 這是內部轉送，不要多一筆 hook 事件。
    expect(
      h.hub.received.filter(
        (m) =>
          m.type === 'session.event' &&
          m.event.type === 'hook' &&
          m.event.payload.event === 'PermissionRequest',
      ),
    ).toEqual([]);
    h.hub.send({
      type: 'approval.decide',
      approvalId: approval.id,
      sessionId: 's1',
      decision: { behavior: 'deny', reason: 'no' },
    });
    await pending;
  });

  it('危險指令超時回 deny（真實等待時間注入縮短）', async () => {
    const daemon = await h.restartDaemon({ approvalWaitMs: 50 });
    const local = await HookClient.connect(daemon.hookSocketPath);
    const reply = await local.request('s1', 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    local.close();
    expect(reply.output).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await h.hub.waitFor('approval.resolved', (m) => m.by === 'timeout');
  });

  it('hub 斷線時 approval 繼續等；重連的 hello 帶 pendingApprovals，決定仍有效', async () => {
    const pending = client.request('s1', 'PermissionRequest', { tool_name: 'Edit' });
    const { approval } = await h.hub.waitFor('approval.requested');
    h.hub.dropConnection();
    await waitUntil(() => h.hellos().length === 2, '重連');
    expect(h.hellos()[1]?.pendingApprovals.map((a) => a.id)).toEqual([approval.id]);
    await waitUntil(() => h.daemons[0]?.['hub'].connected, '連上');
    h.hub.send({
      type: 'approval.decide',
      approvalId: approval.id,
      sessionId: 's1',
      decision: { behavior: 'deny', reason: 'no' },
    });
    expect((await pending).output).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny', message: 'no' } },
    });
  });

  it('hook 程式離開（終端機已回答）→ approval.resolved by terminal；PTY 結束 → 等待中的 approval 被取消', async () => {
    const other = await HookClient.connect(h.daemons[0]?.hookSocketPath as string);
    void other.request('s1', 'PermissionRequest', { tool_name: 'Edit' });
    const first = await h.hub.waitFor('approval.requested');
    other.close();
    await h.hub.waitFor(
      'approval.resolved',
      (m) => m.approvalId === first.approval.id && m.by === 'terminal',
    );

    const pending = client.request('s1', 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    await h.hub.waitFor('approval.requested', (m) => m.approval.kind === 'danger');
    input('s1', 'exit 1');
    expect((await pending).output).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('不認得的 session：一般 hook 回 null，危險指令仍攔', async () => {
    expect((await client.request('ghost', 'PermissionRequest', {})).output).toBeNull();
    expect((await client.request('ghost', 'Stop', {})).output).toBeNull();
    void client.request('ghost', 'PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    const { approval } = await h.hub.waitFor('approval.requested');
    expect(approval.sessionId).toBe('ghost');
  });
});

describe('其他 hub 指令', () => {
  beforeEach(() => h.start().then(() => undefined));

  it('hub.welcome 更新 stuckMinutes 給既有與新的 tracker，並寫入本機', async () => {
    await h.createAndSubscribe('s1');
    expect(h.trackers.created[0]?.stuckMinutes).toBe(7);
    h.hub.send({ type: 'hub.welcome', machineId: 'm', dangerRules: ['x'], stuckMinutes: 42 });
    await waitUntil(() => h.trackers.created[0]?.stuckMinutes === 42, 'tracker 更新');
    expect(JSON.parse(readFileSync(join(h.dataDir, 'sessions.json'), 'utf8'))).toMatchObject({
      dangerRules: ['x'],
      stuckMinutes: 42,
    });
    await h.createAndSubscribe('s2');
    expect(h.trackers.created[1]?.stuckMinutes).toBe(42);
  });

  it('resources.watch 控制回報；斷線後停止直到再次要求', async () => {
    await h.restartDaemon({
      resources: {
        sampleCpuMem: async () => ({ cpuPercent: 5, memoryUsedBytes: 1, memoryTotalBytes: 2 }),
        sampleGpu: async () => null,
        cpuIntervalMs: 20,
        gpuIntervalMs: 50,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const resources = () => h.hub.received.filter((m) => m.type === 'resources').length;
    expect(resources()).toBe(0);

    h.hub.send({ type: 'resources.watch', watching: true });
    await waitUntil(() => resources() >= 3, '資源樣本');
    h.hub.dropConnection();
    await waitUntil(() => h.hellos().length === 3, '重連');
    const afterReconnect = resources();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(resources()).toBe(afterReconnect);
  });

  it('fs.list 走訊息流程', async () => {
    mkdirSync(join(h.workDir, 'child'));
    h.hub.send({ type: 'fs.list', requestId: 'l1', path: h.workDir });
    const result = await h.hub.waitFor('fs.listResult', (m) => m.requestId === 'l1');
    expect(result.entries).toEqual([{ name: 'child', isDir: true, isGitRepo: false }]);
  });

  it('session.inspect／session.transcript 走訊息流程，用預設的 Claude 設定資料夾', async () => {
    const id = '0a1b2c3d-aaaa-bbbb-cccc-000011112222';
    const project = join(h.claudeDir, 'projects', 'p');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`,
    );
    const target = {
      sessionId: 's9',
      cwd: h.workDir,
      worktreePath: null,
      branch: null,
      claudeSessionId: id,
      accountProfile: null,
    };
    h.hub.send({ type: 'session.inspect', requestId: 'i1', target });
    const inspect = await h.hub.waitFor('session.inspectResult', (m) => m.requestId === 'i1');
    expect(inspect.error).toBeNull();
    expect(inspect.inspect).toMatchObject({ git: null, worktreeExists: false });
    expect(inspect.inspect?.transcriptBytes).toBeGreaterThan(0);

    h.hub.send({
      type: 'session.transcript',
      requestId: 't1',
      claudeSessionId: id,
      accountProfile: null,
      cursor: 0,
      limit: 10,
      query: null,
    });
    const transcript = await h.hub.waitFor('session.transcriptResult', (m) => m.requestId === 't1');
    expect(transcript.page).toMatchObject({
      total: 1,
      missing: false,
      entries: [{ index: 0, role: 'user', text: 'hello' }],
    });
  });

  it('session.purge：活著的 session 回 session_active、什麼都不清；結束後才清並忘掉', async () => {
    await h.createAndSubscribe('s1');
    const id = '0a1b2c3d-aaaa-bbbb-cccc-000011113333';
    const project = join(h.claudeDir, 'projects', 'p');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${id}.jsonl`);
    writeFileSync(transcript, '{}\n');
    mkdirSync(join(h.workDir, '.claude'), { recursive: true });
    const settings = join(h.workDir, '.claude', 'settings.local.json');
    const hookSettings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] },
    });
    writeFileSync(settings, hookSettings);
    const all = { removeWorktree: true, removeTranscript: true, removeHooks: true };
    const target = {
      sessionId: 's1',
      cwd: h.workDir,
      worktreePath: null,
      branch: null,
      claudeSessionId: id,
      accountProfile: null,
    };
    const daemon = h.daemons[0]!;
    h.hub.send({ type: 'session.purge', requestId: 'p1', target, options: all });
    const first = await h.hub.waitFor('session.purgeResult', (m) => m.requestId === 'p1');
    expect(first).toMatchObject({ result: null, error: 'session_active' });
    expect(existsSync(transcript)).toBe(true);
    expect(readFileSync(settings, 'utf8')).toBe(hookSettings);
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(daemon['sessions'].has('s1')).toBe(true);

    input('s1', 'exit 0');
    await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 's1' && m.session.endedAt !== null,
    );
    expect(daemon['sessions'].has('s1')).toBe(true); // 結束的畫面還留著給人看
    // 同一個 id 連送兩次：依序執行，第二次看到的是已經清掉的狀態。
    h.hub.send({ type: 'session.purge', requestId: 'p2', target, options: all });
    h.hub.send({ type: 'session.purge', requestId: 'p3', target, options: all });
    const second = await h.hub.waitFor('session.purgeResult', (m) => m.requestId === 'p2');
    const third = await h.hub.waitFor('session.purgeResult', (m) => m.requestId === 'p3');
    expect(second.result).toMatchObject({
      transcript: { status: 'removed' },
      hooks: { status: 'removed' },
      worktree: { status: 'not_found' },
    });
    expect(third.result).toMatchObject({
      transcript: { status: 'not_found' },
      hooks: { status: 'not_found' },
    });
    expect(existsSync(transcript)).toBe(false);
    expect(daemon['sessions'].has('s1')).toBe(false);
    expect(persisted().sessions).toEqual([]);
    expect(persistedEnded()).toEqual([]);
  });

  it('清理中的 session 不能建立（session_deleting）', async () => {
    const daemon = h.daemons[0]!;
    daemon['purging'].add('s2');
    h.hub.send({ type: 'session.create', requestId: 'c2', sessionId: 's2', spec: h.spec() });
    const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'c2');
    expect(failed.error).toBe('session_deleting');
    expect(h.installHookCalls).toEqual([]);
  });

  it('accountProfile 不是絕對路徑：勾對話紀錄的 purge 回 error，不忘掉 session；沒勾就照常清', async () => {
    await h.createAndSubscribe('s3');
    input('s3', 'exit 0');
    await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 's3' && m.session.endedAt !== null,
    );
    const daemon = h.daemons[0]!;
    const target = {
      sessionId: 's3',
      cwd: h.workDir,
      worktreePath: null,
      branch: null,
      claudeSessionId: null,
      accountProfile: 'rel/.claude',
    };
    const none = { removeWorktree: false, removeTranscript: false, removeHooks: false };
    h.hub.send({
      type: 'session.purge',
      requestId: 'p9',
      target,
      options: { ...none, removeTranscript: true },
    });
    const result = await h.hub.waitFor('session.purgeResult', (m) => m.requestId === 'p9');
    expect(result.result).toBeNull();
    expect(result.error).toContain('absolute');
    expect(daemon['sessions'].has('s3')).toBe(true); // 驗證失敗不先忘掉

    h.hub.send({
      type: 'session.purge',
      requestId: 'p10',
      target,
      options: { ...none, removeHooks: true },
    });
    const ok = await h.hub.waitFor('session.purgeResult', (m) => m.requestId === 'p10');
    expect(ok).toMatchObject({ error: null, result: { hooks: { status: 'not_found' } } });
    expect(daemon['sessions'].has('s3')).toBe(false);
  });

  it('清理範圍裡有其他活著或建立中的 session：回 session_active、什麼都不清、撤銷登記', async () => {
    const wt = join(h.workDir, 'wt2');
    const sub = join(wt, 'sub');
    mkdirSync(sub, { recursive: true });
    const settings = join(sub, '.claude', 'settings.local.json');
    mkdirSync(dirname(settings));
    const hooks = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'agent-board-hook Stop' }] }] },
    });
    writeFileSync(settings, hooks);
    const transcriptId = '0a1b2c3d-aaaa-bbbb-cccc-000011114444';
    const project = join(h.claudeDir, 'projects', 'p');
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${transcriptId}.jsonl`);
    writeFileSync(transcript, '{}\n');
    const all = { removeWorktree: true, removeTranscript: true, removeHooks: true };
    const purge = async (requestId: string, over: object) => {
      h.hub.send({
        type: 'session.purge',
        requestId,
        target: {
          sessionId: 'old',
          cwd: sub,
          worktreePath: null,
          branch: null,
          claudeSessionId: transcriptId,
          accountProfile: null,
          ...over,
        },
        options: all,
      });
      return h.hub.waitFor('session.purgeResult', (m) => m.requestId === requestId);
    };
    const daemon = h.daemons[0]!;

    // 另一個 session 正在這個 worktree 的子資料夾裡跑。
    await h.createAndSubscribe('other', { cwd: sub });
    expect(await purge('b1', {})).toMatchObject({ result: null, error: 'session_active' });
    expect(await purge('b2', { cwd: join(h.workDir, 'x'), worktreePath: wt })).toMatchObject({
      error: 'session_active',
    });
    expect(readFileSync(settings, 'utf8')).toBe(hooks);
    expect(existsSync(transcript)).toBe(true);
    expect(daemon['purging'].size).toBe(0);
    expect(daemon['purgingDirs'].size).toBe(0);

    // 結束後就不算，照常清。
    input('other', 'exit 0');
    await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 'other' && m.session.endedAt !== null,
    );
    const ok = await purge('b3', {});
    expect(ok.error).toBeNull();
    expect(ok.result).toMatchObject({
      hooks: { status: 'removed' },
      transcript: { status: 'removed' },
    });

    // 建立中（還沒開起來）的也算。
    let finish!: () => void;
    daemon['creating'].set('pending', new Promise<void>((resolve) => (finish = resolve)));
    daemon['sessionDirs'].set('pending', realpathSync(sub));
    expect(await purge('b4', {})).toMatchObject({ error: 'session_active' });
    finish();
    daemon['creating'].delete('pending');
  });

  it('清理中的 worktree／cwd 不能開新 session（hub 的鎖不在也擋得住），清完就可以', async () => {
    const wt = join(h.workDir, 'wt');
    const cwd = join(wt, 'sub');
    mkdirSync(cwd, { recursive: true });
    // 卡住 cwd 的 hook 設定檔鎖，讓 purge 停在拿 hook 的那一步。
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const locked = withFileLock(await hookSettingsLockKey(cwd), () => held);
    h.hub.send({
      type: 'session.purge',
      requestId: 'pd',
      target: {
        sessionId: 'gone',
        cwd,
        worktreePath: wt,
        branch: 'ab/x',
        claudeSessionId: null,
        accountProfile: null,
      },
      options: { removeWorktree: true, removeTranscript: false, removeHooks: true },
    });
    const daemon = h.daemons[0]!;
    await waitUntil(() => daemon['purgingDirs'].size === 1, 'purge 開始');

    for (const [requestId, dir] of [
      ['in-wt', wt],
      ['in-sub', cwd],
    ] as const) {
      h.hub.send({
        type: 'session.create',
        requestId,
        sessionId: requestId,
        spec: h.spec({ cwd: dir }),
      });
      const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === requestId);
      expect(failed.error).toBe('session_deleting');
    }

    release();
    await locked;
    const done = await h.hub.waitFor('session.purgeResult', (m) => m.requestId === 'pd');
    expect(done.error).toBeNull();
    expect(daemon['purgingDirs'].size).toBe(0);
    h.hub.send({
      type: 'session.create',
      requestId: 'after',
      sessionId: 'after',
      spec: h.spec({ cwd: wt }),
    });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'after');
  });

  it('連上後回報 usage（來自設定資料夾）', async () => {
    for (const daemon of h.daemons.splice(0)) await daemon.stop();
    const project = join(h.claudeDir, 'projects', 'p');
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, 'x.jsonl'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        message: { id: 'm', usage: { input_tokens: 11, output_tokens: 22 } },
      })}\n`,
    );
    await h.startDaemon();
    const usage = await h.hub.waitFor('usage', (m) => m.summary.inputTokens === 11);
    expect(usage.summary.outputTokens).toBe(22);
  });
});

describe('hook 執行檔檢查（CONTRACTS §4.3）', () => {
  beforeEach(() => h.start().then(() => undefined));

  const baseConfig = () => ({
    hubUrl: h.hub.url,
    token: 't',
    dataDir: h.dataDir,
    claudeBin: h.bin,
    machineName: 'm',
    claudeConfigDir: h.claudeDir,
  });

  it('PTY 的 PATH 最前面是 hook 所在資料夾', async () => {
    await h.createAndSubscribe('s1');
    expect(h.runs()[0]?.env.PATH?.split(delimiter)[0]).toBe(h.hookDir);
  });

  it('hook 找不到：createFailed、不開 PTY、不建 worktree', async () => {
    const repo = join(h.root, 'repo');
    mkdirSync(repo);
    await h.restartDaemon({
      config: { ...baseConfig(), hookBin: join(h.root, 'nope', 'agent-board-hook') },
    });
    h.hub.send({
      type: 'session.create',
      requestId: 'r1',
      sessionId: 's1',
      spec: h.spec({ cwd: repo, useWorktree: true }),
    });
    const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'r1');
    expect(failed.error).toContain('找不到可執行');
    expect(h.runs()).toEqual([]);
    expect(existsSync(join(h.root, '.agent-board-wt'))).toBe(false);
  });

  it('bare 指令名不在 PATH 上也算找不到', async () => {
    // pnpm test 會把 node_modules/.bin 放進 PATH，而 daemon 依賴 hook 套件，要拿掉才符合前提。
    // 裝過 Agent Board 的機器在 ~/.local/bin 也有一支，同樣拿掉。
    h.extraEnv.PATH = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((dir) => !dir.includes('node_modules') && !existsSync(join(dir, 'agent-board-hook')))
      .join(delimiter);
    await h.restartDaemon({ config: { ...baseConfig(), hookBin: 'agent-board-hook' } });
    h.hub.send({ type: 'session.create', requestId: 'r1', sessionId: 's1', spec: h.spec() });
    await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'r1');
    expect(h.runs()).toEqual([]);
  });

  it('bare 指令名在 PATH 上就通過', async () => {
    h.extraEnv.PATH = `${h.hookDir}${delimiter}${process.env.PATH}`;
    await h.restartDaemon({ config: { ...baseConfig(), hookBin: 'agent-board-hook' } });
    await h.createAndSubscribe('s1');
  });

  it('覆寫的檔案可執行但檔名不對：settings 的指令解析不到，同樣拒絕', async () => {
    const wrong = writeFakeHook(join(h.root, 'other'), 'my-hook');
    await h.restartDaemon({ config: { ...baseConfig(), hookBin: wrong } });
    h.hub.send({ type: 'session.create', requestId: 'r1', sessionId: 's1', spec: h.spec() });
    const failed = await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'r1');
    expect(failed.error).toContain('必須命名為');
    expect(h.runs()).toEqual([]);
  });

  it('沒有執行權限也算找不到', async () => {
    const noExec = join(h.root, 'noexec', 'agent-board-hook');
    mkdirSync(dirname(noExec));
    writeFileSync(noExec, '');
    await h.restartDaemon({ config: { ...baseConfig(), hookBin: noExec } });
    h.hub.send({ type: 'session.create', requestId: 'r1', sessionId: 's1', spec: h.spec() });
    await h.hub.waitFor('session.createFailed', (m) => m.requestId === 'r1');
  });

  it('重啟時 hook 暫時找不到：不開 PTY、清單保留；修好後再啟動就接回', async () => {
    await h.createAndSubscribe('s1');
    await h.restartDaemon({
      config: { ...baseConfig(), hookBin: join(h.root, 'nope', 'agent-board-hook') },
    });
    expect(h.hellos().at(-1)?.sessions).toEqual([]);
    expect(h.runs()).toHaveLength(1);
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['s1']);

    writeTranscript(persisted().sessions[0]?.claudeSessionId as string);
    await h.restartDaemon();
    expect(
      h
        .hellos()
        .at(-1)
        ?.sessions.map((s) => s.id),
    ).toEqual(['s1']);
    await waitUntil(() => h.runs().length === 2, '接回');
    expect(h.runs()[1]?.argv[0]).toBe('--resume');
  });

  it('沒有對話紀錄（開了沒說話）：不用 --resume，用同一個 id 重新開始，不會變錯誤', async () => {
    await h.createAndSubscribe('s1', { name: 'silent' });
    const claudeId = h.runs()[0]?.argv[1] as string;

    await h.restartDaemon();
    await waitUntil(() => h.runs().length === 2, '第二次啟動');
    expect(h.runs()[1]?.argv.slice(0, 2)).toEqual(['--session-id', claudeId]);
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(persisted().sessions[0]?.claudeSessionId).toBe(claudeId);

    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    input('s1', 'fresh-start');
    await h.waitForOutput('s1', 'INPUT:fresh-start');
  });

  it('accountProfile 的 session 到它自己的 CLAUDE_CONFIG_DIR 找對話紀錄', async () => {
    const profile = join(h.root, 'profile-b');
    mkdirSync(profile, { recursive: true });
    await h.createAndSubscribe('s1', { accountProfile: profile });
    const claudeId = h.runs()[0]?.argv[1] as string;
    writeTranscript(claudeId); // 預設帳號底下有同名檔不算數
    await h.restartDaemon();
    await waitUntil(() => h.runs().length === 2, '第二次啟動');
    expect(h.runs()[1]?.argv.slice(0, 2)).toEqual(['--session-id', claudeId]);

    writeTranscript(claudeId, profile);
    await h.restartDaemon();
    await waitUntil(() => h.runs().length === 3, '第三次啟動');
    expect(h.runs()[2]?.argv.slice(0, 2)).toEqual(['--resume', claudeId]);
  });
});

describe('與 hub 的語意（Agent C）', () => {
  beforeEach(() => h.start().then(() => undefined));

  it('terminal.subscribe 冪等：每次都回新快照；一次 unsubscribe 就停止', async () => {
    await h.createAndSubscribe('s1');
    const snapshots = () => h.hub.received.filter((m) => m.type === 'terminal.snapshot').length;
    const start = snapshots();
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    await waitUntil(() => snapshots() === start + 2, '兩份新快照');

    h.hub.send({ type: 'terminal.unsubscribe', sessionId: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const outputs = () => h.hub.received.filter((m) => m.type === 'terminal.output').length;
    const before = outputs();
    input('s1', 'quiet');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(outputs()).toBe(before);
  });

  it('連續 subscribe 中間夾著輸出：每份快照的 seq 正確，持有任一份都能接上連續的 output', async () => {
    await h.createAndSubscribe('s1');
    const session = h.daemons[0]?.['sessions'].get('s1');
    if (!session) throw new Error('沒有 session');
    const before = h.hub.received.length;
    session.subscribe();
    session['handleData']('one\r\n');
    session.subscribe();
    session['handleData']('two\r\n');
    await waitUntil(
      () => h.hub.received.slice(before).filter((m) => m.type === 'terminal.output').length === 2,
      '兩則 output',
    );
    const messages = h.hub.received
      .slice(before)
      .filter((m) => m.type === 'terminal.snapshot' || m.type === 'terminal.output');
    expect(messages.map((m) => m.type)).toEqual([
      'terminal.snapshot',
      'terminal.snapshot',
      'terminal.output',
      'terminal.output',
    ]);
    const [first, second, one, two] = messages as Extract<
      DaemonToHub,
      { type: 'terminal.snapshot' | 'terminal.output' }
    >[];
    expect(second?.seq).toBe((first?.seq as number) + 1);
    expect(first?.data).not.toContain('one');
    expect(second?.data).toContain('one');
    expect(second?.data).not.toContain('two');
    expect(one?.seq).toBe((first?.seq as number) + 1);
    expect(two?.seq).toBe((one?.seq as number) + 1);
  });

  it('快照還沒送出就 unsubscribe：不送快照也不送暫存的輸出；之後還能再訂閱', async () => {
    await h.createAndSubscribe('s1');
    const session = h.daemons[0]?.['sessions'].get('s1');
    if (!session) throw new Error('沒有 session');
    const before = h.hub.received.length;
    session.subscribe();
    session['handleData']('dropped\r\n');
    session.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      h.hub.received
        .slice(before)
        .some((m) => m.type === 'terminal.snapshot' || m.type === 'terminal.output'),
    ).toBe(false);

    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const snap = await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    expect(snap.data).toContain('dropped');
    input('s1', 'still-live');
    await h.waitForOutput('s1', 'INPUT:still-live');
  });

  it('PTY 還沒開就收到 subscribe：不出事；session.created 後重送就有快照', async () => {
    h.hub.send({ type: 'session.create', requestId: 'early', sessionId: 'early', spec: h.spec() });
    h.hub.send({ type: 'terminal.subscribe', sessionId: 'early' });
    h.hub.send({ type: 'terminal.resize', sessionId: 'early', cols: 80, rows: 24 });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'early');
    h.hub.send({ type: 'terminal.subscribe', sessionId: 'early' });
    const snap = await h.hub.waitFor('terminal.snapshot', (m) => m.sessionId === 'early');
    expect(snap.seq).toBeGreaterThanOrEqual(0);
    input('early', 'ok');
    await h.waitForOutput('early', 'INPUT:ok');
  });

  it('hub.welcome 重送時覆蓋 dangerRules；用量不重掃', async () => {
    const client = await HookClient.connect(h.daemons[0]?.hookSocketPath as string);
    const command = (text: string) => ({ tool_name: 'Bash', tool_input: { command: text } });
    h.hub.send({
      type: 'hub.welcome',
      machineId: 'm',
      dangerRules: ['brand new'],
      stuckMinutes: 9,
    });
    await waitUntil(() => h.daemons[0]?.['dangerRules'].includes('brand new'), '規則更新');
    // 舊規則失效
    expect((await client.request('s', 'PreToolUse', command('rm -rf /'))).output).toBeNull();
    void client.request('s', 'PreToolUse', command('do brand  new thing'));
    const { approval } = await h.hub.waitFor('approval.requested');
    expect(approval.matchedRule).toBe('brand new');
    client.close();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.hub.received.filter((m) => m.type === 'usage')).toHaveLength(1);
  });

  it('接續已結束的 session（同 sessionId、resumeClaudeSessionId）：新 PTY、新畫面、新 session.created', async () => {
    await h.createAndSubscribe('s1');
    input('s1', 'exit 2');
    await h.hub.waitFor('session.runtime', (m) => m.session.id === 's1' && !!m.session.endedAt);
    const oldId = h.runs()[0]?.argv[1] as string;

    h.hub.send({
      type: 'session.create',
      requestId: 'resume-1',
      sessionId: 's1',
      spec: h.spec({ resumeClaudeSessionId: oldId }),
    });
    const created = await h.hub.waitFor('session.created', (m) => m.requestId === 'resume-1');
    expect(created.session).toMatchObject({ id: 's1', endedAt: null, claudeSessionId: oldId });
    await waitUntil(() => h.runs().length === 2, '第二次啟動');
    expect(h.runs()[1]?.argv.slice(0, 2)).toEqual(['--resume', oldId]);
    expect(persisted().sessions.map((s) => s.sessionId)).toEqual(['s1']);

    h.hub.send({ type: 'terminal.subscribe', sessionId: 's1' });
    const snap = await h.hub.waitFor('terminal.snapshot', () => true, { includePast: false });
    expect(snap.seq).toBeLessThanOrEqual(1); // 新 PTY 的序號重新開始
    input('s1', 'second-life');
    await h.waitForOutput('s1', 'INPUT:second-life');
  });

  it('活著的 session 收到接續請求：不開第二個 PTY，回目前狀態', async () => {
    await h.createAndSubscribe('s1');
    h.hub.send({
      type: 'session.create',
      requestId: 'resume-alive',
      sessionId: 's1',
      spec: h.spec({ resumeClaudeSessionId: '0a1b2c3d-0000-4000-8000-0000000000bb' }),
    });
    await h.hub.waitFor('session.created', (m) => m.requestId === 'resume-alive');
    expect(h.runs()).toHaveLength(1);
  });

  it('接續 worktree session（cwd=原 worktreePath、useWorktree=false）：worktreePath、branch 不會遺失', async () => {
    const repo = join(h.root, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'f.txt'), 'x');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        stdio: 'ignore',
      });
    git('init', '-b', 'main');
    git('add', '.');
    git('commit', '-m', 'init');
    await h.createAndSubscribe('wt', { cwd: repo, useWorktree: true, name: 'feat' });
    const first = await h.hub.waitFor('session.created', (m) => m.requestId === 'req-wt');
    input('wt', 'exit 0');
    await h.hub.waitFor('session.runtime', (m) => m.session.id === 'wt' && !!m.session.endedAt);

    h.hub.send({
      type: 'session.create',
      requestId: 'resume-wt',
      sessionId: 'wt',
      spec: h.spec({
        cwd: first.session.worktreePath as string,
        useWorktree: false,
        resumeClaudeSessionId: first.session.claudeSessionId,
      }),
    });
    const created = await h.hub.waitFor('session.created', (m) => m.requestId === 'resume-wt');
    expect(created.session).toMatchObject({
      cwd: first.session.worktreePath,
      worktreePath: first.session.worktreePath,
      branch: first.session.branch,
    });

    // 一般 repo 的接續不會被誤標成 worktree。
    h.hub.send({
      type: 'session.create',
      requestId: 'resume-main',
      sessionId: 'plain',
      spec: h.spec({ cwd: repo, resumeClaudeSessionId: '0a1b2c3d-0000-4000-8000-0000000000cc' }),
    });
    const plain = await h.hub.waitFor('session.created', (m) => m.requestId === 'resume-main');
    expect(plain.session.worktreePath).toBeNull();
  });
});

describe('capabilities', () => {
  it('claude 版本從 --version 來', async () => {
    await h.hub.start();
    await h.startDaemon({ capabilities: undefined });
    const hello = await h.hub.waitFor('daemon.hello');
    expect(hello.capabilities.claudeVersion).toBe('9.9.9');
    expect(hello.capabilities.cpuCores).toBeGreaterThan(0);
    expect(hello.version).toBe('0.0.0');
    expect(hello.name).toBe('test-machine');
    expect(hello.os).toBe(process.platform);
  });
});

describe('機器被移除（token 被拒）', () => {
  const alive = (daemon: Daemon, id: string) => daemon['sessions'].get(id)?.isAlive;

  it('持續被拒超過寬限期：停掉本機 session，重啟也不接回', async () => {
    await h.hub.start();
    mkdirSync(h.workDir, { recursive: true });
    const daemon = await h.startDaemon({ revokedGraceMs: 100, authRetryMs: 50 });
    await h.createAndSubscribe('s1');
    expect(alive(daemon, 's1')).toBe(true);

    h.hub.rejectStatus = 401;
    h.hub.dropConnection();
    await waitUntil(() => alive(daemon, 's1') === false, 'PTY 被停掉');
    expect(persistedEnded().map((r) => r.id)).toEqual(['s1']);

    const runs = h.runs().length;
    h.hub.rejectStatus = null;
    await h.restartDaemon({ revokedGraceMs: 100, authRetryMs: 50 });
    await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 's1' && m.session.endedAt !== null,
    );
    expect(h.runs()).toHaveLength(runs);
  });

  it('寬限期內恢復（例如 hub 設定修好了）：session 不受影響', async () => {
    await h.hub.start();
    mkdirSync(h.workDir, { recursive: true });
    const daemon = await h.startDaemon({ revokedGraceMs: 1500, authRetryMs: 30 });
    await h.createAndSubscribe('s1');
    h.hub.rejectStatus = 401;
    h.hub.dropConnection();
    await waitUntil(() => daemon['revokedTimer'] !== null, '第一次被拒');
    h.hub.rejectStatus = null;
    await waitUntil(() => daemon['revokedTimer'] === null, 'welcome 取消計時');
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(alive(daemon, 's1')).toBe(true);
  });

  it('hub 只是掛了（502、連不上）不會停 session', async () => {
    await h.hub.start();
    mkdirSync(h.workDir, { recursive: true });
    const daemon = await h.startDaemon({ revokedGraceMs: 30 });
    await h.createAndSubscribe('s1');
    h.hub.rejectStatus = 502;
    h.hub.dropConnection();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(daemon['revokedTimer']).toBeNull();
    expect(alive(daemon, 's1')).toBe(true);
  });

  it('hub 送 session.stop（移除機器的正常路徑）：PTY 結束', async () => {
    await h.start();
    await h.createAndSubscribe('s1');
    h.hub.send({ type: 'session.stop', sessionId: 's1' });
    await h.hub.waitFor(
      'session.runtime',
      (m) => m.session.id === 's1' && m.session.endedAt !== null,
    );
  });
});
