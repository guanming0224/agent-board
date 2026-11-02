import { useEffect, useState } from 'react';
import type { Project } from '@agent-board/protocol';
import { create } from 'zustand';
import { useBoard } from '../shared/store';

export const useProjects = create<{ projects: Project[] }>(() => ({ projects: [] }));

export type LoadState =
  { status: 'loading' } | { status: 'ready' } | { status: 'error'; detail: string };

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** store 一開始就是空陣列，分不出「還沒收到」和「真的沒有」，所以自己等第一份快照。 */
export function useBoardLoad(): LoadState & { retry: () => void } {
  const backend = useBoard((s) => s.backend);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setState({ status: 'loading' });
    let stop: (() => void) | undefined;
    try {
      stop = backend.watchBoard(() => setState({ status: 'ready' }));
    } catch (e) {
      setState({ status: 'error', detail: errorText(e) });
    }
    // 專案名稱讀不到時呼號退回資料夾名稱，不影響操作，所以不算錯誤。
    backend
      .listProjects()
      .then((projects) => useProjects.setState({ projects }))
      .catch(() => {});
    return () => stop?.();
  }, [backend, attempt]);

  return { ...state, retry: () => setAttempt((n) => n + 1) };
}
