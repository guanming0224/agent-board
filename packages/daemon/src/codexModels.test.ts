// Codex 模型目錄（CONTRACTS §26.11）：daemon 跑 `codex debug models`、只留五個欄位、版本變了才重抓。
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexModels, MachineCapabilities } from '@agent-board/protocol';
import { describe, expect, it } from 'vitest';
import { probeCapabilities, probeCodexModels, refreshCodexCapabilities } from './resources';
import { makeTempDir } from './test-support/harness';

const FIXTURE = join(import.meta.dirname, '../../protocol/src/fixtures/codex-debug-models.json');

/**
 * 假 codex：記下參數；`debug models --help` 印新版說明；`debug models` 印 fixture 加上不該留下的欄位；
 * fail：照常模式失敗、只有 --bundled 成功；old：沒有 debug 子指令的舊版（--help 印主說明，否則把 debug 當成 prompt）。
 */
function fakeCodex(
  dir: string,
  mode: 'ok' | 'fail' | 'garbage' | 'old' = 'ok',
): { bin: string; log: string } {
  const log = join(dir, 'codex-args.log');
  const out = join(dir, 'catalog.json');
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { models: Record<string, unknown>[] };
  writeFileSync(
    out,
    JSON.stringify({
      models: raw.models.map((m) => ({
        ...m,
        base_instructions: 'SYSTEM PROMPT '.repeat(100),
        account_id: 'acct_secret',
        model_messages: { token: 'tok_secret' },
      })),
    }),
  );
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> '${log}'
if [ "$1" = "--version" ]; then echo "codex-cli 0.167.0"; exit 0; fi
if [ "${mode}" = "old" ]; then
  for a in "$@"; do if [ "$a" = "--help" ]; then echo "Codex CLI\nUsage: codex [OPTIONS] [PROMPT]"; exit 0; fi; done
  echo "STARTED SESSION WITH PROMPT $1"; exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ "$3" = "--help" ]; then
  echo "Render the raw model catalog as JSON"; exit 0
fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  if [ "${mode}" = "garbage" ]; then echo "not json"; exit 0; fi
  if [ "${mode}" = "fail" ] && [ "$3" != "--bundled" ]; then echo "boom" >&2; exit 1; fi
  cat '${out}'; exit 0
fi
echo "unexpected $*" >&2
exit 2
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const calls = (log: string) => readFileSync(log, 'utf8').trim().split('\n');

describe.skipIf(process.platform === 'win32')('probeCodexModels（假 codex）', () => {
  it('跑 `codex debug models`，只留五個欄位，帶上版本', async () => {
    const dir = makeTempDir();
    const { bin, log } = fakeCodex(dir);
    const catalog = (await probeCodexModels(bin, process.env, '0.167.0'))!;
    expect(calls(log)).toEqual(['debug models --help', 'debug models']);
    expect(catalog.codexVersion).toBe('0.167.0');
    expect(catalog.models).toHaveLength(12);
    expect(JSON.stringify(catalog)).not.toMatch(/secret|SYSTEM PROMPT|instructions/);
    expect(catalog.models[0]).toEqual({
      slug: 'gpt-6.2-sol',
      displayName: 'GPT-6.2-Sol',
      defaultEffort: 'low',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      visibility: 'list',
    });
  });

  it('照常模式失敗：再試 --bundled（只讀內建目錄）', async () => {
    const dir = makeTempDir();
    const { bin, log } = fakeCodex(dir, 'fail');
    const catalog = await probeCodexModels(bin, process.env, '0.167.0');
    expect(calls(log)).toEqual(['debug models --help', 'debug models', 'debug models --bundled']);
    expect(catalog?.models).toHaveLength(12);
  });

  it('沒有 debug models 的舊版 codex：只跑 --help 就停，不會把 debug 當成 prompt 開對話', async () => {
    const dir = makeTempDir();
    const { bin, log } = fakeCodex(dir, 'old');
    expect(await probeCodexModels(bin, process.env, '0.100.0')).toBeNull();
    expect(calls(log)).toEqual(['debug models --help']);
  });

  it('輸出讀不懂、找不到 codex：null（網頁退回內建清單）', async () => {
    const dir = makeTempDir();
    const { bin } = fakeCodex(dir, 'garbage');
    expect(await probeCodexModels(bin, process.env, '0.167.0')).toBeNull();
    expect(await probeCodexModels(join(dir, 'nope'), process.env, null)).toBeNull();
  });

  it('probeCapabilities：有 codex 就帶目錄；沒有 codex 也帶這個鍵（null）', async () => {
    const dir = makeTempDir();
    const { bin } = fakeCodex(dir);
    const withCodex = await probeCapabilities(join(dir, 'no-claude'), process.env, bin);
    expect(withCodex.codexVersion).toBe('0.167.0');
    expect(withCodex.codexModels?.models).toHaveLength(12);
    const without = await probeCapabilities(join(dir, 'no-claude'), process.env, join(dir, 'nope'));
    expect(without.codexModels).toBeNull();
    expect('codexModels' in without).toBe(true);
  });
});

describe('refreshCodexCapabilities：codex 版本變了才重抓', () => {
  const catalog: CodexModels = { codexVersion: '0.167.0', models: [] };
  const caps = (codexVersion?: string): MachineCapabilities => ({
    hasGpu: false,
    gpuName: null,
    cpuCores: 1,
    memoryBytes: 1,
    claudeVersion: null,
    ...(codexVersion ? { codexVersion } : {}),
    codexModels: codexVersion ? catalog : null,
  });
  const probes = (version: string | null) => {
    const counts = { version: 0, models: 0 };
    return {
      counts,
      probes: {
        version: async () => {
          counts.version++;
          return version;
        },
        models: async (_bin: string, _env: NodeJS.ProcessEnv, v: string | null) => {
          counts.models++;
          return { codexVersion: v, models: [] };
        },
      },
    };
  };

  it('版本沒變：只看 --version，不跑 debug models', async () => {
    const p = probes('0.167.0');
    expect(await refreshCodexCapabilities(caps('0.167.0'), 'codex', {}, p.probes)).toBeNull();
    expect(p.counts).toEqual({ version: 1, models: 0 });
  });

  it('版本變了：重抓並換上新版本', async () => {
    const p = probes('0.168.0');
    expect(await refreshCodexCapabilities(caps('0.167.0'), 'codex', {}, p.probes)).toEqual({
      codexVersion: '0.168.0',
      codexModels: { codexVersion: '0.168.0', models: [] },
    });
    expect(p.counts.models).toBe(1);
  });

  it('剛裝好 codex：抓；codex 被移除：目錄清成 null、不跑 debug models', async () => {
    const installed = probes('0.167.0');
    expect(
      (await refreshCodexCapabilities(caps(), 'codex', {}, installed.probes))?.codexVersion,
    ).toBe('0.167.0');
    const removed = probes(null);
    expect(await refreshCodexCapabilities(caps('0.167.0'), 'codex', {}, removed.probes)).toEqual({
      codexVersion: undefined,
      codexModels: null,
    });
    expect(removed.counts.models).toBe(0);
  });
});
