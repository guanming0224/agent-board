// @vitest-environment node
// 狀態代碼（GM 2026-11-08）：代碼對應、「等你」的範圍與待處理順序。
import { describe, expect, it } from 'vitest';
import { IDLE_START_DETAIL, waitingSessions } from '@agent-board/protocol';
import type { Approval, Session, SessionStatus } from '@agent-board/protocol';
import { nextInQueue, pendingQueue } from '../views/queue';
import { workItems } from '../flows/workItems';
import {
  attentionQueue,
  codeClass,
  codeWaits,
  STATUS_CODES,
  statusCode,
  statusGlyph,
  statusLabelKey,
  waitsForYou,
} from './status';

const at = (m: number) => new Date(Date.UTC(2026, 10, 8, 12, 0) - m * 60_000).toISOString();

const session = (over: Partial<Session> & Pick<Session, 'id'>): Session => ({
  name: over.id,
  machineId: 'm1',
  projectId: null,
  cwd: '/work/api',
  branch: 'main',
  worktreePath: null,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  status: 'running',
  statusDetail: null,
  claudeSessionId: null,
  lastLines: [],
  lastOutputAt: at(0),
  statusSince: at(1),
  contextTokens: null,
  contextWindow: null,
  repoRoot: null,
  repoCommonDir: null,
  createdAt: at(60),
  endedAt: null,
  archived: false,
  archivedAt: null,
  readOnly: false,
  autoContinue: null,
  dispatchedBy: null,
  ...over,
});

const approval = (over: Partial<Approval> & Pick<Approval, 'id' | 'sessionId'>): Approval => ({
  kind: 'permission',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  suggestions: [],
  matchedRule: null,
  message: null,
  createdAt: at(1),
  ...over,
});

const of = (status: SessionStatus, statusDetail: string | null = null) => ({
  status,
  statusDetail,
});

describe('statusCode', () => {
  it.each([
    ['starting', null, 'NEW'],
    ['waiting_input', IDLE_START_DETAIL, 'NEW'],
    ['running', null, 'RUN'],
    ['waiting_input', null, 'ASK'],
    // 其他 detail（例如信任對話框）照舊是 ASK
    ['waiting_input', 'trust', 'ASK'],
    ['waiting_permission', null, 'PERM'],
    ['plan_review', null, 'PLAN'],
    ['error', null, 'ERR'],
    ['stuck', null, 'ERR'],
    ['rate_limited', null, 'QUOTA'],
    ['queued', null, 'QUE'],
    ['done', null, 'DONE'],
    ['offline', null, 'OFF'],
  ] as const)('%s（detail %s）→ %s', (status, detail, code) => {
    expect(statusCode(of(status, detail))).toBe(code);
  });

  it('idle:start 只在 waiting_input 時算 NEW', () => {
    expect(statusCode(of('running', IDLE_START_DETAIL))).toBe('RUN');
  });

  it('十個代碼都用得到，class 各不相同', () => {
    expect(STATUS_CODES).toHaveLength(10);
    expect(new Set(STATUS_CODES.map(codeClass)).size).toBe(10);
  });

  it('只有 ASK、PERM、PLAN、ERR 算等你', () => {
    expect(STATUS_CODES.filter(codeWaits)).toEqual(['PERM', 'ASK', 'PLAN', 'ERR']);
    expect(waitsForYou(of('waiting_input', IDLE_START_DETAIL))).toBe(false);
    expect(waitsForYou(of('waiting_input'))).toBe(true);
    expect(waitsForYou(of('starting'))).toBe(false);
  });

  it('提示框的說明分得出錯誤／卡住、剛開好／啟動中', () => {
    expect(statusLabelKey(of('error'))).toBe('status.error');
    expect(statusLabelKey(of('stuck'))).toBe('status.stuck');
    expect(statusLabelKey(of('waiting_input', IDLE_START_DETAIL))).toBe('status.idle_start');
    expect(statusLabelKey(of('starting'))).toBe('status.starting');
    expect(statusGlyph(of('waiting_input', IDLE_START_DETAIL))).toBe(statusGlyph(of('starting')));
  });

  it('和 protocol 的「等你」定義一致（頁首計數）', () => {
    const statuses: SessionStatus[] = [
      'starting',
      'running',
      'waiting_input',
      'waiting_permission',
      'plan_review',
      'error',
      'stuck',
      'rate_limited',
      'queued',
      'done',
      'offline',
    ];
    const sessions = [
      ...statuses.map((status) => session({ id: status, status })),
      session({ id: 'idle', status: 'waiting_input', statusDetail: IDLE_START_DETAIL }),
    ];
    const ours = sessions.filter(waitsForYou).map((s) => s.id);
    expect(ours).toEqual(waitingSessions(sessions, []).map((s) => s.id));
    expect(ours).not.toContain('idle');
    expect(ours).not.toContain('starting');
  });
});

describe('attentionQueue／pendingQueue（下一個等我的）', () => {
  const sessions = [
    session({ id: 'ask', status: 'waiting_input', statusSince: at(30) }),
    session({ id: 'plan', status: 'plan_review', statusSince: at(20) }),
    session({ id: 'perm', status: 'waiting_permission', statusSince: at(5) }),
    session({ id: 'err', status: 'error', statusSince: at(1) }),
    session({ id: 'stuck', status: 'stuck', statusSince: at(2) }),
    session({
      id: 'new',
      status: 'waiting_input',
      statusDetail: IDLE_START_DETAIL,
      statusSince: at(90),
    }),
    session({ id: 'starting', status: 'starting', statusSince: at(80) }),
    session({ id: 'run', status: 'running' }),
    session({ id: 'quota', status: 'rate_limited' }),
    session({ id: 'gone', status: 'waiting_input', archived: true }),
  ];

  it('不算 NEW；故障優先、再 PERM、再 PLAN／ASK（同級等最久的在前）', () => {
    expect(attentionQueue(sessions).map((s) => s.id)).toEqual([
      'stuck',
      'err',
      'perm',
      'ask',
      'plan',
    ]);
  });

  it('危險指令置頂（session 還是 running 也算），其餘照 attentionQueue', () => {
    const approvals = [approval({ id: 'd', sessionId: 'run', kind: 'danger' })];
    const queue = pendingQueue(sessions, approvals).map((s) => s.id);
    expect(queue).toEqual(['run', 'stuck', 'err', 'perm', 'ask', 'plan']);
    expect(queue).not.toContain('new');
  });

  it('只有剛開好的 session 時，下一個等我的是空的', () => {
    const idle = [sessions[5]!, sessions[6]!];
    expect(nextInQueue(pendingQueue(idle, []), null)).toBeNull();
  });

  it('收件匣：危險指令 → 故障 → PERM → PLAN／ASK，不列剛開好的', () => {
    const items = workItems({
      sessions,
      approvals: [
        approval({ id: 'a-plan', sessionId: 'plan', kind: 'plan', createdAt: at(40) }),
        approval({ id: 'a-danger', sessionId: 'run', kind: 'danger', createdAt: at(1) }),
        approval({ id: 'a-perm', sessionId: 'perm', createdAt: at(3) }),
      ],
    });
    expect(items.map((i) => i.key)).toEqual([
      'a-danger',
      'stuck',
      'err',
      'a-perm',
      'a-plan',
      'ask',
    ]);
  });
});
