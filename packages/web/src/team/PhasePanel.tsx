// 研究團隊的「換階段」（GM 2026-11-06）：顯示目前階段；選新階段時列出用不到的成員（可封存，要確認、
// 不刪任何東西）和要補的分工（用補成員那一套建立）。任務、交接規則、TEAM.md 都不動。
import { useState } from 'react';
import type { ResearchKind, ResearchPhase, Session, Team, TeamMember } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { AddMembers } from './AddMembers';
import { ActionMessage, TwoClickButton, useAction } from './common';
import { kindLabel } from './PlanEditor';
import { memberKind, phaseDiff } from './research';
import { refreshTeams } from './store';
import { PHASE_IDS } from './teamPlan';

export function PhasePanel({
  team,
  members,
}: {
  team: Team & { phase: ResearchPhase };
  members: readonly { member: TeamMember; session: Session }[];
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [target, setTarget] = useState<ResearchPhase | null>(null);
  /** 選新階段當下缺的分工：補成員途中成員變多也不換掉正在填的列。 */
  const [missing, setMissing] = useState<ResearchKind[]>([]);
  const { busy, message, run } = useAction();
  const live = members.filter(({ session }) => !session.archived);
  const diff = target
    ? phaseDiff(
        live.map(({ member }) => member),
        target,
      )
    : null;
  const extra = diff ? live.filter(({ member }) => diff.extra.includes(member.sessionId)) : [];

  const archive = (session: Session) =>
    run(async () => {
      // 和畫布的封存同一個動作：還在跑的會先停止，相關交接規則暫停；可在設定頁「已封存」還原。
      await backend.updateSession(session.id, { archived: true });
      await refreshTeams(backend);
      return t('team.phase.archived', { name: session.name });
    });

  const move = (phase: ResearchPhase) =>
    run(async () => {
      await backend.updateTeam(team.id, { phase });
      await refreshTeams(backend);
      setTarget(null);
      return t('team.phase.moved', { phase: t(`team.phase.${phase}`) });
    });

  return (
    <section className="panel phase-panel" aria-labelledby="phase-title" data-testid="phase-panel">
      <h2 id="phase-title">{t('team.phase.title')}</h2>
      <p>
        <b data-testid="team-phase">{t(`team.phase.${team.phase}`)}</b>
        <span className="sub"> · {t(`team.phase.hint.${team.phase}`)}</span>
      </p>
      <div className="seg" role="group" aria-label={t('team.phase.change')}>
        {PHASE_IDS.filter((id) => id !== team.phase).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={target === id}
            title={t(`team.phase.hint.${id}`)}
            onClick={() => {
              const next = target === id ? null : id;
              setTarget(next);
              if (next)
                setMissing(
                  phaseDiff(
                    live.map(({ member }) => member),
                    next,
                  ).missing,
                );
            }}
          >
            {t('team.phase.to', { phase: t(`team.phase.${id}`) })}
          </button>
        ))}
      </div>
      {target && diff && (
        <div className="phase-diff" data-testid="phase-diff">
          <p className="sub">{t(`team.phase.hint.${target}`)}</p>
          <h3>{t('team.phase.extraTitle')}</h3>
          {extra.length === 0 ? (
            <p className="sub" data-testid="phase-extra-none">
              {t('team.phase.extraNone')}
            </p>
          ) : (
            <>
              <p className="sub">{t('team.phase.extraHint')}</p>
              <ul className="phase-extra">
                {extra.map(({ member, session }) => (
                  <li key={session.id} data-testid={`phase-extra-${session.id}`}>
                    <b>{session.name}</b>{' '}
                    <span className="sub">{kindLabel(t, memberKind(member))}</span>{' '}
                    <TwoClickButton
                      className="sm"
                      label={t('team.phase.archive')}
                      armedLabel={t('team.phase.archiveArmed', { name: session.name })}
                      disabled={busy}
                      onConfirm={() => void archive(session)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>{t('team.phase.missingTitle')}</h3>
          {missing.length === 0 ? (
            <p className="sub" data-testid="phase-missing-none">
              {t('team.phase.missingNone')}
            </p>
          ) : (
            <AddMembers
              key={target}
              team={team}
              members={members}
              initialKinds={missing}
              title={t('team.phase.missingAdd', {
                kinds: missing.map((k) => kindLabel(t, k)).join(t('team.phase.sep')),
              })}
            />
          )}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void move(target)}>
              {t('team.phase.confirm', { phase: t(`team.phase.${target}`) })}
            </button>
            <span className="sub">{t('team.phase.keeps')}</span>
          </div>
        </div>
      )}
      <ActionMessage message={message} testId="phase-msg" />
    </section>
  );
}
