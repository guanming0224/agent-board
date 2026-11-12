// Codex 用量（Codex 第二輪，GM 2026-11-12）：格式照本機 codex-cli 0.130–0.167 真實檔案的欄位結構（合成資料）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageDetail } from '@agent-board/protocol';
import { makeTempDir } from './test-support/harness';
import { assertE2eCodexHome } from './daemon';
import { codexFile, scanCodexUsage } from './usage';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const T2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-09T03:00:00Z');
const line = (fields: Record<string, unknown>) => JSON.stringify(fields);

const codexHome = () => {
  const dir = makeTempDir();
  temps.push(dir);
  return dir;
};
const rollout = (home: string, day: string, id: string, lines: string[]) => {
  const [y, m, d] = day.split('-');
  const folder = join(home, 'sessions', y!, m!, d!);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `rollout-${day}T01-02-03-${id}.jsonl`), lines.join('\n'));
};
const meta = (cwd: string) =>
  line({
    timestamp: '2026-11-08T01:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'x', session_id: 'x', cwd, cli_version: '0.167.0', source: 'cli' },
  });
const turn = (model: string) =>
  line({ timestamp: '2026-11-08T01:00:01.000Z', type: 'turn_context', payload: { model } });
const tokens = (
  at: string,
  last: { input: number; cached: number; output: number; reasoning?: number },
  total: number,
) =>
  line({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          cache_write_input_tokens: 0,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          output_tokens: last.output,
          reasoning_output_tokens: last.reasoning ?? 0,
          cache_write_input_tokens: 0,
          total_tokens: last.input + last.output,
        },
        model_context_window: 258400,
      },
      rate_limits: { primary: null, secondary: null },
    },
  });

/** 細項攤平：`日期|模型|thread 前兩字` → [輸入, 輸出, 快取讀, 快取寫]。 */
function flat(detail: UsageDetail): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [d, m, s, ...counts] of detail.rows) {
    const session = s === -1 ? 'other' : detail.sessions[s]!.id.slice(0, 2);
    out[`${detail.days[d]}|${detail.models[m]}|${session}`] = counts;
  }
  return out;
}

describe('scanCodexUsage', () => {
  it('依日期 × 模型 × thread 彙總：輸入扣掉快取、重複的 token_count 與 info null 略過', async () => {
    const home = codexHome();
    rollout(home, '2026-11-08', T1, [
      meta('/work/api'),
      turn('gpt-5-codex'),
      tokens(
        '2026-11-08T02:00:00.000Z',
        { input: 1000, cached: 600, output: 50, reasoning: 20 },
        1050,
      ),
      // 同一個 total 再送一次（實測會有）：不重複算。
      tokens('2026-11-08T02:00:01.000Z', { input: 1000, cached: 600, output: 50 }, 1050),
      line({
        timestamp: '2026-11-08T02:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: null },
      }),
      line({ type: 'response_item', payload: { type: 'message', content: [] } }),
      'not json {',
      turn('gpt-5.1'),
      tokens('2026-11-09T01:00:00.000Z', { input: 2000, cached: 0, output: 100 }, 3150),
    ]);
    rollout(home, '2026-11-09', T2, [
      meta('/work/web'),
      turn('gpt-5-codex'),
      tokens('2026-11-09T02:00:00.000Z', { input: 10, cached: 20, output: 5 }, 15),
    ]);
    const { summary, detail } = await scanCodexUsage(home, NOW, { timeZone: 'UTC' });
    expect(summary).toMatchObject({
      inputTokens: 400 + 2000 + 0,
      outputTokens: 50 + 100 + 5,
      cacheReadTokens: 600 + 0 + 10,
      cacheCreationTokens: 0,
    });
    expect(flat(detail)).toEqual({
      '2026-11-08|gpt-5-codex|aa': [400, 50, 600, 0],
      '2026-11-09|gpt-5.1|aa': [2000, 100, 0, 0],
      // 快取比輸入多（不該發生）：快取最多等於輸入，輸入不會變負數。
      '2026-11-09|gpt-5-codex|bb': [0, 5, 10, 0],
    });
    expect(detail.sessions).toEqual([
      { id: T1, cwd: '/work/api' },
      { id: T2, cwd: '/work/web' },
    ]);
    expect(UsageDetail.safeParse(detail).success).toBe(true);
  });

  it('沒有 sessions 資料夾：空的、不丟例外', async () => {
    const result = await scanCodexUsage(join(codexHome(), 'missing'), NOW, { timeZone: 'UTC' });
    expect(result.detail.rows).toEqual([]);
    expect(result.stats.files).toBe(0);
  });

  it('codexFile：thread id 取自檔名（轉小寫）、不認得的行一律 null', () => {
    const reader = codexFile(`/x/rollout-2026-11-08T01-02-03-${T1.toUpperCase()}.jsonl`);
    expect(reader.sessionId).toBe(T1);
    expect(reader.parse('{"type":"event_msg","payload":{"type":"token_count"}}')).toBeNull();
    expect(reader.parse('{"type":"token_count"')).toBeNull();
    expect(reader.parse('["token_count"]')).toBeNull();
    expect(codexFile('/x/notes.jsonl').sessionId).toBeNull();
  });
});

describe('assertE2eCodexHome（審查 S4）', () => {
  it('e2e 模式下 CODEX_HOME 指到真的 ~/.codex（或沒設）就拒絕；暫存資料夾或非 e2e 照常', () => {
    const home = '/home/someone';
    expect(() => assertE2eCodexHome({ AGENT_BOARD_E2E: '1', HOME: home }, home)).toThrow(
      /CODEX_HOME/,
    );
    expect(() =>
      assertE2eCodexHome({ AGENT_BOARD_E2E: '1', CODEX_HOME: `${home}/.codex/` }, home),
    ).toThrow();
    expect(() =>
      assertE2eCodexHome({ AGENT_BOARD_E2E: '1', CODEX_HOME: '/tmp/ab-codex' }, home),
    ).not.toThrow();
    expect(() => assertE2eCodexHome({ HOME: home }, home)).not.toThrow();
  });
});
