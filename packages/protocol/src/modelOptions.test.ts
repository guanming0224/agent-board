// 推理強度、備援模型、模型清單（CONTRACTS §26）：白名單、安全字元、新舊版相容。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  effortsFor,
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
  it('依 agent 不同：Claude 有 xhigh／max、沒有 minimal；Codex 相反', () => {
    expect(effortsFor('claude')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor('codex')).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(validEffort('claude', 'max')).toBe(true);
    expect(validEffort('claude', 'minimal')).toBe(false);
    expect(validEffort('codex', 'minimal')).toBe(true);
    expect(validEffort('codex', 'xhigh')).toBe(false);
    expect(validEffort('claude', null)).toBe(false);
    expect(validEffort('claude', 'HIGH')).toBe(false);
  });

  it('備援模型只有 Claude', () => {
    expect(supportsFallbackModel('claude')).toBe(true);
    expect(supportsFallbackModel('codex')).toBe(false);
  });
});

describe('模型名稱的安全字元', () => {
  it.each(['opus', 'claude-opus-5-5', 'opus[1m]', 'gpt-6-luna', 'us.anthropic/x:1', 'a_b.c'])(
    '收 %s',
    (name) => expect(isSafeModelName(name)).toBe(true),
  );
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
    expect(MODEL_LISTS_DEFAULT.claude).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(MODEL_LISTS_DEFAULT.codex).toEqual(['gpt-6-luna']);
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
