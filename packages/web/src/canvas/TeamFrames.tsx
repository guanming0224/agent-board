import { useMemo } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { useT } from '../shared/i18n';
import { teamColorVar, useTeams } from '../team/store';
import { teamHash } from '../views/overlay';
import type { Rect } from './layout';
import { canvasTeams, teamRect } from './teams';

/**
 * 團隊框是成員位置算出來的，不當 xyflow 節點：拖曳時框一直變大小，
 * 節點的 ResizeObserver 會在同一輪又改版面，觸發 ResizeObserver loop 錯誤。
 */
export function TeamFrames({
  rects,
  onTidy,
}: {
  rects: ReadonlyMap<string, Rect>;
  /** 標籤旁的「整理團隊」。 */
  onTidy?: (teamId: string) => void;
}) {
  const t = useT();
  const allTeams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const teams = useMemo(() => canvasTeams(allTeams, members), [allTeams, members]);
  return (
    <ViewportPortal>
      {teams.map((team) => {
        const rect = teamRect(team, rects);
        if (!rect) return null;
        return (
          <div
            key={team.id}
            className="team"
            style={{
              width: rect.w,
              height: rect.h,
              transform: `translate(${rect.x}px, ${rect.y}px)`,
              ['--team' as string]: teamColorVar(team.color),
            }}
          >
            <span>
              {/* 點標籤打開右側的團隊面板（P2 §1.2）；框內空白處的點擊屬於項目二。 */}
              <a
                className="team-open nopan nodrag"
                href={teamHash(team.id)}
                title={t('canvas.team.open', { name: team.name })}
                data-testid={`team-open-${team.id}`}
              >
                {t('canvas.team.label', { name: team.name })}
              </a>
              {onTidy && (
                // 框本身不吃滑鼠（拖曳畫布要穿過去），只有按鈕吃；nopan／nodrag 讓 xyflow 不把按下當成拖曳。
                <button
                  type="button"
                  className="team-tidy nopan nodrag"
                  data-testid={`tidy-team-${team.id}`}
                  aria-label={t('canvas.tidy.teamAria', { name: team.name })}
                  title={t('canvas.tidy.teamAria', { name: team.name })}
                  onClick={() => onTidy(team.id)}
                >
                  {t('canvas.tidy.team')}
                </button>
              )}
            </span>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
