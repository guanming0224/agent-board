// codex 探測指令的 no-llm 檢查（scripts/no-llm-codex-probe.mjs）：真的原始碼通過，違規片段一定抓得到。
// node --test scripts/no-llm-codex-probe.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkCodexProbe,
  checkCodexProbeCallers,
  CODEX_PROBE_FILE,
} from './no-llm-codex-probe.mjs';

const root = join(import.meta.dirname, '..');
const real = readFileSync(join(root, CODEX_PROBE_FILE), 'utf8');

test('真的 resources.ts 通過，而且四組參數都真的出現（檢查不是空轉）', () => {
  assert.deepEqual(checkCodexProbe(real), []);
  assert.match(real, /execFileAsync\(codexBin, \['--version'\]/);
  for (const name of [
    'CODEX_CATALOG_ARGS',
    'CODEX_BUNDLED_CATALOG_ARGS',
    'CODEX_CATALOG_HELP_ARGS',
  ]) {
    assert.match(real, new RegExp(`const ${name} = \\[`));
  }
  assert.match(real, /runCodexProbe\(codexBin, CODEX_CATALOG_HELP_ARGS,/);
  assert.match(real, /for \(const args of \[CODEX_CATALOG_ARGS, CODEX_BUNDLED_CATALOG_ARGS\]\)/);
});

const fails = (text, pattern) => {
  const problems = checkCodexProbe(text);
  assert.ok(problems.length > 0, `應該失敗：${text}`);
  if (pattern)
    assert.ok(
      problems.some((p) => pattern.test(p)),
      problems.join('\n'),
    );
};

test('違規片段都會失敗', () => {
  // 常數改成非互動子指令。
  fails(real.replace("['debug', 'models', '--bundled']", "['exec', '--json']"), /不在允許清單/);
  // 新增一個沒審查的常數。
  fails(`${real}\nconst CODEX_EXTRA_ARGS = ['review'];\n`, /不在允許清單/);
  // execFileAsync 帶字面以外的參數、或不在白名單的字面陣列。
  fails(`${real}\nexecFileAsync(codexBin, userArgs, {});\n`, /不是允許的字面陣列/);
  fails(`${real}\nexecFileAsync(codexBin, ['exec', 'hi'], {});\n`, /不是允許的字面陣列/);
  // runCodexProbe 傳任意變數。
  fails(`${real}\nrunCodexProbe(codexBin, ['exec'], {});\n`, /只能傳 CODEX_\*ARGS/);
  fails(`${real}\nrunCodexProbe(codexBin, userArgs, {});\n`, /只能傳 CODEX_\*ARGS/);
  // 迴圈清單混進別的東西。
  fails(
    real.replace(
      'for (const args of [CODEX_CATALOG_ARGS, CODEX_BUNDLED_CATALOG_ARGS])',
      "for (const args of [CODEX_CATALOG_ARGS, ['exec']])",
    ),
    /參數清單只能放/,
  );
  // 多一個 spawn，或用其他方式執行 codexBin。
  fails(`${real}\nspawn(codexBin, ['exec'], {});\n`, /spawn\(codexBin/);
  fails(`${real}\nspawnSync(codexBin, ['debug', 'models']);\n`, /只能經/);
  fails(`${real}\nexecFile(codexBin, ['debug', 'models']);\n`, /只能經/);
});

test('其他檔案呼叫 runCodexProbe：失敗', () => {
  assert.deepEqual(checkCodexProbeCallers([{ path: CODEX_PROBE_FILE, text: real }]), []);
  assert.equal(
    checkCodexProbeCallers([
      { path: 'packages/daemon/src/daemon.ts', text: "runCodexProbe(bin, ['exec'], {})" },
    ]).length,
    1,
  );
});
