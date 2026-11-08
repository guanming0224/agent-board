// 請隊長拆解：固定格式的提示與回覆解析。解析不到不算當機，要能說出原因。
// 自動指派（GM 2026-11-06）：提示請隊長替每項標上成員的縮寫（role），解析後依縮寫指派，不另外花額度。
import type { Session, Team, TeamMember } from '@agent-board/protocol';
import { DECOMPOSE_PROMPT_START } from '../shared/decomposePrompt';
import { memberKind } from './research';
import { KIND_ABBR, ROLE_ABBR } from './teamPlan';

const MAX_TASKS = 50;
const MAX_TITLE_CHARS = 200;
const MAX_NOTES_CHARS = 3000;
const MAX_ATTEMPTS = 200;

const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();

/** 提示裡縮寫後面的說明（英文：提示是固定的英文）。 */
const ABBR_LABEL: Record<string, string> = {
  LD: 'lead',
  BD: 'builder',
  RS: 'researcher',
  RV: 'reviewer',
  QA: 'tester',
  LR: 'literature',
  EX: 'experiments',
  WR: 'writing',
};

/** 可以接任務的成員：縮寫（BD、EX…）與比對用的別名（角色或分工的英文代碼）。 */
export interface RoleRef {
  sessionId: string;
  name: string;
  abbr: string;
  aliases: readonly string[];
}

/**
 * 團隊裡可以接任務的成員（沒封存的）。程式開發團隊用角色縮寫（LD／BD／RS／RV），
 * 研究團隊用分工縮寫（LD／LR／EX／WR／RV）。依名稱排序：輪流指派從 BD1 開始。
 */
export function roleRefs(
  team: Pick<Team, 'phase'>,
  members: readonly TeamMember[],
  sessions: readonly Session[],
): RoleRef[] {
  return members
    .flatMap((member): RoleRef[] => {
      const session = sessions.find((s) => s.id === member.sessionId);
      if (!session || session.archived) return [];
      if (team.phase !== undefined) {
        const kind = memberKind(member);
        return [
          { sessionId: session.id, name: session.name, abbr: KIND_ABBR[kind], aliases: [kind] },
        ];
      }
      return [
        {
          sessionId: session.id,
          name: session.name,
          abbr: ROLE_ABBR[member.role],
          aliases: [member.role],
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** 團隊裡實際有的縮寫（依第一次出現的順序，不重複）。 */
export const presentAbbrs = (refs: readonly RoleRef[]): string[] => [
  ...new Set(refs.map((r) => r.abbr)),
];

/** 一行：多行內容打進 TUI 不一定會被當成同一則訊息。`abbrs` 是團隊裡有的縮寫，沒有就不要求 role。 */
export function decomposePrompt(
  team: Pick<Team, 'goal' | 'doneCriteria' | 'contextMd'>,
  abbrs: readonly string[] = [],
): string {
  const notes = oneLine(team.contextMd).slice(0, MAX_NOTES_CHARS);
  const roles = abbrs.map((abbr) => `${abbr} (${ABBR_LABEL[abbr] ?? abbr.toLowerCase()})`);
  return [
    DECOMPOSE_PROMPT_START,
    `Goal: ${oneLine(team.goal)}`,
    team.doneCriteria.trim() ? `Done when: ${oneLine(team.doneCriteria)}` : null,
    notes ? `Team notes: ${notes}` : null,
    'Do not start the work.',
    roles.length > 0
      ? `Reply with only a JSON array of at most 12 tasks, like [{"title":"...","role":"${abbrs[0]}"}], with titles in the language of the goal. Set "role" to who should do the task, one of: ${roles.join(', ')}.`
      : 'Reply with only a JSON array of at most 12 tasks, like [{"title":"..."}], with titles in the language of the goal.',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface ParsedTask {
  title: string;
  /** 隊長標的縮寫（原樣、清過控制字元）；沒標或不是字串是 null。 */
  role: string | null;
}

export type ParseFailure = 'no_json' | 'bad_json' | 'no_titles';
export type ParseResult = { ok: true; tasks: ParsedTask[] } | { ok: false; reason: ParseFailure };

/** 舊格式（字串、只有 title 的物件）照樣讀得到，只是沒有 role。 */
function tasksOf(value: unknown): ParsedTask[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const tasks = value.flatMap((item: unknown): ParsedTask[] => {
    const object =
      typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : null;
    const title = typeof item === 'string' ? item : object?.title;
    if (typeof title !== 'string' || !title.trim()) return [];
    const clean = oneLine(title).slice(0, MAX_TITLE_CHARS);
    // 重複的標題只留第一個（連同它的 role）。
    if (seen.has(clean)) return [];
    seen.add(clean);
    const role = object && typeof object.role === 'string' ? oneLine(object.role).slice(0, 20) : '';
    return [{ title: clean, role: role || null }];
  });
  return tasks.length > 0 ? tasks.slice(0, MAX_TASKS) : null;
}

/**
 * 依 role 指派負責人：和縮寫（不分大小寫）或角色／分工代碼相同的成員；同縮寫有好幾位就輪流
 * （BD1、BD2、BD1…）。對不到、沒標的不指派（留在待分配給使用者選）。回傳和 tasks 同順序。
 */
export function assignOwners(
  tasks: readonly ParsedTask[],
  refs: readonly RoleRef[],
): (string | null)[] {
  const groups = new Map<string, RoleRef[]>();
  for (const ref of refs) {
    const list = groups.get(ref.abbr) ?? [];
    list.push(ref);
    groups.set(ref.abbr, list);
  }
  const groupOf = (role: string): string | null => {
    const upper = role.trim().toUpperCase();
    if (groups.has(upper)) return upper;
    const lower = role.trim().toLowerCase();
    return refs.find((ref) => ref.aliases.includes(lower))?.abbr ?? null;
  };
  const next = new Map<string, number>();
  return tasks.map((task) => {
    const group = task.role === null ? null : groupOf(task.role);
    if (group === null) return null;
    const list = groups.get(group)!;
    const at = next.get(group) ?? 0;
    next.set(group, at + 1);
    return list[at % list.length]!.sessionId;
  });
}

/** 跳過字串內容，找到和開頭配對的 `]`。 */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']' && --depth === 0) return i;
  }
  return -1;
}

/** 回覆常包 ```json 或前後夾說明，甚至有 `[注意]` 這種方括號，所以每個 `[` 都試。 */
export function parseTaskList(text: string): ParseResult {
  let sawArray = false;
  let sawOpen = false;
  let start = text.indexOf('[');
  for (let attempt = 0; start !== -1 && attempt < MAX_ATTEMPTS; attempt += 1) {
    sawOpen = true;
    const end = balancedEnd(text, start);
    if (end !== -1) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        sawArray = true;
        const tasks = tasksOf(value);
        if (tasks) return { ok: true, tasks };
      } catch {
        // 不是 JSON，換下一個 `[`
      }
    }
    start = text.indexOf('[', start + 1);
  }
  if (sawArray) return { ok: false, reason: 'no_titles' };
  return { ok: false, reason: sawOpen ? 'bad_json' : 'no_json' };
}
