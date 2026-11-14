// 表單草稿（STYLE §5.2）：換網址卸載後再開還原，明確關閉才清。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDraft,
  hasDraft,
  NEW_SESSION_DRAFT,
  NEW_TEAM_DRAFT,
  readDraft,
  useDrafts,
  writeDraft,
} from './draftStore';

beforeEach(() => useDrafts.setState({ drafts: {} }));

describe('draftStore', () => {
  it('寫進去的欄位讀得回來；沒寫過的是 undefined（用元件的預設值）', () => {
    writeDraft(NEW_SESSION_DRAFT, 'name', '填一半');
    writeDraft(NEW_SESSION_DRAFT, 'machine', null);
    expect(readDraft(NEW_SESSION_DRAFT, 'name')).toBe('填一半');
    // null 是使用者選的值（例如「依建議」），不是「沒有草稿」。
    expect(readDraft(NEW_SESSION_DRAFT, 'machine')).toBeNull();
    expect(readDraft(NEW_SESSION_DRAFT, 'cwd')).toBeUndefined();
  });

  it('各表單各自一份；清一份不動另一份', () => {
    writeDraft(NEW_SESSION_DRAFT, 'name', 'a');
    writeDraft(NEW_TEAM_DRAFT, 'name', 'b');
    clearDraft(NEW_SESSION_DRAFT);
    expect(hasDraft(NEW_SESSION_DRAFT)).toBe(false);
    expect(readDraft(NEW_SESSION_DRAFT, 'name')).toBeUndefined();
    expect(readDraft(NEW_TEAM_DRAFT, 'name')).toBe('b');
  });

  it('清不存在的草稿不會改狀態', () => {
    const before = useDrafts.getState();
    clearDraft('nope');
    expect(useDrafts.getState()).toBe(before);
  });
});
