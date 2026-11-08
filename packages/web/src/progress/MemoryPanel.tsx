// Memory 面板（P3 項目一，§1.5）：底部列「Memory」開的右側面板（和收件匣、團隊面板互斥，寬 420、可展開 760）。
// 列出每張進度卡：名稱 → 下一步第一行 → 阻礙第一行（有才顯示）→ 更新時間與更新者 → ⚠ 久未更新。
// 點一列：畫布聚焦該團隊並展開卡片（目標在別的工作區就先切過去），面板不關。手機是全螢幕頁（#/memory）。
import { useState } from 'react';
import {
  firstLine,
  progressOwnerKey,
  type ProgressCard,
  type ProgressOwner,
} from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useTeams, useTeamSync } from '../team/store';
import { closeRight, EmptyState, useNow, useViewsUi } from '../views';
import { CloseButton, SidePanel } from '../views/Overlays';
import { useCurrentZoneId, useZones } from '../zones';
import { memoryRows, type MemoryRow } from './model';
import { ProgressAge, ProgressCardView } from './ProgressCard';
import { useProgressUi } from './uiStore';
import './messages';
import './progress.css';

export const MEMORY_WIDTH = 420;
export const MEMORY_WIDE_WIDTH = 760;

/** 聚焦卡片的擁有者並展開卡片（Memory 點列、收件匣「下一步」共用）。 */
export function focusProgress(row: Pick<MemoryRow, 'card' | 'info'>): void {
  const { card } = row;
  if (card.teamId !== null) focusProgressOwner({ teamId: card.teamId });
  else if (card.sessionId !== null) focusProgressOwner({ sessionId: card.sessionId });
}

/** 同上，只給擁有者（全域搜尋的進度卡結果用）。 */
export function focusProgressOwner(owner: ProgressOwner): void {
  const { members } = useTeams.getState();
  useProgressUi.getState().setExpanded(progressOwnerKey(owner));
  if ('teamId' in owner) {
    const ids = members.filter((m) => m.teamId === owner.teamId).map((m) => m.sessionId);
    if (ids.length > 0) useViewsUi.getState().focusTeam(ids);
  } else {
    useViewsUi.getState().focusSession(owner.sessionId);
  }
}

function Row({ row, phone }: { row: MemoryRow; phone: boolean }) {
  const t = useT();
  const mask = useMaskText();
  const zones = useZones();
  const scope = useProgressUi((s) => s.scope);
  const expanded = useProgressUi((s) => s.expanded === row.info.key);
  const setExpanded = useProgressUi((s) => s.setExpanded);
  const { card, info } = row;
  const next = firstLine(card.next);
  const blockers = firstLine(card.blockers);
  const zoneName = zones.find((z) => z.id === info.zoneId)?.name;
  // 手機沒有畫布：點列在清單裡展開整張卡。
  if (phone && expanded) {
    return (
      <li>
        <ProgressCardView
          owner={info.owner}
          name={info.name ?? ''}
          variant="panel"
          expanded
          onExpandedChange={(open) => setExpanded(open ? info.key : null)}
          testId={`memory-card-${info.key}`}
        />
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className="memory-row"
        aria-label={t('memory.row.aria', { name: info.name ?? '' })}
        onClick={() => (phone ? setExpanded(info.key) : focusProgress(row))}
        data-testid={`memory-row-${info.key}`}
        data-stale={row.stale ? 'true' : undefined}
      >
        <b>
          {info.name}
          {info.joinedTeam && (
            <span className="sub"> {t('memory.joined', { team: info.joinedTeam })}</span>
          )}
          {card.teamId === null && !info.joinedTeam && (
            <span className="sub"> · {t('memory.session')}</span>
          )}
        </b>
        <span className="line">
          {next ? t('progress.collapsed.next', { text: mask(next) }) : t('progress.collapsed.none')}
        </span>
        {blockers && (
          <span className="line sub">{t('memory.blockers', { text: mask(blockers) })}</span>
        )}
        <span className="sub">
          <ProgressAge card={card} />
          {scope === 'all' && zoneName && <> · {t('memory.zone', { name: zoneName })}</>}
          {card.locked && ' · 🔒'}
        </span>
      </button>
    </li>
  );
}

export function MemoryContent({ phone = false }: { phone?: boolean }) {
  const t = useT();
  // 團隊名稱與成員（手機沒有畫布、團隊資料可能還沒讀過）。
  useTeamSync();
  const cards = useBoard((s) => s.progress) ?? [];
  const sessions = useBoard((s) => s.sessions);
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const zoneId = useCurrentZoneId();
  const scope = useProgressUi((s) => s.scope);
  const setScope = useProgressUi((s) => s.setScope);
  const now = useNow();
  const rows = memoryRows(cards as ProgressCard[], {
    teams,
    members,
    sessions,
    now,
    scope,
    zoneId,
  });
  return (
    <div className="memory-page" data-testid="memory-page">
      <h1>{t('memory.title')}</h1>
      <div className="memory-scope" role="group" aria-label={t('memory.scope.aria')}>
        {(['current', 'all'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={scope === value}
            onClick={() => setScope(value)}
            data-testid={`memory-scope-${value}`}
          >
            {t(`memory.scope.${value}`)}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState text={t('memory.empty')} />
      ) : (
        <ul className="memory-list" data-testid="memory-list">
          {rows.map((row) => (
            <Row key={row.info.key} row={row} phone={phone} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function MemoryDrawer() {
  const t = useT();
  const [wide, setWide] = useState(false);
  return (
    <SidePanel
      label={t('memory.title')}
      width={wide ? MEMORY_WIDE_WIDTH : MEMORY_WIDTH}
      testId="memory-panel"
    >
      <div className="panel-tools">
        <button
          type="button"
          aria-pressed={wide}
          onClick={() => setWide(!wide)}
          title={t('memory.wide.hint')}
          style={{ margin: '8px 8px 0 0' }}
          data-testid="memory-wide"
        >
          {wide ? t('memory.wide.off') : t('memory.wide.on')}
        </button>
        <CloseButton onClose={closeRight} testId="memory-close" />
      </div>
      <MemoryContent />
    </SidePanel>
  );
}
