// 展開的終端機（DISPATCH §5.3 畫面 5）：全尺寸 xterm、Esc 中斷、交接，旁邊並列其他 session。
// 畫布在這頁是卸載的，同一個瀏覽器分頁裡每個 session 最多只有一個 TerminalView 在訂閱與送 resize。
import { useEffect, useState } from 'react';
import { HandoffTrigger } from '@agent-board/protocol';
import type { HandoffRule, Session } from '@agent-board/protocol';
import { SessionReviewCards } from '../flows';
import { useMaskText } from '../security';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { ActionMessage, CostChip, useAction } from '../team/common';
import { refreshTeams, useTeams, useTeamSync } from '../team/store';
import { TerminalView } from '../terminal';
import {
  Age,
  AppHeader,
  PauseStrip,
  EmptyState,
  ErrorState,
  handsClass,
  Lamp,
  LoadingState,
  pendingQueue,
  StaleBanner,
  useBoardLoad,
  useViewsUi,
} from '../views';
import { CommandInput } from './CommandInput';
import { DoneHint } from './DoneHint';
import { CardHead, cardClass, NO_INPUT, useSizeNote } from './SessionNode';
import { teamForHandoff } from './teams';
import { sessionFromHash, terminalHash } from './terminalRoute';
import './canvas.css';
import './expanded.css';
import './messages';

function useHashSession(): string | null {
  const [id, setId] = useState(() => sessionFromHash(location.hash));
  useEffect(() => {
    const onChange = () => setId(sessionFromHash(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return id;
}

/** 回畫布：有離開時的鏡頭就還原；直接開網址進來的，改成把畫布帶到這張卡。 */
function backToCanvas(sessionId: string | null) {
  const ui = useViewsUi.getState();
  if (!ui.canvasReturn && sessionId) ui.focusSession(sessionId);
  location.hash = '#/canvas';
}

function SessionList({ currentId }: { currentId: string | null }) {
  const t = useT();
  const { sessions, approvals } = useBoard();
  const visible = sessions.filter((s) => !s.archived);
  // 等你的排前面，順序和待處理清單相同；其他照畫布的順序。
  const queue = pendingQueue(visible, approvals);
  const queued = new Set(queue.map((s) => s.id));
  const ordered = [...queue, ...visible.filter((s) => !queued.has(s.id))];
  return (
    <nav className="xpand-list" aria-label={t('canvas.full.list')}>
      <button onClick={() => backToCanvas(currentId)} data-testid="full-back">
        ← {t('canvas.full.back')}
      </button>
      <h3>{t('canvas.full.list')}</h3>
      <ul>
        {ordered.map((s) => (
          <li key={s.id}>
            <a
              className={`xpand-item hands-host ${handsClass(s.permissionMode)}`}
              href={terminalHash(s.id)}
              aria-current={s.id === currentId ? 'page' : undefined}
              data-testid={`full-item-${s.id}`}
            >
              <span className="head">
                <Lamp status={s.status} detail={s.statusDetail} />
                <Age session={s} />
              </span>
              <span className="title">{s.name}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function HandoffBox({ session }: { session: Session }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const rules = useTeams((s) => s.rules);
  const members = useTeams((s) => s.members);
  const [to, setTo] = useState('');
  const [trigger, setTrigger] = useState<HandoffRule['trigger']>('on_done');
  const { busy, message, run, setMessage } = useAction();
  const outgoing = rules.filter((r) => r.fromSessionId === session.id);
  const targets = sessions.filter((s) => s.id !== session.id && !s.archived);
  const nameOf = (id: string) => sessions.find((s) => s.id === id)?.name ?? t('team.rules.gone');

  const add = () => {
    // 和畫布拖線同一條規則：來源所屬的團隊優先，其次目標。
    const teamId = teamForHandoff(session.id, to, members);
    if (!teamId) {
      setMessage({ text: t('canvas.handoff.noTeam'), failed: true });
      return;
    }
    void run(async () => {
      // 先關著：開啟才會花額度，要使用者自己按（STYLE.md 規則三之二）。
      await backend.createHandoffRule(teamId, {
        fromSessionId: session.id,
        trigger,
        action: { toSessionId: to },
        enabled: false,
      });
      await refreshTeams(backend);
      setTo('');
      return t('canvas.full.handoffAdded');
    });
  };
  const toggle = (rule: HandoffRule) =>
    void run(async () => {
      await backend.updateHandoffRule(rule.id, { enabled: !rule.enabled });
      await refreshTeams(backend);
    });

  return (
    <section className="xpand-panel" aria-labelledby="full-handoff" data-testid="full-handoff">
      <h3 id="full-handoff">{t('canvas.full.handoff')}</h3>
      {outgoing.length > 0 && (
        <ul className="xpand-rules">
          {outgoing.map((rule) => (
            <li key={rule.id} data-testid={`full-rule-${rule.id}`}>
              <div>
                → <b>{nameOf(rule.action.toSessionId)}</b>{' '}
                <span className="sub">{t(`canvas.handoff.${rule.trigger}`)}</span>
              </div>
              <div className="xpand-row">
                <button
                  className="sm"
                  aria-pressed={rule.enabled}
                  disabled={busy}
                  onClick={() => toggle(rule)}
                >
                  {rule.enabled ? t('team.rules.on') : t('team.rules.off')}
                </button>
                <CostChip />
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="xpand-row">
        <select
          className="sm"
          aria-label={t('team.rules.to')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value="">{t('team.rules.to')}</option>
          {targets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="sm"
          aria-label={t('team.rules.trigger')}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as HandoffRule['trigger'])}
        >
          {/* 回覆含標記要填標記字串，在團隊工作台建立。 */}
          {HandoffTrigger.options
            .filter((option) => option !== 'on_marker')
            .map((option) => (
              <option key={option} value={option}>
                {t(`canvas.handoff.${option}`)}
              </option>
            ))}
        </select>
        <button className="sm" disabled={busy || to === ''} onClick={add}>
          {t('canvas.full.handoffAdd')}
        </button>
      </div>
      <p className="sub">{t('canvas.full.handoffHint')}</p>
      <ActionMessage message={message} />
    </section>
  );
}

function EscButton({ session }: { session: Session }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const [msg, setMsg] = useState('');
  useEffect(() => setMsg(''), [session.id]);
  return (
    <>
      <button
        className="sm"
        disabled={!connected || NO_INPUT.includes(session.status)}
        onClick={() => {
          backend.terminal.send({
            type: 'terminal.signal',
            sessionId: session.id,
            signal: 'escape',
          });
          setMsg(t('canvas.act.escSent'));
        }}
      >
        {t('canvas.act.esc')}
      </button>
      {msg && (
        <span className="msg" role="status">
          {msg}
        </span>
      )}
    </>
  );
}

function Expanded({ session }: { session: Session }) {
  const t = useT();
  const mask = useMaskText();
  const backend = useBoard((s) => s.backend);
  const canType = !NO_INPUT.includes(session.status);
  const size = useSizeNote();
  return (
    <article className={cardClass('xpand-card', session)} data-testid={`full-${session.id}`}>
      <header>
        <CardHead session={session} />
        <div className="term-acts">
          <EscButton session={session} />
        </div>
      </header>
      <DoneHint session={session} />
      <div className="xpand-body">
        {/* xterm 外框之內不疊任何東西（規則三之一）。 */}
        <div className="term-slot xpand-term" data-testid="terminal-slot">
          {session.status === 'offline' ? (
            // 失聯的機器沒有串流可接，維持凍結的最後畫面（規則四）。
            <pre className="tail">{mask(session.lastLines.join('\n'))}</pre>
          ) : (
            <TerminalView
              key={session.id}
              sessionId={session.id}
              stream={backend.terminal}
              autoFocus
              onSizeOwnerChange={size.onSizeOwnerChange}
            />
          )}
        </div>
        <aside className="xpand-side" aria-label={t('canvas.full.side')}>
          <SessionReviewCards sessionId={session.id} />
          <HandoffBox session={session} />
        </aside>
      </div>
      {size.note}
      {canType && <CommandInput session={session} />}
    </article>
  );
}

export function TerminalPage() {
  const t = useT();
  const load = useBoardLoad();
  useTeamSync();
  const sessionId = useHashSession();
  const connected = useBoard((s) => s.connected);
  const session = useBoard((s) => s.sessions.find((x) => x.id === sessionId && !x.archived));

  // 頁首的「下一個等我的」只會框選卡片；在這頁時要真的回到畫布才看得到。
  useEffect(
    () =>
      useViewsUi.subscribe((state, prev) => {
        if (state.pendingFocus !== null && state.pendingFocus !== prev.pendingFocus) {
          location.hash = '#/canvas';
        }
      }),
    [],
  );

  let body;
  if (load.status === 'error') {
    body = (
      <ErrorState text={t('views.error.board', { detail: load.detail })} onRetry={load.retry} />
    );
  } else if (load.status === 'loading') {
    body = <LoadingState />;
  } else if (!session) {
    body = (
      <EmptyState
        text={t('canvas.full.missing')}
        action={<button onClick={() => backToCanvas(null)}>{t('canvas.full.back')}</button>}
      />
    );
  } else {
    body = <Expanded session={session} />;
  }

  return (
    <div className={`shell${connected ? '' : ' is-stale'}`}>
      <AppHeader />
      {!connected && <StaleBanner />}
      <PauseStrip />
      <div className="board xpand">
        <SessionList currentId={sessionId} />
        <main className="main xpand-main">{body}</main>
      </div>
    </div>
  );
}
