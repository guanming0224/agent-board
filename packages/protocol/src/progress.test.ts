// 進度卡的共用規則（hub、前端假後端、畫面都用）：三方比對、送字的一行、久未更新、文字清理。
import { describe, expect, it } from 'vitest';
import {
  AgentBoardTool,
  cleanProgressText,
  emptyProgressCard,
  firstLine,
  overLimit,
  planProgressWrite,
  progressLine,
  progressStale,
  PROGRESS_LINE_MAX,
  PROGRESS_STALE_MS,
  type ProgressCard,
} from './progress';

const card = (over: Partial<ProgressCard> = {}): ProgressCard => ({
  ...emptyProgressCard({ teamId: 't1' }),
  ...over,
});

describe('planProgressWrite（三方比對）', () => {
  // rev 1：GM 寫 status、next；rev 2：next 被改（GM 或 agent，比對規則不看是誰）。
  const current = card({
    status: 'S',
    next: 'N2',
    revision: 2,
    fieldRevisions: { status: 1, next: 2, blockers: 0, gmNotes: 0 },
  });

  it('base 是目前版本：直接寫，不算合併', () => {
    expect(planProgressWrite(current, 2, { next: 'X' })).toEqual({
      changed: ['next'],
      conflicts: [],
      merged: false,
    });
  });

  it('同欄：base 之後被改過 → 衝突（不論誰先）', () => {
    expect(planProgressWrite(current, 1, { next: 'X' }).conflicts).toEqual(['next']);
  });

  it('不同欄：base 之後別的欄被改過 → 合併寫入', () => {
    expect(planProgressWrite(current, 1, { status: 'S2' })).toEqual({
      changed: ['status'],
      conflicts: [],
      merged: true,
    });
  });

  it('有任何一個要寫的欄位衝突就整筆拒絕；內容沒變的欄位不算改也不算衝突', () => {
    expect(planProgressWrite(current, 1, { status: 'S2', next: 'X' }).conflicts).toEqual(['next']);
    expect(planProgressWrite(current, 1, { next: 'N2', status: 'S2' })).toMatchObject({
      changed: ['status'],
      conflicts: [],
    });
    expect(planProgressWrite(current, 1, { next: 'N2' })).toEqual({
      changed: [],
      conflicts: [],
      merged: false,
    });
  });
});

describe('progressLine（帶入進度卡）', () => {
  it('一行、空欄位略過、清控制字元', () => {
    expect(
      progressLine('台股', {
        status: 'done 2015\n- Sharpe 0.8',
        next: '\u001b[31m2021\r\n',
        blockers: '',
        gmNotes: 'fee 0.1425%',
      }),
    ).toBe(
      '[Progress card: 台股] Status: done 2015 - Sharpe 0.8 | Next: 2021 | GM notes: fee 0.1425%',
    );
    expect(progressLine('x', { status: '', next: ' ', blockers: '', gmNotes: '' })).toBeNull();
  });

  it(`超過 ${PROGRESS_LINE_MAX} 字截斷`, () => {
    const line = progressLine('t', {
      status: 'a'.repeat(5000),
      next: '',
      blockers: '',
      gmNotes: '',
    })!;
    expect([...line]).toHaveLength(PROGRESS_LINE_MAX);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toMatch(/[\r\n]/);
  });
});

describe('其他規則', () => {
  it('久未更新：超過 24 小時，而且之後有回合結束', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const old = '2026-11-08T00:00:00.000Z';
    const facts = (lastStopAt: string | null) => ({ ...card().facts, lastStopAt });
    expect(
      progressStale(
        card({ revision: 1, updatedAt: old, facts: facts('2026-11-09T00:00:00.000Z') }),
        now,
      ),
    ).toBe(true);
    // 之後沒有回合結束（沒在動）：不算。
    expect(
      progressStale(
        card({ revision: 1, updatedAt: old, facts: facts('2026-11-07T00:00:00.000Z') }),
        now,
      ),
    ).toBe(false);
    // 還不到 24 小時。
    const recent = new Date(now - PROGRESS_STALE_MS + 1000).toISOString();
    expect(
      progressStale(
        card({ revision: 1, updatedAt: recent, facts: facts(new Date(now).toISOString()) }),
        now,
      ),
    ).toBe(false);
    // 還沒寫過。
    expect(progressStale(card({ facts: facts(new Date(now).toISOString()) }), now)).toBe(false);
  });

  it('文字清理保留換行、拿掉 ESC 與 \\r；上限以字元計；第一行去掉清單符號', () => {
    expect(cleanProgressText('a\r\nb\u001b[0m\u0000\t c  \n\n')).toBe('a\nb  c');
    expect(overLimit({ next: 'x'.repeat(2000), status: '字'.repeat(2001) })).toEqual(['status']);
    expect(firstLine('\n\n- 補 2021\n- 再跑')).toBe('補 2021');
    expect(firstLine('1. one')).toBe('one');
  });

  it('agent-board 工具共七個：派工 5 個（含隊長自主擴編的 release_member）＋進度卡 2 個', () => {
    expect(AgentBoardTool.options).toEqual([
      'list_members',
      'spawn_member',
      'send_task',
      'get_result',
      'release_member',
      'get_progress',
      'update_progress',
    ]);
  });
});
