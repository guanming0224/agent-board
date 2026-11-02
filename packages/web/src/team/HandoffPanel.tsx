// 自動交接規則：開關、觸發條件，以及最近實際發生了什麼（被防迴圈擋下也要看得到）。
import { useEffect, useState } from 'react';
import { HandoffTrigger } from '@agent-board/protocol';
import type { HandoffRule, Session, SessionEvent, Team } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useClock } from '../views';
import { ActionMessage, CostChip, useAction } from './common';
import { refreshTeams, useTeams } from './store';

const ACTIVITY_POLL_MS = 10_000;
const ACTIVITY_SHOWN = 8;
const ACTIVITY_TYPES = new Set(['handoff.fired', 'handoff.blocked']);

function RuleRow({ rule, members }: { rule: HandoffRule; members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const [pattern, setPattern] = useState(rule.action.filePattern ?? '');
  const { busy, message, run } = useAction();
  const nameOf = (id: string) =>
    members.find((m) => m.id === id)?.name ??
    sessions.find((s) => s.id === id)?.name ??
    t('team.rules.gone');

  const update = (patch: Parameters<typeof backend.updateHandoffRule>[1]) =>
    run(async () => {
      await backend.updateHandoffRule(rule.id, patch);
      await refreshTeams(backend);
    });

  return (
    <li className="rule" data-testid={`rule-${rule.id}`}>
      <div className="rule-route">
        <b>{nameOf(rule.fromSessionId)}</b> → <b>{nameOf(rule.action.toSessionId)}</b>
      </div>
      <div className="row">
        <select
          aria-label={t('team.rules.trigger')}
          value={rule.trigger}
          disabled={busy}
          onChange={(e) => void update({ trigger: e.target.value as HandoffRule['trigger'] })}
        >
          {HandoffTrigger.options.map((trigger) => (
            <option key={trigger} value={trigger}>
              {t(`canvas.handoff.${trigger}`)}
            </option>
          ))}
        </select>
        {rule.trigger === 'on_file' && (
          <input
            aria-label={t('team.rules.pattern')}
            placeholder={t('team.rules.patternPlaceholder')}
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onBlur={() => {
              if (pattern !== (rule.action.filePattern ?? '')) {
                void update({
                  action: {
                    toSessionId: rule.action.toSessionId,
                    ...(pattern ? { filePattern: pattern } : {}),
                  },
                });
              }
            }}
          />
        )}
        <button
          aria-pressed={rule.enabled}
          disabled={busy}
          onClick={() => void update({ enabled: !rule.enabled })}
        >
          {rule.enabled ? t('team.rules.on') : t('team.rules.off')}
        </button>
        <CostChip />
        <button
          className="link"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await backend.deleteHandoffRule(rule.id);
              await refreshTeams(backend);
            })
          }
        >
          {t('team.rules.delete')}
        </button>
      </div>
      <ActionMessage message={message} />
    </li>
  );
}

function NewRule({ team, members }: { team: Team; members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [trigger, setTrigger] = useState<HandoffRule['trigger']>('on_done');
  const { busy, message, run } = useAction();
  const invalid = from === '' || to === '' || from === to;
  const options = members.map((m) => (
    <option key={m.id} value={m.id}>
      {m.name}
    </option>
  ));
  return (
    <div className="row new-rule">
      <select
        aria-label={t('team.rules.from')}
        value={from}
        onChange={(e) => setFrom(e.target.value)}
      >
        <option value="">{t('team.rules.from')}</option>
        {options}
      </select>
      <select aria-label={t('team.rules.to')} value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">{t('team.rules.to')}</option>
        {options}
      </select>
      <select
        aria-label={t('team.rules.trigger')}
        value={trigger}
        onChange={(e) => setTrigger(e.target.value as HandoffRule['trigger'])}
      >
        {HandoffTrigger.options.map((option) => (
          <option key={option} value={option}>
            {t(`canvas.handoff.${option}`)}
          </option>
        ))}
      </select>
      <button
        disabled={busy || invalid}
        onClick={() =>
          void run(async () => {
            // 新規則先關著：開啟才會花額度，要使用者自己按。
            await backend.createHandoffRule(team.id, {
              fromSessionId: from,
              trigger,
              action: { toSessionId: to },
              enabled: false,
            });
            await refreshTeams(backend);
            setFrom('');
            setTo('');
          })
        }
      >
        {t('team.rules.add')}
      </button>
      <ActionMessage message={message} />
    </div>
  );
}

function Activity({ members }: { members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const clock = useClock();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const ids = members.map((m) => m.id).join('|');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      const lists = await Promise.all(
        ids
          .split('|')
          .filter(Boolean)
          .map((id) => backend.sessionEvents(id)),
      );
      if (!alive) return;
      const handoffs = lists.flat().filter((e) => ACTIVITY_TYPES.has(e.type));
      handoffs.sort((a, b) => b.at.localeCompare(a.at));
      setEvents(handoffs.slice(0, ACTIVITY_SHOWN));
    };
    // 紀錄只是輔助資訊，讀不到不打斷工作台。
    const safeLoad = () => void load().catch(() => undefined);
    safeLoad();
    const timer = setInterval(safeLoad, ACTIVITY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [backend, ids]);

  const nameOf = (id: unknown) => sessions.find((s) => s.id === id)?.name ?? t('team.rules.gone');

  if (events.length === 0) return <p className="sub">{t('team.activity.empty')}</p>;
  return (
    <ul className="activity" data-testid="handoff-activity">
      {events.map((event) => (
        <li key={event.id}>
          <span className="num sub">{clock(event.at)}</span> {nameOf(event.payload.fromSessionId)} →{' '}
          {nameOf(event.payload.toSessionId)}
          {'：'}
          {event.type === 'handoff.fired'
            ? t('team.activity.fired')
            : t(`team.activity.blocked.${String(event.payload.reason)}`)}
        </li>
      ))}
    </ul>
  );
}

export function HandoffPanel({ team, members }: { team: Team; members: Session[] }) {
  const t = useT();
  const rules = useTeams((s) => s.rules).filter((r) => r.teamId === team.id);
  return (
    <section className="panel" aria-labelledby="rules-title">
      <h2 id="rules-title">{t('team.rules.title')}</h2>
      <p className="sub">{t('team.rules.hint')}</p>
      {rules.length === 0 ? (
        <p className="sub">{t('team.rules.empty')}</p>
      ) : (
        <ul className="rules">
          {rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} members={members} />
          ))}
        </ul>
      )}
      <NewRule team={team} members={members} />
      <h3>{t('team.activity.title')}</h3>
      <Activity members={members} />
    </section>
  );
}
