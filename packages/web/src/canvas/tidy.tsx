// 畫布的一鍵整理（GM 2026-11-06）：「整理畫布」「整理團隊」「回到上一次擺設」與整理後的「已整理・復原」。
// 位置怎麼算在 arrange.ts；這裡只管動畫、存檔、快照與按鈕。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '@xyflow/react';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useTeams } from '../team/store';
import { UNDO_MS } from './archive';
import { arrangeCanvas, arrangeTeam, restoreLayout, type ArrangeInput } from './arrange';
import type { Rect } from './layout';
import { PROGRESS_K_MAX } from '../progress/CanvasProgress';
import { motion } from './motion';
import type { SessionNodeType } from './SessionNode';

/** 卡片滑到新位置的時間；使用者要求減少動態時（motion() 為 0）直接到位。 */
const TIDY_MS = 360;

const ease = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * 畫布上收合的進度卡最高多高（畫布 px，progress/CanvasProgress.tsx 的 .progress-anchor）。
 * 寫過的收合卡縮小畫布時會反向放大（--progress-k，寬度除回去、字換行後高度跟著變高）。整理後鏡頭會換縮放，
 * 所以不用「現在」的倍數，一律用最大倍數 PROGRESS_K_MAX 量（暫時改 --progress-k、量完放回）：
 * 結果不取決於按下整理時的縮放，整理後縮到哪裡預留都夠。展開的卡和縮很小時的小標籤都不算。
 */
function measureProgressHeight(): number {
  let max = 0;
  for (const el of document.querySelectorAll<HTMLElement>('.progress-anchor')) {
    if (el.classList.contains('expanded') || el.querySelector('.progress-tiny')) continue;
    const k = el.dataset.grows === 'true' ? PROGRESS_K_MAX : 1;
    const before = el.style.getPropertyValue('--progress-k');
    el.style.setProperty('--progress-k', String(k));
    max = Math.max(max, el.offsetHeight * k);
    el.style.setProperty('--progress-k', before);
  }
  return max;
}

export interface TidyState {
  /** 上一次擺設（一鍵整理前的全部位置）。 */
  previous: ReadonlyMap<string, Rect> | null;
  /** 動畫進行中時的目標位置；存檔用它，才不會存到半路的位置。 */
  target: ReadonlyMap<string, Rect> | null;
}

export interface Tidy {
  hasPrevious: boolean;
  /** 「已整理・復原」的 key；null 表示不顯示。 */
  toastKey: number | null;
  tidyCanvas: () => void;
  tidyTeam: (teamId: string) => void;
  restorePrevious: () => void;
  /** 使用者拖了卡：停掉動畫、收掉「復原」。 */
  dragged: () => void;
  dismissToast: () => void;
}

interface Options {
  sessions: readonly Session[];
  cardsRef: React.RefObject<SessionNodeType[]>;
  setCards: React.Dispatch<React.SetStateAction<SessionNodeType[]>>;
  tidyState: React.RefObject<TidyState>;
  saveNow: (rects: ReadonlyMap<string, Rect>) => void;
  rectOf: (node: SessionNodeType) => Rect;
  /** 整理完移鏡頭：ids 為 null 表示全部顯示。 */
  fit: (ids: string[] | null) => void;
  /** 畫布可視範圍（螢幕 px）：整理照它的長寬比排（GM 2026-11-09 妥善利用空間）。量不到回 null。 */
  viewSize?: () => { w: number; h: number } | null;
}

export function useTidy({
  sessions,
  cardsRef,
  setCards,
  tidyState,
  saveNow,
  rectOf,
  fit,
  viewSize,
}: Options): Tidy {
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const rules = useTeams((s) => s.rules);
  const progress = useBoard((s) => s.progress);
  const [hasPrevious, setHasPrevious] = useState(() => tidyState.current.previous !== null);
  const [toastKey, setToastKey] = useState<number | null>(null);
  const frame = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    tidyState.current.target = null;
  }, [tidyState]);
  useEffect(() => stop, [stop]);

  const current = useCallback(
    () => new Map(cardsRef.current.map((n) => [n.id, rectOf(n)] as const)),
    [cardsRef, rectOf],
  );

  /** 卡片滑到 target，然後移鏡頭。 */
  const animate = useCallback(
    (target: ReadonlyMap<string, Rect>, fitIds: string[] | null) => {
      stop();
      const from = current();
      tidyState.current.target = target;
      const apply = (k: number) =>
        setCards((prev) =>
          prev.map((n) => {
            const to = target.get(n.id);
            if (!to) return n;
            const f = from.get(n.id) ?? to;
            const x = f.x + (to.x - f.x) * k;
            const y = f.y + (to.y - f.y) * k;
            return n.position.x === x && n.position.y === y ? n : { ...n, position: { x, y } };
          }),
        );
      const finish = () => {
        frame.current = null;
        tidyState.current.target = null;
        apply(1);
        // xyflow 會等這次節點更新後才移鏡頭。
        fit(fitIds);
      };
      const duration = motion() === 0 ? 0 : TIDY_MS;
      if (duration === 0) {
        finish();
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        if (t >= 1) finish();
        else {
          apply(ease(t));
          frame.current = requestAnimationFrame(step);
        }
      };
      frame.current = requestAnimationFrame(step);
    },
    [current, fit, setCards, stop, tidyState],
  );

  const input = useCallback(
    (): ArrangeInput => ({
      rects: current(),
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        projectId: s.projectId,
        cwd: s.cwd,
        ended: s.endedAt !== null,
        // 寫過的單獨 session 進度卡畫在卡片右側（progress/CanvasProgress.tsx），整理時預留寬度。
        progress: (progress ?? []).some((c) => c.sessionId === s.id && c.revision > 0),
      })),
      teams,
      members,
      // 交接順序決定同分工成員的左右順序，交接線才只跨相鄰的空隙。
      links: rules.map((r) => ({ source: r.fromSessionId, target: r.action.toSessionId })),
      progressH: measureProgressHeight(),
      view: viewSize?.() ?? undefined,
    }),
    [current, members, progress, rules, sessions, teams, viewSize],
  );

  /** 先記下整理前的全部位置當「上一次擺設」，再一次存好新位置與快照。 */
  const run = useCallback(
    (target: Map<string, Rect>, before: ReadonlyMap<string, Rect>, fitIds: string[] | null) => {
      tidyState.current.previous = before;
      setHasPrevious(true);
      saveNow(target);
      animate(target, fitIds);
      setToastKey(Date.now());
    },
    [animate, saveNow, tidyState],
  );

  const tidyCanvas = useCallback(() => {
    const data = input();
    if (data.rects.size === 0) return;
    run(arrangeCanvas(data), data.rects, null);
  }, [input, run]);

  const tidyTeam = useCallback(
    (teamId: string) => {
      const data = input();
      const ids = members
        .filter((m) => m.teamId === teamId && data.rects.has(m.sessionId))
        .map((m) => m.sessionId);
      if (ids.length === 0) return;
      run(arrangeTeam(teamId, data), data.rects, ids);
    },
    [input, members, run],
  );

  const restorePrevious = useCallback(() => {
    const snap = tidyState.current.previous;
    if (!snap) return;
    const { rects, snapshot } = restoreLayout(current(), snap);
    tidyState.current.previous = snapshot;
    saveNow(rects);
    animate(rects, null);
    setToastKey(null);
  }, [animate, current, saveNow, tidyState]);

  const dragged = useCallback(() => {
    if (frame.current !== null) stop();
    setToastKey(null);
  }, [stop]);
  const dismissToast = useCallback(() => setToastKey(null), []);

  return useMemo(
    () => ({
      hasPrevious,
      toastKey,
      tidyCanvas,
      tidyTeam,
      restorePrevious,
      dragged,
      dismissToast,
    }),
    [hasPrevious, toastKey, tidyCanvas, tidyTeam, restorePrevious, dragged, dismissToast],
  );
}

/** 右上角：「整理畫布」，有快照時多一顆「回到上一次擺設」。 */
export function TidyPanel({ tidy, empty }: { tidy: Tidy; empty: boolean }) {
  const t = useT();
  if (empty) return null;
  return (
    <Panel
      position="top-right"
      className="tidy-panel"
      role="group"
      aria-label={t('canvas.tidy.toolbar')}
    >
      <button
        type="button"
        className="sm"
        title={t('canvas.tidy.canvasHint')}
        onClick={tidy.tidyCanvas}
      >
        {t('canvas.tidy.canvas')}
      </button>
      {tidy.hasPrevious && (
        <button
          type="button"
          className="sm"
          title={t('canvas.tidy.previousHint')}
          onClick={tidy.restorePrevious}
        >
          {t('canvas.tidy.previous')}
        </button>
      )}
    </Panel>
  );
}

/** 整理後的「已整理　[復原]」，10 秒後消失；復原＝回到上一次擺設。 */
export function TidyToast({ tidy }: { tidy: Tidy }) {
  const t = useT();
  const { toastKey, dismissToast } = tidy;
  useEffect(() => {
    if (toastKey === null) return;
    const timer = setTimeout(dismissToast, UNDO_MS);
    return () => clearTimeout(timer);
  }, [toastKey, dismissToast]);
  if (toastKey === null) return null;
  return (
    // 和封存提示疊在同一欄（CanvasPage 的 .toast-stack），不用自己算讓位。
    <div className="toast-row tidy-toast" role="status" data-testid="tidy-toast">
      <span>{t('canvas.tidy.done')}</span>
      <button type="button" className="sm" onClick={tidy.restorePrevious}>
        {t('canvas.tidy.undo')}
      </button>
    </div>
  );
}
