import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_1M,
  CONTEXT_200K,
  contextWindowForModel,
  readLastTurn,
  resolveContextWindow,
} from './contextWindow';
import { makeTempDir } from './test-support/harness';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('contextWindowForModel', () => {
  it.each([
    ['claude-opus-5-5', CONTEXT_1M],
    ['claude-opus-5', CONTEXT_1M],
    ['claude-sonnet-4-6', CONTEXT_200K],
    ['claude-haiku-4-5-20251001', CONTEXT_200K],
    ['claude-opus-4-1-20250805', CONTEXT_200K],
    ['us.anthropic.claude-sonnet-5-v1:0', CONTEXT_1M],
    ['claude-sonnet-4-6[1m]', CONTEXT_1M],
    ['sonnet[1m]', CONTEXT_1M],
    ['opus[1M]', CONTEXT_1M],
  ])('%s → %d', (model, window) => {
    expect(contextWindowForModel(model)).toBe(window);
  });

  it('較短的 id 不會吃掉較長的版本（claude-opus-5 對 claude-opus-5-5），日期後綴不算版本', () => {
    expect(contextWindowForModel('claude-opus-4-6')).toBe(CONTEXT_200K);
    expect(contextWindowForModel('claude-opus-4-6-20260101')).toBe(CONTEXT_200K);
  });

  it.each([null, '', 'opus', 'sonnet', 'default', 'claude-unknown-9', '<synthetic>'])(
    '不知道就回 null，不猜：%s',
    (model) => {
      expect(contextWindowForModel(model)).toBeNull();
    },
  );
});

describe('resolveContextWindow', () => {
  const none = { hookModel: null, specModel: null, transcriptModel: null, contextTokens: null };

  it('hook 的模型優先，其次對話紀錄，最後指定的模型', () => {
    expect(
      resolveContextWindow({
        ...none,
        hookModel: 'claude-opus-4-6',
        transcriptModel: 'claude-opus-5',
      }),
    ).toBe(CONTEXT_200K);
    expect(
      resolveContextWindow({ ...none, specModel: 'opus', transcriptModel: 'claude-opus-5' }),
    ).toBe(CONTEXT_1M);
    expect(resolveContextWindow({ ...none, specModel: 'claude-sonnet-4-6' })).toBe(CONTEXT_200K);
  });

  it('指定 [1m] 時對話紀錄只寫基本 id，仍是 1M', () => {
    expect(
      resolveContextWindow({
        ...none,
        specModel: 'sonnet[1m]',
        transcriptModel: 'claude-sonnet-4-6',
      }),
    ).toBe(CONTEXT_1M);
  });

  it('別名、沒指定都不知道就是 null；用量超過 200k 就一定是 1M', () => {
    expect(resolveContextWindow({ ...none, specModel: 'opus' })).toBeNull();
    expect(resolveContextWindow(none)).toBeNull();
    expect(resolveContextWindow({ ...none, contextTokens: 250_000 })).toBe(CONTEXT_1M);
    expect(
      resolveContextWindow({ ...none, hookModel: 'claude-opus-4-6', contextTokens: 250_000 }),
    ).toBe(CONTEXT_1M);
  });
});

describe('readLastTurn', () => {
  function transcript(lines: unknown[], raw = ''): string {
    const dir = makeTempDir();
    temps.push(dir);
    const file = join(dir, 't.jsonl');
    writeFileSync(file, raw + lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }
  const assistant = (model: string, usage: Record<string, number>, extra = {}) => ({
    type: 'assistant',
    message: { id: 'm', model, usage },
    ...extra,
  });

  it('取最後一則主線回覆：input + cache 讀 + cache 寫，加上模型', async () => {
    const file = transcript([
      assistant('claude-opus-5', { input_tokens: 1, cache_read_input_tokens: 2 }),
      { type: 'user', message: { content: 'hi' } },
      assistant('claude-opus-5-5', {
        input_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
        output_tokens: 99,
      }),
      assistant('claude-haiku-4-5', { input_tokens: 5 }, { isSidechain: true }),
      assistant('<synthetic>', { input_tokens: 0 }),
    ]);
    expect(await readLastTurn(file)).toEqual({ contextTokens: 1210, model: 'claude-opus-5-5' });
  });

  it('壞掉的行、被切開的開頭都略過；讀不到檔案或沒有回覆回 null', async () => {
    const file = transcript(
      [assistant('claude-opus-5', { input_tokens: 7 }), { type: 'user' }],
      '{"type":"assistant","usage" broken\n',
    );
    expect(await readLastTurn(file)).toEqual({ contextTokens: 7, model: 'claude-opus-5' });
    expect(await readLastTurn(transcript([{ type: 'user' }]))).toBeNull();
    expect(await readLastTurn('/nonexistent/file.jsonl')).toBeNull();
  });
});
