// 團隊、成員、交接規則。畫布與工作台共用。協定沒有團隊的 WebSocket 訊息，所以用 REST 輪詢。
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
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [backend, attempt]);

  return {
    retry: () => {
      useTeams.setState({ status: 'loading', detail: null });
      setAttempt((n) => n + 1);
    },
  };
}

/** 使用者選的團隊框色（STYLE.md §4），不是狀態色。存的是名稱，不把任意字串放進 CSS。 */
export const TEAM_COLORS = ['teal', 'lime', 'indigo', 'apricot'] as const;

export function teamColorVar(color: string): string {
  const known = TEAM_COLORS.find((c) => c === color) ?? 'teal';
  return `var(--team-${known})`;
}
