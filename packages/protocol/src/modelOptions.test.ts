// 推理強度、備援模型、模型清單（CONTRACTS §26）：白名單、安全字元、新舊版相容。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  allowedModelOptions,
  effortsFor,
  parseClaudeHelp,
  sameModel,
  isSafeModelName,
  MODEL_LISTS_DEFAULT,
  normalizeModelList,
  supportsFallbackModel,
  validEffort,
} from './modelOptions';
import { MachineCapabilities, Session, Settings } from './models';
import { SettingsPatch } from './rest';
import { DAEMON_FEATURES, SessionSpec } from './ws';

const baseSpec = {
  name: 'n',
  projectId: null,
  cwd: '/p',
  useWorktree: false,
  permissionMode: 'default',
  model: null,
  accountProfile: null,
  resumeClaudeSessionId: null,
  firstPrompt: null,
};

describe('推理強度白名單', () => {
  it('依 agent 不同：Claude 沒有 minimal／ultra；Codex 的安全集合多到 ultra（§26.11）', () => {
    expect(effortsFor('claude')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor('codex')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(validEffort('claude', 'ultra')).toBe(false);
    expect(validEffort('codex', 'ultra')).toBe(true);
    expect(validEffort('codex', 'turbo')).toBe(false);
    expect(validEffort('claude', 'max')).toBe(true);
    expect(validEffort('claude', 'minimal')).toBe(false);
    expect(validEffort('codex', 'minimal')).toBe(true);
    expect(validEffort('codex', 'xhigh')).toBe(true);
    expect(validEffort('claude', null)).toBe(false);
    expect(validEffort('claude', 'HIGH')).toBe(false);
  });

  it('備援模型只有 Claude', () => {
    expect(supportsFallbackModel('claude')).toBe(true);
    expect(supportsFallbackModel('codex')).toBe(false);
  });
});

describe('模型名稱的安全字元', () => {
  it.each([
    'opus',
    'claude-opus-5-5',
    'opus[1m]',
    'gpt-6-luna',
    'us.anthropic/x:1',
    'a_b.c',
    'claude-opus-4-1@20250805',
  ])('收 %s', (name) => expect(isSafeModelName(name)).toBe(true));
  it.each([
    '',
    '-m',
    '--fallback-model',
    'a b',
    'opus;rm',
    'a"b',
    "a'b",
    'a,b',
    'a=b',
    '$HOME',
    'a\nb',
    'x'.repeat(101),
  ])('拒絕 %j', (name) => expect(isSafeModelName(name)).toBe(false));
});

describe('SessionSpec 的新欄位', () => {
  it('選填：舊 hub 送的 spec（沒有這兩個欄位）照樣通過；新值原樣保留', () => {
    expect(SessionSpec.parse(baseSpec)).not.toHaveProperty('effort');
    expect(
      SessionSpec.parse({ ...baseSpec, effort: 'xhigh', fallbackModel: 'sonnet' }),
    ).toMatchObject({ effort: 'xhigh', fallbackModel: 'sonnet' });
    expect(SessionSpec.parse({ ...baseSpec, effort: null, fallbackModel: null })).toMatchObject({
      effort: null,
      fallbackModel: null,
    });
  });

  it('聯集外的強度、不安全的備援名稱：整個 spec 不通過', () => {
    expect(SessionSpec.safeParse({ ...baseSpec, effort: 'turbo' }).success).toBe(false);
    expect(SessionSpec.safeParse({ ...baseSpec, fallbackModel: 'a b' }).success).toBe(false);
    expect(SessionSpec.safeParse({ ...baseSpec, fallbackModel: '-x' }).success).toBe(false);
  });

  it('舊 daemon 的 SessionSpec（沒有這兩個欄位的 z.object）收到新 hub 的 spec：多的欄位丟掉，其他照常', () => {
    const OldSpec = SessionSpec.omit({ effort: true, fallbackModel: true });
    const parsed = OldSpec.parse({ ...baseSpec, effort: 'max', fallbackModel: 'sonnet' });
    expect(parsed).not.toHaveProperty('effort');
    expect(parsed).not.toHaveProperty('fallbackModel');
    expect(parsed.name).toBe('n');
  });

  it('Session、MachineCapabilities 的新欄位都是選填（舊 hub、舊 daemon 不送）', () => {
    const caps = { hasGpu: false, gpuName: null, cpuCores: 1, memoryBytes: 0, claudeVersion: null };
    expect(MachineCapabilities.parse(caps).modelOptions).toBeUndefined();
    expect(MachineCapabilities.parse({ ...caps, modelOptions: true }).modelOptions).toBe(true);
    const shape = Session.shape;
    expect(shape.effort.safeParse(undefined).success).toBe(true);
    expect(shape.fallbackModel.safeParse(undefined).success).toBe(true);
    expect(DAEMON_FEATURES.modelOptions).toBe('session.modelOptions');
  });
});

describe('模型清單（Settings.modelLists）', () => {
  it('舊設定沒有這個鍵＝內建清單；Codex 只放實測過的名稱', () => {
    const settings = Settings.parse({
      listenAddress: '127.0.0.1',
      publicOrigin: null,
      stuckMinutes: 10,
      dangerRules: [],
      quotaGuards: { denyReadPaths: [], maxConcurrentSessions: null, queueWhenRateLimited: true },
      notifications: { enabled: true, quietHours: null },
    });
    expect(settings.modelLists).toEqual(MODEL_LISTS_DEFAULT);
    // §26.11：內建的名稱改由 CLAUDE_MODEL_CATALOG 與 Codex 目錄提供，「自己加的」預設是空的。
    expect(MODEL_LISTS_DEFAULT).toEqual({ claude: [], codex: [] });
  });

  it('SettingsPatch 沒帶就不補預設；名稱一樣只收安全字元、每份最多 30 個', () => {
    expect(SettingsPatch.parse({ dispatch: true })).toEqual({ dispatch: true });
    const ok = { modelLists: { claude: ['opus'], codex: [] } };
    expect(SettingsPatch.parse(ok)).toEqual(ok);
    expect(SettingsPatch.safeParse({ modelLists: { claude: ['a b'], codex: [] } }).success).toBe(
      false,
    );
    const many = Array.from({ length: 31 }, (_, i) => `m${i}`);
    expect(SettingsPatch.safeParse({ modelLists: { claude: many, codex: [] } }).success).toBe(
      false,
    );
    expect(z.array(z.string()).parse(normalizeModelList([' opus', 'opus', '', 'haiku ']))).toEqual([
      'opus',
      'haiku',
    ]);
  });
});

// claude 2.1.326 `--help` 的實際寫法（節錄）。
const HELP_2_1_326 = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session that runs on
                                        the given self-hosted environment
                                        (ccpool_...).
  --fallback-model <model>              Models to fall back to when the main
                                        model is busy or unavailable
                                        (comma-separated, in order). The main
                                        model is tried again at the start of
                                        each turn.
  --file <specs...>                     Files to download at startup.
  --model <model>                       Model for the current session.
`;

describe('claude --help 解析（§26.10）', () => {
  it('2.1.326：五個級別、互動模式的備援', () => {
    expect(parseClaudeHelp(HELP_2_1_326)).toEqual({
      effort: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      fallbackModel: true,
    });
  });

  it('舊版沒有 --effort、備援標「只能配 --print」：都不支援', () => {
    const old = `Options:
  --fallback-model <model>     Enable automatic fallback to specified model when default
                               model is overloaded (only works with --print)
  --model <model>              Model for the current session.
`;
    expect(parseClaudeHelp(old)).toEqual({ effort: false, efforts: null, fallbackModel: false });
    expect(parseClaudeHelp('')).toEqual({ effort: false, efforts: null, fallbackModel: false });
  });

  it('只列到 high（沒有 xhigh、max）；括號讀不到＝null；--effort-xxx 不算 --effort', () => {
    const upToHigh = `Options:
  --effort <level>   Effort level (low, medium, high)
  --model <model>    Model.
`;
    expect(parseClaudeHelp(upToHigh)).toMatchObject({
      effort: true,
      efforts: ['low', 'medium', 'high'],
    });
    const noList = `Options:
  --effort <level>   Effort level for the current session
  --model <model>    Model.
`;
    expect(parseClaudeHelp(noList)).toMatchObject({ effort: true, efforts: null });
    expect(parseClaudeHelp('  --effort-budget <n>  Something (low, high)\n').effort).toBe(false);
  });

  it('allowedModelOptions：Codex 沒給目錄資訊＝舊白名單；Claude 看偵測結果，沒有就都不帶', () => {
    expect(allowedModelOptions('codex', null)).toEqual({
      efforts: ['minimal', 'low', 'medium', 'high'],
      fallback: false,
    });
    expect(allowedModelOptions('claude', null)).toEqual({ efforts: [], fallback: false });
    expect(allowedModelOptions('claude', undefined)).toEqual({ efforts: [], fallback: false });
    expect(
      allowedModelOptions('claude', { effort: true, efforts: null, fallbackModel: true }),
    ).toEqual({ efforts: ['low', 'medium', 'high', 'xhigh', 'max'], fallback: true });
    expect(
      allowedModelOptions('claude', {
        effort: true,
        efforts: ['high', 'low'],
        fallbackModel: false,
      }),
    ).toEqual({ efforts: ['low', 'high'], fallback: false });
  });

  it('MachineCapabilities.claudeFlags 格式不合只丟這個欄位', () => {
    const caps = { hasGpu: false, gpuName: null, cpuCores: 1, memoryBytes: 0, claudeVersion: null };
    expect(MachineCapabilities.parse({ ...caps, claudeFlags: 'bad' }).claudeFlags).toBeNull();
    expect(MachineCapabilities.parse(caps).claudeFlags).toBeUndefined();
  });
});

describe('名稱比對不分大小寫', () => {
  it('sameModel 與清單去重', () => {
    expect(sameModel('Opus', 'opus')).toBe(true);
    expect(sameModel('opus', 'claude-opus-5-5')).toBe(false);
    expect(sameModel(null, 'opus')).toBe(false);
    expect(normalizeModelList(['opus', 'Opus', 'OPUS ', 'haiku'])).toEqual(['opus', 'haiku']);
  });
});
