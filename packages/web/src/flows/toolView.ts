// 把工具輸入轉成可顯示的內容：改檔畫成 diff，指令顯示全文，其他工具顯示完整 JSON。

export type DiffLine = { type: 'add' | 'del' | 'ctx'; text: string };

export type ToolView =
  | { kind: 'diff'; file: string | null; lines: DiffLine[] }
  | { kind: 'command'; text: string }
  | { kind: 'raw'; text: string }
  | { kind: 'none' };

const str = (value: unknown) => (typeof value === 'string' ? value : null);

/** 只切掉頭尾相同的行；中間整段算刪除加新增。審核時要看的是改了什麼，不需要最短編輯距離。 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const ctx = (text: string): DiffLine => ({ type: 'ctx', text });
  return [
    ...a.slice(0, head).map(ctx),
    ...a.slice(head, a.length - tail).map((text): DiffLine => ({ type: 'del', text })),
    ...b.slice(head, b.length - tail).map((text): DiffLine => ({ type: 'add', text })),
    ...a.slice(a.length - tail).map(ctx),
  ];
}

export function summarizeTool(
  toolName: string | null,
  input: Record<string, unknown> | null,
): ToolView {
  if (!input) return { kind: 'none' };
  const command = str(input['command']);
  if (command !== null) return { kind: 'command', text: command };
  const file = str(input['file_path']);
  if (toolName === 'Edit') {
    const before = str(input['old_string']);
    const after = str(input['new_string']);
    if (before !== null && after !== null) {
      return { kind: 'diff', file, lines: lineDiff(before, after) };
    }
  }
  if (toolName === 'MultiEdit' && Array.isArray(input['edits'])) {
    const lines = (input['edits'] as { old_string?: unknown; new_string?: unknown }[]).flatMap(
      (edit) => lineDiff(str(edit.old_string) ?? '', str(edit.new_string) ?? ''),
    );
    return { kind: 'diff', file, lines };
  }
  if (toolName === 'Write') {
    const content = str(input['content']);
    if (content !== null) {
      return {
        kind: 'diff',
        file,
        lines: content.split('\n').map((text) => ({ type: 'add', text })),
      };
    }
  }
  return { kind: 'raw', text: JSON.stringify(input, null, 2) };
}
