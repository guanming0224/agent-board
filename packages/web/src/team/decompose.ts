// 請隊長拆解：固定格式的提示與回覆解析。解析不到不算當機，要能說出原因。
import type { Team } from '@agent-board/protocol';
import { DECOMPOSE_PROMPT_START } from '../shared/decomposePrompt';

const MAX_TASKS = 50;
const MAX_TITLE_CHARS = 200;
const MAX_NOTES_CHARS = 3000;
const MAX_ATTEMPTS = 200;

const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();

/** 一行：多行內容打進 TUI 不一定會被當成同一則訊息。 */
export function decomposePrompt(team: Pick<Team, 'goal' | 'doneCriteria' | 'contextMd'>): string {
  const notes = oneLine(team.contextMd).slice(0, MAX_NOTES_CHARS);
  return [
    DECOMPOSE_PROMPT_START,
    `Goal: ${oneLine(team.goal)}`,
    team.doneCriteria.trim() ? `Done when: ${oneLine(team.doneCriteria)}` : null,
    notes ? `Team notes: ${notes}` : null,
    'Do not start the work.',
    'Reply with only a JSON array of at most 12 tasks, like [{"title":"..."}], with titles in the language of the goal.',
  ]
    .filter(Boolean)
    .join(' ');
}

export type ParseFailure = 'no_json' | 'bad_json' | 'no_titles';
export type ParseResult = { ok: true; titles: string[] } | { ok: false; reason: ParseFailure };

function titlesOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const titles = value.flatMap((item: unknown) => {
    const title = typeof item === 'string' ? item : (item as { title?: unknown } | null)?.title;
    return typeof title === 'string' && title.trim()
      ? [oneLine(title).slice(0, MAX_TITLE_CHARS)]
      : [];
  });
  return titles.length > 0 ? [...new Set(titles)].slice(0, MAX_TASKS) : null;
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
        const titles = titlesOf(value);
        if (titles) return { ok: true, titles };
      } catch {
        // 不是 JSON，換下一個 `[`
      }
    }
    start = text.indexOf('[', start + 1);
  }
  if (sawArray) return { ok: false, reason: 'no_titles' };
  return { ok: false, reason: sawOpen ? 'bad_json' : 'no_json' };
}
