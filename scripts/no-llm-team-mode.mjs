// 團隊模式守則的 no-llm 檢查（GM 2026-11-21，CONTRACTS §27）：check-no-llm.mjs 呼叫，測試在
// scripts/no-llm-team-mode.test.mjs（餵違規片段進來，確認會失敗）。
//
// 保證的事：daemon 帶給 agent 的守則只能是 leadGuide.ts 裡寫死的常數組合，
// - session.ts：`'--append-system-prompt'` 只出現一次，而且整句是
//   `args.push('--append-system-prompt', teamModeGuide(input.teamLead));`（不能串接 name、prompt 或任何變數）；
// - codex.ts：`developer_instructions` 只出現一次，整句是
//   ``args.push('-c', `developer_instructions="${tomlString(teamModeGuide(input.teamLead))}"`);``；
// - leadGuide.ts：`teamModeGuide` 的簽名只收兩個布林，函式本體只用 TEAM_MODE_* 常數與這兩個布林（沒有樣板字串、
//   沒有其他識別字）；每個 TEAM_MODE_* 文字常數只由字串字面值與 `+` 組成。

export const TEAM_MODE_FILES = {
  session: 'packages/daemon/src/session.ts',
  codex: 'packages/daemon/src/codex.ts',
  leadGuide: 'packages/protocol/src/leadGuide.ts',
};

export const CLAUDE_STATEMENT =
  "args.push('--append-system-prompt', teamModeGuide(input.teamLead));";
export const CODEX_STATEMENT =
  'args.push(\'-c\', `developer_instructions="${tomlString(teamModeGuide(input.teamLead))}"`);';
const GUIDE_SIGNATURE =
  'export function teamModeGuide(flags: { autoStaff: boolean; presetMembers: boolean }): string {';
/** teamModeGuide 本體可以出現的識別字（其他一律不准）。 */
const BODY_WORDS = new Set(['return', 'flags', 'autoStaff', 'presetMembers', 'join']);

const count = (text, needle) => text.split(needle).length - 1;
const norm = (value) => value.replace(/\s+/g, ' ').trim();
/** 拿掉註解（// 與 /* *\/），只看程式本身。字串裡的 // 不會出現在這幾個檔的相關段落。 */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

export function checkTeamModeClaude(text, file = TEAM_MODE_FILES.session) {
  const problems = [];
  const src = norm(code(text));
  if (count(src, "'--append-system-prompt'") !== 1) {
    problems.push(`${file}：'--append-system-prompt' 應該剛好出現一次`);
  }
  if (count(src, CLAUDE_STATEMENT) !== 1) {
    problems.push(
      `${file}：--append-system-prompt 的值只能是 teamModeGuide(input.teamLead)（整句比對）`,
    );
  }
  if (count(src, 'teamModeGuide(') !== 1) {
    problems.push(`${file}：teamModeGuide(...) 只能在 --append-system-prompt 那一句呼叫`);
  }
  return problems;
}

export function checkTeamModeCodex(text, file = TEAM_MODE_FILES.codex) {
  const problems = [];
  const src = norm(code(text));
  if (count(src, 'developer_instructions') !== 1) {
    problems.push(`${file}：developer_instructions 應該剛好出現一次`);
  }
  if (count(src, CODEX_STATEMENT) !== 1) {
    problems.push(
      `${file}：developer_instructions 的值只能是 tomlString(teamModeGuide(input.teamLead))（整句比對）`,
    );
  }
  if (count(src, 'teamModeGuide(') !== 1) {
    problems.push(`${file}：teamModeGuide(...) 只能在 developer_instructions 那一句呼叫`);
  }
  return problems;
}

export function checkTeamModeGuide(text, file = TEAM_MODE_FILES.leadGuide) {
  const problems = [];
  const src = code(text);
  const start = src.indexOf(GUIDE_SIGNATURE);
  if (start === -1 || count(src, 'function teamModeGuide') !== 1) {
    problems.push(`${file}：teamModeGuide 的簽名必須是 ${GUIDE_SIGNATURE}`);
  } else {
    const end = src.indexOf('\n}', start);
    const body = src.slice(start + GUIDE_SIGNATURE.length, end);
    if (/[`$"'\\]/.test(body)) {
      problems.push(`${file}：teamModeGuide 本體不能有字串、樣板字串（只能拼 TEAM_MODE_* 常數）`);
    }
    for (const word of body.match(/[A-Za-z_]\w*/g) ?? []) {
      if (!BODY_WORDS.has(word) && !/^TEAM_MODE_[A-Z_]+$/.test(word)) {
        problems.push(`${file}：teamModeGuide 本體出現不允許的識別字 ${word}`);
      }
    }
  }
  const consts = [...src.matchAll(/export const (TEAM_MODE_[A-Z_]+)\s*=\s*([\s\S]*?);\n/g)];
  if (consts.length === 0) problems.push(`${file}：找不到 TEAM_MODE_* 常數`);
  for (const [, name, value] of consts) {
    if (name === 'TEAM_MODE_GUIDE_CHARS') continue;
    // 只能是 '...' 字串字面值用 + 串起來（字面值裡不能有 \ 跳脫，免得藏東西）。
    if (!/^'[^'\\\n]*'(\s*\+\s*'[^'\\\n]*')*$/.test(value.trim())) {
      problems.push(`${file}：${name} 只能是字串字面值（用 + 串接）`);
    }
  }
  return problems;
}

export function checkTeamMode(read) {
  return [
    ...checkTeamModeClaude(read(TEAM_MODE_FILES.session)),
    ...checkTeamModeCodex(read(TEAM_MODE_FILES.codex)),
    ...checkTeamModeGuide(read(TEAM_MODE_FILES.leadGuide)),
  ];
}
