import type { Session } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { STATUS_VISUAL } from '../shared/status';
import { useBoard } from '../shared/store';
import {
  Age,
  Callsign,
  dangerApproval,
  EmptyState,
  ErrorState,
  handsClass,
  Lamp,
  LoadingState,
  ModeChip,
  PageShell,
  pendingQueue,
  useBoardLoad,
  useViewsUi,
} from '../views';
import './canvas.css';
import './messages';

function QueueRow({ session }: { session: Session }) {
  const t = useT();
  const approvals = useBoard((s) => s.approvals);
  const focusSession = useViewsUi((s) => s.focusSession);
  const danger = dangerApproval(approvals, session.id);
  const approval = danger ?? approvals.find((a) => a.sessionId === session.id);
  const command = approval?.toolInput?.command;
  const mask = useMaskText();
  const you = STATUS_VISUAL[session.status].holder === 'you';

  return (
    <li>
      <a
        className={`queue-item hands-host ${handsClass(session.permissionMode)}${you ? ' you' : ''}`}
        href="#/canvas"
        data-testid={`queue-${session.id}`}
        onClick={() => focusSession(session.id)}
      >
        {danger && (
          <div className="alert">
            <span aria-hidden="true">⛔</span>
            <div>
              {t('queue.danger')} <span className="callsign">{danger.matchedRule}</span>
            </div>
          </div>
        )}
        <div className="head">
          <Lamp status={session.status} />
          <span className="title">{session.name}</span>
          <Age session={session} />
        </div>
        <div className="sign">
          <Callsign session={session} />
          <ModeChip mode={session.permissionMode} />
        </div>
        {approval?.toolName && (
          <div className="tool">
            {approval.toolName}{' '}
            {typeof command === 'string' && <span className="callsign">{mask(command)}</span>}
          </div>
        )}
      </a>
    </li>
  );
}

export function QueuePage() {
  const t = useT();
  const load = useBoardLoad();
  const { sessions, approvals } = useBoard();
  const queue = pendingQueue(sessions, approvals);

  let body;
  if (load.status === 'error') {
    body = (
      <ErrorState text={t('views.error.board', { detail: load.detail })} onRetry={load.retry} />
    );
  } else if (load.status === 'loading') {
    body = <LoadingState />;
  } else if (queue.length === 0) {
    body = (
      <EmptyState
        text={t('queue.empty')}
        action={<button onClick={() => (location.hash = '#/new')}>{t('views.newSession')}</button>}
      />
    );
  } else {
    body = (
      <div className="page">
        <h2 className="queue-title">{t('queue.title')}</h2>
        <p className="sub">{t('queue.order')}</p>
        <ol className="queue">
          {queue.map((s) => (
            <QueueRow key={s.id} session={s} />
          ))}
        </ol>
      </div>
    );
  }

  return <PageShell tab="queue">{body}</PageShell>;
}
