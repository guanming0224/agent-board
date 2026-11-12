// demo／e2e 用的交叉審查（Codex 第二輪）。規則和 hub 的 ReviewEngine 一樣：prepare 只產生 diff 摘要
// （停在 awaiting_confirm），start 後兩邊各自跑；Windows 機器只跑 Claude、沒裝 codex 的機器 Codex 略過。
// 假的結果是固定文字，Claude 先完成、Codex 稍後完成（REVIEW_FAKE_DELAYS_MS）。
import {
  pendingSide,
  REVIEW_INSTRUCTIONS_VERSION,
  reviewSideFinished,
  type Machine,
  type Review,
  type ReviewDiffSummary,
  type ReviewSide,
  type ReviewTargetInput,
  type Session,
} from '@agent-board/protocol';

/** 兩邊多久後完成（毫秒）：Claude 先、Codex 後。 */
export const REVIEW_FAKE_DELAYS_MS = { claude: 600, codex: 1400 } as const;

export const DEMO_REVIEW_DIFF: ReviewDiffSummary = {
  files: [
    {
      path: 'src/auth/login.ts',
      status: 'modified',
      additions: 42,
      deletions: 7,
      bytes: 3_812,
      truncated: false,
      omitted: false,
    },
    {
      path: 'src/auth/session.test.ts',
      status: 'added',
      additions: 88,
      deletions: 0,
      bytes: 4_120,
      truncated: false,
      omitted: false,
    },
    {
      path: 'fixtures/large-snapshot.json',
      status: 'untracked',
      additions: 5_200,
      deletions: 0,
      bytes: 204_800,
      truncated: true,
      omitted: false,
    },
  ],
  additions: 5_330,
  deletions: 7,
  totalBytes: 212_732,
  truncated: true,
};

const DEMO_OUTPUT: Record<'claude' | 'codex', string> = {
  claude: [
    '1. 嚴重問題',
    '- src/auth/login.ts:58：登入失敗後沒有清掉舊的 session cookie，重新導向時會再次帶入過期的 token。',
    '',
    '2. 建議',
    '- session.test.ts 補一個「cookie 過期」的情境。',
    '- fixtures/large-snapshot.json 太大，建議改成產生器。',
    '',
    '3. 整體結論',
    '修掉 login.ts:58 的 cookie 問題後可以合併。',
  ].join('\n'),
  codex: [
    '1. 嚴重問題',
    '無',
    '',
    '2. 建議',
    '- login.ts 的 redirect 參數沒有檢查是否為同站網址，建議加白名單。',
    '',
    '3. 整體結論',
    '沒有阻擋合併的問題，建議補上 redirect 檢查。',
  ].join('\n'),
};

export interface FakeReviewDeps {
  sessions(): readonly Session[];
  machines(): readonly Machine[];
  publish(): void;
  userName: string;
}

export function createFakeReviews(deps: FakeReviewDeps) {
  let reviews: Review[] = [];
  const now = () => new Date().toISOString();
  const find = (id: string) => {
    const review = reviews.find((r) => r.id === id);
    if (!review) throw Object.assign(new Error('Review not found'), { code: 'not_found' });
    return review;
  };
  const put = (review: Review) => {
    reviews = reviews.some((r) => r.id === review.id)
      ? reviews.map((r) => (r.id === review.id ? review : r))
      : [review, ...reviews];
    deps.publish();
    return review;
  };

  const finishSide = (id: string, agent: 'claude' | 'codex') => {
    const review = reviews.find((r) => r.id === id);
    if (!review || review.status !== 'running' || reviewSideFinished(review[agent])) return;
    const side: ReviewSide = {
      ...review[agent],
      status: 'done',
      output: DEMO_OUTPUT[agent],
      error: null,
      inputTokens: agent === 'claude' ? 18_240 : 15_310,
      outputTokens: agent === 'claude' ? 612 : 488,
      durationMs: REVIEW_FAKE_DELAYS_MS[agent] * 40,
    };
    const next = { ...review, [agent]: side };
    const done = reviewSideFinished(next.claude) && reviewSideFinished(next.codex);
    put(done ? { ...next, status: 'done', completedAt: now() } : next);
  };

  return {
    list: () => reviews,
    async get(id: string) {
      return find(id);
    },
    async prepare(target: ReviewTargetInput, reason?: string): Promise<Review> {
      let machineId: string;
      let label: string;
      let sessionId: string | null = null;
      let cwd: string;
      let branch: string | null = null;
      let base: string | null = null;
      if (target.kind === 'session') {
        const s = deps.sessions().find((x) => x.id === target.sessionId);
        if (!s) throw Object.assign(new Error('Session not found'), { code: 'not_found' });
        machineId = s.machineId;
        label = `${s.name}: uncommitted changes`;
        sessionId = s.id;
        cwd = s.cwd;
        branch = s.branch;
      } else {
        machineId = target.machineId;
        const name = target.repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? target.repoPath;
        label = `${name}: ${target.branch} vs ${target.base}`;
        cwd = target.repoPath;
        branch = target.branch;
        base = target.base;
      }
      const machine = deps.machines().find((m) => m.id === machineId);
      if (!machine?.online) {
        throw Object.assign(new Error('Machine is offline'), { code: 'machine_offline' });
      }
      return put({
        id: crypto.randomUUID(),
        requestedBy: { kind: 'user', id: 'u-demo', name: deps.userName },
        teamId: null,
        reason: reason ?? '',
        machineId,
        target: { kind: target.kind, label, sessionId, cwd, branch, base },
        status: 'awaiting_confirm',
        error: null,
        diff: DEMO_REVIEW_DIFF,
        claude: pendingSide('claude'),
        codex: pendingSide('codex'),
        instructionsVersion: REVIEW_INSTRUCTIONS_VERSION,
        read: false,
        createdAt: now(),
        startedAt: null,
        completedAt: null,
      });
    },
    async start(id: string): Promise<Review> {
      const review = find(id);
      if (review.status !== 'awaiting_confirm') {
        throw Object.assign(new Error('Review is not waiting for confirmation'), {
          code: 'review_not_ready',
        });
      }
      const machine = deps.machines().find((m) => m.id === review.machineId);
      const codexSkip =
        machine?.os === 'win32'
          ? 'windows: Codex is not available on Windows machines yet; only Claude reviewed this change.'
          : !machine?.capabilities.codexVersion
            ? 'codex_unavailable: Codex CLI was not found on this machine.'
            : null;
      const started = put({
        ...review,
        status: 'running',
        startedAt: now(),
        claude: { ...pendingSide('claude'), status: 'running', model: null },
        codex: codexSkip
          ? { ...pendingSide('codex'), status: 'skipped', error: codexSkip }
          : { ...pendingSide('codex'), status: 'running', model: null },
      });
      setTimeout(() => finishSide(id, 'claude'), REVIEW_FAKE_DELAYS_MS.claude);
      if (!codexSkip) setTimeout(() => finishSide(id, 'codex'), REVIEW_FAKE_DELAYS_MS.codex);
      return started;
    },
    async cancel(id: string): Promise<Review> {
      const review = find(id);
      if (['done', 'failed', 'cancelled'].includes(review.status)) return review;
      const stop = (side: ReviewSide): ReviewSide =>
        reviewSideFinished(side) ? side : { ...side, status: 'failed', error: 'cancelled' };
      return put({
        ...review,
        status: 'cancelled',
        completedAt: now(),
        claude: stop(review.claude),
        codex: stop(review.codex),
      });
    },
    async read(ids?: string[]): Promise<Review[]> {
      reviews = reviews.map((r) => (!ids || ids.includes(r.id) ? { ...r, read: true } : r));
      deps.publish();
      return reviews;
    },
    /** 測試／demo：直接放一筆（例如隊長發起的）。 */
    seed(review: Review) {
      put(review);
    },
  };
}
