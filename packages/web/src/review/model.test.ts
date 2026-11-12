// @vitest-environment node
// 交叉審查畫面的純函式與網址（Codex 第二輪）。
import { describe, expect, it } from 'vitest';
import { pendingSide, type Review, type ReviewSide } from '@agent-board/protocol';
import {
  crossReviewHash,
  crossReviewTarget,
  newCrossReviewHash,
  parseHash,
} from '../views/overlay';
import { DEMO_REVIEW_DIFF } from '../shared/fakeReviews';
import {
  awaitingReviews,
  durationParts,
  formatBytes,
  orderedFiles,
  sideReason,
  unreadReviews,
} from './model';

const review = (over: Partial<Review>): Review => ({
  id: 'r',
  requestedBy: { kind: 'user', id: 'u', name: 'gm' },
  teamId: null,
  reason: '',
  machineId: 'm',
  target: { kind: 'session', label: 'x', sessionId: 's', cwd: '/w', branch: null, base: null },
  status: 'done',
  error: null,
  diff: null,
  claude: pendingSide('claude'),
  codex: pendingSide('codex'),
  instructionsVersion: 1,
  read: false,
  createdAt: '2026-11-12T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  ...over,
});

describe('交叉審查網址', () => {
  it('#/cross-review/<id> 與 #/cross-review/new?session=… 都是次畫面；#/review/ 仍是舊的收件匣轉址', () => {
    expect(parseHash(crossReviewHash('abc'))).toEqual({
      kind: 'board',
      right: 'keep',
      modal: 'crossReview',
    });
    expect(parseHash(newCrossReviewHash('s 1'))).toMatchObject({ modal: 'crossReview' });
    expect(parseHash('#/review/s1')).toEqual({ kind: 'redirect', to: '#/inbox/s1' });
    expect(crossReviewTarget(crossReviewHash('a/b'))).toEqual({ id: 'a/b', session: null });
    expect(crossReviewTarget(newCrossReviewHash('s 1'))).toEqual({ id: null, session: 's 1' });
    expect(crossReviewTarget(newCrossReviewHash())).toEqual({ id: null, session: null });
    expect(crossReviewTarget('#/usage')).toBeNull();
  });
});

describe('交叉審查的純函式', () => {
  it('大小、耗時', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(3_812)).toBe('3.7 KB');
    expect(formatBytes(204_800)).toBe('200 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(durationParts(65_400)).toEqual({ m: 1, s: 5 });
  });

  it('收件匣只列結束了、沒讀的；等確認另外列', () => {
    const list = [
      review({ id: 'a' }),
      review({ id: 'b', read: true }),
      review({ id: 'c', status: 'running' }),
      review({ id: 'd', status: 'failed' }),
      review({ id: 'e', status: 'awaiting_confirm' }),
      review({ id: 'f', status: 'cancelled' }),
    ];
    expect(unreadReviews(list).map((r) => r.id)).toEqual(['a', 'd']);
    expect(awaitingReviews(list).map((r) => r.id)).toEqual(['e']);
  });

  it('略過原因：Windows、沒有 codex、取消、其他', () => {
    const side = (error: string | null): ReviewSide => ({
      ...pendingSide('codex'),
      status: 'skipped',
      error,
    });
    expect(sideReason(side('windows: Codex is not available'))).toBe('windows');
    expect(sideReason(side('codex_unavailable: not found'))).toBe('unavailable');
    expect(sideReason(side('cancelled'))).toBe('cancelled');
    expect(sideReason(side('boom'))).toBe('other');
  });

  it('被略過的檔案排最後', () => {
    const files = [
      { ...DEMO_REVIEW_DIFF.files[0]!, omitted: true },
      ...DEMO_REVIEW_DIFF.files.slice(1),
    ];
    expect(orderedFiles(files).map((f) => f.omitted)).toEqual([false, false, true]);
  });
});
