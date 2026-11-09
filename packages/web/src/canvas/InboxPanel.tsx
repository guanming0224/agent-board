// 收件匣抽屜（P2 §1.2）：畫布右側 480px，可展開 760px 看 diff；非模態，畫布照常可拖、可點卡。
// 清單本身在 flows/InboxBoard（排序、直接動作、展開審核卡、鍵盤）。
import { InboxBoard, type TeamOption } from '../flows';
import { useT } from '../shared/i18n';
import { teamColorVar, useTeamSync, useTeams } from '../team/store';
import { closeRight, ErrorState, LoadingState, useBoardLoad, useViewsUi } from '../views';
import { CloseButton, SidePanel } from '../views/Overlays';
import './canvas.css';
import './messages';

export const INBOX_WIDTH = 480;
export const INBOX_WIDE = 760;

function useTeamOptions(): TeamOption[] {
  useTeamSync();
  const { teams, members } = useTeams();
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    color: teamColorVar(team.color),
    memberIds: members.filter((m) => m.teamId === team.id).map((m) => m.sessionId),
  }));
}

/** 收件匣的內容：桌面放在抽屜裡，手機（≤ 640px）用 flows/InboxPage 的全螢幕版。 */
function InboxContent({
  target,
  nonce,
  tools,
}: {
  target: string | null;
  nonce: number;
  tools?: React.ReactNode;
}) {
  const t = useT();
  const load = useBoardLoad();
  const teams = useTeamOptions();
  if (load.status === 'error') {
    return (
      <ErrorState text={t('views.error.board', { detail: load.detail })} onRetry={load.retry} />
    );
  }
  if (load.status === 'loading') return <LoadingState />;
  return <InboxBoard teams={teams} target={target} nonce={nonce} tools={tools} />;
}

export function InboxDrawer({ target, nonce }: { target: string | null; nonce: number }) {
  const t = useT();
  const wide = useViewsUi((s) => s.inboxWide);
  const setWide = useViewsUi((s) => s.setInboxWide);
  return (
    <SidePanel
      label={t('canvas.inbox.aria')}
      width={wide ? INBOX_WIDE : INBOX_WIDTH}
      testId="inbox-drawer"
    >
      <InboxContent
        target={target}
        nonce={nonce}
        tools={
          <>
            <button
              type="button"
              className="sm"
              aria-pressed={wide}
              onClick={() => setWide(!wide)}
              title={t('canvas.inbox.wideHint')}
              data-testid="inbox-wide"
            >
              {wide ? t('canvas.inbox.narrow') : t('canvas.inbox.wide')}
            </button>
            <CloseButton onClose={closeRight} testId="inbox-close" />
          </>
        }
      />
    </SidePanel>
  );
}
