// 模型下拉的分組、Codex 目錄、隱藏／釘選、強度依模型（CONTRACTS §26.11）。
import { describe, expect, it } from 'vitest';
import {
  CODEX_MODELS_FALLBACK,
  type CodexModels,
  type Machine,
  type ModelLists,
} from '@agent-board/protocol';
import {
  codexCatalogFor,
  codexDefaultEffort,
  mergedCodexCatalog,
  modelMenu,
  modelSpec,
  NO_MODEL,
  optionSupport,
} from './modelChoice';

const caps = (extra: object) =>
  ({ capabilities: { modelOptions: true, ...extra } }) as unknown as Machine;

const CATALOG: CodexModels = {
  codexVersion: '0.167.0',
  models: [
    {
      slug: 'gpt-6.2-sol',
      displayName: 'GPT-6.2-Sol',
      defaultEffort: 'low',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      visibility: 'list',
    },
    {
      slug: 'gpt-6-luna',
      displayName: 'GPT-6-Luna',
      defaultEffort: 'medium',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      visibility: 'list',
    },
    {
      slug: 'codex-auto-review',
      displayName: 'Codex Auto Review',
      defaultEffort: 'medium',
      efforts: ['low', 'medium'],
      visibility: 'hide',
    },
  ],
};
const LISTS: ModelLists = {
  claude: ['fable', 'opus', 'my-claude'],
  codex: ['gpt-6-luna', 'my-codex'],
};

const shape = (menu: ReturnType<typeof modelMenu>) =>
  menu.groups.map((g) => [g.series ?? g.key, g.items.map((i) => i.value)]);

describe('modelMenu：分組與隱藏／釘選', () => {
  it('Claude：別名、完整版本、自己加的（內建已有的不重複）；每項有說明', () => {
    const menu = modelMenu('claude', LISTS, CATALOG);
    expect(shape(menu)).toEqual([
      ['alias', ['fable', 'opus', 'sonnet', 'haiku']],
      ['version', ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']],
      ['mine', ['my-claude']],
    ]);
    expect(menu.groups[0]!.items[1]).toMatchObject({
      label: 'Opus',
      note: { zh: '能力最強，較慢、較耗額度' },
    });
    expect(menu.names).toContain('claude-opus-5-5');
  });

  it('Codex：依系列分組、目錄標 hide 的放後面、預設強度帶著；自己加的在最後', () => {
    const menu = modelMenu('codex', LISTS, CATALOG);
    expect(shape(menu)).toEqual([
      ['GPT-6.2', ['gpt-6.2-sol']],
      ['GPT-6', ['gpt-6-luna']],
      ['codexHidden', ['codex-auto-review']],
      ['mine', ['my-codex']],
    ]);
    expect(menu.groups[1]!.items[0]).toMatchObject({
      label: 'GPT-6-Luna',
      defaultEffort: 'medium',
    });
  });

  it('釘選排最上面（照釘的順序、不分大小寫）、隱藏的拿掉；又釘又藏以隱藏為準', () => {
    const lists: ModelLists = {
      ...LISTS,
      pinned: {
        claude: ['Claude-Opus-5-5', 'my-claude'],
        codex: ['gpt-6-luna', 'codex-auto-review'],
      },
      hidden: {
        claude: ['haiku', 'claude-haiku-5-5', 'my-claude'],
        codex: ['codex-auto-review'],
      },
    };
    expect(shape(modelMenu('claude', lists, CATALOG))).toEqual([
      ['pinned', ['claude-opus-5-5']],
      ['alias', ['fable', 'opus', 'sonnet']],
      ['version', ['claude-fable-5-1', 'claude-sonnet-5-5']],
    ]);
    expect(shape(modelMenu('codex', lists, CATALOG))).toEqual([
      ['pinned', ['gpt-6-luna']],
      ['GPT-6.2', ['gpt-6.2-sol']],
      ['mine', ['my-codex']],
    ]);
  });

  it('舊格式（沒有 pinned／hidden）照樣用', () => {
    expect(modelMenu('claude', { claude: [], codex: [] }, CATALOG).names).toHaveLength(8);
  });
});

describe('Codex 目錄來源', () => {
  it('那台有就用那台，沒有（舊 daemon、抓不到）用內建；設定頁合併所有機器', () => {
    const withCatalog = caps({ codexModels: CATALOG });
    expect(codexCatalogFor(withCatalog)).toEqual({ catalog: CATALOG, source: 'machine' });
    expect(codexCatalogFor(caps({ codexModels: null })).source).toBe('builtin');
    expect(codexCatalogFor(caps({})).catalog).toBe(CODEX_MODELS_FALLBACK);
    expect(codexCatalogFor(undefined).source).toBe('builtin');
    const other = caps({
      codexModels: {
        codexVersion: null,
        models: [
          { ...CATALOG.models[0]!, displayName: 'dup' },
          {
            slug: 'gpt-7-x',
            displayName: 'X',
            defaultEffort: null,
            efforts: null,
            visibility: 'list',
          },
        ],
      },
    });
    expect(mergedCodexCatalog([withCatalog, other]).models.map((m) => m.slug)).toEqual([
      'gpt-6.2-sol',
      'gpt-6-luna',
      'codex-auto-review',
      'gpt-7-x',
    ]);
    expect(mergedCodexCatalog([caps({})])).toBe(CODEX_MODELS_FALLBACK);
    expect(codexDefaultEffort(withCatalog, 'GPT-6-LUNA')).toBe('medium');
    expect(codexDefaultEffort(caps({}), 'gpt-6-luna')).toBeNull();
  });
});

describe('optionSupport：Codex 強度依模型（§26.11）', () => {
  it('daemon 帶了目錄：只列該模型支援的；不在目錄、沒指定模型列整份；舊 daemon（沒有這個鍵）只列舊白名單', () => {
    const m = caps({ codexModels: CATALOG });
    expect(optionSupport(m, 'codex', 'gpt-6-luna').efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(optionSupport(m, 'codex', 'gpt-6.2-sol').efforts).toContain('ultra');
    expect(optionSupport(m, 'codex', 'something-else').efforts).toHaveLength(7);
    expect(optionSupport(m, 'codex', null).efforts).toHaveLength(7);
    expect(optionSupport(caps({ codexModels: null }), 'codex', 'gpt-6-luna').efforts).toHaveLength(
      7,
    );
    expect(optionSupport(caps({}), 'codex', 'gpt-6.2-sol').efforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(
      modelSpec({
        model: { value: 'gpt-6-luna', custom: false },
        effort: 'ultra',
        fallback: NO_MODEL,
        support: optionSupport(m, 'codex', 'gpt-6-luna'),
      }),
    ).toEqual({ model: 'gpt-6-luna' });
  });
});
