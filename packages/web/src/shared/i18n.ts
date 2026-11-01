// 極簡 i18n。各資料夾用 registerMessages 註冊自己的字串，避免大家搶同一個檔案。
import { create } from 'zustand';

export type Locale = 'zh-TW' | 'en';
type Dict = Record<string, string>;

const messages: Record<Locale, Dict> = { 'zh-TW': {}, en: {} };

export function registerMessages(locale: Locale, dict: Dict): void {
  Object.assign(messages[locale], dict);
}

export function detectLocale(languages: readonly string[] = navigator.languages): Locale {
  return languages.some((l) => l.toLowerCase().startsWith('zh')) ? 'zh-TW' : 'en';
}

export const useLocale = create<{ locale: Locale; setLocale: (locale: Locale) => void }>((set) => ({
  locale: typeof navigator === 'undefined' ? 'en' : detectLocale(),
  setLocale: (locale) => set({ locale }),
}));

export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const template = messages[locale][key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
}

export function useT() {
  const locale = useLocale((s) => s.locale);
  return (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
}

registerMessages('zh-TW', {
  'status.waiting_permission': '等你允許',
  'status.waiting_input': '等你回覆',
  'status.plan_review': '等你審計畫',
  'status.error': '錯誤',
  'status.stuck': '卡住',
  'status.running': '工作中',
  'status.starting': '啟動中',
  'status.queued': '排隊中',
  'status.rate_limited': '額度用完',
  'status.done': '完成',
  'status.offline': '失聯',
  'action.next': '下一個等我的',
  'label.waiting': '等你',
});

registerMessages('en', {
  'status.waiting_permission': 'Needs approval',
  'status.waiting_input': 'Needs reply',
  'status.plan_review': 'Plan review',
  'status.error': 'Error',
  'status.stuck': 'Stuck',
  'status.running': 'Running',
  'status.starting': 'Starting',
  'status.queued': 'Queued',
  'status.rate_limited': 'Rate limited',
  'status.done': 'Done',
  'status.offline': 'Offline',
  'action.next': 'Next up',
  'label.waiting': 'Waiting on you',
});
