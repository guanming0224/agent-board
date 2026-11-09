// 畫布上的進度卡（P3 項目一，§1.5）：團隊框右上角外側、與框頂對齊、間距 PROGRESS_GAP（畫布 px），
// 跟著團隊框移動；單獨 session 的卡貼在 session 卡右側。不是 React Flow 節點（同 TeamFrames 不當節點），
// 不參與「一鍵整理」的排列，但整理時預留它的寬度與高度（canvas/arrange.ts 的 PROGRESS_RESERVE、progressH）。
// 縮放 < 90% 只畫收合樣式、< 40% 只畫「進度」小標籤與 ⚠；點開（或從 Memory、收件匣展開）時反向縮放回螢幕大小。
// 收合樣式在 40–89% 也反向縮放（字在螢幕上維持約 0.9 倍），但寬度換算回畫布上原本的寬，佔的位置不變。
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@xyflow/react';
import { progressOwnerKey, type ProgressOwner } from '@agent-board/protocol';
import { PROGRESS_GAP } from '../canvas/arrange';
import type { Rect } from '../canvas/layout';
import { canvasTeams, teamRect } from '../canvas/teams';
import { useBoard } from '../shared/store';
import { useTeams } from '../team/store';
import { useCurrentZoneId } from '../zones';
import { ProgressCardView } from './ProgressCard';
import { useProgressUi } from './uiStore';

/** 摘要模式（只畫收合）與小標籤的門檻（同畫布卡片的語意縮放）。 */
const SUMMARY_ZOOM = 0.9;
const TINY_ZOOM = 0.4;
/**
 * 收合的卡在螢幕上至少是原尺寸的幾倍（字 13px × 0.9 ≈ 11.7px）。以前收合卡跟著畫布縮，50% 時字只剩 6.5px，
 * 40% 以下換成反向縮放的小標籤反而比較大（畫布審查 D4）。
 */
const COLLAPSED_SCREEN = 0.9;
/**
 * 收合的卡反向放大的最大倍數（縮到 TINY_ZOOM 前一刻）。整理畫布用這個倍數量卡片高度（canvas/tidy.tsx）：
 * 結果不取決於按下整理時的縮放，整理後不論縮到哪裡（小標籤以上）預留的高度都夠。
 */
export const PROGRESS_K_MAX = COLLAPSED_SCREEN / TINY_ZOOM;
/** 展開的卡底部和底部指令列之間至少留多少（螢幕 px）；卡片頂端離指令列太近時，至少給這麼高再捲動。 */
const BAR_GAP = 8;
const MIN_OPEN_HEIGHT = 160;

interface Anchor {
  owner: ProgressOwner;
  key: string;
  name: string;
  x: number;
  y: number;
}

export function CanvasProgress({ rects }: { rects: ReadonlyMap<string, Rect> }) {
  const [tx, ty, rawZoom] = useStore((s) => s.transform);
  const zoom = rawZoom || 1;
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const sessions = useBoard((s) => s.sessions);
  const cards = useBoard((s) => s.progress);
  const zoneId = useCurrentZoneId();
  const expanded = useProgressUi((s) => s.expanded);
  const setExpanded = useProgressUi((s) => s.setExpanded);
  // 固定的畫布距離，和一鍵整理預留的一樣（canvas/arrange.ts）。
  const gap = PROGRESS_GAP;
  // 底部指令列（views 的 CommandBar，在畫布外面那一層、z-index 比這層高）的頂端，相對這一層（螢幕 px）。
  // P3 整合：指令列多了 Presets、Memory 後變寬（窄的時候換行變高），展開的卡（衝突並排、歷史）會長到它底下、
  // 存檔／取消鈕被蓋住；展開的卡限制高度到指令列上方，內容在卡裡捲動。
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const layer = useRef<HTMLDivElement>(null);
  const [barTop, setBarTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const bar = document.querySelector('[data-testid="command-bar"]');
    const box = layer.current?.getBoundingClientRect();
    setBarTop(bar && box ? bar.getBoundingClientRect().top - box.top : null);
  }, [width, height, expanded]);

  const anchors = useMemo(() => {
    const out: Anchor[] = [];
    for (const team of canvasTeams(teams, members)) {
      if (teams.find((x) => x.id === team.id)?.zoneId !== zoneId) continue;
      // 兩位以上有框；只有一位時貼在那張卡右側；沒有成員在畫面上就不畫。
      const rect =
        teamRect(team, rects) ??
        team.memberIds.map((id) => rects.get(id)).find((r): r is Rect => r !== undefined);
      if (!rect) continue;
      const owner = { teamId: team.id };
      out.push({
        owner,
        key: progressOwnerKey(owner),
        name: team.name,
        x: rect.x + rect.w + gap,
        y: rect.y,
      });
    }
    // 單獨 session：只畫寫過的卡（每張卡旁都放「+ 進度卡」太吵；新卡從卡片選單、Memory 或 agent 建立）。
    const inTeam = new Set(members.map((m) => m.sessionId));
    for (const card of cards ?? []) {
      if (card.sessionId === null || inTeam.has(card.sessionId) || card.revision === 0) continue;
      const rect = rects.get(card.sessionId);
      const session = sessions.find((s) => s.id === card.sessionId);
      if (!rect || !session) continue;
      const owner = { sessionId: card.sessionId };
      out.push({
        owner,
        key: progressOwnerKey(owner),
        name: session.name,
        x: rect.x + rect.w + gap,
        y: rect.y,
      });
    }
    // 展開中的單獨 session 卡（從卡片選單剛建立、還沒寫過）也要畫出來。
    if (expanded?.startsWith('session:') && !out.some((a) => a.key === expanded)) {
      const id = expanded.slice('session:'.length);
      const rect = rects.get(id);
      const session = sessions.find((s) => s.id === id);
      if (rect && session && !inTeam.has(id)) {
        out.push({
          owner: { sessionId: id },
          key: expanded,
          name: session.name,
          x: rect.x + rect.w + gap,
          y: rect.y,
        });
      }
    }
    return out;
  }, [teams, members, sessions, cards, rects, zoneId, gap, expanded]);

  // 寫過的卡（收合時有內容要讀）；還沒寫過的只是「+ 進度卡」佔位鈕。
  const written = useMemo(
    () =>
      new Set(
        (cards ?? [])
          .filter((c) => c.revision > 0 || c.id !== null)
          .map((c) => (c.teamId !== null ? `team:${c.teamId}` : `session:${c.sessionId}`)),
      ),
    [cards],
  );

  return (
    // 自己的一層（跟著畫布的平移與縮放）：ViewportPortal 在節點底下，卡片會被 session 卡蓋住、點不到。
    <div className="progress-layer" ref={layer}>
      <div
        className="progress-viewport"
        style={{ transform: `translate(${tx}px, ${ty}px) scale(${zoom})` }}
      >
        {anchors.map((a) => {
          const open = expanded === a.key;
          const tiny = !open && zoom < TINY_ZOOM;
          // 展開或小標籤：反向縮放成螢幕上的大小。收合（寫過的）：放大到螢幕上至少 COLLAPSED_SCREEN 倍，
          // 寬度除以同一個倍數（--progress-k，progress.css），畫布上佔的寬度仍是 280。
          // 還沒寫過的「+ 進度卡」只是佔位，維持畫布 px：放大會往下長、蓋到旁邊沒整理過的卡。
          const scale = open
            ? Math.max(1, 1 / zoom)
            : tiny
              ? 1 / zoom
              : written.has(a.key)
                ? Math.max(1, COLLAPSED_SCREEN / zoom)
                : 1;
          // 展開時：卡片底部不超過指令列頂端（沒有指令列就是這一層的底部）。換算回卡片自己的 px（螢幕 px ÷ 縮放倍數）。
          const room = (barTop ?? height) - BAR_GAP - (ty + a.y * zoom);
          const maxHeight = open ? Math.max(room, MIN_OPEN_HEIGHT) / (scale * zoom) : undefined;
          return (
            <div
              key={a.key}
              className={`progress-anchor nopan nodrag nowheel${open ? ' expanded' : ''}`}
              style={{
                // 小標籤（含「+ 進度卡」）放在框頂線的上面：螢幕上固定 36px 高，畫布縮很小時往下長
                // 會蓋到從團隊框拉到右邊那張卡的線與卡片標題列。
                transform: `translate(${a.x}px, ${a.y}px) scale(${scale})${tiny ? ' translateY(-100%)' : ''}`,
                ['--progress-k' as string]: open || tiny ? 1 : scale,
                ...(maxHeight !== undefined ? { maxHeight, overflowY: 'auto' } : {}),
              }}
              data-testid={`progress-anchor-${a.key}`}
              data-grows={written.has(a.key) ? 'true' : undefined}
              data-summary={zoom < SUMMARY_ZOOM ? 'true' : undefined}
            >
              <ProgressCardView
                owner={a.owner}
                name={a.name}
                variant="canvas"
                expanded={open}
                tiny={tiny}
                onExpandedChange={(next) => setExpanded(next ? a.key : null)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
