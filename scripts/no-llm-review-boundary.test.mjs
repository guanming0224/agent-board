// 交叉審查的 no-llm 界線檢查（scripts/no-llm-review-boundary.mjs）：真的原始碼要通過、每條白名單都真的有對到呼叫點，
// 從排程器、計時器、其他檔案呼叫要抓得到。node --test scripts/no-llm-review-boundary.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkReviewBoundary, enclosing, REVIEW_TRIGGER_RULES } from './no-llm-review-boundary.mjs';

const root = join(import.meta.dirname, '..');
const read = (path) => ({ path, text: readFileSync(join(root, path), 'utf8') });
const REAL = [
  'packages/hub/src/rest.ts',
  'packages/hub/src/reviews.ts',
  'packages/hub/src/hub.ts',
  'packages/hub/src/dispatch.ts',
  'packages/daemon/src/daemon.ts',
  'packages/daemon/src/review.ts',
].map(read);

test('真的原始碼通過，而且每條白名單都對到至少一個呼叫點（不是空轉）', () => {
  assert.deepEqual(checkReviewBoundary(REAL), []);
  for (const rule of REVIEW_TRIGGER_RULES) {
    for (const allowed of rule.allowed) {
      const file = REAL.find((f) => f.path === allowed.file);
      const hits = [...file.text.matchAll(rule.call)].filter(
        (m) => enclosing(file.text, m.index).name === allowed.within,
      );
      assert.ok(hits.length > 0, `${allowed.file} ${allowed.within} 沒有 ${rule.call}`);
    }
  }
});

test('從 hub 的心跳（排程）呼叫 startReview：抓到', () => {
  const hub = {
    path: 'packages/hub/src/hub.ts',
    text: [
      'export class Hub {',
      '  private tick(): void {',
      '    for (const review of this.reviews.list()) {',
      '      this.reviews.startReview(review.id, { kind: "user", id: null, name: "auto" });',
      '    }',
      '  }',
      '}',
    ].join('\n'),
  };
  const problems = checkReviewBoundary([hub]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /hub\.ts:4 在 tick 裡出現/);
});

test('允許的函式裡包一層計時器（延後自動跑）：抓到', () => {
  const rest = {
    path: 'packages/hub/src/rest.ts',
    text: [
      'const handlers = {',
      '    reviewStart: (ctx) => {',
      '      setTimeout(() => hub.reviews.startReview(param(ctx), by), 60_000);',
      '    },',
      '};',
    ].join('\n'),
  };
  const problems = checkReviewBoundary([rest]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /在計時器裡/);
});

test('新的自動流程檔（例如任務自動執行）呼叫 requestByLead、送 review.run：抓到', () => {
  const tasks = {
    path: 'packages/hub/src/tasks.ts',
    text: [
      'export class TaskEngine {',
      '  onDone(task) {',
      '    this.reviews.requestByLead({ lead, teamId, target, reason: "auto" });',
      "    this.send(conn, { type: 'review.run', reviewId: id, claude, codex: null });",
      '  }',
      '}',
    ].join('\n'),
  };
  const problems = checkReviewBoundary([tasks]);
  assert.equal(problems.length, 2);
});

test('daemon 其他檔案出現 -p 或 codex exec：抓到；review.ts 不能 setInterval', () => {
  const problems = checkReviewBoundary([
    { path: 'packages/daemon/src/usage.ts', text: "spawn('claude', ['-p', prompt]);" },
    { path: 'packages/daemon/src/misc.ts', text: "spawn('codex', ['exec', '--json']);" },
    {
      path: 'packages/daemon/src/review.ts',
      text: 'export class ReviewRunner {\n  start() {\n    setInterval(() => this.run(next), 1000);\n  }\n}',
    },
  ]);
  assert.equal(problems.length, 3);
});
