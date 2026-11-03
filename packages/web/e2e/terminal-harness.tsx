// E2E 專用：只載入 TerminalView + FakeTerminalStream。
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FakeTerminalStream } from '../src/shared/fakeBackend';
import '../src/shared/styles/tokens.css';
import type { TerminalServerMessage, TerminalStream } from '../src/shared/terminal-contract';
import { TerminalView } from '../src/terminal';
import { terminalForTest } from '../src/terminal/controller';

const SESSION = 'e2e';

type Sent = Parameters<TerminalStream['send']>[0];

class HarnessStream extends FakeTerminalStream {
  sent: Sent[] = [];
  subscribes = 0;
  dropNextOutput = false;
  /** 假 PTY 不送 terminal.size；測試用這個模擬 hub 告知尺寸擁有者。 */
  latest: ((m: TerminalServerMessage) => void) | null = null;

  override subscribe(sessionId: string, onMessage: (m: TerminalServerMessage) => void) {
    this.subscribes += 1;
    this.latest = onMessage;
    return super.subscribe(sessionId, (message) => {
      if (this.dropNextOutput && message.type === 'terminal.output') {
        this.dropNextOutput = false;
        return;
      }
      onMessage(message);
    });
  }

  override send(message: Sent): void {
    this.sent.push(message);
    super.send(message);
  }
}

const stream = new HarnessStream();

/** TerminalView 已經套用的 visible；React 的 state 更新與 effect 都是非同步的，測試要等這個。 */
let appliedVisible: boolean | null = null;

const container = () => document.querySelector<HTMLElement>('[data-terminal-session]')!;
const term = () => terminalForTest(container())!;

const api = {
  emit: (data: string) => stream.emit(SESSION, data),
  /** 下一筆 output 不送到 TerminalView，製造跳號。 */
  dropNextOutput: () => {
    stream.dropNextOutput = true;
  },
  inputs: () => stream.sent.flatMap((m) => (m.type === 'terminal.input' ? [m.data] : [])),
  resizes: () =>
    stream.sent.flatMap((m) =>
      m.type === 'terminal.resize' ? [{ cols: m.cols, rows: m.rows }] : [],
    ),
  /** 送出的訊息種類照順序，claim 的 resize 記成 claim。 */
  sentKinds: () =>
    stream.sent.map((m) =>
      m.type === 'terminal.resize' && m.claim ? 'claim' : m.type.replace('terminal.', ''),
    ),
  sizeMessage: (owner: 'you' | 'other' | 'none', cols: number, rows: number) =>
    stream.latest?.({ type: 'terminal.size', sessionId: SESSION, cols, rows, owner }),
  sizeOwner: () => container().dataset.sizeOwner,
  followScale: () => container().dataset.followScale,
  clearSent: () => {
    stream.sent = [];
  },
  subscribes: () => stream.subscribes,
  renderer: () => container().dataset.renderer,
  focusIsInTerminal: () => document.activeElement === term().textarea,
  size: () => ({ cols: term().cols, rows: term().rows }),
  background: () => term().options.theme?.background,
  lines: () => {
    const buffer = term().buffer.active;
    return Array.from(
      { length: buffer.length },
      (_, i) => buffer.getLine(i)?.translateToString(true) ?? '',
    );
  },
  /** 找到含 text 的那一行，回傳第一個字的 cell 顏色。 */
  colorOf: (text: string) => {
    const buffer = term().buffer.active;
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      const x = line?.translateToString(true).indexOf(text) ?? -1;
      if (line && x >= 0) {
        const cell = line.getCell(x)!;
        return { palette: cell.isFgPalette(), color: cell.getFgColor() };
      }
    }
    return null;
  },
  /** text 第二個字元在畫面上的座標。 */
  pointOf: (text: string) => {
    const t = term();
    const buffer = t.buffer.active;
    const box = container().querySelector('.xterm-screen')!.getBoundingClientRect();
    for (let y = 0; y < buffer.length; y += 1) {
      const x = buffer.getLine(y)?.translateToString(true).indexOf(text) ?? -1;
      if (x >= 0) {
        return {
          x: box.x + ((x + 1.5) * box.width) / t.cols,
          y: box.y + ((y - buffer.viewportY + 0.5) * box.height) / t.rows,
        };
      }
    }
    return null;
  },
  selectAll: () => term().selectAll(),
  visibleApplied: () => appliedVisible,
  setVisible: (_visible: boolean) => {},
  setFrame: (_width: number, _height: number) => {},
};

export type HarnessApi = typeof api;

declare global {
  interface Window {
    __harness: HarnessApi;
  }
}

function Harness() {
  const params = new URLSearchParams(location.search);
  const [visible, setVisible] = useState(params.get('visible') !== '0');
  const [frame, setFrame] = useState({ width: 800, height: 400 });

  useEffect(() => {
    window.__harness = {
      ...api,
      setVisible,
      setFrame: (width, height) => setFrame({ width, height }),
    };
  }, []);

  // 同一次 commit 裡子元件的 effect 先跑，所以這裡執行時 TerminalView 已經收到新的 visible。
  useEffect(() => {
    appliedVisible = visible;
  }, [visible]);

  return (
    // 看不見時用 display:none 模擬畫面外的卡片，開啟時量不到字元尺寸是最嚴苛的情況
    <div style={{ ...frame, display: visible ? 'block' : 'none' }}>
      <TerminalView sessionId={SESSION} stream={stream} visible={visible} autoFocus />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
