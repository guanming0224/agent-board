// 團隊、成員、交接規則。畫布與工作台共用。用 REST 輪詢；P2 起 hub 另外推 team.updated／team.removed，收到就馬上重讀。
import { useEffect, useState } from 'react';
import type { HandoffRule, Team, TeamMember } from '@agent-board/protocol';
import { create } from 'zustand';
import type { BoardBackend } from '../shared/backend';
import { useBoard } from '../shared/store';
import { errorText } from '../views';

const POLL_MS = 10_000;

interface TeamsState {
  teams: Team[];
  members: TeamMember[];
  rules: HandoffRule[];
  status: 'loading' | 'ready' | 'error';
  detail: string | null;
}

export const useTeams = create<TeamsState>(() => ({
  teams: [],
  members: [],
  rules: [],
  status: 'loading',
  detail: null,
}));

let latestRefresh = 0;

/** 比較晚發出的請求為準：慢回來的舊資料不能蓋掉剛改好的內容。 */
export async function refreshTeams(backend: BoardBackend): Promise<void> {
  latestRefresh += 1;
  const mine = latestRefresh;
  const teams = await backend.listTeams();
  const [members, rules] = await Promise.all([
    Promise.all(teams.map((team) => backend.listTeamMembers(team.id))),
    Promise.all(teams.map((team) => backend.listHandoffRules(team.id))),
  ]);
  if (mine !== latestRefresh) return;
  useTeams.setState({
    teams,
    members: members.flat(),
    rules: rules.flat(),
    status: 'ready',
    detail: null,
  });
}

/** 掛載時讀一次，之後輪詢。已經有資料時讀失敗就保留舊資料，資料過期由頁面的 hub 斷線列說明。 */
export function useTeamSync(): { retry: () => void } {
  const backend = useBoard((s) => s.backend);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      refreshTeams(backend).catch((e: unknown) => {
        if (!alive || useTeams.getState().status === 'ready') return;
        useTeams.setState({ status: 'error', detail: errorText(e) });
      });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    // hub 推的團隊變化（建立、改名、換工作區、刪除）：先就地換掉讓畫面馬上跟上，再整份重讀（成員、規則）。
    const unwatch = backend.watchTeamChanges?.((change) => {
      if ('team' in change) {
        const { team } = change;
        useTeams.setState((s) =>
          s.teams.some((x) => x.id === team.id)
            ? { teams: s.teams.map((x) => (x.id === team.id ? team : x)) }
            : s,
        );
      }
      load();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      unwatch?.();
    };
  }, [backend, attempt]);

  return {
    retry: () => {
      useTeams.setState({ status: 'loading', detail: null });
      setAttempt((n) => n + 1);
    },
  };
}

export { TEAM_COLORS, teamColorVar } from './colors';
