// 團隊面板（P2 §1.2）：畫布右側 420px，和收件匣互斥。#/team：團隊清單；#/team/<id>：工作台（DISPATCH §5.3-4）。
// 手機（≤ 640px）是全螢幕頁，內容相同。
import { useEffect } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  closeRight,
  EmptyState,
  ErrorState,
  LoadingState,
  useBoardLoad,
  useViewsUi,
} from '../views';
import { CloseButton, SidePanel } from '../views/Overlays';
import { NewTeamForm } from './NewTeamForm';
import { refreshTeams, teamColorVar, useTeams, useTeamSync } from './store';
import { TeamWorkbench } from './TeamWorkbench';

export const TEAM_WIDTH = 420;

function TeamList({ missing }: { missing: boolean }) {
  const t = useT();
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  return (
    <div className="page team-page" data-testid="team-list">
      <h1>{t('team.title')}</h1>
      {missing && (
        <p className="team-missing" role="status" data-testid="team-not-found">
          {t('team.notFound')}
        </p>
      )}
      <NewTeamForm />
      {teams.length === 0 ? (
        <EmptyState text={t('team.empty')} />
      ) : (
        <ul className="team-list">
          {teams.map((team) => (
            <li key={team.id}>
              <a
                className="panel team-row"
                href={`#/team/${encodeURIComponent(team.id)}`}
                style={{ ['--team' as string]: teamColorVar(team.color) }}
              >
                <b>{team.name}</b>
                <span className="sub">{team.goal || t('team.noGoal')}</span>
                <span className="sub num">
                  {t('team.memberCount', {
                    n: members.filter((m) => m.teamId === team.id).length,
                  })}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 團隊清單或工作台。團隊不存在時開清單並寫一行「找不到這個團隊」（P2 §1.4）。 */
export function TeamContent({ teamId }: { teamId: string | null }) {
  const t = useT();
  const board = useBoardLoad();
  const { retry } = useTeamSync();
  const status = useTeams((s) => s.status);
  const detail = useTeams((s) => s.detail);
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const team = teamId === null ? undefined : teams.find((x) => x.id === teamId);

  // 清單裡沒有這個團隊（例如剛建好、清單還沒讀到）：馬上再讀一次，不等下一輪輪詢。
  const backend = useBoard((s) => s.backend);
  const known = teamId === null || team !== undefined;
  useEffect(() => {
    if (status === 'ready' && !known) refreshTeams(backend).catch(() => {});
  }, [backend, known, status, teamId]);

  // 開某個團隊：畫布把它的成員框進畫面（團隊框跟著成員）。
  const memberIds = team
    ? members
        .filter((m) => m.teamId === team.id)
        .map((m) => m.sessionId)
        .join('|')
    : '';
  useEffect(() => {
    if (memberIds) useViewsUi.getState().focusTeam(memberIds.split('|'));
  }, [memberIds]);

  if (board.status === 'error') {
    return (
      <ErrorState text={t('views.error.board', { detail: board.detail })} onRetry={board.retry} />
    );
  }
  if (status === 'error') {
    return <ErrorState text={t('team.error.load', { detail: detail ?? '' })} onRetry={retry} />;
  }
  if (board.status === 'loading' || status === 'loading') return <LoadingState />;
  if (team) return <TeamWorkbench key={team.id} team={team} />;
  return <TeamList missing={teamId !== null} />;
}

export function TeamDrawer({ teamId }: { teamId: string | null }) {
  const t = useT();
  return (
    <SidePanel label={t('team.title')} width={TEAM_WIDTH} testId="team-panel">
      <div className="panel-tools">
        <CloseButton onClose={closeRight} testId="team-close" />
      </div>
      <TeamContent teamId={teamId} />
    </SidePanel>
  );
}
