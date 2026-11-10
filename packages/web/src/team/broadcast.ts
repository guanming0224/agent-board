// 團隊群發的指令框（P2 §2.3）：@ 點名的解析與名單排序。純函式，畫面與單元測試共用。
import type { TeamMember } from '@agent-board/protocol';

/** 名單排序：隊長在最上，其餘依角色（成員、研究、審查、測試），同角色依名稱。 */
export const ROLE_ORDER: Record<TeamMember['role'], number> = {
  lead: 0,
  worker: 1,
  researcher: 2,
  reviewer: 3,
  tester: 4,
};

export function sortRoster<T extends { role: TeamMember['role']; name: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name),
  );
}

export interface MentionCandidate {
  id: string;
  name: string;
  /**
   * 這位成員的角色可以怎麼叫（中文名稱、縮寫、英文代碼，例如「審查」「RV」「reviewer」）。
   * `@審查` 比對不到成員名稱時，改拿角色比：團隊裡這個角色有幾位就點名幾位（§2.1「@審查 這版再看一次」）。
   */
  roles?: readonly string[];
}

export interface ParsedCommand {
  /** 拿掉 @名稱 之後要送出的文字。 */
  text: string;
  /** 點到的成員（依出現順序、不重複）；沒有點名是空陣列＝整組。 */
  targets: string[];
  /** 打了 @ 但不是本團隊成員的名稱（有就不能送）。 */
  unknown: string[];
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
/** 半形 @ 與全形 ＠（中文輸入法常打出來的）都算點名。 */
const isAt = (ch: string | undefined) => ch === '@' || ch === '＠';
/**
 * @ 前面可以是什麼才算點名：開頭、空白，或中文等非英數字（「請＠BD1 看一下」，GM 2026-11-10）。
 * 英文字母、數字與 email 常見符號後面的不算，避免把 a@b.com 當點名。
 */
const mentionBoundary = (ch: string | undefined) => ch === undefined || !/[A-Za-z0-9_.+-]/.test(ch);

/**
 * 解析指令框：`@`（或全形 `＠`）在開頭、空白或中文等非英數字後面才算點名。名稱可能有空白（session 名稱），所以由長到短比對成員名稱，
 * 名稱後面要接空白或結尾。比對不到名稱時再比角色（`@審查`、`@RV`、`@reviewer`）：這個角色的成員全部點名。
 * 都比對不到的取到下一個空白為止，當成「不是本團隊成員」。
 */
export function parseCommand(input: string, members: readonly MentionCandidate[]): ParsedCommand {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  // 角色別名 → 這個角色的成員（依名單順序）。由長到短比對，避免短的別名搶先。
  const roleMap = new Map<string, string[]>();
  for (const m of members) {
    for (const alias of new Set((m.roles ?? []).map((r) => r.toLowerCase()))) {
      if (alias === '') continue;
      roleMap.set(alias, [...(roleMap.get(alias) ?? []), m.id]);
    }
  }
  const aliases = [...roleMap.keys()].sort((a, b) => b.length - a.length);
  const startsWithWord = (rest: string, word: string) =>
    rest.toLowerCase().startsWith(word.toLowerCase()) && isSpace(rest[word.length]);
  const targets: string[] = [];
  const unknown: string[] = [];
  let text = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (isAt(ch) && mentionBoundary(input[i - 1])) {
      const rest = input.slice(i + 1);
      const hit = byLength.find((m) => startsWithWord(rest, m.name));
      if (hit) {
        if (!targets.includes(hit.id)) targets.push(hit.id);
        i += 1 + hit.name.length;
        continue;
      }
      const role = aliases.find((a) => startsWithWord(rest, a));
      if (role) {
        for (const id of roleMap.get(role)!) if (!targets.includes(id)) targets.push(id);
        i += 1 + role.length;
        continue;
      }
      const token = /^\S+/.exec(rest)?.[0];
      if (token) {
        unknown.push(token);
        i += 1 + token.length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  return { text: text.replace(/\s+/g, ' ').trim(), targets, unknown };
}

/**
 * 游標前正在打的 @ 點名（還沒打完的那一段），給成員選單用；不是在點名就 null。
 * start 是 @ 的位置。
 */
export function activeMention(
  input: string,
  caret: number,
): { start: number; query: string } | null {
  const before = input.slice(0, caret);
  const at = Math.max(before.lastIndexOf('@'), before.lastIndexOf('＠'));
  if (at < 0 || !mentionBoundary(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}
