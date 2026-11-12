// 交叉審查的 no-llm 界線（Codex 第二輪，docs/no-llm-review.md「交叉審查」）：check-no-llm.mjs 用、測試用。
// daemon 開非互動 CLI（`claude -p`、`codex exec`）只能由兩種動作觸發：GM 在網頁按確認（REST reviewStart）、
// 隊長呼叫 MCP 工具 request_review。不能由排程、規則或任何自動流程觸發。這裡把整條路的每個呼叫點列成白名單：
//   GM：rest.ts reviewStart → ReviewEngine.startReview → `type: 'review.run'`
//   隊長：hub.ts `case 'dispatch.request'` → onDispatchRequest → dispatch.handle
//         → dispatch.ts `case 'request_review'` → requestReview → deps.requestReview
//         → hub.ts 的 DispatchDeps 接線 → ReviewEngine.requestByLead → startReview
//   daemon：daemon.ts `case 'review.run':` → ReviewRunner.run（review.ts，唯一開審查 CLI 的地方）
// 白名單以外出現這些呼叫、或呼叫點和所在函式開頭之間有延後執行（setTimeout／setInterval／setImmediate、
// queueMicrotask、process.nextTick、`.then(`、事件監聽 `.on(`／`.once(`），一律算違反（審查 W8）。
// 唯一的例外是 requestByLead：diff 產生好（`.then`）才開始，標 allowDeferred。

/** 每一種呼叫：在哪個檔案、哪個函式（或物件鍵）裡才可以出現。 */
export const REVIEW_TRIGGER_RULES = [
  {
    call: /\.startReview\(/g,
    allowed: [
      { file: 'packages/hub/src/rest.ts', within: 'reviewStart' },
      { file: 'packages/hub/src/reviews.ts', within: 'requestByLead', allowDeferred: true },
    ],
  },
  {
    call: /\.onDispatchRequest\(/g,
    allowed: [{ file: 'packages/hub/src/hub.ts', within: "case 'dispatch.request'" }],
  },
  {
    call: /\.dispatch\.handle\(/g,
    allowed: [{ file: 'packages/hub/src/hub.ts', within: 'onDispatchRequest' }],
  },
  {
    call: /this\.requestReview\(/g,
    allowed: [{ file: 'packages/hub/src/dispatch.ts', within: "case 'request_review'" }],
  },
  {
    call: /\.requestByLead\(/g,
    allowed: [{ file: 'packages/hub/src/hub.ts', within: 'requestReview' }],
  },
  {
    call: /\.deps\.requestReview\(/g,
    allowed: [{ file: 'packages/hub/src/dispatch.ts', within: 'requestReview' }],
  },
  {
    // hub 送出的物件（型別宣告 `{ type: 'review.run' }` 沒有逗號，不算）。
    call: /type: 'review\.run',/g,
    allowed: [{ file: 'packages/hub/src/reviews.ts', within: 'startReview' }],
  },
  {
    call: /\.reviews\.run\(/g,
    allowed: [{ file: 'packages/daemon/src/daemon.ts', within: "case 'review.run'" }],
  },
  {
    call: /new ReviewRunner\(/g,
    allowed: [{ file: 'packages/daemon/src/daemon.ts', within: 'constructor' }],
  },
];

/** 這些檔案以外不准出現非互動 CLI 的參數（`'-p'`／`'--print'`、`'exec'`＋`'--json'`）。 */
export const NON_INTERACTIVE_FILE = 'packages/daemon/src/review.ts';

const TIMER =
  /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(|process\.nextTick\s*\(|\.then\s*\(|\.(on|once|addListener|addEventListener)\s*\(/;

/**
 * 呼叫點往上找所在的函式（靠 prettier 排好的縮排：縮排比目前少的行才是外層）：class method
 * （`  private foo(`、`  constructor(`）、物件鍵（`foo: (…) =>`）或 switch 的 `case '…':`。
 * 結束行（`) {`、`}): T {`、`]`）跳過。回傳 { name, index }（index 是那一行的開頭）。
 */
export function enclosing(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const indentOf = (line) => /^\s*/.exec(line)[0].length;
  let min = indentOf(text.slice(lineStart, index));
  // 呼叫點那一行本身就是物件鍵（`foo: (x) => this.bar(…)`）。
  const own = /^\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/.exec(text.slice(lineStart, index));
  if (own) return { name: own[1], index: lineStart };
  let end = lineStart - 1;
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    const line = text.slice(start, end);
    end = start - 1;
    if (!line.trim() || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const indent = indentOf(line);
    if (indent >= min || /^\s*[)}\]]/.test(line)) continue;
    min = indent;
    const caseMatch = /^\s*(case '[^']+')\s*:/.exec(line);
    if (caseMatch) return { name: caseMatch[1], index: start };
    const method =
      /^\s*(?:(?:private|public|protected|static|async|readonly|get)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/.exec(
        line,
      );
    if (method && !/^(if|for|while|switch|catch|return|function)$/.test(method[1])) {
      return { name: method[1], index: start };
    }
    const key = /^\s+([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/.exec(line);
    if (key) return { name: key[1], index: start };
  }
  return { name: null, index: 0 };
}

/** files：[{ path, text }]（只放 packages/*\/src 的原始碼，不含測試）。回傳違反的說明。 */
export function checkReviewBoundary(files) {
  const problems = [];
  for (const { path, text } of files) {
    for (const rule of REVIEW_TRIGGER_RULES) {
      for (const match of text.matchAll(rule.call)) {
        const line = text.slice(0, match.index).split('\n').length;
        const where = enclosing(text, match.index);
        const allowed = rule.allowed.find((a) => a.file === path && a.within === where.name);
        const ok = allowed !== undefined;
        if (!ok) {
          problems.push(
            `${path}:${line} 在 ${where.name ?? '（頂層）'} 裡出現 ${rule.call.source}：交叉審查只能由使用者動作（reviewStart）或隊長的 request_review 觸發`,
          );
          continue;
        }
        if (!allowed.allowDeferred && TIMER.test(text.slice(where.index, match.index))) {
          problems.push(
            `${path}:${line} ${rule.call.source} 在計時器裡：交叉審查不能由排程或自動流程觸發`,
          );
        }
      }
    }
    if (path.startsWith('packages/daemon/') && path !== NON_INTERACTIVE_FILE) {
      if (/'(-p|--print)'/.test(text)) {
        problems.push(`${path}：出現 -p／--print，只有 ${NON_INTERACTIVE_FILE}（交叉審查）可以`);
      }
      if (/['"]exec['"],\s*['"]--json['"]|codex exec/.test(text)) {
        problems.push(`${path}：出現 codex exec，只有 ${NON_INTERACTIVE_FILE}（交叉審查）可以`);
      }
    }
  }
  // review.ts 自己：開 CLI 的只有 ReviewRunner.run 底下的 runSide，不能有 setInterval（不自己排程）。
  const runner = files.find((f) => f.path === NON_INTERACTIVE_FILE);
  if (runner) {
    if (/setInterval\(/.test(runner.text)) {
      problems.push(`${NON_INTERACTIVE_FILE}：不能有 setInterval（審查不能自己排程）`);
    }
    for (const match of runner.text.matchAll(/\bspawn\(/g)) {
      const where = enclosing(runner.text, match.index);
      if (where.name !== 'runSide') {
        problems.push(`${NON_INTERACTIVE_FILE}：spawn 只能在 runSide 裡（目前在 ${where.name}）`);
      }
    }
  }
  return problems;
}
