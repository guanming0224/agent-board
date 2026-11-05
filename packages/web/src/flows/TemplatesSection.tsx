// 設定「Session 與額度」的範本清單。
import { useCallback, useState } from 'react';
import type { Template } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import {
  Empty,
  ErrorBox,
  errorText,
  Loading,
  ModeChip,
  Msg,
  useLoad,
  useTwoStep,
  type Note,
} from './common';
import { Section, type AdminBackend } from './settingsParts';

function TemplateRow({ template, onDeleted }: { template: Template; onDeleted: () => void }) {
  const t = useT();
  const { backend, machines } = useBoard();
  const admin = backend as AdminBackend;
  const twoStep = useTwoStep();
  const [note, setNote] = useState<Note | null>(null);
  const { config } = template;
  const machine = machines.find((m) => m.id === config.machineId);
  return (
    <li className="rig-row">
      <div className="rig-name">
        <strong>{template.name}</strong>
        <ModeChip mode={config.permissionMode} />
      </div>
      <div className="sub">
        {machine?.name ?? t('flows.template.anyMachine')}
        {config.cwd ? ` · ${config.cwd}` : ''}
        {config.model ? ` · ${config.model}` : ''}
      </div>
      {admin.deleteTemplate && (
        <div className="acts">
          <button
            type="button"
            className="danger"
            onClick={() =>
              twoStep.press(() => {
                admin.deleteTemplate?.(template.id).then(onDeleted, (e: unknown) =>
                  setNote({
                    text: t('flows.template.deleteFailed', { error: errorText(e) }),
                    tone: 'err',
                  }),
                );
              })
            }
          >
            {twoStep.armed ? t('flows.template.deleteAgain') : t('flows.template.delete')}
          </button>
          <Msg note={note} />
        </div>
      )}
    </li>
  );
}

export function TemplatesSection() {
  const t = useT();
  const { backend } = useBoard();
  const templates = useLoad(useCallback(() => backend.listTemplates(), [backend]));
  return (
    <Section id="templates" title={t('flows.settings.templates')}>
      {templates.loading && !templates.data ? (
        <Loading />
      ) : templates.error ? (
        <ErrorBox
          what={t('flows.error.templates', { error: templates.error })}
          how={t('flows.retryHow')}
          onRetry={templates.reload}
        />
      ) : templates.data?.length === 0 ? (
        <Empty
          title={t('flows.template.none')}
          next={<a href="#/new">{t('flows.template.noneNext')}</a>}
        />
      ) : (
        <>
          <ul className="rows">
            {templates.data?.map((template) => (
              <TemplateRow key={template.id} template={template} onDeleted={templates.reload} />
            ))}
          </ul>
          <p className="hint">
            <a href="#/new">{t('flows.template.noneNext')}</a>
          </p>
        </>
      )}
    </Section>
  );
}
