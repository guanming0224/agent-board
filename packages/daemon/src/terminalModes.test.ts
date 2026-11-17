// 快照要帶滑鼠編碼（?1006h）：不然網頁 reset 後寫快照，滑鼠碼會用 X10 送出（Claude Code 要 SGR）。
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { mouseEncodingSequence, serializeSnapshot } from './terminalModes';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } =
  require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

type HeadlessTerminal = InstanceType<typeof Terminal>;

const write = (term: HeadlessTerminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

function headless() {
  const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}

describe('快照的滑鼠編碼', () => {
  it('Claude 開了 ?1003h＋?1006h：從快照還原的終端機是 any＋SGR', async () => {
    const source = headless();
    await write(source.term, '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006hhello');
    const data = serializeSnapshot(source.term, source.serializer, 100);
    const restored = headless();
    await write(restored.term, data);
    expect(restored.term.modes.mouseTrackingMode).toBe('any');
    expect(mouseEncodingSequence(restored.term)).toBe('\x1b[?1006h');
  });

  it('關掉 SGR（?1006l）後不再帶；預設編碼不帶任何序列', async () => {
    const { term, serializer } = headless();
    await write(term, '\x1b[?1006h\x1b[?1006l');
    expect(mouseEncodingSequence(term)).toBe('');
    expect(serializeSnapshot(term, serializer, 100)).not.toContain('\x1b[?1006h');
  });

  it('SGR 像素（?1016h）也帶上', async () => {
    const { term } = headless();
    await write(term, '\x1b[?1016h');
    expect(mouseEncodingSequence(term)).toBe('\x1b[?1016h');
  });
});
