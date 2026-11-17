// 新增 session 的模型下拉（CONTRACTS §26）：選單值、自訂、換 agent、送出的欄位。
import { describe, expect, it } from 'vitest';
import type { Machine } from '@agent-board/protocol';
import {
  CUSTOM,
  modelOptionsSupported,
  modelSpec,
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

describe('modelSpec：送出的欄位', () => {
  const opus = { value: 'opus', custom: false };
  const sonnet = { value: 'sonnet', custom: false };
  const claude = (effort: string, fallback = NO_MODEL, model = opus, supported = true) =>
    modelSpec({ agent: 'claude', model, effort, fallback, supported });

  it('Claude：三個都帶；強度不在白名單不帶；備援和主模型相同不帶', () => {
    expect(claude('max', sonnet)).toEqual({
      model: 'opus',
      effort: 'max',
      fallbackModel: 'sonnet',
    });
    expect(claude('minimal', opus)).toEqual({ model: 'opus' });
    expect(claude('', NO_MODEL, NO_MODEL)).toEqual({ model: null });
  });

  it('Codex：沒有備援；強度用 Codex 的白名單', () => {
    const codex = (effort: string) =>
      modelSpec({
        agent: 'codex',
        model: { value: 'gpt-6-luna', custom: false },
        effort,
        fallback: sonnet,
        supported: true,
      });
    expect(codex('minimal')).toEqual({ model: 'gpt-6-luna', effort: 'minimal' });
    expect(codex('xhigh')).toEqual({ model: 'gpt-6-luna' });
  });

  it('daemon 太舊：只送模型', () => {
    expect(claude('high', sonnet, opus, false)).toEqual({ model: 'opus' });
  });

  it('看機器的 capabilities.modelOptions；沒選機器不提示', () => {
    const machine = (modelOptions?: boolean) =>
      ({ capabilities: modelOptions === undefined ? {} : { modelOptions } }) as Machine;
    expect(modelOptionsSupported(undefined)).toBe(true);
    expect(modelOptionsSupported(machine(true))).toBe(true);
    expect(modelOptionsSupported(machine())).toBe(false);
  });
});
