// 團隊面板（P2 §1.2）：畫布右側 420px，和收件匣互斥。#/team：團隊清單；#/team/<id>：工作台（DISPATCH §5.3-4）。
// 手機（≤ 640px）是全螢幕頁，內容相同。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { waitingSessions } from '@agent-board/protocol';
import { useT } from '../shared/i18n';
import { useBoard } from '../shared/store';
import { Empty } from '../flows/common';
import { closeRight, ErrorState, LoadingState, useBoardLoad, useViewsUi } from '../views';
import { PanelHead, SidePanel } from '../views/Overlays';
import { useCurrentZoneId, useZones } from '../zones';
import { NewTeamForm } from './NewTeamForm';
import { PresetEntry } from './PresetPicker';
import { refreshTeams, teamColorVar, useTeams, useTeamSync } from './store';
import { TeamWorkbench } from './TeamWorkbench';

export const TEAM_WIDTH = 420;
/** 展開（看任務板）時的寬度，和收件匣的寬版一樣。 */
export const TEAM_WIDE_WIDTH = 760;

/**
 * 團隊清單模式（#/team）：列出目前工作區的團隊（名稱、成員數、等你數），可切「顯示全部工作區」（P2 §2.3）。
 */
function TeamList({ missing, inPanel }: { missing: boolean; inPanel: boolean }) {
  const t = useT();
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const sessions = useBoard((s) => s.sessions);
  const approvals = useBoard((s) => s.approvals);
  const zones = useZones();
  const current = useCurrentZoneId();
  const [all, setAll] = useState(false);
  const waitingIds = new Set(waitingSessions(sessions, approvals).map((s) => s.id));
  const shown = all ? teams : teams.filter((team) => team.zoneId === current);
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? '';
  return (
    <div className="page team-page" data-testid="team-list">
      {inPanel ? (
        <PanelHead title={t('team.title')} onClose={closeRight} closeTestId="team-close" />
      ) : (
        <h1>{t('team.title')}</h1>
      )}
      {missing && (
        <p className="team-missing" role="status" data-testid="team-not-found">
          {t('team.notFound')}
        </p>
      )}
      {/* 從 Preset 建立（P3 §2.4：手機的入口；桌面另有底部指令列的 Presets）。 */}
      <PresetEntry />
      <NewTeamForm />
      <label className="check team-list-all">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          data-testid="team-list-all"
        />
        {t('team.list.allZones')}
      </label>
      {shown.length === 0 ? (
        <Empty title={t('team.emptyTitle')} next={t('team.empty')} />
      ) : (
        <ul className="team-list">
          {shown.map((team) => {
            const ids = members.filter((m) => m.teamId === team.id).map((m) => m.sessionId);
            const waiting = ids.filter((id) => waitingIds.has(id)).length;
            return (
              <li key={team.id}>
                <a
                  className="panel team-row"
                  href={`#/team/${encodeURIComponent(team.id)}`}
                  style={{ ['--team' as string]: teamColorVar(team.color) }}
                  data-testid={`team-row-${team.id}`}
                >
                  <b>{team.name}</b>
                  <span className="sub">{team.goal || t('team.noGoal')}</span>
                  <span className="sub num">{t('team.memberCount', { n: ids.length })}</span>
                  {waiting > 0 && (
                    <span className="num team-row-waiting">
                      {t('team.list.waiting', { n: waiting })}
                    </span>
                  )}
                  {all && (
                    <span className="chip">{t('zones.chip', { name: zoneName(team.zoneId) })}</span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 團隊清單或工作台。團隊不存在時開清單並寫一行「找不到這個團隊」（P2 §1.4）。
 * frameOnCanvas：開某個團隊時讓畫布框住它的成員；手機沒有畫布，傳 false。
 */
export function TeamContent({
  teamId,
  frameOnCanvas = true,
  inPanel = false,
}: {
  teamId: string | null;
  frameOnCanvas?: boolean;
  /** 放在右側面板裡：標題列用 PanelHead（含 ✕）；手機全螢幕頁用一般 h1。 */
  inPanel?: boolean;
}) {
  const t = useT();
  const board = useBoardLoad();
  const { retry } = useTeamSync();
  const status = useTeams((s) => s.status);
  const detail = useTeams((s) => s.detail);
  const teams = useTeams((s) => s.teams);
  const members = useTeams((s) => s.members);
  const team = teamId === null ? undefined : teams.find((x) => x.id === teamId);

  // 清單裡沒有這個團隊（例如剛建好、清單還沒讀到）：馬上再讀一次，不等下一輪輪詢。
  // 這次重讀回來之前先顯示讀取中，回來還是沒有才說「找不到」，不會先閃一下錯誤。
  const backend = useBoard((s) => s.backend);
  const known = teamId === null || team !== undefined;
  const [checkedId, setCheckedId] = useState<string | null>(null);
  useEffect(() => {
    if (status !== 'ready' || known || teamId === null || checkedId === teamId) return;
    let live = true;
    refreshTeams(backend)
      .catch(() => {})
      .finally(() => {
        if (live) setCheckedId(teamId);
      });
    return () => {
      live = false;
    };
  }, [backend, known, status, teamId, checkedId]);

  // 開某個團隊：畫布把它的成員框進畫面（團隊框跟著成員）。
  const memberIds = team
    ? members
        .filter((m) => m.teamId === team.id)
        .map((m) => m.sessionId)
        .join('|')
    : '';
  // 每個團隊只框一次：面板開著時成員有變（新增、spawn）不再搶走正在拖的畫布。
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (!frameOnCanvas || !team || !memberIds || framed.current === team.id) return;
    framed.current = team.id;
    useViewsUi.getState().focusTeam(memberIds.split('|'));
  }, [frameOnCanvas, team, memberIds]);

  // 讀取中、錯誤時面板也要有標題列與 ✕（觸控沒有 Esc）。
  const headed = (node: ReactNode) =>
    inPanel ? (
      <>
        <PanelHead title={t('team.title')} onClose={closeRight} closeTestId="team-close" />
        {node}
      </>
    ) : (
      node
    );
  if (board.status === 'error') {
    return headed(
      <ErrorState text={t('views.error.board', { detail: board.detail })} onRetry={board.retry} />,
    );
  }
  if (status === 'error') {
    return headed(
      <ErrorState text={t('team.error.load', { detail: detail ?? '' })} onRetry={retry} />,
    );
  }
  if (board.status === 'loading' || status === 'loading') return headed(<LoadingState />);
  if (!known && checkedId !== teamId) return headed(<LoadingState />);
  if (team) return <TeamWorkbench key={team.id} team={team} inPanel={inPanel} />;
  return <TeamList missing={teamId !== null} inPanel={inPanel} />;
}

export function TeamDrawer({ teamId }: { teamId: string | null }) {
  const t = useT();
  const wide = useViewsUi((s) => s.teamWide);
  return (
    <SidePanel
      label={t('team.title')}
      width={wide && teamId !== null ? TEAM_WIDE_WIDTH : TEAM_WIDTH}
      testId="team-panel"
    >
      <TeamContent teamId={teamId} inPanel />
    </SidePanel>
  );
}
