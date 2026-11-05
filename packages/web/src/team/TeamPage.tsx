// #/team：團隊清單；#/team/<id>：工作台（DISPATCH §5.3-4）。
import { useEffect, useState } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { EmptyState, ErrorState, LoadingState, PageShell, useBoardLoad } from '../views';
import { NewTeamForm } from './NewTeamForm';
import { refreshTeams, teamColorVar, useTeams, useTeamSync } from './store';
import { TeamWorkbench } from './TeamWorkbench';

function teamIdFromHash(): string | null {
  return decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/')[1] ?? '') || null;
}

function TeamList() {
  const t = useT();
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  return (
    <div className="page team-page">
      <h1>{t('team.title')}</h1>
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

export function TeamPage() {
  const t = useT();
  const board = useBoardLoad();
  const { retry } = useTeamSync();
  const status = useTeams((s) => s.status);
  const detail = useTeams((s) => s.detail);
  const teams = useTeams((s) => s.teams);
  const [teamId, setTeamId] = useState(teamIdFromHash);

  useEffect(() => {
    const onChange = () => setTeamId(teamIdFromHash());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);

  // 清單裡沒有這個團隊（例如剛建好、清單還沒讀到）：馬上再讀一次，不等下一輪輪詢。
  const backend = useBoard((s) => s.backend);
  const known = teamId === null || teams.some((x) => x.id === teamId);
  useEffect(() => {
    if (status === 'ready' && !known) refreshTeams(backend).catch(() => {});
  }, [backend, known, status, teamId]);

  let body;
  if (board.status === 'error') {
    body = (
      <ErrorState text={t('views.error.board', { detail: board.detail })} onRetry={board.retry} />
    );
  } else if (status === 'error') {
    body = <ErrorState text={t('team.error.load', { detail: detail ?? '' })} onRetry={retry} />;
  } else if (board.status === 'loading' || status === 'loading') {
    body = <LoadingState />;
  } else if (teamId === null) {
    body = <TeamList />;
  } else {
    const team = teams.find((x) => x.id === teamId);
    body = team ? (
      <TeamWorkbench key={team.id} team={team} />
    ) : (
      <EmptyState
        text={t('team.notFound')}
        action={<button onClick={() => (location.hash = '#/team')}>{t('team.backToList')}</button>}
      />
    );
  }
  return <PageShell tab="team">{body}</PageShell>;
}
