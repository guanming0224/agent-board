// session 卡片與全尺寸頁的「在這裡 git init」（GM 2026-11-14，CONTRACTS §24.5）。
// 一個還沒有團隊、之後要自己組隊的 session（或隊長）在不是 git 的資料夾開會改檔案的成員會被擋；這裡讓 GM 直接對
// 那個 session 的資料夾 git init，不用再去「新增 session」等頁面找按鈕。確認步驟、結果、略過的大檔、daemon 太舊都
// 沿用 GitInit.tsx。成功後 daemon 讓這個 session 即時換上 repo（session.runtime），卡片上的「不是 git」自己消失。
//   - NotGitChip：卡片標題下的小標示（不是按鈕，不多佔觸控空間；畫布縮很小時跟著 .sign 一起藏起來）。
//   - SessionGitInitPanel：全尺寸頁側欄的區塊，與「⋯ → 在這裡 git init…」打開的次畫面（GitInitPage）。
import { useEffect, useState } from 'react';
import type { Session } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { useTeams } from '../team/store';
import { gitInitTarget } from '../views/overlay';
import { useCurrentUser } from './common';
import { GitInitAction } from './GitInit';
import { needsGitInit, useNotGitBlocked } from './gitInitState';

/** 這個 session 剛才想開會改檔案的成員、因為不是 git 被擋（hub 的 dispatch.not_git）。 */
const useBlocked = (sessionId: string) =>
  useNotGitBlocked((s) => s.blocked[sessionId] !== undefined);

/** 所屬的團隊有一隊勾了「共用資料夾」。 */
const useSharedTeam = (sessionId: string) =>
  useTeams((s) =>
    s.members.some(
      (m) =>
        m.sessionId === sessionId &&
        s.teams.some((team) => team.id === m.teamId && team.sharedWriters === true),
    ),
  );

/**
 * 卡片標題下的「不是 git」。隊長開成員因為不是 git 被擋過時，改成「開成員被擋：不是 git」（等你的琥珀色），
 * 提示 GM 去「⋯」按 git init。所有人都看得到（只是說明）；按鈕只給 owner（CardMenu）。
 */
export function NotGitChip({ session }: { session: Session }) {
  const t = useT();
  const blocked = useBlocked(session.id);
  if (!needsGitInit(session)) return null;
  return (
    <span
      className={blocked ? 'chip not-git blocked' : 'chip not-git'}
      title={t(blocked ? 'flows.gitInit.chipBlockedTitle' : 'flows.gitInit.chipTitle')}
      data-testid={blocked ? 'not-git-blocked' : 'not-git'}
    >
      {t(blocked ? 'flows.gitInit.chipBlocked' : 'flows.gitInit.chip')}
    </span>
  );
}

/**
 * 「這個資料夾不是 git」的說明＋git init（只有 owner；還沒讀到使用者資料前不顯示）。
 * page：次畫面（GitInitPage）——一打開就是確認步驟；不是 owner 或已經不需要時顯示一句說明，不留白。
 * 側欄（page=false）：不需要、不是 owner 都不顯示。成功後留著結果（略過的大檔要看得到），直到離開這個畫面。
 */
export function SessionGitInitPanel({
  session,
  page = false,
}: {
  session: Session;
  page?: boolean;
}) {
  const t = useT();
  const me = useCurrentUser();
  const machine = useBoard((s) => s.machines.find((m) => m.id === session.machineId));
  const shared = useSharedTeam(session.id);
  const blocked = useBlocked(session.id);
  // 按過確認就留著（hub 推來新的 repoRoot 可能比 API 回應早到，不能因此把結果卸掉）。
  // 呼叫端用 key={session.id} 掛，換 session 時重來。
  const [started, setStarted] = useState(false);
  const eligible = needsGitInit(session);

  if (!me.data) return null;
  if (!eligible && !started) {
    return page ? (
      <p className="sub" data-testid="session-git-init-none">
        {t('flows.gitInit.pageNone')}
      </p>
    ) : null;
  }
  if (me.data.role !== 'owner') {
    return page ? (
      <p className="sub" data-testid="git-init-owner-only">
        {t('flows.gitInit.ownerOnly')}
      </p>
    ) : null;
  }
  return (
    <section
      className={page ? 'session-git-init' : 'xpand-panel session-git-init'}
      aria-labelledby={`session-git-init-${session.id}`}
      data-testid="session-git-init"
    >
      <h3 id={`session-git-init-${session.id}`}>
        {t(eligible ? 'flows.gitInit.sessionTitle' : 'flows.gitInit.sessionDoneTitle')}
      </h3>
      {eligible && (
        <>
          {blocked && (
            <p className="session-git-init-blocked" data-testid="session-git-init-blocked">
              {t('flows.gitInit.sessionBlocked')}
            </p>
          )}
          <p className="sub">{t('flows.gitInit.sessionWhy')}</p>
          {shared && (
            <p className="sub" data-testid="session-git-init-shared">
              {t('flows.gitInit.sessionShared')}
            </p>
          )}
        </>
      )}
      {/* 錯誤與結果文字的樣式（.flows .msg）在 flows.css。 */}
      <div className="flows">
        <GitInitAction
          key={`${session.machineId}\n${session.cwd}`}
          machine={machine}
          path={session.cwd}
          notGit={eligible}
          startOpen={page}
          onStart={() => setStarted(true)}
          // 不用重新偵測：daemon 成功後會送 session.runtime，hub 推來新的 repoRoot，這裡跟著重畫。
          onDone={() => undefined}
        />
      </div>
    </section>
  );
}

/** `#/git-init/<sessionId>` 次畫面（卡片「⋯ → 在這裡 git init…」）。 */
export function GitInitPage() {
  const t = useT();
  const [id, setId] = useState(() => gitInitTarget(location.hash));
  useEffect(() => {
    const onChange = () => setId(gitInitTarget(location.hash));
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  const session = useBoard((s) => s.sessions.find((x) => x.id === id && !x.archived));
  const machine = useBoard((s) => s.machines.find((m) => m.id === session?.machineId));
  return (
    <div className="page git-init-page" data-testid="git-init-page">
      <header className="panel-head git-init-page-head">
        <h1>{t('flows.gitInit.pageTitle')}</h1>
      </header>
      {session ? (
        <>
          <p className="sub mono git-init-page-where">
            {`${session.name} · ${machine?.name ?? session.machineId} · ${session.cwd}`}
          </p>
          <SessionGitInitPanel key={session.id} session={session} page />
        </>
      ) : (
        <p className="sub" data-testid="session-git-init-none">
          {t('flows.gitInit.pageNone')}
        </p>
      )}
    </div>
  );
}
