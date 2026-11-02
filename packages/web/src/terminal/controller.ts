// 把 xterm 與資料流接起來。React 的部分在 TerminalView.tsx。
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalStream } from '../shared/terminal-contract';
import { TerminalFeed, type TerminalSnapshotMessage } from './feed';
import { ImeInputGuard, classifyKey, isOpenableLink } from './input';
import { ResizeGate, debounce } from './resize';

const RESIZE_DEBOUNCE_MS = 100;
const FONT_SIZE = 13;

const terminals = new WeakMap<HTMLElement, Terminal>();

/** 只給 E2E 測試頁讀 buffer（WebGL 畫的內容從 DOM 讀不到）。 */
export const terminalForTest = (container: HTMLElement) => terminals.get(container);

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

function openLink(uri: string): void {
  if (isOpenableLink(uri)) window.open(uri, '_blank', 'noopener');
}

export class TerminalController {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly feed: TerminalFeed;
  private readonly gate = new ResizeGate();
  private readonly ime = new ImeInputGuard();
  private readonly resizeDebounce = debounce(() => this.fitAndReport(), RESIZE_DEBOUNCE_MS);
  private readonly observer = new ResizeObserver(() => this.resizeDebounce.call());
  private readonly listeners = new AbortController();
  private webgl: WebglAddon | null = null;
  /** 正在還原的快照數；xterm 的 write 是非同步的，還原完才能 fit。 */
  private restoring = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly sessionId: string,
    private readonly stream: TerminalStream,
    private visible: boolean,
  ) {
    // 16 色 ANSI 不設定，用 xterm 預設（STYLE 規則三之一）。
    this.term = new Terminal({
      fontFamily: cssVar('--font-mono'),
      fontSize: FONT_SIZE,
      theme: { background: cssVar('--term-bg') },
      // OSC 8 連結；不設定的話 xterm 會跳原生 confirm。
      linkHandler: { activate: (_event, uri) => openLink(uri) },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    this.term.open(container);
    terminals.set(container, this.term);
    this.loadWebgl();

    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.term.onData((data) => this.handleData(data));
    this.term.onBinary((data) => this.sendInput(data));
    this.listenComposition();

    this.observer.observe(container);
    if (visible) this.fitLocally();

    this.feed = new TerminalFeed(
      stream,
      sessionId,
      {
        snapshot: (message) => this.applySnapshot(message),
        output: (data) => this.term.write(data),
      },
      visible,
    );
    this.feed.start();
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.feed.setVisible(visible);
    if (visible) this.fitAndReport();
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.feed.stop();
    this.resizeDebounce.cancel();
    this.observer.disconnect();
    this.listeners.abort();
    this.term.dispose();
  }

  private loadWebgl(): void {
    this.container.dataset.renderer = 'dom';
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => this.dropWebgl());
      this.term.loadAddon(addon);
      this.webgl = addon;
      this.container.dataset.renderer = 'webgl';
      // addon 內建要等 3 秒看 context 會不會回來，這段時間是黑屏，所以一失去就立刻退回。
      this.container.addEventListener('webglcontextlost', () => this.dropWebgl(), {
        capture: true,
        signal: this.listeners.signal,
      });
    } catch {
      // 不支援 WebGL2：維持 xterm 預設的 DOM renderer。
    }
  }

  private dropWebgl(): void {
    const addon = this.webgl;
    if (!addon) return;
    this.webgl = null;
    this.container.dataset.renderer = 'dom';
    addon.dispose();
    this.term.refresh(0, this.term.rows - 1);
  }

  private listenComposition(): void {
    const options = { capture: true, signal: this.listeners.signal };
    this.container.addEventListener('compositionstart', () => this.ime.compositionStart(), options);
    this.container.addEventListener(
      'compositionend',
      () => this.ime.compositionEnd(performance.now()),
      options,
    );
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type === 'keydown') this.ime.keyDown(event.keyCode);
    const action = classifyKey(event, isMac());
    if (action === 'copy' && event.type === 'keydown') {
      event.preventDefault();
      // navigator.clipboard 只有安全來源能用，走 Tailscale 的 http 不一定有。xterm 會接 copy 事件。
      document.execCommand('copy');
    }
    return action === 'terminal';
  }

  private handleData(data: string): void {
    if (data && this.ime.accept(data, performance.now())) this.sendInput(data);
  }

  private sendInput(data: string): void {
    this.stream.send({ type: 'terminal.input', sessionId: this.sessionId, data });
  }

  /** 快照是照 PTY 的尺寸序列化的，先用同尺寸還原再 fit，內容才不會折行錯位。 */
  private applySnapshot(message: TerminalSnapshotMessage): void {
    this.term.reset();
    this.term.resize(message.cols, message.rows);
    this.gate.sync(message.cols, message.rows);
    this.restoring += 1;
    this.term.write(message.data, () => {
      this.restoring -= 1;
      this.fitAndReport();
    });
  }

  private fitLocally(): boolean {
    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) return false;
    if (!this.fit.proposeDimensions()) {
      // 開啟時容器不可見，字元尺寸量不到；同尺寸的 resize 會讓 xterm 重量一次。
      this.term.resize(this.term.cols, this.term.rows);
      if (!this.fit.proposeDimensions()) return false;
    }
    this.fit.fit();
    return true;
  }

  private fitAndReport(): void {
    if (this.disposed || !this.visible || this.restoring > 0 || !this.fitLocally()) return;
    const { cols, rows } = this.term;
    if (this.gate.shouldSend(cols, rows)) {
      this.stream.send({ type: 'terminal.resize', sessionId: this.sessionId, cols, rows });
    }
  }
}
