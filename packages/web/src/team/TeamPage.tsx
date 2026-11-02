// #/team：團隊清單；#/team/<id>：工作台（DISPATCH §5.3-4）。
import { useEffect, useState } from 'react';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { EmptyState, ErrorState, LoadingState, PageShell, useBoardLoad } from '../views';
import { ActionMessage, ColorPicker, useAction } from './common';
import { refreshTeams, teamColorVar, TEAM_COLORS, useTeams, useTeamSync } from './store';
import { TeamWorkbench } from './TeamWorkbench';

function teamIdFromHash(): string | null {
  return decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/')[1] ?? '') || null;
}

function NewTeamForm() {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(TEAM_COLORS[0]);
  const { busy, message, run } = useAction();
  const create = () =>
    run(async () => {
      const team = await backend.createTeam({
        name: name.trim(),
        goal: '',
        doneCriteria: '',
        color,
        contextMd: '',
      });
      await refreshTeams(backend);
      location.hash = `#/team/${encodeURIComponent(team.id)}`;
    });
  return (
    <form
      className="panel new-team"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label>
        {t('team.new.name')}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <ColorPicker value={color} onChange={setColor} />
      <button className="primary" disabled={busy || name.trim() === ''}>
        {t('team.new.create')}
      </button>
      <ActionMessage message={message} />
    </form>
  );
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
