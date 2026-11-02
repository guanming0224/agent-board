// 審核中心與收件匣共用：把 approval 內容畫出來、送出決定。
import { useState } from 'react';
import type { Approval, ApprovalDecision, Machine, User } from '@agent-board/protocol';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Callsign, type Loaded, type Note } from './common';
import { summarizeTool, type DiffLine, type ToolView } from './toolView';

export function DiffBlock({ lines }: { lines: DiffLine[] }) {
  const t = useT();
  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;
  return (
    <div
      className="diff"
      role="group"
      tabIndex={0}
      aria-label={t('flows.diff.aria', { add: added, del: removed })}
    >
      <div className="diff-lines">
        {lines.map((line, i) => (
          <div key={i} className={line.type === 'ctx' ? 'c' : line.type === 'add' ? 'a' : 'd'}>
            <span className="sign" aria-hidden="true">
              {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
            </span>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolBody({ approval }: { approval: Approval }) {
  const t = useT();
  const view: ToolView = summarizeTool(approval.toolName, approval.toolInput);
  return (
    <>
      <div className="tool">
        {approval.toolName ?? t('flows.review.noTool')}
        {view.kind === 'diff' && view.file ? (
          <>
            {' '}
            <Callsign text={view.file} />
          </>
        ) : null}
      </div>
      {approval.message && <p className="body-text">{approval.message}</p>}
      {view.kind === 'diff' && <DiffBlock lines={view.lines} />}
      {view.kind === 'command' && <pre className="command">{view.text}</pre>}
      {view.kind === 'raw' && <pre className="command">{view.text}</pre>}
    </>
  );
}

export interface Question {
  question: string;
  options: string[];
}

/** AskUserQuestion 的 tool_input 有 questions；沒有就用 message。 */
export function parseQuestions(approval: Approval): Question[] {
  const raw = approval.toolInput?.['questions'];
  if (Array.isArray(raw)) {
    const parsed = raw.flatMap((q): Question[] => {
      if (typeof q !== 'object' || q === null) return [];
      const { question, options } = q as { question?: unknown; options?: unknown };
      if (typeof question !== 'string') return [];
      const labels = Array.isArray(options)
        ? options.flatMap((o: unknown) => {
            const label = typeof o === 'string' ? o : (o as { label?: unknown } | null)?.label;
            return typeof label === 'string' ? [label] : [];
          })
        : [];
      return [{ question, options: labels }];
    });
    if (parsed.length > 0) return parsed;
  }
  return approval.message ? [{ question: approval.message, options: [] }] : [];
}

export const planText = (approval: Approval): string | null => {
  const plan = approval.toolInput?.['plan'];
  return typeof plan === 'string' ? plan : null;
};

/** 這個項目目前能不能從介面決定；不能的話回傳原因。失聯時寫最後讀到的時間（STYLE.md 規則四）。 */
export function useBlockedReason(
  hasSession: boolean,
  machine: Machine | undefined,
  approval: Approval | null,
  me: Loaded<User | null>,
): string | null {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { connected } = useBoard();
  if (!connected) return t('flows.blocked.hub');
  if (!hasSession) return t('flows.blocked.noSession');
  if (machine && !machine.online) {
    const time = machine.lastSeenAt
      ? new Date(machine.lastSeenAt).toLocaleTimeString(locale, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—';
    return t('flows.blocked.offline', { machine: machine.name, time });
  }
  // 危險指令只有 owner 能決定（CONTRACTS.md）；還不知道身分時也先不給按。
  if (approval?.kind === 'danger' && me.data?.role !== 'owner') {
    if (me.data) return t('flows.blocked.ownerOnly');
    return me.loading ? t('flows.loading') : t('flows.blocked.noUser');
  }
  return null;
}

/** 送出決定與結果訊息。卡片通常會在成功後消失；失敗時留在畫面上可以再按。 */
export function useDecide(approval: Approval | null) {
  const t = useT();
  const { backend } = useBoard();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const decide = async (decision: ApprovalDecision) => {
    if (!approval) return;
    setBusy(true);
    setNote({ text: t('flows.review.sending') });
    try {
      await backend.decideApproval(approval, decision);
      setNote({ text: t('flows.review.sent') });
    } catch (e) {
      setNote({ text: t('flows.review.sendFailed', { error: errorText(e) }), tone: 'err' });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, setNote, decide };
}

/** 回答提問。和 deny 分開，audit 才不會把回答記成拒絕。 */
export const answerDecision = (text: string): ApprovalDecision => ({ behavior: 'answer', text });
