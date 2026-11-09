// 拒絕原因框：收件匣列（桌面）、手機收件匣、展開的審核卡三處共用（GM Q3）。
// 流程一律是：灰色「拒絕」→ 展開這個框 → 紅框「拒絕」＋「取消」。展開時呼叫端要把「允許」那排藏起來：
// 免得「允許一次」補到剛才「拒絕」的位置（連點兩下變成允許），也不會同時出現兩顆意思相反的紅鈕。
import { useRef, useState } from 'react';
import { useT } from '../shared/i18n';
import type { useDecide } from './approvalParts';
import { Msg } from './common';

export function DenyForm({
  decide,
  disabled,
  onCancel,
  phone = false,
}: {
  decide: ReturnType<typeof useDecide>;
  disabled: boolean;
  /** 「取消」：收起原因框，回到「允許／拒絕」。 */
  onCancel: () => void;
  /** 手機收件匣：兩顆 56px（.act）並排在 .big 格子裡。 */
  phone?: boolean;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const text = reason.trim();
    if (!text) {
      setInvalid(true);
      decide.setNote({ text: t('flows.review.denyNeedsReason'), tone: 'err' });
      inputRef.current?.focus();
      return;
    }
    void decide.decide({ behavior: 'deny', reason: text });
  };
  const size = phone ? ' act' : '';
  return (
    <div className={`deny-form${phone ? '' : ' row-panel'}`} data-testid="deny-form">
      <textarea
        ref={inputRef}
        autoFocus
        className="field-input"
        rows={2}
        value={reason}
        aria-label={t('flows.review.denyReason')}
        aria-invalid={invalid}
        placeholder={t('flows.review.denyReason')}
        onChange={(e) => {
          setReason(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          // Cmd／Ctrl＋Enter 送出；單按 Enter 照常換行。
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className={phone ? 'big' : 'acts'}>
        <button type="button" className={`danger${size}`} disabled={disabled} onClick={send}>
          {t('flows.review.deny')}
        </button>
        <button
          type="button"
          className={`ghost${size}`}
          onClick={() => {
            decide.setNote(null);
            onCancel();
          }}
        >
          {t('flows.inbox.denyCancel')}
        </button>
        {!phone && <Msg note={decide.note} />}
      </div>
    </div>
  );
}
