// 設定頁「模型清單」（GM 2026-11-17，CONTRACTS §26）：新增 session 的模型下拉要列哪些名稱，Claude 與 Codex 各一份。
// 只有 owner（hub 的 PATCH /api/settings）；增、刪、上下移，存檔走共用的儲存列。
import { useState } from 'react';
import {
  isSafeModelName,
  sameModel,
  MODEL_LIST_MAX,
  MODEL_LISTS_DEFAULT,
  type ModelLists,
} from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { Msg, type Note } from './common';
import type { ServerSettingsForm } from './ServerSettings';
import { Section } from './settingsParts';

type Kind = keyof ModelLists;
const KINDS: readonly Kind[] = ['claude', 'codex'];

function ListEditor({
  kind,
  list,
  onChange,
}: {
  kind: Kind;
  list: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [note, setNote] = useState<Note | null>(null);
  const label = t(`flows.modelLists.${kind}`);

  const add = () => {
    const name = text.trim();
    const error = !name
      ? 'flows.modelLists.errEmpty'
      : !isSafeModelName(name)
        ? 'flows.new.err.modelName'
        : list.some((existing) => sameModel(existing, name))
          ? 'flows.modelLists.errDup'
          : list.length >= MODEL_LIST_MAX
            ? 'flows.modelLists.errMax'
            : null;
    if (error) return setNote({ text: t(error, { max: MODEL_LIST_MAX }), tone: 'err' });
    onChange([...list, name]);
    setText('');
    setNote(null);
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };

  return (
    <div className="field" data-testid={`model-list-${kind}`}>
      <span className="label">{label}</span>
      {list.length === 0 ? (
        <p className="hint">{t('flows.modelLists.empty')}</p>
      ) : (
        <ul className="rule-list model-list">
          {list.map((name, index) => (
            <li key={name}>
              <code>{name}</code>
              <span className="model-list-acts">
                <button
                  type="button"
                  className="sm icon"
                  disabled={index === 0}
                  aria-label={t('flows.modelLists.up', { name })}
                  title={t('flows.modelLists.up', { name })}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="sm icon"
                  disabled={index === list.length - 1}
                  aria-label={t('flows.modelLists.down', { name })}
                  title={t('flows.modelLists.down', { name })}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="sm"
                  aria-label={t('flows.modelLists.remove', { name })}
                  onClick={() => onChange(list.filter((n) => n !== name))}
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
  // 舊 hub 沒有這個設定（回應裡沒有 modelLists）：不顯示編輯器，免得存了被丟掉。
  const lists = (draft as { modelLists?: ModelLists }).modelLists;
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
              list={lists[kind]}
              onChange={(next) => patch({ modelLists: { ...lists, [kind]: next } })}
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
