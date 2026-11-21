// 團隊模式守則的 no-llm 檢查（scripts/no-llm-team-mode.mjs）：真的原始碼通過，違規片段一定抓得到。
// node --test scripts/no-llm-team-mode.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkTeamModeClaude,
  checkTeamModeCodex,
  checkTeamModeGuide,
  CLAUDE_STATEMENT,
  CODEX_STATEMENT,
  TEAM_MODE_FILES,
} from './no-llm-team-mode.mjs';

const root = join(import.meta.dirname, '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const session = read(TEAM_MODE_FILES.session);
const codex = read(TEAM_MODE_FILES.codex);
const guide = read(TEAM_MODE_FILES.leadGuide);

test('真的原始碼通過，而且兩句真的出現（檢查不是空轉）', () => {
  assert.deepEqual(checkTeamModeClaude(session), []);
  assert.deepEqual(checkTeamModeCodex(codex), []);
  assert.deepEqual(checkTeamModeGuide(guide), []);
  assert.ok(session.includes(CLAUDE_STATEMENT));
  assert.ok(codex.includes(CODEX_STATEMENT));
  assert.match(guide, /export function teamModeGuide\(/);
});

const fails = (check, text, pattern) => {
  const problems = check(text);
  assert.ok(problems.length > 0, `應該失敗：${text.slice(0, 200)}`);
  if (pattern)
    assert.ok(
      problems.some((p) => pattern.test(p)),
      problems.join('\n'),
    );
};

test('Claude：串接變數、換成別的值、多帶一次、拿掉，都會失敗', () => {
  const swap = (to) => session.replace(CLAUDE_STATEMENT, to);
  fails(
    checkTeamModeClaude,
    swap("args.push('--append-system-prompt', teamModeGuide(input.teamLead) + input.name);"),
  );
  fails(
    checkTeamModeClaude,
    swap("args.push('--append-system-prompt', `${teamModeGuide(input.teamLead)} ${input.name}`);"),
  );
  fails(checkTeamModeClaude, swap("args.push('--append-system-prompt', input.name);"));
  fails(
    checkTeamModeClaude,
    swap(`${CLAUDE_STATEMENT}\n      args.push('--append-system-prompt', spec.firstPrompt);`),
    /剛好出現一次/,
  );
  fails(
    checkTeamModeClaude,
    swap(`${CLAUDE_STATEMENT}\n      args.push('--x', teamModeGuide(input.teamLead));`),
    /只能在/,
  );
  fails(checkTeamModeClaude, swap(''));
  // 拆成兩行再串接也抓得到（空白正規化後整句不符）。
  fails(
    checkTeamModeClaude,
    swap("args.push(\n'--append-system-prompt',\nteamModeGuide(input.teamLead) +\ninput.name);"),
  );
});

test('Codex：串接、換值、多一個 developer_instructions，都會失敗', () => {
  const swap = (to) => codex.replace(CODEX_STATEMENT, to);
  fails(
    checkTeamModeCodex,
    swap(
      'args.push(\'-c\', `developer_instructions="${tomlString(teamModeGuide(input.teamLead) + input.firstPrompt)}"`);',
    ),
  );
  fails(
    checkTeamModeCodex,
    swap("args.push('-c', `developer_instructions=\"${tomlString(input.firstPrompt ?? '')}\"`);"),
  );
  fails(
    checkTeamModeCodex,
    swap(`${CODEX_STATEMENT}\n    args.push('-c', 'developer_instructions="x"');`),
    /剛好出現一次/,
  );
  fails(checkTeamModeCodex, swap(''));
});

test('leadGuide：teamModeGuide 收任意文字、用樣板字串、拼別的變數，或常數不是純字面值，都會失敗', () => {
  fails(
    checkTeamModeGuide,
    guide.replace(
      'export function teamModeGuide(flags: { autoStaff: boolean; presetMembers: boolean }): string {',
      'export function teamModeGuide(flags: { autoStaff: boolean; presetMembers: boolean; text: string }): string {',
    ),
    /簽名/,
  );
  fails(
    checkTeamModeGuide,
    guide.replace(
      '    TEAM_MODE_SMALL_WORK,\n',
      '    TEAM_MODE_SMALL_WORK,\n    `${process.env.X}`,\n',
    ),
  );
  fails(
    checkTeamModeGuide,
    guide.replace(
      '    TEAM_MODE_SMALL_WORK,\n',
      '    TEAM_MODE_SMALL_WORK,\n    globalThis.extra,\n',
    ),
    /識別字/,
  );
  fails(
    checkTeamModeGuide,
    guide.replace(
      "export const TEAM_MODE_SEPARATOR = ' ';",
      'export const TEAM_MODE_SEPARATOR = process.env.SEP;',
    ),
    /字串字面值/,
  );
  fails(
    checkTeamModeGuide,
    guide.replace(
      "export const TEAM_MODE_SEPARATOR = ' ';",
      "export const TEAM_MODE_SEPARATOR = ' ' + `${1}`;",
    ),
    /字串字面值/,
  );
});
