// 收件匣每列呼號後的工作區晶片（P2 §2.3）：收件匣全域，看得出那一項在哪個工作區。只有一個工作區時不顯示（沒有資訊量）。
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useSessionZones, useZones } from './store';
import './messages';

export function ZoneChip({ session }: { session: Pick<Session, 'id' | 'zoneId'> }) {
  const t = useT();
  const zones = useZones();
  const zoneOf = useSessionZones();
  if (zones.length < 2) return null;
  const zone = zones.find((z) => z.id === zoneOf(session));
  if (!zone) return null;
  return (
    <span className="chip zone-chip" data-testid={`zone-chip-${session.id}`}>
      {t('zones.chip', { name: zone.name })}
    </span>
  );
}
