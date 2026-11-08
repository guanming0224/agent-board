// 團隊名單與群發指令框（P2 §2.3）：每列狀態燈（符號＋代碼）→ agent 名稱 → 角色 → 時間；點列＝畫布聚焦那張卡，
// 面板不關；角色可以在列上改（PUT /api/teams/:id/members/:sessionId）。
// 底部指令框對整組或 @ 點名的成員下指令，不跳確認（GM 決定）；送字由 hub 端排隊（只在等輸入時送），
// 每列右側顯示這一則的結果，排隊中的可以個別取消。全部暫停中照送，只提示（Q6）。
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TeamRole } from '@agent-board/protocol';
import type { Broadcast, BroadcastTarget, Session, Team, TeamMember } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { statusCode } from '../shared/status';
import { useBoard } from '../shared/store';
import { Age, errorText, Lamp, useViewsUi } from '../views';
import { activeMention, parseCommand, sortRoster } from './broadcast';
import { refreshTeams } from './store';
import { ROLE_ABBR } from './teamPlan';

type Role = TeamMember['role'];

export interface RosterRow {
  member: TeamMember;
  session: Session;
}

/** 這個團隊的群發（任何人送的），舊的在前。進度卡的送字（帶入進度卡、請隊長更新）不算，狀態顯示在進度卡上。 */
function useTeamBroadcasts(teamId: string): Broadcast[] {
  const broadcasts = useBoard((s) => s.broadcasts);
  return useMemo(
    () =>
      (broadcasts ?? [])
        .filter((b) => b.teamId === teamId && b.kind === 'team')
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    [broadcasts, teamId],
  );
}

/** 列上顯示的文字摘要（排隊中的舊群發要讓 GM 認得是哪一則）。 */
const snippet = (text: string) => (text.length > 24 ? `${text.slice(0, 24)}…` : text);

function TargetResult({
  broadcast,
  target,
  session,
  earlier = false,
}: {
  broadcast: Broadcast;
  target: BroadcastTarget;
  session: Session | undefined;
  /** 不是最新一則、但還在排隊的群發（§2.8：排隊中的一定要看得到、能取消）。 */
  earlier?: boolean;
}) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [error, setError] = useState<string | null>(null);
  let text: string;
  switch (target.state) {
    case 'sent':
      text = t('team.broadcast.result.sent');
      break;
    case 'queued':
      text = t('team.broadcast.result.queued', {
        code: session ? statusCode(session) : '—',
      });
      break;
    case 'skipped':
      text = t(
        `team.broadcast.result.skipped.${target.reason === 'archived' ? 'archived' : 'ended'}`,
      );
      break;
    case 'cancelled':
      text = t('team.broadcast.result.cancelled');
      break;
    default:
      text = t(
        `team.broadcast.result.failed.${
          target.reason === 'hub_restarted' || target.reason === 'not_waiting'
            ? target.reason
            : 'ended'
        }`,
      );
  }
  return (
    <span
      className={`roster-result is-${target.state}`}
      data-testid={
        earlier ? `broadcast-earlier-${target.sessionId}` : `broadcast-result-${target.sessionId}`
      }
      data-broadcast={broadcast.id}
      data-state={target.state}
      title={`${broadcast.text}\n${new Date(target.at).toLocaleString()}`}
    >
      {earlier && <q className="roster-result-text">{snippet(broadcast.text)}</q>}
      {text}
      {target.state === 'queued' && (
        <button
          type="button"
          className="link"
          onClick={(e) => {
            e.stopPropagation();
            backend
              .cancelBroadcast(broadcast.id, target.sessionId)
              .catch((err: unknown) => setError(errorText(err)));
          }}
          aria-label={t('team.broadcast.cancelOf', { text: snippet(broadcast.text) })}
          data-testid={
            earlier
              ? `broadcast-cancel-earlier-${target.sessionId}`
              : `broadcast-cancel-${target.sessionId}`
          }
        >
          {t('team.broadcast.cancel')}
        </button>
      )}
      {error && (
        <span className="msg err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

export function Roster({ team, rows }: { team: Team; rows: RosterRow[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const broadcasts = useTeamBroadcasts(team.id);
  const [error, setError] = useState<string | null>(null);
  const sorted = sortRoster(rows.map((r) => ({ ...r, role: r.member.role, name: r.session.name })));

  const changeRole = async (sessionId: string, role: Role) => {
    setError(null);
    try {
      await backend.putTeamMember(team.id, sessionId, role);
      await refreshTeams(backend);
    } catch (e) {
      // 唯讀成員改成會改檔案的角色：hub 會重新檢查同資料夾（CONTRACTS「團隊事件」），角色維持不變。
      const name = rows.find((r) => r.session.id === sessionId)?.session.name ?? sessionId;
      setError(
        (e as { code?: string }).code === 'worktree_required'
          ? t('team.members.roleConflict', { name, detail: errorText(e) })
          : errorText(e),
      );
    }
  };

  return (
    <section className="roster" aria-labelledby={`roster-${team.id}`} data-testid="team-roster">
      <h2 id={`roster-${team.id}`}>{t('team.roster.title', { n: rows.length })}</h2>
      {rows.length === 0 ? (
        <p className="sub">{t('team.roster.empty')}</p>
      ) : (
        <ul className="roster-list">
          {sorted.map(({ member, session }) => {
            // 最新一則有點到這位：顯示它的結果；更早、還在排隊的每一則另外列出來，各自能取消。
            const mine = broadcasts.flatMap((b) =>
              b.targets.filter((x) => x.sessionId === session.id).map((x) => ({ b, x })),
            );
            const latest = mine.at(-1);
            const queuedEarlier = mine.slice(0, -1).filter(({ x }) => x.state === 'queued');
            return (
              <li
                key={session.id}
                className="roster-row"
                data-testid={`roster-row-${session.id}`}
                // 點列＝畫布聚焦那張卡（面板不關）；列上的選單、按鈕自己處理。
                onClick={(e) => {
                  if ((e.target as Element).closest('select, button, a')) return;
                  useViewsUi.getState().focusSession(session.id);
                }}
              >
                <Lamp status={session.status} detail={session.statusDetail} />
                <button
                  type="button"
                  className="roster-name"
                  title={t('team.roster.focus', { name: session.name })}
                  onClick={() => useViewsUi.getState().focusSession(session.id)}
                >
                  {session.name}
                </button>
                <select
                  className="roster-role"
                  aria-label={t('team.members.roleOf', { name: session.name })}
                  value={member.role}
                  onChange={(e) => void changeRole(session.id, e.target.value as Role)}
                  data-testid={`roster-role-${session.id}`}
                >
                  {TeamRole.options.map((r) => (
                    <option key={r} value={r}>
                      {t('team.role.withAbbr', { role: t(`team.role.${r}`), abbr: ROLE_ABBR[r] })}
                    </option>
                  ))}
                </select>
                <span className="roster-age">
                  <Age session={session} />
                </span>
                {(latest || queuedEarlier.length > 0) && (
                  <span className="roster-results">
                    {queuedEarlier.map(({ b, x }) => (
                      <TargetResult key={b.id} broadcast={b} target={x} session={session} earlier />
                    ))}
                    {latest && (
                      <TargetResult broadcast={latest.b} target={latest.x} session={session} />
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="alert you-alert" role="alert" data-testid="worktree-conflict">
          <span aria-hidden="true">◆</span>
          <div>{error}</div>
        </div>
      )}
    </section>
  );
}

/** 底部指令框：對整組下指令，@ 點名單一 agent。Enter 送出，不跳確認。 */
export function BroadcastBox({ team, rows }: { team: Team; rows: RosterRow[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const paused = useBoard((s) => s.pause?.paused ?? null);
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  /** 選了成員之後游標要放的位置：在這次畫面更新時就放好（不能等下一格，使用者可能已經在打字）。 */
  const placeCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === null || !input.current) return;
    placeCaret.current = null;
    input.current.focus();
    input.current.setSelectionRange(at, at);
  }, [value]);

  const live = rows.filter((r) => !r.session.archived);
  const candidates = live.map((r) => ({
    id: r.session.id,
    name: r.session.name,
    roles: [t(`team.role.${r.member.role}`), ROLE_ABBR[r.member.role], r.member.role],
  }));
  const parsed = parseCommand(value, candidates);
  const mention = activeMention(value, caret);
  const options = mention
    ? live.filter((r) => {
        const q = mention.query.toLowerCase();
        const role = r.member.role;
        return (
          r.session.name.toLowerCase().includes(q) ||
          t(`team.role.${role}`).toLowerCase().includes(q) ||
          ROLE_ABBR[role].toLowerCase().includes(q) ||
          role.includes(q)
        );
      })
    : [];

  const names = parsed.targets.map((id) => candidates.find((c) => c.id === id)?.name ?? id);
  const count = parsed.targets.length > 0 ? parsed.targets.length : live.length;
  const label =
    parsed.targets.length === 1
      ? t('team.broadcast.sendTo', { name: names[0]! })
      : parsed.targets.length > 1
        ? t('team.broadcast.sendToNames', { names: names.join('、') })
        : t('team.broadcast.sendAll', { n: count });
  const blocked = parsed.unknown.length > 0;
  const canSend = !busy && !blocked && parsed.text !== '' && count > 0;

  const choose = (row: RosterRow) => {
    if (!mention) return;
    const next = `${value.slice(0, mention.start)}@${row.session.name} ${value.slice(caret)}`;
    const at = mention.start + row.session.name.length + 2;
    placeCaret.current = at;
    setValue(next);
    setCaret(at);
    setPicked(0);
  };

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await backend.broadcastToTeam(
        team.id,
        parsed.text,
        parsed.targets.length > 0 ? parsed.targets : undefined,
      );
      setValue('');
      setCaret(0);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="broadcast" data-testid="team-broadcast">
      {options.length > 0 && (
        <ul className="mention-menu" role="listbox" data-testid="mention-menu">
          {options.map((row, i) => (
            <li key={row.session.id} role="option" aria-selected={i === picked}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(row)}
                data-testid={`mention-${row.session.id}`}
              >
                <b>{row.session.name}</b>
                <span className="sub">{t(`team.role.${row.member.role}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="broadcast-row">
        <input
          ref={input}
          className="cmd"
          value={value}
          placeholder={t('team.broadcast.placeholder')}
          aria-label={t('team.broadcast.aria', { name: team.name })}
          onChange={(e) => {
            setValue(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setPicked(0);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (options.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setPicked((p) => (p + step + options.length) % options.length);
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (options.length > 0) choose(options[Math.min(picked, options.length - 1)]!);
              else void send();
            }
          }}
          data-testid="broadcast-input"
        />
        <button
          type="button"
          className="primary"
          disabled={!canSend}
          onClick={() => void send()}
          data-testid="broadcast-send"
        >
          {label} <kbd>⏎</kbd>
        </button>
      </div>
      {blocked && (
        <p className="msg err" role="alert" data-testid="broadcast-unknown">
          {t('team.broadcast.unknown', { names: parsed.unknown.map((n) => `@${n}`).join('、') })}
        </p>
      )}
      {paused && (
        <p className="sub broadcast-paused" role="status" data-testid="broadcast-paused">
          {t('team.broadcast.paused')}
        </p>
      )}
      {error && (
        <p className="msg err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
