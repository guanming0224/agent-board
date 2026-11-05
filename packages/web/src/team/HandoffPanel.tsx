// 自動交接規則：開關、觸發條件、雙向來回的輪數上限，以及最近實際發生了什麼（被防迴圈擋下也要看得到）。
import { useEffect, useState } from 'react';
import { HANDOFF_MARKER_MAX_CHARS, HandoffTrigger } from '@agent-board/protocol';
import type { HandoffRule, Session, SessionEvent, Team } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, useClock } from '../views';
import { ActionMessage, CostChip, useAction } from './common';
import {
  choiceProblem,
  createRules,
  DEFAULT_MARKER,
  patchAction,
  ROUND_OPTIONS,
  ruleAction,
  triggerChoice,
  TWO_WAY_DEFAULT_ROUNDS,
  twoWayRules,
  type RuleInput,
  type Trigger,
  type TriggerChoice,
} from './handoffRules';
import { refreshTeams, useTeams } from './store';

const ACTIVITY_POLL_MS = 10_000;
const ACTIVITY_SHOWN = 8;
const ACTIVITY_TYPES = new Set(['handoff.fired', 'handoff.blocked']);
const TRIGGER_NOTE: Record<HandoffRule['trigger'], string> = {
  on_done: 'team.rules.doneLimit',
  on_file: 'team.rules.fileLimit',
  on_fail: 'team.rules.failLimit',
  on_marker: 'team.rules.markerLimit',
};

type T = ReturnType<typeof useT>;

/** 觸發條件＋它需要的欄位（on_file 的檔案樣式、on_marker 的標記）。`label` 給雙向時分辨方向。 */
function TriggerFields({
  value,
  onChange,
  label,
}: {
  value: TriggerChoice;
  onChange: (next: TriggerChoice) => void;
  label?: string;
}) {
  const t = useT();
  const prefix = label ? `${label} ` : '';
  return (
    <>
      <select
        aria-label={`${prefix}${t('team.rules.trigger')}`}
        value={value.trigger}
        onChange={(e) => {
          const trigger = e.target.value as Trigger;
          onChange({ ...triggerChoice(trigger), filePattern: value.filePattern });
        }}
      >
        {HandoffTrigger.options.map((option) => (
          <option key={option} value={option}>
            {t(`canvas.handoff.${option}`)}
          </option>
        ))}
      </select>
      {value.trigger === 'on_file' && (
        <input
          aria-label={`${prefix}${t('team.rules.pattern')}`}
          placeholder={t('team.rules.patternPlaceholder')}
          value={value.filePattern}
          onChange={(e) => onChange({ ...value, filePattern: e.target.value })}
        />
      )}
      {value.trigger === 'on_marker' && (
        <input
          aria-label={`${prefix}${t('team.rules.marker')}`}
          placeholder={DEFAULT_MARKER}
          maxLength={HANDOFF_MARKER_MAX_CHARS}
          value={value.marker}
          onChange={(e) => onChange({ ...value, marker: e.target.value })}
        />
      )}
    </>
  );
}

function RoundsSelect({
  value,
  onChange,
  disabled,
  allowOneWay,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  disabled?: boolean;
  allowOneWay: boolean;
}) {
  const t = useT();
  return (
    <select
      aria-label={t('team.rules.rounds')}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      {allowOneWay && <option value="">{t('team.rules.roundsNone')}</option>}
      {ROUND_OPTIONS.map((n) => (
        <option key={n} value={n}>
          {t('team.rules.roundsN', { n })}
        </option>
      ))}
    </select>
  );
}

const markerText = (t: T, rule: HandoffRule) =>
  rule.trigger === 'on_marker' && rule.action.marker
    ? t('team.rules.markerIs', { marker: rule.action.marker })
    : null;

function RuleRow({ rule, members }: { rule: HandoffRule; members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const sessions = useBoard((s) => s.sessions);
  const [pattern, setPattern] = useState(rule.action.filePattern ?? '');
  const [marker, setMarker] = useState(rule.action.marker ?? '');
  const { busy, message, run, setMessage } = useAction();
  const nameOf = (id: string) =>
    members.find((m) => m.id === id)?.name ??
    sessions.find((s) => s.id === id)?.name ??
    t('team.rules.gone');

  const update = (patch: Parameters<typeof backend.updateHandoffRule>[1]) =>
    run(async () => {
      await backend.updateHandoffRule(rule.id, patch);
      await refreshTeams(backend);
    });

  const changeTrigger = (trigger: Trigger) => {
    // 改成回覆含標記：沒有標記就先放預設的，hub 不收沒有標記的 on_marker。
    const nextMarker = trigger === 'on_marker' ? rule.action.marker || DEFAULT_MARKER : undefined;
    if (nextMarker) setMarker(nextMarker);
    void update({
      trigger,
      ...(nextMarker ? { action: patchAction(rule.action, { marker: nextMarker }) } : {}),
    });
  };

  const { maxRounds } = rule.action;
  const markerNote = markerText(t, rule);
  return (
    <li className="rule" data-testid={`rule-${rule.id}`}>
      <div className="rule-route">
        <b>{nameOf(rule.fromSessionId)}</b> → <b>{nameOf(rule.action.toSessionId)}</b>
        {maxRounds !== undefined && (
          <span className="chip rule-rounds" data-testid={`rule-rounds-${rule.id}`}>
            {t('team.rules.roundsChip', { n: maxRounds })}
          </span>
        )}
      </div>
      <div className="row">
        <select
          aria-label={t('team.rules.trigger')}
          value={rule.trigger}
          disabled={busy}
          onChange={(e) => changeTrigger(e.target.value as Trigger)}
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
                void update({ action: patchAction(rule.action, { filePattern: pattern }) });
              }
            }}
          />
        )}
        {rule.trigger === 'on_marker' && (
          <input
            aria-label={t('team.rules.marker')}
            placeholder={DEFAULT_MARKER}
            maxLength={HANDOFF_MARKER_MAX_CHARS}
            value={marker}
            onChange={(e) => setMarker(e.target.value)}
            onBlur={() => {
              if (marker.trim() === (rule.action.marker ?? '')) return;
              if (!marker.trim()) {
                setMessage({ text: t('team.rules.err.marker_required'), failed: true });
                return;
              }
              void update({ action: patchAction(rule.action, { marker }) });
            }}
          />
        )}
        <RoundsSelect
          value={maxRounds ?? null}
          disabled={busy}
          allowOneWay
          onChange={(n) => void update({ action: patchAction(rule.action, { maxRounds: n }) })}
        />
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
      <p className="sub rule-limit">
        {t(TRIGGER_NOTE[rule.trigger])}
        {markerNote && ` ${markerNote}`}
        {maxRounds !== undefined && ` ${t('team.rules.roundsNote', { n: maxRounds })}`}
      </p>
      <ActionMessage message={message} />
    </li>
  );
}

type Direction = 'one' | 'two';

function NewRule({ team, members }: { team: Team; members: Session[] }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const [direction, setDirection] = useState<Direction>('one');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [forward, setForward] = useState<TriggerChoice>(triggerChoice('on_done'));
  const [back, setBack] = useState<TriggerChoice>(triggerChoice('on_marker'));
  const [rounds, setRounds] = useState<number>(TWO_WAY_DEFAULT_ROUNDS);
  const { busy, message, run, setMessage } = useAction();
  const two = direction === 'two';
  const invalid = from === '' || to === '' || from === to;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? t('team.rules.gone');
  const options = members.map((m) => (
    <option key={m.id} value={m.id}>
      {m.name}
    </option>
  ));

  const add = () => {
    const problem = choiceProblem(forward) ?? (two ? choiceProblem(back) : null);
    if (problem) {
      setMessage({ text: t(`team.rules.err.${problem}`), failed: true });
      return;
    }
    void run(async () => {
      // 新規則先關著：開啟才會花額度，要使用者自己按。
      const inputs: RuleInput[] = two
        ? twoWayRules(from, to, forward, back, rounds)
        : [
            {
              fromSessionId: from,
              trigger: forward.trigger,
              action: ruleAction(to, forward),
              enabled: false,
            },
          ];
      const { created, failed } = await createRules(backend, team.id, inputs);
      await refreshTeams(backend);
      if (failed.length > 0) {
        // 一條成功一條失敗：留著成功的，說清楚哪一條沒建。
        throw new Error(
          t('team.rules.partial', {
            created: created.length,
            routes: failed
              .map(
                (f) => `${nameOf(f.input.fromSessionId)} → ${nameOf(f.input.action.toSessionId)}`,
              )
              .join('、'),
            detail: errorText(failed[0]!.error),
          }),
        );
      }
      setFrom('');
      setTo('');
      return two ? t('team.rules.addedTwoWay', { n: rounds }) : null;
    });
  };

  return (
    <div className="new-rule" data-testid="new-rule">
      <div className="seg" role="group" aria-label={t('team.rules.direction')}>
        {(['one', 'two'] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={direction === d}
            onClick={() => setDirection(d)}
          >
            {t(`team.rules.direction.${d}`)}
          </button>
        ))}
      </div>
      <div className="row">
        <select
          aria-label={two ? t('team.rules.sideA') : t('team.rules.from')}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        >
          <option value="">{two ? t('team.rules.sideA') : t('team.rules.from')}</option>
          {options}
        </select>
        <select
          aria-label={two ? t('team.rules.sideB') : t('team.rules.to')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value="">{two ? t('team.rules.sideB') : t('team.rules.to')}</option>
          {options}
        </select>
        {!two && <TriggerFields value={forward} onChange={setForward} />}
      </div>
      {two && (
        <>
          <div className="row" data-testid="two-way-forward">
            <span className="sub">{t('team.rules.aToB')}</span>
            <TriggerFields value={forward} onChange={setForward} label={t('team.rules.aToB')} />
          </div>
          <div className="row" data-testid="two-way-back">
            <span className="sub">{t('team.rules.bToA')}</span>
            <TriggerFields value={back} onChange={setBack} label={t('team.rules.bToA')} />
          </div>
          <div className="row">
            <RoundsSelect
              value={rounds}
              allowOneWay={false}
              onChange={(n) => setRounds(n ?? TWO_WAY_DEFAULT_ROUNDS)}
            />
            <span className="sub">{t('team.rules.twoWayHint')}</span>
          </div>
        </>
      )}
      <div className="row">
        <button disabled={busy || invalid} onClick={add}>
          {two ? t('team.rules.addTwoWay') : t('team.rules.add')}
        </button>
        <ActionMessage message={message} testId="new-rule-msg" />
      </div>
      <p className="sub rule-limit">{t(TRIGGER_NOTE[forward.trigger])}</p>
      {two && back.trigger !== forward.trigger && (
        <p className="sub rule-limit">{t(TRIGGER_NOTE[back.trigger])}</p>
      )}
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
            : t(`team.activity.blocked.${String(event.payload.reason)}`, {
                max: String(event.payload.maxRounds ?? '?'),
              })}
          {typeof event.payload.round === 'number' &&
            typeof event.payload.maxRounds === 'number' && (
              <span className="sub">
                {' '}
                {t('canvas.talk.round', {
                  n: Math.min(event.payload.round, event.payload.maxRounds),
                  max: event.payload.maxRounds,
                })}
              </span>
            )}
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
