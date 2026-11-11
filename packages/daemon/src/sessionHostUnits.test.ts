// session host 相關的純函式與小模組：畫面補正、狀態機載入快照、快照檔、MCP 密鑰保留、拉起 host 的指令。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gapNotice } from './hostPty';
import { downMarkerPath } from './hookServer';
import { clearMcpDir, readMcpSecret, repointMcpConfig, writeMcpFiles } from './mcpFiles';
import { screenCorrection } from './session';
import { launchCommand } from './sessionHostLauncher';
import {
  pruneSnapshots,
  readSnapshot,
  removeSnapshot,
  stateDir,
  writeSnapshot,
  type SessionSnapshotInput,
} from './sessionState';
import { createStatusTracker } from './status';
import type { StatusChange } from './status/types';

const RULE = '─'.repeat(40);
const inputBox = ['⏺ 完成了。', '', RULE, '❯ ', RULE, '  ? for shortcuts'];
const working = ['⏺ Bash(npm test)', '', '✻ Thinking… (esc to interrupt)', '', RULE, '❯ ', RULE];
const dialog = [
  '⏺ Bash(rm -rf build)',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently',
];

describe('screenCorrection：接回後看畫面補正（停機期間漏掉的 hook）', () => {
  it('輸入框可見、沒有工作中提示：跑、卡住、等允許、啟動中 → 等你回覆', () => {
    for (const status of ['running', 'stuck', 'waiting_permission', 'starting'] as const) {
      expect(screenCorrection(inputBox, status)).toEqual({
        to: 'waiting_input',
        reason: 'screen:input-box',
      });
    }
    expect(screenCorrection(inputBox, 'waiting_input')).toBeNull();
    // 限流、錯誤看到輸入框不動（自動接續靠 inputReady 另外判斷）。
    expect(screenCorrection(inputBox, 'rate_limited')).toBeNull();
    expect(screenCorrection(inputBox, 'error')).toBeNull();
  });

  it('工作中提示（輸入框也在）：等你回覆、等允許 → 跑；本來就在跑不動', () => {
    expect(screenCorrection(working, 'waiting_input')).toEqual({
      to: 'running',
      reason: 'screen:busy',
    });
    expect(screenCorrection(working, 'waiting_permission')?.to).toBe('running');
    expect(screenCorrection(working, 'running')).toBeNull();
  });

  it('權限對話框：→ 等你允許；計畫審核、限流、錯誤不動', () => {
    expect(screenCorrection(dialog, 'running')).toEqual({
      to: 'waiting_permission',
      reason: 'screen:dialog',
    });
    expect(screenCorrection(dialog, 'waiting_input')?.to).toBe('waiting_permission');
    for (const status of ['waiting_permission', 'plan_review', 'rate_limited', 'error'] as const) {
      expect(screenCorrection(dialog, status)).toBeNull();
    }
  });

  it('認不出來（假 claude、Codex、空畫面）：不動', () => {
    expect(screenCorrection(['FAKE READY', 'INPUT:x'], 'running')).toBeNull();
    expect(screenCorrection([], 'waiting_input')).toBeNull();
    // 很久以前的對話框已經捲上去（不在最下面 15 行）：不算。
    const old = [...dialog, ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
    expect(screenCorrection(old, 'running')).toBeNull();
  });
});

describe('狀態機：restore／correct', () => {
  function tracker() {
    const changes: StatusChange[] = [];
    const t = createStatusTracker({ stuckMinutes: 30, onChange: (c) => changes.push(c) });
    return { t, changes };
  }

  it('restore 不觸發 onChange；之後的 hook 照常從快照的狀態接著轉', () => {
    const { t, changes } = tracker();
    const at = new Date('2026-11-10T01:00:00.000Z');
    t.restore!({
      status: 'waiting_permission',
      detail: 'Bash',
      at,
      claudeSessionId: '0a1b2c3d-0000-4000-8000-000000000001',
    });
    expect(t.status).toBe('waiting_permission');
    expect(t.claudeSessionId).toBe('0a1b2c3d-0000-4000-8000-000000000001');
    expect(changes).toEqual([]);
    // 快照沒有請求細節：任何一筆主線工具事件都能結算。
    t.onHook('PostToolUse', {
      session_id: 'x',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(t.status).toBe('running');
    expect(changes.at(-1)).toMatchObject({ from: 'waiting_permission', to: 'running' });
    t.dispose();
  });

  it('接回後新出現的限流訊息算數（重播時看過的舊訊息不算）', () => {
    const { t } = tracker();
    const limit = "You've hit your limit · resets 3pm (Asia/Taipei)\n";
    t.onOutput(limit); // 重播
    t.restore!({ status: 'running', detail: null, at: new Date(), claudeSessionId: null });
    t.onOutput(limit); // 重畫同一則：不算
    expect(t.status).toBe('running');
    t.onOutput("You've hit your limit · resets 5pm (Asia/Taipei)\n");
    expect(t.status).toBe('rate_limited');
    t.dispose();
  });

  it('correct 觸發 onChange、帶 screen:* 原因；同狀態不動', () => {
    const { t, changes } = tracker();
    t.restore!({ status: 'running', detail: null, at: new Date(), claudeSessionId: null });
    t.correct!('running', 'screen:busy', null);
    expect(changes).toEqual([]);
    t.correct!('waiting_input', 'screen:input-box', null);
    expect(changes).toMatchObject([
      { from: 'running', to: 'waiting_input', reason: 'screen:input-box' },
    ]);
    t.dispose();
  });
});

describe('狀態快照檔', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ab-state-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  const snapshot = (sessionId: string): SessionSnapshotInput => ({
    version: 1,
    sessionId,
    savedAt: '2026-11-10T01:00:00.000Z',
    status: 'running',
    statusDetail: null,
    statusSince: '2026-11-10T00:59:00.000Z',
    claudeSessionId: null,
    contextTokens: 1234,
    hookModel: 'opus',
    transcriptModel: null,
    lastOutputAt: null,
    pendingApprovalIds: ['a1'],
  });

  it('寫入 600、資料夾 700；讀回一樣；刪除', () => {
    writeSnapshot(dataDir, snapshot('s1'));
    expect(statSync(stateDir(dataDir)).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir(dataDir), 's1.json')).mode & 0o777).toBe(0o600);
    expect(readSnapshot(dataDir, 's1')).toEqual({
      ...snapshot('s1'),
      pendingApprovals: [],
      approvalsHandedOff: false,
      agentPid: null,
      agentStartedAt: null,
    });
    removeSnapshot(dataDir, 's1');
    expect(readSnapshot(dataDir, 's1')).toBeNull();
  });

  it('壞檔、id 不符、不安全的 id：當成沒有', () => {
    mkdirSync(stateDir(dataDir), { recursive: true });
    writeFileSync(join(stateDir(dataDir), 'bad.json'), '{not json');
    expect(readSnapshot(dataDir, 'bad')).toBeNull();
    writeFileSync(join(stateDir(dataDir), 'other.json'), JSON.stringify(snapshot('s9')));
    expect(readSnapshot(dataDir, 'other')).toBeNull();
    writeSnapshot(dataDir, snapshot('../escape'));
    expect(readdirSync(dataDir)).not.toContain('escape.json');
    expect(readSnapshot(dataDir, '../escape')).toBeNull();
  });

  it('pruneSnapshots 只留清單上的', () => {
    writeSnapshot(dataDir, snapshot('keep'));
    writeSnapshot(dataDir, snapshot('gone'));
    pruneSnapshots(dataDir, new Set(['keep']));
    expect(readdirSync(stateDir(dataDir))).toEqual(['keep.json']);
  });
});

describe('MCP 密鑰檔', () => {
  it('clearMcpDir 保留 keep 裡的 session，其他的與暫存檔都刪；readMcpSecret 讀回密鑰', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-mcp-'));
    try {
      const dir = join(dataDir, 'mcp');
      mkdirSync(dir);
      for (const name of ['a.json', 'a.key', 'b.json', 'b.key', 'x.key.1.tmp']) {
        writeFileSync(join(dir, name), name === 'a.key' ? 'sk-ant-demo-secret\n' : '{}');
      }
      clearMcpDir(dataDir, new Set(['a']));
      expect(readdirSync(dir).sort()).toEqual(['a.json', 'a.key']);
      expect(readMcpSecret(dataDir, 'a')).toBe('sk-ant-demo-secret');
      expect(readMcpSecret(dataDir, 'b')).toBeNull();
      clearMcpDir(dataDir);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('repointMcpConfig：設定檔的 node 不存在或和現在的不同就改成現在的；密鑰、env 不變、0600（§21.10）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-mcp-'));
    try {
      // 0.1.1 期間開的 session：command 是已經不存在的自帶 node。
      const gone = join(dataDir, 'releases', '0.1.1', 'runtime', 'node', 'bin', 'node');
      const { configPath, secret } = writeMcpFiles(
        dataDir,
        's1',
        { command: gone, args: ['/x/agent-board-mcp.mjs'] },
        '/tmp/hook.sock',
        ['send_task'],
      );
      const before = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(repointMcpConfig(dataDir, 's1', process.execPath)).toBe(true);
      const after = JSON.parse(readFileSync(configPath, 'utf8'));
      const server = after.mcpServers['agent-board'];
      expect(server.command).toBe(process.execPath);
      expect(server.args).toEqual(before.mcpServers['agent-board'].args);
      expect(server.env).toEqual(before.mcpServers['agent-board'].env);
      expect(readMcpSecret(dataDir, 's1')).toBe(secret);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(dataDir, 'mcp')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      // 已經是現在的 node：不動。
      expect(repointMcpConfig(dataDir, 's1', process.execPath)).toBe(false);
      // 現在的 node 不存在、設定檔不在：不動。
      expect(repointMcpConfig(dataDir, 's1', join(dataDir, 'no-node'))).toBe(false);
      expect(repointMcpConfig(dataDir, 'missing', process.execPath)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('repointMcpConfig：0.1.6 以前的設定檔沒有 hook 密鑰檔的 env 就補上，其他 env 不動；已經有的不改（W5）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-mcp-'));
    try {
      const { configPath } = writeMcpFiles(
        dataDir,
        's1',
        { command: process.execPath, args: ['/x/agent-board-mcp.mjs'] },
        '/tmp/hook.sock',
        ['send_task'],
      );
      const before = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers['agent-board'];
      expect(before.env.AGENT_BOARD_HOOK_KEY_FILE).toBeUndefined();
      expect(repointMcpConfig(dataDir, 's1', process.execPath, '/data/hook.key')).toBe(true);
      const after = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers['agent-board'];
      expect(after.env).toEqual({ ...before.env, AGENT_BOARD_HOOK_KEY_FILE: '/data/hook.key' });
      expect(after.command).toBe(process.execPath);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(repointMcpConfig(dataDir, 's1', process.execPath, '/other/hook.key')).toBe(false);
      // 新寫的設定檔本來就有。
      const fresh = writeMcpFiles(
        dataDir,
        's2',
        { command: process.execPath, args: ['/x/agent-board-mcp.mjs'] },
        '/tmp/hook.sock',
        ['send_task'],
        '/data/hook.key',
      );
      expect(
        JSON.parse(readFileSync(fresh.configPath, 'utf8')).mcpServers['agent-board'].env
          .AGENT_BOARD_HOOK_KEY_FILE,
      ).toBe('/data/hook.key');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('其他', () => {
  it('拉起 session host 的指令', () => {
    expect(launchCommand('com.agent-board.session-host', 'darwin', 501)).toEqual({
      command: 'launchctl',
      args: ['kickstart', 'gui/501/com.agent-board.session-host'],
    });
    expect(launchCommand('agent-board-session-host.service', 'linux', 1000)).toEqual({
      command: 'systemctl',
      args: ['--user', 'start', 'agent-board-session-host.service'],
    });
    expect(launchCommand('AgentBoard-session-host', 'win32', null)).toEqual({
      command: 'schtasks',
      args: ['/Run', '/TN', 'AgentBoard-session-host'],
    });
    expect(launchCommand('x', 'darwin', null)).toBeNull();
  });

  it('停止記號在 socket 旁邊；Windows named pipe 沒有', () => {
    expect(downMarkerPath('/home/u/.agent-board/hook.sock')).toBe(
      '/home/u/.agent-board/hook.sock.down',
    );
    expect(downMarkerPath('\\\\.\\pipe\\agent-board-abc')).toBeNull();
  });

  it('緩衝缺口的提示寫明缺多少 KB', () => {
    expect(gapNotice(300 * 1024)).toContain('300 KB');
    expect(gapNotice(10)).toContain('1 KB');
  });
});
