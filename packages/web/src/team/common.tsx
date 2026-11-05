// 工作台內共用的小元件。
import { useEffect, useRef, useState } from 'react';
import { useT } from '../shared/i18n';
import { errorText } from '../views';
import { TEAM_COLORS, teamColorVar } from './store';
import './messages';
import './team.css';

/** 耗額度晶片（STYLE.md 規則三之二）。 */
export function CostChip() {
  const t = useT();
  return <span className="chip cost">◈ {t('team.cost')}</span>;
}

/** 操作結果緊貼按鈕（STYLE.md 邏輯 7）；失敗寫原因，不丟例外。 */
export function useAction() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const run = async (action: () => Promise<string | null | void>) => {
    setBusy(true);
    try {
      const text = await action();
      setMessage(text ? { text, failed: false } : null);
    } catch (e) {
      setMessage({ text: t('team.failed', { detail: errorText(e) }), failed: true });
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, run, setMessage };
}

export function ActionMessage({
  message,
  testId,
}: {
  message: { text: string; failed: boolean } | null;
  testId?: string;
}) {
  if (!message) return null;
  return (
    <span
      className={`msg${message.failed ? ' err' : ''}`}
      role={message.failed ? 'alert' : 'status'}
      data-testid={testId}
    >
      {message.text}
    </span>
  );
}

const ARM_MS = 5000;

/** 危險操作按兩次（STYLE.md 邏輯 6），不用原生 confirm。第二次之前說清楚會發生什麼。 */
export function TwoClickButton({
  label,
  armedLabel,
  onConfirm,
  disabled,
}: {
  label: string;
  armedLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      className="danger"
      disabled={disabled}
      onClick={() => {
        clearTimeout(timer.current);
        if (armed) {
          setArmed(false);
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), ARM_MS);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? armedLabel : label}
    </button>
  );
}

export function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const t = useT();
  // 不認得的名稱畫成 teal（teamColorVar），選單也要標 teal，不然看起來什麼都沒選。
  const current = TEAM_COLORS.find((c) => c === value) ?? 'teal';
  return (
    <div className="color-picker" role="group" aria-label={t('team.color')}>
      {TEAM_COLORS.map((color) => {
        const name = t(`team.color.${color}`);
        return (
          <button
            key={color}
            type="button"
            className="color-pick"
            aria-label={name}
            title={name}
            aria-pressed={current === color}
            data-color={color}
            onClick={() => onChange(color)}
          >
            <i className="swatch" style={{ background: teamColorVar(color) }} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

/** 編輯到一半不被輪詢蓋掉：沒改過才跟著伺服器的值。 */
export function useDraft(saved: string) {
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(saved);
  }, [saved, dirty]);
  return {
    draft,
    dirty,
    set: (value: string) => {
      setDraft(value);
      setDirty(value !== saved);
    },
    markSaved: () => setDirty(false),
  };
}
