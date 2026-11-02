// 還沒進設定頁就要能換語言：登入與首次引導共用。
import { useLocale } from '../shared/i18n';
import { applyLocaleChoice } from './locale';

const OPTIONS = [
  ['zh-TW', '繁體中文'],
  ['en', 'English'],
] as const;

export function LanguagePicker() {
  const locale = useLocale((s) => s.locale);
  return (
    <div className="segmented" role="group" aria-label="Language / 語言">
      {OPTIONS.map(([value, label]) => (
        <label key={value} className={locale === value ? 'on' : ''}>
          <input
            type="radio"
            name="pick-locale"
            checked={locale === value}
            onChange={() => applyLocaleChoice(value)}
          />
          {label}
        </label>
      ))}
    </div>
  );
}
