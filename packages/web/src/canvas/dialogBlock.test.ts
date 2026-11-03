import { describe, expect, it } from 'vitest';
import type { Approval } from '@agent-board/protocol';
import { dialogBlock } from './dialogBlock';

const approval = (kind: Approval['kind'], sessionId = 's1'): Approval => ({
  id: `a-${kind}`,
  sessionId,
  kind,
  toolName: null,
  toolInput: null,
  suggestions: [],
  matchedRule: null,
  message: null,
  createdAt: '2026-11-03T00:00:00.000Z',
});

describe('dialogBlock', () => {
  it('等你回覆、工作中沒有待決請求時不擋', () => {
    expect(dialogBlock({ id: 's1', status: 'waiting_input' }, [])).toBeNull();
    expect(dialogBlock({ id: 's1', status: 'running' }, [approval('permission', 's2')])).toBeNull();
  });

  it('權限對話框：狀態或待決請求任一個成立就擋', () => {
    expect(dialogBlock({ id: 's1', status: 'waiting_permission' }, [])).toBe('permission');
    expect(dialogBlock({ id: 's1', status: 'running' }, [approval('danger')])).toBe('permission');
  });

  it('提問與計畫各自指向對的處理方式', () => {
    expect(dialogBlock({ id: 's1', status: 'waiting_permission' }, [approval('question')])).toBe(
      'question',
    );
    expect(dialogBlock({ id: 's1', status: 'plan_review' }, [])).toBe('plan');
    expect(dialogBlock({ id: 's1', status: 'waiting_permission' }, [approval('plan')])).toBe(
      'plan',
    );
  });
});
