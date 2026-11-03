// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  EMPTY_AUDIT_FORM,
  exportFileName,
  localInputToIso,
  rangeReversed,
  SYSTEM_USER,
  toAuditQuery,
} from './audit';

describe('localInputToIso', () => {
  it('依瀏覽器時區轉成 ISO；結束時間含那一整分鐘', () => {
    expect(localInputToIso('2026-11-03T10:05')).toBe(new Date('2026-11-03T10:05').toISOString());
    expect(localInputToIso('2026-11-03T10:05', true)).toBe(
      new Date(new Date('2026-11-03T10:05').getTime() + 59_999).toISOString(),
    );
  });

  it('帶秒數的值不再補到分鐘尾', () => {
    expect(localInputToIso('2026-11-03T10:05:30', true)).toBe(
      new Date('2026-11-03T10:05:30').toISOString(),
    );
  });

  it('格式不對回 null', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('2026-11-03')).toBeNull();
    expect(localInputToIso('2026-13-45T99:99')).toBeNull();
  });
});

describe('toAuditQuery', () => {
  it('空的條件只帶 limit', () => {
    expect(toAuditQuery(EMPTY_AUDIT_FORM, 100)).toEqual({ limit: 100 });
  });

  it('使用者交給 hub 篩，時間格式不對就不帶', () => {
    const query = toAuditQuery(
      {
        action: 'terminal.input',
        sessionId: 's1',
        userId: 'u1',
        from: '2026-11-03T10:00',
        to: 'nope',
      },
      200,
    );
    expect(query).toEqual({
      limit: 200,
      action: 'terminal.input',
      sessionId: 's1',
      userId: 'u1',
      from: new Date('2026-11-03T10:00').toISOString(),
    });
  });

  it('「系統」用 hub 認得的值', () => {
    expect(SYSTEM_USER).toBe('system');
    expect(toAuditQuery({ ...EMPTY_AUDIT_FORM, userId: SYSTEM_USER }, 100)).toEqual({
      limit: 100,
      userId: 'system',
    });
  });
});

describe('rangeReversed', () => {
  it('開始晚於結束才算；同一分鐘不算', () => {
    const form = { ...EMPTY_AUDIT_FORM, from: '2026-11-03T10:05', to: '2026-11-03T10:00' };
    expect(rangeReversed(form)).toBe(true);
    expect(rangeReversed({ ...form, to: '2026-11-03T10:05' })).toBe(false);
    expect(rangeReversed({ ...form, to: '' })).toBe(false);
  });
});

describe('exportFileName', () => {
  it('帶本地日期與時間', () => {
    expect(exportFileName(new Date(2026, 10, 3, 9, 7))).toBe('agent-board-audit-20261103-0907.csv');
  });
});

describe('AUDIT_ACTIONS', () => {
  it('每一個都真的出現在 hub 的程式碼裡（防打錯字，篩選是完全相符）', () => {
    const dir = join(import.meta.dirname, '../../../hub/src');
    const source = readdirSync(dir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n');
    const missing = AUDIT_ACTIONS.filter((action) => !source.includes(`'${action}'`));
    expect(missing).toEqual([]);
  });
});
