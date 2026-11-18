// 模型目錄（CONTRACTS §26.11）：解析 `codex debug models`、欄位過濾、強度依模型、Claude 內建清單、隱藏／釘選的存法。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL_CATALOG, CODEX_MODELS_FALLBACK, codexSeries } from './modelCatalog';
import {
  allowedModelOptions,
  CODEX_CATALOG_MAX_BYTES,
  CODEX_MODELS_MAX,
  codexEffortsFor,
  CodexModels,
  findCodexModel,
  isSafeModelName,
  ModelLists,
  parseCodexModelCatalog,
} from './modelOptions';
import { MachineCapabilities, Settings } from './models';
import { SettingsPatch } from './rest';
import { DAEMON_FEATURES, SessionSpec } from './ws';

// 2026-11-18 開發機 codex-cli 0.167.0 實際跑 `codex debug models` 的輸出，只留五個欄位（原始約 830KB）。
const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/codex-debug-models.json'), 'utf8');

describe('parseCodexModelCatalog（真實輸出）', () => {
  const models = parseCodexModelCatalog(FIXTURE)!;

  it('12 個模型、照目錄順序、只有五個欄位', () => {
    expect(models.map((m) => m.slug)).toEqual([
      'gpt-6.2-sol',
      'gpt-6.2-astra',
      'gpt-6.1-terra',
      'gpt-reserve',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'codex-auto-review',
    ]);
    for (const m of models) {
      expect(Object.keys(m).sort()).toEqual([
        'defaultEffort',
        'displayName',
        'efforts',
        'slug',
        'visibility',
      ]);
    }
    expect(models.filter((m) => m.visibility === 'hide').map((m) => m.slug)).toEqual([
      'gpt-reserve',
      'codex-auto-review',
    ]);
  });

  it('強度依模型：gpt-6.2-sol 到 ultra、預設 low；gpt-6-luna 到 max、預設 medium', () => {
    expect(models[0]).toEqual({
      slug: 'gpt-6.2-sol',
      displayName: 'GPT-6.2-Sol',
      defaultEffort: 'low',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      visibility: 'list',
    });
    expect(models.find((m) => m.slug === 'gpt-6-luna')).toMatchObject({
      defaultEffort: 'medium',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    // 通過 capabilities 的 schema（hub 收 hello 時驗）。
    expect(CodexModels.parse({ codexVersion: '0.167.0', models }).models).toHaveLength(12);
  });
});

describe('parseCodexModelCatalog（欄位過濾與壞資料）', () => {
  const one = (model: Record<string, unknown>) =>
    parseCodexModelCatalog(JSON.stringify({ models: [model] }));

  it('其他欄位一律丟掉（含帳號、提示、價格這類）', () => {
    const [m] = one({
      slug: 'gpt-x',
      display_name: 'GPT X',
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'high'],
      visibility: 'list',
      base_instructions: 'very long system prompt',
      account_id: 'acct_123',
      access_token: 'secret',
      supported_in_api: true,
    })!;
    expect(m).toEqual({
      slug: 'gpt-x',
      displayName: 'GPT X',
      defaultEffort: 'high',
      efforts: ['low', 'high'],
      visibility: 'list',
    });
    expect(JSON.stringify(m)).not.toMatch(/secret|acct_|instructions/);
  });

  it('強度元素可以是字串或 { effort }；白名單外的級別丟掉、照白名單排序、去重', () => {
    expect(
      one({
        slug: 'a',
        supported_reasoning_levels: [
          { effort: 'ultra' },
          'low',
          'turbo',
          'low',
          { effort: 'rm -rf' },
          42,
        ],
      })![0]!.efforts,
    ).toEqual(['low', 'ultra']);
  });

  it('沒列強度＝null（不知道）；預設強度不在白名單＝null；顯示名稱沒有就用 slug、控制字元拿掉', () => {
    expect(one({ slug: 'a', default_reasoning_level: 'turbo' })![0]).toEqual({
      slug: 'a',
      displayName: 'a',
      defaultEffort: null,
      efforts: null,
      visibility: 'hide',
    });
    expect(one({ slug: 'a', display_name: 'A\u0007\nB' })![0]!.displayName).toBe('A B');
    // 雙向控制字元（\p{Cf}）也拿掉，名稱才不會在畫面上被反轉。
    expect(one({ slug: 'a', display_name: 'GPT\u202Eevil\u200B' })![0]!.displayName).toBe(
      'GPT evil',
    );
    expect(one({ slug: 'a', supported_reasoning_levels: [] })![0]!.efforts).toBeNull();
    expect(one({ slug: 'a', display_name: 'x'.repeat(200) })![0]!.displayName).toHaveLength(80);
  });

  it('slug 不安全的整筆略過、重複的略過（不分大小寫）；不是物件的略過', () => {
    const list = parseCodexModelCatalog(
      JSON.stringify({
        models: [
          { slug: '--danger' },
          { slug: 'has space' },
          { slug: 'gpt"q' },
          null,
          'gpt-y',
          { slug: 'GPT-Z' },
          { slug: 'gpt-z' },
        ],
      }),
    )!;
    expect(list.map((m) => m.slug)).toEqual(['GPT-Z']);
  });

  it('讀不懂回 null；太大回 null；最多留 CODEX_MODELS_MAX 個', () => {
    expect(parseCodexModelCatalog('not json')).toBeNull();
    expect(parseCodexModelCatalog('{"data":[]}')).toBeNull();
    expect(parseCodexModelCatalog('null')).toBeNull();
    expect(parseCodexModelCatalog(' '.repeat(CODEX_CATALOG_MAX_BYTES + 1))).toBeNull();
    const many = Array.from({ length: CODEX_MODELS_MAX + 5 }, (_, i) => ({ slug: `m${i}` }));
    expect(parseCodexModelCatalog(JSON.stringify({ models: many }))).toHaveLength(CODEX_MODELS_MAX);
  });
});

describe('Codex 強度依模型（hub、daemon、網頁共用）', () => {
  const catalog: CodexModels = {
    codexVersion: '0.167.0',
    models: parseCodexModelCatalog(FIXTURE)!,
  };

  it('目錄有列：取交集；沒指定模型：list 模型的交集；不在目錄、沒有目錄：舊安全集合（不 fail-open）', () => {
    expect(codexEffortsFor('gpt-6-luna', catalog)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(codexEffortsFor('GPT-6.2-SOL', catalog)).toContain('ultra');
    const legacy = ['minimal', 'low', 'medium', 'high'];
    expect(codexEffortsFor('gpt-unknown', catalog)).toEqual(legacy);
    // 真實目錄 visibility=list 的 10 個：有的只到 max，所以交集是 low～max（hide 的 gpt-reserve 等不算）。
    expect(codexEffortsFor(null, catalog)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(codexEffortsFor('gpt-6-luna', null)).toEqual(legacy);
    expect(codexEffortsFor(null, null)).toEqual(legacy);
    expect(codexEffortsFor(null, { codexVersion: null, models: [] })).toEqual(legacy);
    // 有列級別但和白名單交集是空的：空陣列（這個模型帶不了強度）。
    const odd = parseCodexModelCatalog(
      JSON.stringify({
        models: [{ slug: 'gpt-odd', supported_reasoning_levels: ['turbo'], visibility: 'list' }],
      }),
    )!;
    expect(odd[0]!.efforts).toEqual([]);
    expect(codexEffortsFor('gpt-odd', { codexVersion: null, models: odd })).toEqual([]);
    expect(codexEffortsFor(null, { codexVersion: null, models: odd })).toEqual([]);
    expect(findCodexModel(catalog, 'Gpt-6-Luna')?.slug).toBe('gpt-6-luna');
  });

  it('allowedModelOptions：daemon 沒宣告依模型＝舊白名單；宣告了＝看目錄', () => {
    expect(
      allowedModelOptions('codex', null, { model: 'gpt-6-luna', catalog, byModel: false }).efforts,
    ).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(
      allowedModelOptions('codex', null, { model: 'gpt-6-luna', catalog, byModel: true }).efforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(
      allowedModelOptions('codex', null, { model: 'gpt-6.2-sol', catalog: null, byModel: true })
        .efforts,
    ).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('SessionSpec 收 ultra；daemon 宣告旗標；capabilities 的 codexModels 壞掉只丟這個欄位', () => {
    expect(
      SessionSpec.parse({
        name: 'n',
        projectId: null,
        cwd: '/p',
        useWorktree: false,
        permissionMode: 'default',
        model: 'gpt-6.2-sol',
        effort: 'ultra',
        accountProfile: null,
        resumeClaudeSessionId: null,
        firstPrompt: null,
      }).effort,
    ).toBe('ultra');
    expect(DAEMON_FEATURES.codexEffortsByModel).toBe('session.codexEffortsByModel');
    const base = { hasGpu: false, gpuName: null, cpuCores: 4, memoryBytes: 1, claudeVersion: '1' };
    expect(MachineCapabilities.parse(base).codexModels).toBeUndefined();
    expect(MachineCapabilities.parse({ ...base, codexModels: null }).codexModels).toBeNull();
    expect(MachineCapabilities.parse({ ...base, codexModels: catalog }).codexModels).toEqual(
      catalog,
    );
    expect(
      MachineCapabilities.parse({ ...base, codexModels: { models: [{ slug: '--x' }] } }),
    ).toMatchObject({ ...base, codexModels: null });
  });
});

describe('Claude 內建清單', () => {
  it('四個別名＋四個完整版本，名稱都是安全字元、不重複', () => {
    expect(CLAUDE_MODEL_CATALOG.filter((m) => m.kind === 'alias').map((m) => m.name)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ]);
    expect(CLAUDE_MODEL_CATALOG.filter((m) => m.kind === 'version').map((m) => m.name)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    const names = CLAUDE_MODEL_CATALOG.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(isSafeModelName)).toBe(true);
  });

  it('每項有中英說明；Fable 只寫中性的系列說明', () => {
    for (const m of CLAUDE_MODEL_CATALOG) {
      expect(m.note.zh.length).toBeGreaterThan(0);
      expect(m.note.en.length).toBeGreaterThan(0);
    }
    const opus = CLAUDE_MODEL_CATALOG.find((m) => m.name === 'opus')!;
    expect(opus.note.zh).toBe('能力最強，較慢、較耗額度');
    expect(CLAUDE_MODEL_CATALOG.find((m) => m.name === 'sonnet')!.note.zh).toBe('速度與能力平衡');
    expect(CLAUDE_MODEL_CATALOG.find((m) => m.name === 'haiku')!.note.zh).toBe('最快、最省額度');
    expect(CLAUDE_MODEL_CATALOG.find((m) => m.name === 'fable')!.note.zh).toBe('Fable 系列');
  });

  it('Codex 內建名單：名稱安全、不標強度；系列分組', () => {
    expect(CodexModels.parse(CODEX_MODELS_FALLBACK)).toEqual(CODEX_MODELS_FALLBACK);
    expect(
      CODEX_MODELS_FALLBACK.models.every((m) => m.efforts === null && m.defaultEffort === null),
    ).toBe(true);
    expect(codexSeries('gpt-6.2-sol')).toBe('GPT-6.2');
    expect(codexSeries('gpt-6-luna')).toBe('GPT-6');
    expect(codexSeries('codex-auto-review')).toBeNull();
  });
});

describe('隱藏／釘選的存法（Settings.modelLists，不升 schema）', () => {
  it('舊資料沒有 pinned／hidden 照樣讀；新資料原樣保留', () => {
    const old = Settings.shape.modelLists.parse(undefined);
    expect(old.pinned).toBeUndefined();
    expect(ModelLists.parse({ claude: ['opus'], codex: [] })).toEqual({
      claude: ['opus'],
      codex: [],
    });
    const next = {
      claude: [],
      codex: ['my-model'],
      pinned: { claude: ['claude-opus-5-5'], codex: ['gpt-6-luna'] },
      hidden: { claude: ['haiku'], codex: ['codex-auto-review'] },
    };
    expect(ModelLists.parse(next)).toEqual(next);
    expect(SettingsPatch.parse({ modelLists: next }).modelLists).toEqual(next);
  });

  it('名稱一樣只收安全字元', () => {
    expect(
      ModelLists.safeParse({ claude: [], codex: [], pinned: { claude: ['a b'], codex: [] } })
        .success,
    ).toBe(false);
  });

  it('舊版的 schema（沒有 pinned／hidden）讀新資料：多的鍵丟掉，不會失敗', async () => {
    const { z } = await import('zod');
    const OldModelLists = z.object({ claude: z.array(z.string()), codex: z.array(z.string()) });
    expect(
      OldModelLists.parse({ claude: ['opus'], codex: [], pinned: { claude: ['opus'], codex: [] } }),
    ).toEqual({ claude: ['opus'], codex: [] });
  });
});
