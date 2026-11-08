// 收件匣每列（屬於有卡片的團隊時）在呼號下加一行淡色「下一步：…」，點了展開整張卡（§1.6）。
// 這是 GM 在手機上回覆 ASK 前最需要的上下文。
import { useState } from 'react';
import { firstLine, type ProgressOwner, type Session } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useTeams } from '../team/store';
import { ProgressCardView, useProgressCard } from './ProgressCard';
import './messages';
import './progress.css';

/**
 * session 的卡：它所在的團隊（名稱排序第一個）的卡；不在團隊就是它自己的。手機收件匣不讀團隊清單，
 * 團隊資料還沒讀過時改看卡片自動事實裡的成員（hub 算的）。
 */
function useOwner(session: Session): { owner: ProgressOwner; name: string } {
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const cards = useBoard((s) => s.progress);
  const team = members
    .filter((m) => m.sessionId === session.id)
    .map((m) => teams.find((x) => x.id === m.teamId))
    .filter((x) => x !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (team) return { owner: { teamId: team.id }, name: team.name };
  const viaFacts = (cards ?? []).find(
    (c) => c.teamId !== null && c.facts.members.some((m) => m.sessionId === session.id),
  );
  if (viaFacts && useTeams.getState().status !== 'ready') {
    return { owner: { teamId: viaFacts.teamId! }, name: viaFacts.facts.teamName ?? '' };
  }
  return { owner: { sessionId: session.id }, name: session.name };
}

export function InboxProgressHint({ session }: { session: Session }) {
  const t = useT();
  const mask = useMaskText();
  const { owner, name } = useOwner(session);
  const card = useProgressCard(owner);
  const [open, setOpen] = useState(false);
  const next = firstLine(card.next);
  if (card.revision === 0 || !next) return null;
  if (open) {
    return (
      <ProgressCardView
        owner={owner}
        name={name}
        variant="panel"
        expanded
        onExpandedChange={setOpen}
        testId={`inbox-progress-card-${session.id}`}
      />
    );
  }
  return (
    <button
      type="button"
      className="inbox-progress"
      aria-label={t('inbox.progressOpen', { name })}
      onClick={() => setOpen(true)}
      data-testid={`inbox-progress-${session.id}`}
    >
      {t('inbox.progressNext', { text: mask(next) })}
    </button>
  );
}
