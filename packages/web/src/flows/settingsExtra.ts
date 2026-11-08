// 其他資料夾放進設定頁的分類內容（例如 team 的「Presets」，P3 項目二）。用註冊的方式，
// flows 不必反過來 import team（team 已經依賴 flows 的表單零件）。
import type { ComponentType } from 'react';
import type { Category } from './settingsNav';

const registry = new Map<Category, ComponentType>();

export function registerSettingsCategory(category: Category, component: ComponentType): void {
  registry.set(category, component);
}

export function settingsCategoryContent(category: Category): ComponentType | null {
  return registry.get(category) ?? null;
}
