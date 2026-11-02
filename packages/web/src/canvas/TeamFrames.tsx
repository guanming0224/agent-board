import { useMemo } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { useT } from '../shared/i18n';
import { teamColorVar, useTeams } from '../team/store';
import type { Rect } from './layout';
import { canvasTeams, teamRect } from './teams';

/**
 * 團隊框是成員位置算出來的，不當 xyflow 節點：拖曳時框一直變大小，
 * 節點的 ResizeObserver 會在同一輪又改版面，觸發 ResizeObserver loop 錯誤。
 */
export function TeamFrames({ rects }: { rects: ReadonlyMap<string, Rect> }) {
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
            <span>{t('canvas.team.label', { name: team.name })}</span>
          </div>
        );
      })}
    </ViewportPortal>
  );
}
