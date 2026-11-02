// 把 deploy/ 的模板填成各平台的服務設定。路徑可能有空格、中文、& 或 %，一律在這裡跳脫。
// 純函式、不碰系統，測試見 scripts/service-templates.test.mjs。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const deployDir = join(import.meta.dirname, '..', '..', 'deploy');

function fill(template, values) {
  return readFileSync(join(deployDir, template), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`模板 ${template} 缺少 ${key}`);
    return values[key];
  });
}

const xml = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** @param {{label, node, entry, env, workdir, log}} s */
export function renderLaunchd(s) {
  return fill('launchd/agent-board.plist.template', {
    LABEL: xml(s.label),
    NODE: xml(s.node),
    ENTRY: xml(s.entry),
    WORKDIR: xml(s.workdir),
    LOG: xml(s.log),
    ENV: Object.entries(s.env)
      .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
      .join('\n'),
  });
}

// systemd 的 %、$、\、" 都有特殊意義；StandardOutput=append: 不吃引號，只處理 %。
const systemdPercent = (text) => text.replaceAll('%', '%%');
const systemdWord = (text) =>
  `"${systemdPercent(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '$$$$')}"`;

/** @param {{description, node, entry, env, workdir, log}} s */
export function renderSystemd(s) {
  for (const [name, value] of [
    ['工作目錄', s.workdir],
    ['log', s.log],
  ]) {
    if (/[\n"]/.test(value)) throw new Error(`${name}路徑含有 systemd 不接受的字元：${value}`);
  }
  return fill('systemd/agent-board.service.template', {
    DESCRIPTION: s.description.replaceAll('%', '%%'),
    EXEC_START: `${systemdWord(s.node)} ${systemdWord(s.entry)}`,
    WORKDIR: systemdPercent(s.workdir),
    LOG: systemdPercent(s.log),
    ENV: Object.entries(s.env)
      .map(
        ([key, value]) =>
          `Environment="${key}=${systemdPercent(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
      )
      .join('\n'),
  });
}

const cmdPercent = (text) => text.replaceAll('%', '%%');

/** @param {{node, entry, env, workdir, log}} s */
export function renderWindowsCmd(s) {
  const text = fill('windows/run-service.cmd.template', {
    NODE: cmdPercent(s.node),
    ENTRY: cmdPercent(s.entry),
    WORKDIR: cmdPercent(s.workdir),
    LOG: cmdPercent(s.log),
    ENV: Object.entries(s.env)
      .map(([key, value]) => `set "${key}=${cmdPercent(value)}"`)
      .join('\n'),
  });
  return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
}

/** schtasks /XML 要 UTF-16 LE 加 BOM，回傳 Buffer。@param {{description, user, runCmd}} s */
export function renderWindowsTask(s) {
  const text = fill('windows/task.xml.template', {
    DESCRIPTION: xml(s.description),
    USER: xml(s.user),
    RUN_CMD: xml(s.runCmd),
  });
  return Buffer.from(`﻿${text}`, 'utf16le');
}

/**
 * 服務環境的 PATH：node、claude 在最前面，接著是安裝時的 PATH（session 裡的 claude 才找得到
 * 使用者的工具），最後補常見位置。相對路徑不收：工作目錄換了會指到別的東西。
 */
export function servicePath({ first, current, delimiter, extra, absolute }) {
  const seen = new Set();
  const result = [];
  for (const dir of [...first, ...current.split(delimiter), ...extra]) {
    if (!dir || !absolute(dir) || seen.has(dir)) continue;
    // 從 pnpm、npm script 執行安裝時才會有；不該變成服務的永久環境。
    if (/[\\/]node_modules[\\/]\.bin$|[\\/]node-gyp-bin$/.test(dir)) continue;
    seen.add(dir);
    result.push(dir);
  }
  return result.join(delimiter);
}
