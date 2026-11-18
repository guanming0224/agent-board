// 設定頁「模型清單」（GM 2026-11-17，CONTRACTS §26；2026-11-18 §26.11 加隱藏／釘選）：新增 session 的模型下拉要列哪些，
// Claude 與 Codex 各一份。三塊：釘選（排最上面、可排序）、內建目錄（Claude 內建清單；Codex 是各機器 `codex debug models`
// 抓到的目錄，沒有就內建名單）可釘選或隱藏、自己加的（增、刪、上下移、釘選）。只有 owner，存檔走共用的儲存列。
import { useState } from 'react';
import {
  EMPTY_MODEL_PREF,
  isSafeModelName,
  sameModel,
  MODEL_LIST_MAX,
  MODEL_LISTS_DEFAULT,
  MODEL_PREF_MAX,
  type CodexModels,
  type ModelLists,
  type ModelPref,
} from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { Msg, type Note } from './common';
import { groupLabel, optionText, useNoteText } from './ModelFields';
import { catalogItems, mergedCodexCatalog } from './modelChoice';
import type { ServerSettingsForm } from './ServerSettings';
import { Section } from './settingsParts';

type Kind = 'claude' | 'codex';
const KINDS: readonly Kind[] = ['claude', 'codex'];

const has = (list: readonly string[], name: string) => list.some((n) => sameModel(n, name));
const without = (list: readonly string[], name: string) => list.filter((n) => !sameModel(n, name));
const moved = (list: readonly string[], index: number, by: -1 | 1) => {
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(index + by, 0, item!);
  return next;
};

/** 上移／下移兩顆。 */
function MoveButtons({
  name,
  index,
  count,
  onMove,
}: {
  name: string;
  index: number;
  count: number;
  onMove: (by: -1 | 1) => void;
}) {
  const t = useT();
  return (
    <>
      <button
        type="button"
        className="sm icon"
        disabled={index === 0}
        aria-label={t('flows.modelLists.up', { name })}
        title={t('flows.modelLists.up', { name })}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="sm icon"
        disabled={index === count - 1}
        aria-label={t('flows.modelLists.down', { name })}
        title={t('flows.modelLists.down', { name })}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
    </>
  );
}

/** 釘選鈕（aria-pressed）：釘了排到下拉最上面。 */
function PinButton({
  name,
  pinned,
  onToggle,
}: {
  name: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="sm"
      aria-pressed={pinned}
      aria-label={t(pinned ? 'flows.modelLists.unpinName' : 'flows.modelLists.pinName', { name })}
      onClick={onToggle}
    >
      {t(pinned ? 'flows.modelLists.unpin' : 'flows.modelLists.pin')}
    </button>
  );
}

function ListEditor({
  kind,
  lists,
  codexCatalog,
  onChange,
}: {
  kind: Kind;
  lists: ModelLists;
  codexCatalog: CodexModels;
  onChange: (next: ModelLists) => void;
}) {
  const t = useT();
  const noteText = useNoteText();
  const [text, setText] = useState('');
  const [note, setNote] = useState<Note | null>(null);
  const label = t(`flows.modelLists.${kind}`);
  const catalog = catalogItems(kind, codexCatalog);
  const inCatalog = (name: string) => catalog.some((c) => sameModel(c.item.value, name));
  const pinned = lists.pinned?.[kind] ?? [];
  const hidden = lists.hidden?.[kind] ?? [];
  // 自己加的：內建目錄已有的名稱（§26 的舊預設是 fable、opus…）不再另列，下拉也只出現一次。
  const mine = lists[kind].filter((name) => !inCatalog(name));

  const setPref = (key: 'pinned' | 'hidden', list: string[]) => {
    const base: ModelPref = lists[key] ?? EMPTY_MODEL_PREF;
    onChange({ ...lists, [key]: { ...base, [kind]: list } });
  };
  const setBoth = (pins: string[], hides: string[], own = mine) =>
    onChange({
      ...lists,
      [kind]: own,
      pinned: { ...(lists.pinned ?? EMPTY_MODEL_PREF), [kind]: pins },
      hidden: { ...(lists.hidden ?? EMPTY_MODEL_PREF), [kind]: hides },
    });
  const togglePin = (name: string) => {
    if (has(pinned, name)) return setPref('pinned', without(pinned, name));
    if (pinned.length >= MODEL_PREF_MAX) return;
    // 釘選的一定顯示：同時從隱藏拿掉。
    setBoth([...pinned, name], without(hidden, name));
  };
  const toggleHide = (name: string) => {
    if (has(hidden, name)) return setPref('hidden', without(hidden, name));
    if (hidden.length >= MODEL_PREF_MAX) return;
    setBoth(without(pinned, name), [...hidden, name]);
  };

  const add = () => {
    const name = text.trim();
    const error = !name
      ? 'flows.modelLists.errEmpty'
      : !isSafeModelName(name)
        ? 'flows.new.err.modelName'
        : mine.some((existing) => sameModel(existing, name)) || inCatalog(name)
          ? 'flows.modelLists.errDup'
          : mine.length >= MODEL_LIST_MAX
            ? 'flows.modelLists.errMax'
            : null;
    if (error) return setNote({ text: t(error, { max: MODEL_LIST_MAX }), tone: 'err' });
    onChange({ ...lists, [kind]: [...mine, name] });
    setText('');
    setNote(null);
  };
  const describe = (name: string) => {
    const item = catalog.find((c) => sameModel(c.item.value, name))?.item;
    return item ? optionText(item, noteText(item.note)) : name;
  };

  return (
    <div className="field model-lists" data-testid={`model-list-${kind}`}>
      <span className="label">{label}</span>

      <span className="sublabel">{t('flows.modelLists.pinnedTitle')}</span>
      {pinned.length === 0 ? (
        <p className="hint">{t('flows.modelLists.pinnedEmpty')}</p>
      ) : (
        <ul className="rule-list model-list" data-testid={`model-pinned-${kind}`}>
          {pinned.map((name, index) => (
            <li key={name}>
              <span className="model-row-name">{describe(name)}</span>
              <span className="model-list-acts">
                <MoveButtons
                  name={name}
                  index={index}
                  count={pinned.length}
                  onMove={(by) => setPref('pinned', moved(pinned, index, by))}
                />
                <PinButton name={name} pinned onToggle={() => togglePin(name)} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <span className="sublabel">
        {t(kind === 'codex' ? 'flows.modelLists.catalogCodex' : 'flows.modelLists.catalogClaude')}
      </span>
      <ul className="rule-list model-list" data-testid={`model-catalog-${kind}`}>
        {catalog.map(({ item, key, series }, index) => {
          const isHidden = has(hidden, item.value);
          const prev = catalog[index - 1];
          const heading =
            !prev || prev.key !== key || prev.series !== series
              ? groupLabel(t, { key, series })
              : null;
          return (
            <li
              key={item.value}
              className={isHidden ? 'model-hidden' : undefined}
              data-model={item.value}
            >
              <span className="model-row-name">
                {heading && <span className="model-row-group">{heading}</span>}
                {optionText(item, noteText(item.note))}
              </span>
              <span className="model-list-acts">
                <PinButton
                  name={item.value}
                  pinned={has(pinned, item.value)}
                  onToggle={() => togglePin(item.value)}
                />
                <button
                  type="button"
                  className="sm"
                  aria-pressed={isHidden}
                  aria-label={t(
                    isHidden ? 'flows.modelLists.showName' : 'flows.modelLists.hideName',
                    {
                      name: item.value,
                    },
                  )}
                  onClick={() => toggleHide(item.value)}
                >
                  {t(isHidden ? 'flows.modelLists.show' : 'flows.modelLists.hide')}
                </button>
              </span>
            </li>
          );
        })}
      </ul>

      <span className="sublabel">{t('flows.modelLists.mineTitle')}</span>
      {mine.length === 0 ? (
        <p className="hint">{t('flows.modelLists.empty')}</p>
      ) : (
        <ul className="rule-list model-list" data-testid={`model-mine-${kind}`}>
          {mine.map((name, index) => (
            <li key={name}>
              <code>{name}</code>
              <span className="model-list-acts">
                <MoveButtons
                  name={name}
                  index={index}
                  count={mine.length}
                  onMove={(by) => onChange({ ...lists, [kind]: moved(mine, index, by) })}
                />
                <PinButton
                  name={name}
                  pinned={has(pinned, name)}
                  onToggle={() => togglePin(name)}
                />
                <button
                  type="button"
                  className="sm"
                  aria-label={t('flows.modelLists.remove', { name })}
                  onClick={() =>
                    setBoth(without(pinned, name), without(hidden, name), without(mine, name))
                  }
                >
                  {t('flows.security.remove')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="input-row">
        <input
          className="mono"
          value={text}
          aria-label={t('flows.modelLists.newName', { list: label })}
          placeholder={t(
            kind === 'codex'
              ? 'flows.new.modelCustomPlaceholderCodex'
              : 'flows.new.modelCustomPlaceholder',
          )}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add}>
          {t('flows.modelLists.add')}
        </button>
      </div>
      <Msg note={note} />
    </div>
  );
}

export function ModelListsSection({ form }: { form: ServerSettingsForm }) {
  const t = useT();
  const { draft, patch } = form;
  const machines = useBoard((s) => s.machines);
  // 舊 hub 沒有這個設定（回應裡沒有 modelLists）：不顯示編輯器，免得存了被丟掉。
  const lists = (draft as { modelLists?: ModelLists }).modelLists;
  const codexCatalog = mergedCodexCatalog(machines);
  return (
    <Section
      id="modelLists"
      title={t('flows.settings.modelLists')}
      dirty={form.isDirty('modelLists')}
    >
      {!lists ? (
        <p className="hint">{t('flows.modelLists.oldHub')}</p>
      ) : (
        <>
          <p className="hint">{t('flows.modelLists.hint')}</p>
          {KINDS.map((kind) => (
            <ListEditor
              key={kind}
              kind={kind}
              lists={lists}
              codexCatalog={codexCatalog}
              onChange={(next) => patch({ modelLists: next })}
            />
          ))}
          <div className="field">
            <button
              type="button"
              data-testid="model-lists-reset"
              onClick={() =>
                patch({
                  modelLists: {
                    claude: [...MODEL_LISTS_DEFAULT.claude],
                    codex: [...MODEL_LISTS_DEFAULT.codex],
                    pinned: { claude: [], codex: [] },
                    hidden: { claude: [], codex: [] },
                  },
                })
              }
            >
              {t('flows.modelLists.reset')}
            </button>
          </div>
        </>
      )}
    </Section>
  );
}
