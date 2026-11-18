// daemon 探測 codex 的指令白名單（GM 2026-11-18，CONTRACTS §26.11）：check-no-llm.mjs 呼叫，測試在
// scripts/no-llm-codex-probe.test.mjs（餵違規片段進來，確認會失敗）。
//
// 可以跑的指令（逐字比對陣列）：
// - `--version`：版本。
// - `debug models --help`：先確認這版有 `debug models`（沒有的舊版會把 `debug` 當成 prompt），只印說明。
// - `debug models`：印模型目錄 JSON 就結束，不開對話、不做模型推論。**會連網**：codex 用使用者的登入向 OpenAI 抓
//   最新目錄、寫進 codex 自己的快取（docs/no-llm-review.md 有實測證據）；不是 LLM 呼叫、不送 prompt。
// - `debug models --bundled`：只讀執行檔內建的目錄（不連網），上面失敗時才用。

export const CODEX_PROBE_FILE = 'packages/daemon/src/resources.ts';

export const CODEX_PROBE_ARGS = new Set([
  "['--version']",
  "['debug', 'models', '--help']",
  "['debug', 'models']",
  "['debug', 'models', '--bundled']",
]);

const norm = (value) => value.replace(/\s+/g, ' ').trim();

/**
 * 檢查 resources.ts 的內容：
 * - `const CODEX_*ARGS = [...]` 與 `execFileAsync(codexBin, [...])` 的陣列都要在白名單裡；
 * - `execFileAsync(codexBin, X)` 的 X 只能是字面陣列；
 * - `runCodexProbe(codexBin, X)` 的 X 只能是 CODEX_*ARGS 常數，或 `for (const args of [CODEX_*ARGS, …])` 迴圈的 args；
 * - `spawn(codexBin, X)` 只能出現一次（runCodexProbe 裡面），X 是 `argv`；
 * - 不能用其他寫法把 codexBin 交給 execFile／exec／spawnSync 之類。
 * 回傳問題清單（空的＝通過）。
 */
export function checkCodexProbe(text, file = CODEX_PROBE_FILE) {
  const problems = [];
  const consts = [...text.matchAll(/const (CODEX_\w*ARGS) = (\[[^\]]*\])/g)];
  const known = new Set(consts.map((m) => m[1]));
  for (const [, , value] of consts) {
    if (!CODEX_PROBE_ARGS.has(norm(value))) {
      problems.push(`${file}：codex 探測參數 ${norm(value)} 不在允許清單`);
    }
  }
  for (const m of text.matchAll(/execFileAsync\(codexBin,\s*([^,]+),/g)) {
    const value = norm(m[1]);
    if (!value.startsWith('[') || !CODEX_PROBE_ARGS.has(value)) {
      problems.push(`${file}：execFileAsync(codexBin, ${value}) 不是允許的字面陣列`);
    }
  }
  for (const m of text.matchAll(/runCodexProbe\(codexBin,\s*([^,]+),/g)) {
    const value = norm(m[1]);
    if (!known.has(value) && value !== 'args') {
      problems.push(`${file}：runCodexProbe(codexBin, ${value}) 只能傳 CODEX_*ARGS 常數`);
    }
  }
  // 一行內最短比對到 `])`：清單裡有字面陣列（`['exec']`）也抓得到。
  const loops = [...text.matchAll(/for \(const args of \[(.*?)\]\)/g)].map((m) => m[1]);
  if (/for \(const args of /.test(text) && loops.length === 0) {
    problems.push(`${file}：codex 探測的參數清單看不懂，無法審查`);
  }
  if (loops.some((loop) => loop.split(',').some((n) => !known.has(n.trim())))) {
    problems.push(`${file}：codex 探測的參數清單只能放 CODEX_*ARGS 常數`);
  }
  const spawns = [...text.matchAll(/\bspawn\(codexBin,\s*([^,]+),/g)];
  if (spawns.length > 1 || spawns.some((m) => norm(m[1]) !== 'argv')) {
    problems.push(`${file}：spawn(codexBin, …) 只能在 runCodexProbe 裡出現一次`);
  }
  if (/\b(execFile|execFileSync|exec|execSync|spawnSync|fork)\(codexBin\b/.test(text)) {
    problems.push(`${file}：codexBin 只能經 execFileAsync／runCodexProbe 執行`);
  }
  return problems;
}

/** 其他檔案（測試以外）不能呼叫 runCodexProbe：參數只在 resources.ts 審查。 */
export function checkCodexProbeCallers(files) {
  return files
    .filter((f) => f.path !== CODEX_PROBE_FILE && /\brunCodexProbe\(/.test(f.text))
    .map((f) => `${f.path}：runCodexProbe 只能在 ${CODEX_PROBE_FILE} 裡呼叫`);
}
