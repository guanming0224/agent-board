import { useT } from '../shared/i18n';
import { useMaskMode } from './maskMode';
import './messages';
import './security.css';

/** 頁首的遮蔽開關。開著時要一眼看得出來，也要講清楚它只改畫面。 */
export function MaskChip() {
  const t = useT();
  const { masking, toggle } = useMaskMode();
  return (
    <button
      type="button"
      className={masking ? 'mask-chip on' : 'mask-chip'}
      aria-pressed={masking}
      title={t('security.mask.title')}
      data-testid="mask-chip"
      onClick={toggle}
    >
      {t(masking ? 'security.mask.on' : 'security.mask.off')}
    </button>
  );
}
