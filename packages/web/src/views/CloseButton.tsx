// 面板、對話框右上角的 ✕（STYLE §5.1「關閉」）。Overlays 與 FloatingDialog 共用，獨立一個檔避免循環引用。
import { useT } from '../shared/i18n';
import './messages';

export function CloseButton({
  onClose,
  testId,
  label,
}: {
  onClose: () => void;
  testId?: string;
  /** 可存取名稱；框裡另有文字「關閉」鈕時傳不同的名字（例如「關閉對話框」），兩顆才分得出來。 */
  label?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="close"
      aria-label={label ?? t('views.panel.close')}
      title={t('views.panel.closeHint')}
      onClick={onClose}
      data-testid={testId}
    >
      <span aria-hidden="true">✕</span>
    </button>
  );
}
