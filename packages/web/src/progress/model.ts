// 進度卡畫面的純函式（P3 項目一）：簡單 Markdown、Memory 清單排序、衝突時的選擇、編輯中被改的欄位。
// 不碰 DOM，單元測試與元件共用。
import {
  progressOwnerKey,
  progressOwnerOf,
  progressStale,
  PROGRESS_FIELDS,
  type ProgressCard,
  type ProgressField,
  type ProgressFields,
  type ProgressOwner,
  type Session,
  type Team,
  type TeamMember,
} from '@agent-board/protocol';

// ── 簡單 Markdown：只有清單、粗體、行內 code（不渲染連結與圖片，§1.2） ──

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string };
export type MdBlock = { kind: 'list'; items: Inline[][] } | { kind: 'p'; lines: Inline[][] };

/** `**粗體**` 與 `` `code` ``；其他一律原樣（連結、圖片的語法也只是文字）。 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) });
    if (match[2] !== undefined) out.push({ kind: 'bold', text: match[2] });
    else out.push({ kind: 'code', text: match[3]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** 連續的清單行併成一個清單；其他連續的行是一段（保留換行），空行分段。 */
export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const line of text.split('\n')) {
    const item = LIST_ITEM.exec(line);
    const last = blocks.at(-1);
    if (item) {
      if (last?.kind === 'list') last.items.push(parseInline(item[1]!));
      else blocks.push({ kind: 'list', items: [parseInline(item[1]!)] });
    } else if (line.trim() === '') {
      blocks.push({ kind: 'p', lines: [] });
    } else if (last?.kind === 'p') {
      last.lines.push(parseInline(line));
    } else {
      blocks.push({ kind: 'p', lines: [parseInline(line)] });
    }
  }
  return blocks.filter((b) => (b.kind === 'p' ? b.lines.length > 0 : true));
}

// ── 擁有者與 Memory 清單 ──

export interface CardOwnerInfo {
  owner: ProgressOwner;
  key: string;
  /** 團隊名稱或 session 名稱；擁有者已刪除是 null（不顯示）。 */
  name: string | null;
  /** 卡片顯示在哪個工作區（團隊卡看團隊，單獨 session 看它加入的團隊或自己的）。 */
  zoneId: string | null;
  /** 單獨 session 的卡、而那個 session 已經加入團隊：團隊名稱（畫布不顯示這張卡）。 */
  joinedTeam: string | null;
}

export function ownerInfo(
  card: Pick<ProgressCard, 'teamId' | 'sessionId'>,
  teams: readonly Team[],
  members: readonly TeamMember[],
  sessions: readonly Session[],
): CardOwnerInfo {
  const owner = progressOwnerOf(card);
  const key = progressOwnerKey(owner);
  if ('teamId' in owner) {
    const team = teams.find((t) => t.id === owner.teamId);
    return { owner, key, name: team?.name ?? null, zoneId: team?.zoneId ?? null, joinedTeam: null };
  }
  const session = sessions.find((s) => s.id === owner.sessionId);
  const joined = members
    .filter((m) => m.sessionId === owner.sessionId)
    .map((m) => teams.find((t) => t.id === m.teamId))
    .filter((t): t is Team => t !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  return {
    owner,
    key,
    name: session && !session.archived ? session.name : null,
    zoneId: joined?.zoneId ?? session?.zoneId ?? null,
    joinedTeam: joined?.name ?? null,
  };
}

export interface MemoryRow {
  card: ProgressCard;
  info: CardOwnerInfo;
  stale: boolean;
}

/**
 * Memory 面板的列：寫過的卡、擁有者還在。current 範圍只列目前工作區、不含已加入團隊的單獨 session 卡；
 * all 範圍全部列（已加入團隊的標「（已加入 …）」）。排序：⚠ 久未更新在前，其餘依更新時間新到舊。
 */
export function memoryRows(
  cards: readonly ProgressCard[],
  ctx: {
    teams: readonly Team[];
    members: readonly TeamMember[];
    sessions: readonly Session[];
    now: number;
    scope: 'current' | 'all';
    zoneId: string;
  },
): MemoryRow[] {
  const rows = cards
    .filter((card) => card.revision > 0)
    .map((card) => ({
      card,
      info: ownerInfo(card, ctx.teams, ctx.members, ctx.sessions),
      stale: progressStale(card, ctx.now),
    }))
    .filter((row) => row.info.name !== null)
    .filter(
      (row) =>
        ctx.scope === 'all' || (row.info.zoneId === ctx.zoneId && row.info.joinedTeam === null),
    );
  const time = (row: MemoryRow) => (row.card.updatedAt ? Date.parse(row.card.updatedAt) : 0);
  return rows.sort((a, b) => Number(b.stale) - Number(a.stale) || time(b) - time(a));
}

// ── 編輯與衝突 ──

export type ConflictChoice = 'mine' | 'theirs' | 'both';

/** 「兩個都留（我的在上）」：我的、空一行、目前的。 */
export function resolveConflict(mine: string, theirs: string, choice: ConflictChoice): string {
  if (choice === 'mine') return mine;
  if (choice === 'theirs') return theirs;
  if (mine.trim() === '') return theirs;
  if (theirs.trim() === '') return mine;
  return `${mine}\n\n${theirs}`;
}

/** 開始編輯之後被別人改過的欄位（看每個欄位最後被改的版本）。 */
export function changedSince(card: ProgressCard, baseRevision: number): ProgressField[] {
  return PROGRESS_FIELDS.filter((f) => card.fieldRevisions[f] > baseRevision);
}

/** 編輯框：和開始編輯時的內容比，真的改了的欄位才送（沒動的欄位不帶，就不會和別人的改動衝突）。 */
export function editedFields(
  original: ProgressFields,
  draft: ProgressFields,
): Partial<ProgressFields> {
  const out: Partial<ProgressFields> = {};
  for (const f of PROGRESS_FIELDS) if (draft[f] !== original[f]) out[f] = draft[f];
  return out;
}

export const fieldsOf = (card: ProgressFields): ProgressFields => ({
  status: card.status,
  next: card.next,
  blockers: card.blockers,
  gmNotes: card.gmNotes,
});
