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
  'status.idle_start': '剛開好，還沒下指令',
  // 派工（GM 2026-11-11）：waiting_input 但不是在等你，結果會自動送進去。
  'status.awaiting_lead': '等隊長',
  'status.awaiting_members': '等成員結果',
  // 狀態代碼（GM 2026-11-08）：卡片與徽章顯示代碼，完整說明放在提示框與 aria-label。
  'status.title': '{code}：{label}',
  'code.NEW': '剛開好、等隊長或等成員結果',
  'code.RUN': '工作中',
  'code.ASK': '等你回覆',
  'code.PERM': '等你允許（最急）',
  'code.PLAN': '等你審計畫',
  'code.UNK': '不認得的狀態',
  'status.unknown': '不認得的狀態',
  'code.ERR': '錯誤或卡住',
  'code.QUOTA': '額度用完',
  'code.QUE': '排隊中',
  'code.DONE': '已結束',
  'code.OFF': '失聯',
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
  'status.idle_start': 'Just started, no prompt yet',
  'status.awaiting_lead': 'Awaiting lead',
  'status.awaiting_members': 'Awaiting members',
  'status.title': '{code}: {label}',
  'code.NEW': 'Just started, or awaiting lead / members',
  'code.RUN': 'Running',
  'code.ASK': 'Needs reply',
  'code.PERM': 'Needs approval (most urgent)',
  'code.PLAN': 'Plan review',
  'code.UNK': 'Unknown status',
  'status.unknown': 'Unknown status',
  'code.ERR': 'Error or stuck',
  'code.QUOTA': 'Rate limited',
  'code.QUE': 'Queued',
  'code.DONE': 'Ended',
  'code.OFF': 'Offline',
  'action.next': 'Next up',
  'label.waiting': 'Waiting on you',
});
