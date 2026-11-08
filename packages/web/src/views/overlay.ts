// 畫布常駐＋疊加層的網址規則（P2 規格 §1.4）。純函式，App 與測試共用。
// 畫布永遠在底下；右側一次一個面板（收件匣或團隊，互斥）；設定、封存細節、完整新增表單是置中次畫面，
// 可疊在右側面板之上（關掉後右側面板還在）。

export type RightPanel =
  { kind: 'inbox'; target: string | null } | { kind: 'team'; teamId: string | null };

export type ModalKind = 'settings' | 'archive' | 'new';

export type RouteView =
  /** 不疊在畫布上的整頁：全尺寸終端機、登入、首次引導（規格 §1.4 不變）。 */
  | { kind: 'page'; page: 'terminal' | 'login' | 'onboarding' }
  /** 舊網址：換成新網址（replace，不留歷史）。 */
  | { kind: 'redirect'; to: string; inboxSort?: 'group' }
  /** 畫布＋疊加層。right 為 'keep' 表示沿用上一個畫面的右側面板（設定疊在面板上）。 */
  | { kind: 'board'; right: RightPanel | null | 'keep'; modal: ModalKind | null };

function part(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    // 壞掉的百分比編碼：當成沒給。
    return null;
  }
}

/** 解析 `#/<頁>/<參數>`。不認得的一律當畫布。 */
export function parseHash(hash: string): RouteView {
  const [name = '', raw] = hash.replace(/^#\/?/, '').split('/');
  const param = part(raw);
  switch (name) {
    case 'terminal':
    case 'login':
    case 'onboarding':
      return { kind: 'page', page: name };
    case 'queue':
      // 待處理併進收件匣；從舊網址來的人習慣分組，排序切到「依組別」。
      return { kind: 'redirect', to: '#/inbox', inboxSort: 'group' };
    case 'review':
      return { kind: 'redirect', to: param ? inboxHash(param) : '#/inbox' };
    case 'inbox':
      return { kind: 'board', right: { kind: 'inbox', target: param }, modal: null };
    case 'team':
      return { kind: 'board', right: { kind: 'team', teamId: param }, modal: null };
    case 'settings':
      return { kind: 'board', right: 'keep', modal: 'settings' };
    case 'archive':
      // 沒帶 id 的舊網址：設定的「封存」分類。帶 id 是單一封存 session 的細節。
      return param
        ? { kind: 'board', right: 'keep', modal: 'archive' }
        : { kind: 'redirect', to: '#/settings/archived' };
    case 'new':
      return { kind: 'board', right: 'keep', modal: 'new' };
    default:
      return { kind: 'board', right: null, modal: null };
  }
}

export const inboxHash = (sessionId?: string | null) =>
  sessionId ? `#/inbox/${encodeURIComponent(sessionId)}` : '#/inbox';

export const teamHash = (teamId?: string | null) =>
  teamId ? `#/team/${encodeURIComponent(teamId)}` : '#/team';

/** 右側面板對應的網址；沒有面板就是畫布。關設定時回到這裡。 */
export function rightHash(right: RightPanel | null): string {
  if (!right) return '#/canvas';
  return right.kind === 'inbox' ? '#/inbox' : teamHash(right.teamId);
}

export interface Resolved {
  view: RouteView;
  /** 目前的右側面板（'keep' 已換成實際沿用的那個）。 */
  right: RightPanel | null;
}

/** 把網址解析成畫面；設定類的次畫面沿用上一個畫面的右側面板。 */
export function resolve(hash: string, previousRight: RightPanel | null): Resolved {
  const view = parseHash(hash);
  if (view.kind !== 'board') return { view, right: previousRight };
  return { view, right: view.right === 'keep' ? previousRight : view.right };
}

/**
 * 關掉一層要回到哪裡，以及能不能直接「上一頁」：上一筆歷史就是要回去的畫面時用 history.back()，
 * 「上一頁」才不會又打開剛關掉的面板；否則 replace，不會跳出 app（規格 §1.4）。
 */
export function closeStep(
  from: string | null,
  layer: 'modal' | 'right',
  right: RightPanel | null,
): { back: true } | { back: false; to: string } {
  if (from !== null) {
    // '' 是沒有 hash 的網址：畫布。
    const previous = parseHash(from);
    if (previous.kind === 'board' && previous.modal === null) {
      if (layer === 'modal') {
        // 上一筆是沒有次畫面的畫布：回去就對（右側面板跟著那筆網址）。
        const same =
          previous.right === null
            ? right === null
            : right !== null && previous.right !== 'keep' && previous.right.kind === right.kind;
        if (same) return { back: true };
      } else if (previous.right === null) {
        return { back: true };
      }
    }
  }
  return { back: false, to: layer === 'modal' ? rightHash(right) : '#/canvas' };
}
