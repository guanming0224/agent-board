// 待處理分頁：頁首、側欄、載入狀態在這裡；清單本身在 flows/QueueBoard（分組、直接動作、鍵盤）。
import { QueueBoard, triageItems, type TeamOption } from '../flows';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useTeamSync, useTeams } from '../team/store';
import { EmptyState, ErrorState, LoadingState, PageShell, useBoardLoad } from '../views';
import './canvas.css';
import './messages';

export function QueuePage() {
  const t = useT();
  const load = useBoardLoad();
  const { sessions, approvals } = useBoard();
  useTeamSync();
  const { teams: rawTeams, members } = useTeams();
  const teams: TeamOption[] = rawTeams.map((team) => ({
    id: team.id,
    name: team.name,
    memberIds: members.filter((m) => m.teamId === team.id).map((m) => m.sessionId),
  }));

  let body;
  if (load.status === 'error') {
    body = (
      <ErrorState text={t('views.error.board', { detail: load.detail })} onRetry={load.retry} />
    );
  } else if (load.status === 'loading') {
    body = <LoadingState />;
  } else if (triageItems(sessions, approvals).length === 0) {
    body = (
      <EmptyState
        text={t('queue.empty')}
        action={<button onClick={() => (location.hash = '#/new')}>{t('views.newSession')}</button>}
      />
    );
  } else {
    body = (
      <div className="page">
        <QueueBoard teams={teams} />
      </div>
    );
  }

  return <PageShell tab="queue">{body}</PageShell>;
}
