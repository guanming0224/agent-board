// 畫布常駐＋疊加層的網址規則（P2 規格 §1.4）。純函式，App 與測試共用。
// 畫布永遠在底下；右側一次一個面板（收件匣、團隊或 Memory，互斥）；設定、封存細節、完整新增表單是置中次畫面，
// 可疊在右側面板之上（關掉後右側面板還在）。

export type RightPanel =
  | { kind: 'inbox'; target: string | null }
  | { kind: 'team'; teamId: string | null }
  /** Memory（進度卡一覽，P3 項目一）。 */
  | { kind: 'memory' };

/**
 * search：全域搜尋（P3 §3）。桌面是置中次畫面，手機是全螢幕頁 `#/search`（網址可帶 `?q=`）。
 * transcript：某個 session 的對話紀錄 `#/transcript/<id>?at=<序號>`（搜尋結果按 ⌘Enter 開，P3 ③b）。
 * usage：用量詳情 `#/usage`（GM 2026-11-09），從頁首的「近 30 天 N token」或側欄用量打開。
 * machines：機器面板（發版與自動更新）`#/machines`，從設定的機器區或側欄的機器區打開；推播「更新失敗」也開這裡。
 * crossReview：交叉審查（Codex 第二輪）`#/cross-review/<id>`；發起是 `#/cross-review/new?session=<id>`。
 * gitInit：在這個 session 的資料夾 git init `#/git-init/<sessionId>`（卡片「⋯」，CONTRACTS §24.5）。
 * （`#/review/` 是舊的收件匣網址，已經轉址，不能用。）
 */
export type ModalKind =
  | 'settings'
  | 'archive'
  | 'new'
  | 'search'
  | 'transcript'
  | 'usage'
  | 'machines'
  | 'crossReview'
  | 'gitInit';

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
  // `?` 之後是頁面自己的參數（例如 #/search?q=…），不影響畫面種類。
  const [name = '', raw] = (hash.replace(/^#\/?/, '').split('?')[0] ?? '').split('/');
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
    case 'memory':
      return { kind: 'board', right: { kind: 'memory' }, modal: null };
    case 'settings':
      return { kind: 'board', right: 'keep', modal: 'settings' };
    case 'archive':
      // 沒帶 id 的舊網址：設定的「封存」分類。帶 id 是單一封存 session 的細節。
      return param
        ? { kind: 'board', right: 'keep', modal: 'archive' }
        : { kind: 'redirect', to: '#/settings/archived' };
    case 'new':
      return { kind: 'board', right: 'keep', modal: 'new' };
    case 'search':
      return { kind: 'board', right: 'keep', modal: 'search' };
    case 'usage':
      return { kind: 'board', right: 'keep', modal: 'usage' };
    case 'machines':
      return { kind: 'board', right: 'keep', modal: 'machines' };
    case 'cross-review':
      return { kind: 'board', right: 'keep', modal: 'crossReview' };
    case 'git-init':
      return param
        ? { kind: 'board', right: 'keep', modal: 'gitInit' }
        : { kind: 'board', right: null, modal: null };
    case 'transcript':
      return param
        ? { kind: 'board', right: 'keep', modal: 'transcript' }
        : { kind: 'board', right: null, modal: null };
    default:
      return { kind: 'board', right: null, modal: null };
  }
}

export const inboxHash = (sessionId?: string | null) =>
  sessionId ? `#/inbox/${encodeURIComponent(sessionId)}` : '#/inbox';

export const MEMORY_HASH = '#/memory';

export const USAGE_HASH = '#/usage';

/** 交叉審查的結果（Codex 第二輪）。 */
export const crossReviewHash = (reviewId: string) =>
  `#/cross-review/${encodeURIComponent(reviewId)}`;

/** 發起交叉審查；帶 session 就預選「這個 session 的未 commit 變更」。 */
export const newCrossReviewHash = (sessionId?: string | null) =>
  sessionId ? `#/cross-review/new?session=${encodeURIComponent(sessionId)}` : '#/cross-review/new';

/**
 * `#/cross-review/<id>` → { id }；`#/cross-review/new?session=<id>` → { id: null, session }。
 * 不是這個畫面回 null。
 */
export function crossReviewTarget(
  hash: string,
): { id: string | null; session: string | null } | null {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [name, raw] = path.split('/');
  if (name !== 'cross-review') return null;
  let id: string | null = null;
  try {
    id = decodeURIComponent(raw ?? '') || null;
  } catch {
    id = null;
  }
  if (id === 'new' || id === null) {
    return { id: null, session: new URLSearchParams(query).get('session') || null };
  }
  return { id, session: null };
}

/** 在這個 session 的資料夾 git init（§24.5）。 */
export const gitInitHash = (sessionId: string) => `#/git-init/${encodeURIComponent(sessionId)}`;

/** `#/git-init/<id>` → id；不是這個畫面或解不開是 null。 */
export function gitInitTarget(hash: string): string | null {
  const [name, raw] = (hash.replace(/^#\/?/, '').split('?')[0] ?? '').split('/');
  return name === 'git-init' ? part(raw) : null;
}

/** 機器面板（版本與更新）。 */
export const MACHINES_HASH = '#/machines';

/** 全域搜尋；q 有給就帶在網址上（手機可分享的深連結）。 */
export const searchHash = (q?: string | null) =>
  q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';

/** `#/search?q=…` 的查詢字；沒有或解不開是空字串。 */
export function searchQueryOf(hash: string): string {
  const query = hash.split('?')[1];
  if (!query) return '';
  try {
    return new URLSearchParams(query).get('q') ?? '';
  } catch {
    return '';
  }
}

/** 對話紀錄（P3 ③b）；at 是要捲到的那則的序號（`TranscriptEntry.index`）。 */
export const transcriptHash = (sessionId: string, at?: number | null) =>
  `#/transcript/${encodeURIComponent(sessionId)}${at === null || at === undefined ? '' : `?at=${at}`}`;

/** `#/transcript/<id>?at=<n>`、`#/transcript/<id>` → { id, at }。 */
export function transcriptTarget(hash: string): { id: string | null; at: number | null } {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  let id: string | null = null;
  try {
    id = decodeURIComponent(path.split('/')[1] ?? '') || null;
  } catch {
    id = null;
  }
  const raw = new URLSearchParams(query).get('at');
  const at = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  return { id, at };
}

export const teamHash = (teamId?: string | null) =>
  teamId ? `#/team/${encodeURIComponent(teamId)}` : '#/team';

/** 右側面板對應的網址；沒有面板就是畫布。關設定時回到這裡。 */
export function rightHash(right: RightPanel | null): string {
  if (!right) return '#/canvas';
  if (right.kind === 'memory') return MEMORY_HASH;
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
/** 這個網址是不是全域搜尋（`#/search`、`#/search?q=…`）。 */
export function isSearchHash(hash: string | null): boolean {
  if (hash === null) return false;
  const view = parseHash(hash);
  return view.kind === 'board' && view.modal === 'search';
}

export function closeStep(
  from: string | null,
  layer: 'modal' | 'right',
  right: RightPanel | null,
  /** 正在關的次畫面。搜尋 ⌘Enter 開的對話紀錄，關掉回到搜尋（結果還在）。 */
  current: ModalKind | null = null,
): { back: true } | { back: false; to: string } {
  if (layer === 'modal' && current === 'transcript' && isSearchHash(from)) return { back: true };
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
