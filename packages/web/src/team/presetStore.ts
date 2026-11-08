// 團隊 Presets 清單：平常來自 board 快照（hub 的 board.state.presets 與 preset.list 推送）；
// 還沒收到快照時（或舊版 hub 沒送）用 REST 讀一次放進同一個 store。
import { useEffect, useState } from 'react';
import type { TeamPreset } from '@agent-board/protocol';
import { useBoard } from '../shared/store';
import { errorText } from '../views';
import { sortPresets } from './presetPlan';

export function usePresetList(): {
  presets: TeamPreset[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  retry: () => void;
} {
  const backend = useBoard((s) => s.backend);
  const snapshot = useBoard((s) => s.presets);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (snapshot !== undefined) return;
    let live = true;
    backend.listTeamPresets().then(
      (presets) => {
        // 等待期間快照先到了就以快照為準（比較新）。
        if (live && useBoard.getState().presets === undefined) useBoard.setState({ presets });
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [backend, snapshot, attempt]);
  return {
    presets: snapshot ? sortPresets(snapshot) : [],
    status: snapshot !== undefined ? 'ready' : error ? 'error' : 'loading',
    error,
    retry: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}
