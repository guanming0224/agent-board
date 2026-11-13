// 收件匣的「加開申請」（GM 2026-11-13，CONTRACTS §23）：隊長碰到團隊人數上限或 10 分鐘新增上限時，向 GM 申請
// 再加一位成員。同意 → hub 照申請開成員；拒絕或 30 分鐘沒處理 → 告訴隊長。只有 owner 能處理。
// 桌面抽屜（InboxBoard）與手機收件匣（InboxPage）共用。沒有待處理的申請時整區不顯示。
// 按鈕：同意會開 session，所以用標準 36（手機 .act 56，STYLE §5.1）。
import { useState } from 'react';
import type { StaffRequest } from '@agent-board/protocol';
import { useMaskText } from '../security';
import { useLocale, useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { errorText, Msg, type Note } from './common';

function RequestRow({
  request,
  owner,
  disabled,
  onApprove,
  onReject,
}: {
  request: StaffRequest;
  owner: boolean;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const mask = useMaskText();
  const backend = useBoard((s) => s.backend);
  /** owner 按「展開全文」才向 hub 讀 prompt 全文（清單只帶 300 字摘要）。 */
  const [full, setFull] = useState<{ text: string | null; error: string | null } | null>(null);
  const truncated = request.promptChars > [...request.promptPreview].length;
  const loadFull = async () => {
    if (full?.text) {
      setFull(null);
      return;
    }
    setFull({ text: null, error: null });
    try {
      const detail = await backend.getStaffRequest(request.id);
      setFull({ text: detail.prompt, error: null });
    } catch (e) {
      setFull({ text: null, error: errorText(e) });
    }
  };
  const at = new Date(request.at);
  const expires = new Date(request.expiresAt).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return (
    <li
      className="activity-row staff-request unread"
      data-testid={`staff-request-${request.id}`}
      data-limit={request.limit}
    >
      <time className="num" dateTime={request.at} title={at.toLocaleString(locale)}>
        {at.toLocaleString(locale, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })}
      </time>
      <span className="activity-text">
        {t('flows.staff.request', {
          lead: mask(request.leadName),
          role: t(`flows.teamActivity.role.${request.role}`),
          limit: t(`flows.staff.limit.${request.limit}`),
        })}
      </span>
      <span className="activity-team">{mask(request.teamName)}</span>
      <span className="activity-reason">
        {t('flows.staff.size', { size: request.teamSize, limit: request.teamLimit })}
      </span>
      <span className="activity-reason" data-testid={`staff-request-reason-${request.id}`}>
        {t('flows.staff.reason', { reason: mask(request.reason) })}
      </span>
      {request.name && (
        <span className="activity-reason">
          {t('flows.staff.name', { name: mask(request.name) })}
        </span>
      )}
      <span className="activity-reason" data-testid={`staff-request-prompt-${request.id}`}>
        {t('flows.staff.prompt', { prompt: mask(full?.text ?? request.promptPreview) })}
      </span>
      <span className="activity-reason staff-prompt-meta">
        <span data-testid={`staff-request-chars-${request.id}`}>
          {t('flows.staff.chars', { n: request.promptChars })}
        </span>
        {owner && truncated && (
          <button
            type="button"
            className="link touch"
            onClick={() => void loadFull()}
            disabled={full !== null && full.text === null && full.error === null}
            data-testid={`staff-request-full-${request.id}`}
          >
            {full?.text ? t('flows.staff.collapse') : t('flows.staff.expand')}
          </button>
        )}
        {full?.error && <span role="alert">{t('flows.staff.failed', { error: full.error })}</span>}
      </span>
      <span className="activity-reason">{t('flows.staff.expires', { time: expires })}</span>
      {owner && (
        <span className="staff-acts">
          <button
            type="button"
            className="primary act"
            disabled={disabled}
            onClick={onApprove}
            data-testid={`staff-request-approve-${request.id}`}
          >
            {t('flows.staff.approve')}
          </button>
          <button
            type="button"
            className="act"
            disabled={disabled}
            onClick={onReject}
            data-testid={`staff-request-reject-${request.id}`}
          >
            {t('flows.staff.reject')}
          </button>
        </span>
      )}
    </li>
  );
}

/** owner：目前登入的是擁有者（不是的話只看得到，不能處理）。 */
export function StaffRequestsSection({ owner }: { owner: boolean }) {
  const t = useT();
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const items = useBoard((s) => s.staffRequests) ?? [];
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  if (items.length === 0 && note === null) return null;
  const decide = async (id: string, approve: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const result = approve
        ? await backend.approveStaffRequest(id)
        : await backend.rejectStaffRequest(id);
      setNote(
        result.status === 'approved'
          ? { text: t('flows.staff.approved', { member: result.memberName ?? '' }), tone: 'ok' }
          : result.status === 'failed'
            ? { text: t('flows.staff.failedStart', { error: result.error ?? '' }), tone: 'err' }
            : { text: t('flows.staff.rejected'), tone: 'ok' },
      );
    } catch (e) {
      // 409 request_decided：別的分頁或別人已經處理過（或已失效），畫面還沒更新。
      const decided = (e as { code?: unknown }).code === 'request_decided';
      setNote(
        decided
          ? { text: t('flows.staff.decided'), tone: 'err' }
          : { text: t('flows.staff.failed', { error: errorText(e) }), tone: 'err' },
      );
    } finally {
      setBusy(false);
    }
  };
  const off = busy || !connected;
  return (
    <section
      className="team-activity staff-requests"
      aria-labelledby="staff-requests-title"
      data-testid="staff-requests"
    >
      <header className="activity-head">
        <h2 id="staff-requests-title">
          {t('flows.staff.title')}
          {items.length > 0 && (
            <span className="count num" data-testid="staff-requests-count">
              {items.length}
            </span>
          )}
        </h2>
      </header>
      {items.length > 0 && <p className="hint">{t('flows.staff.hint')}</p>}
      {items.length > 0 && !owner && <p className="hint">{t('flows.staff.ownerOnly')}</p>}
      <ol className="activity-list">
        {items.map((request) => (
          <RequestRow
            key={request.id}
            request={request}
            owner={owner}
            disabled={off}
            onApprove={() => void decide(request.id, true)}
            onReject={() => void decide(request.id, false)}
          />
        ))}
      </ol>
      <Msg note={note} />
    </section>
  );
}
