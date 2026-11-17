// 新增 session 的模型下拉（CONTRACTS §26）：選單值、自訂、換 agent、送出的欄位。
import { describe, expect, it } from 'vitest';
import type { Machine } from '@agent-board/protocol';
import {
  CUSTOM,
  modelSpec,
  optionSupport,
  NO_MODEL,
  onSelect,
  pickError,
  pickForAgent,
  selectValue,
} from './modelChoice';

const LIST = ['fable', 'opus', 'sonnet', 'haiku'];

describe('模型下拉', () => {
  it('選單值：預設、清單項目、自訂；清單沒有的名稱（範本帶來的）也顯示成自訂', () => {
    expect(selectValue(NO_MODEL, LIST)).toBe('');
    expect(selectValue({ value: 'opus', custom: false }, LIST)).toBe('opus');
    expect(selectValue({ value: '', custom: true }, LIST)).toBe(CUSTOM);
    expect(selectValue({ value: 'claude-opus-5-5', custom: false }, LIST)).toBe(CUSTOM);
  });

  it('切到「自訂…」保留目前的名稱，方便改；選回清單項目就不是自訂', () => {
    expect(onSelect({ value: 'opus', custom: false }, CUSTOM)).toEqual({
      value: 'opus',
      custom: true,
    });
    expect(onSelect({ value: 'x', custom: true }, 'haiku')).toEqual({
      value: 'haiku',
      custom: false,
    });
    expect(onSelect({ value: 'x', custom: true }, '')).toEqual(NO_MODEL);
  });

  it('錯誤：自訂沒填、不安全的字元', () => {
    expect(pickError(NO_MODEL)).toBeNull();
    expect(pickError({ value: '  ', custom: true })).toBe('empty');
    expect(pickError({ value: 'a b', custom: true })).toBe('name');
    expect(pickError({ value: ' claude-opus-5-5 ', custom: true })).toBeNull();
  });

  it('換 agent：別家的清單項目清回預設，自訂名稱留著', () => {
    expect(pickForAgent({ value: 'opus', custom: false }, ['gpt-6-luna'])).toEqual(NO_MODEL);
    expect(pickForAgent({ value: 'my-model', custom: true }, ['gpt-6-luna'])).toEqual({
      value: 'my-model',
      custom: true,
    });
    expect(pickForAgent({ value: 'gpt-6-luna', custom: false }, ['gpt-6-luna']).value).toBe(
      'gpt-6-luna',
    );
  });
});

const caps = (extra: object) =>
  ({ capabilities: { modelOptions: true, ...extra } }) as unknown as Machine;
const FULL = { effort: true, efforts: null, fallbackModel: true };

describe('optionSupport：那台機器能帶什麼（§26.10）', () => {
  it('沒選機器照白名單；daemon 太舊都不行；claude 偵測不到也不行', () => {
    expect(optionSupport(undefined, 'claude')).toMatchObject({ fallback: true, reason: null });
    expect(optionSupport({ capabilities: {} } as Machine, 'claude')).toEqual({
      efforts: [],
      fallback: false,
      reason: 'old_daemon',
    });
    expect(optionSupport(caps({ claudeFlags: null }), 'claude')).toEqual({
      efforts: [],
      fallback: false,
      reason: 'old_claude',
    });
    expect(optionSupport(caps({ claudeFlags: FULL }), 'claude').reason).toBeNull();
    // Codex 不看 claude。
    expect(optionSupport(caps({ claudeFlags: null }), 'codex')).toEqual({
      efforts: ['minimal', 'low', 'medium', 'high'],
      fallback: false,
      reason: null,
    });
  });

  it('只認得到 high、備援只能配 --print：只列能用的，提示 old_claude', () => {
    expect(
      optionSupport(
        caps({
          claudeFlags: { effort: true, efforts: ['low', 'medium', 'high'], fallbackModel: false },
        }),
        'claude',
      ),
    ).toEqual({ efforts: ['low', 'medium', 'high'], fallback: false, reason: 'old_claude' });
  });
});

describe('modelSpec：送出的欄位', () => {
  const opus = { value: 'opus', custom: false };
  const sonnet = { value: 'sonnet', custom: false };
  const full = optionSupport(caps({ claudeFlags: FULL }), 'claude');
  const claude = (effort: string, fallback = NO_MODEL, model = opus, support = full) =>
    modelSpec({ model, effort, fallback, support });

  it('Claude：三個都帶；強度不在白名單不帶；備援和主模型相同（不分大小寫）不帶', () => {
    expect(claude('max', sonnet)).toEqual({
      model: 'opus',
      effort: 'max',
      fallbackModel: 'sonnet',
    });
    expect(claude('minimal', opus)).toEqual({ model: 'opus' });
    expect(claude('', { value: 'OPUS', custom: true })).toEqual({ model: 'opus' });
    expect(claude('', NO_MODEL, NO_MODEL)).toEqual({ model: null });
  });

  it('Codex：沒有備援；強度用 Codex 的白名單', () => {
    const support = optionSupport(caps({}), 'codex');
    const codex = (effort: string) =>
      modelSpec({
        model: { value: 'gpt-6-luna', custom: false },
        effort,
        fallback: sonnet,
        support,
      });
    expect(codex('minimal')).toEqual({ model: 'gpt-6-luna', effort: 'minimal' });
    expect(codex('xhigh')).toEqual({ model: 'gpt-6-luna' });
  });

  it('daemon 太舊或 claude 不認得：只送模型', () => {
    expect(
      claude('high', sonnet, opus, optionSupport({ capabilities: {} } as Machine, 'claude')),
    ).toEqual({
      model: 'opus',
    });
    expect(
      claude('high', sonnet, opus, optionSupport(caps({ claudeFlags: null }), 'claude')),
    ).toEqual({
      model: 'opus',
    });
  });
});
