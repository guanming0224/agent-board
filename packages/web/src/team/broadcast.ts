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

/**
 * 解析指令框：`@` 只在開頭或空白後面才算點名。名稱可能有空白（session 名稱），所以由長到短比對成員名稱，
 * 名稱後面要接空白或結尾。比對不到的取到下一個空白為止，當成「不是本團隊成員」。
 */
export function parseCommand(input: string, members: readonly MentionCandidate[]): ParsedCommand {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const targets: string[] = [];
  const unknown: string[] = [];
  let text = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '@' && isSpace(input[i - 1])) {
      const rest = input.slice(i + 1);
      const hit = byLength.find(
        (m) => rest.toLowerCase().startsWith(m.name.toLowerCase()) && isSpace(rest[m.name.length]),
      );
      if (hit) {
        if (!targets.includes(hit.id)) targets.push(hit.id);
        i += 1 + hit.name.length;
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
  const at = before.lastIndexOf('@');
  if (at < 0 || !isSpace(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}
