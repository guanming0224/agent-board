// 把 xterm 與資料流接起來。React 的部分在 TerminalView.tsx。
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TerminalMaskGate, useMaskMode } from '../security';
import type { TerminalStream } from '../shared/terminal-contract';
import { TerminalFeed, type TerminalSizeMessage, type TerminalSnapshotMessage } from './feed';
import { ImeInputGuard, classifyKey, isOpenableLink } from './input';
import { ResizeGate, SizeOwnership, debounce, followScale, type SizeOwner } from './resize';
import { webglBudget, type WebglBudget, type WebglClient } from './webglBudget';

const RESIZE_DEBOUNCE_MS = 100;
const FONT_SIZE = 13;
/** xterm 預設的捲動保留行數；全尺寸終端機頁用這個。 */
export const DEFAULT_SCROLLBACK = 1000;

export interface TerminalOptions {
  /** 捲動保留行數（畫布小卡用比較少）。 */
  scrollback?: number;
  /** 要不要用 WebGL（預設 true）；畫布卡一律 false，只有全尺寸頁用。 */
  webgl?: boolean;
  /** WebGL 配額；預設全頁共用的那一份。 */
  budget?: WebglBudget;
}

const terminals = new WeakMap<HTMLElement, Terminal>();

/** 只給 E2E 測試頁讀 buffer（WebGL 畫的內容從 DOM 讀不到）。 */
export const terminalForTest = (container: HTMLElement) => terminals.get(container);

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

function openLink(uri: string): void {
  if (isOpenableLink(uri)) window.open(uri, '_blank', 'noopener');
}

export class TerminalController implements WebglClient {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly feed: TerminalFeed;
  private readonly gate = new ResizeGate();
  /** 尺寸擁有權（CONTRACTS §6.1 第 6 點）：別人擁有時照遠端尺寸顯示，不送 resize。 */
  private readonly size = new SizeOwnership();
  private readonly ime = new ImeInputGuard();
  private readonly resizeDebounce = debounce(() => this.fitAndReport(), RESIZE_DEBOUNCE_MS);
  private readonly observer = new ResizeObserver(() => this.resizeDebounce.call());
  private readonly listeners = new AbortController();
  /** 遮蔽要在寫進 xterm 之前做：畫面裡不能疊任何東西（STYLE 規則三之一）。 */
  private readonly mask = new TerminalMaskGate(
    (data) => this.term.write(data),
    () => useMaskMode.getState().masking,
  );
  private readonly unsubscribeMask: () => void;
  private webgl: WebglAddon | null = null;
  /** WebGL addon 建的 canvas；收回時要主動釋放 context，不能等 GC（否則很快撞到一頁 16 個的上限）。 */
  private webglCanvases: HTMLCanvasElement[] = [];
  private readonly budget: WebglBudget;
  private hasFocus = false;
  private preferWebgl: boolean;
  private broken = false;
  /** 正在還原的快照數；xterm 的 write 是非同步的，還原完才能 fit。 */
  private restoring = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly sessionId: string,
    private readonly stream: TerminalStream,
    private shown: boolean,
    private readonly onSizeOwner: (owner: SizeOwner | null) => void = () => {},
    options: TerminalOptions = {},
  ) {
    this.budget = options.budget ?? webglBudget;
    this.preferWebgl = options.webgl ?? true;
    // 16 色 ANSI 不設定，用 xterm 預設（STYLE 規則三之一）。
    this.term = new Terminal({
      fontFamily: cssVar('--font-mono'),
      fontSize: FONT_SIZE,
      theme: { background: cssVar('--term-bg') },
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      // OSC 8 連結；不設定的話 xterm 會跳原生 confirm。
      linkHandler: { activate: (_event, uri) => openLink(uri) },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    this.term.open(container);
    terminals.set(container, this.term);
    // 先用 DOM renderer；要不要 WebGL 由全頁的配額決定（webglBudget.ts）。
    container.dataset.renderer = 'dom';

    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.term.onData((data) => this.handleData(data));
    this.term.onBinary((data) => {
      this.claimSize();
      this.sendInput(data);
    });
    this.listenComposition();
    // 點進這個終端機就是要在這裡操作：搶下尺寸。程式自動 focus（放大、全尺寸頁）不算。
    container.addEventListener('pointerdown', () => this.claimSize(), {
      capture: true,
      signal: this.listeners.signal,
    });

    this.listenFocus();

    this.observer.observe(container);
    if (shown) this.fitLocally();

    this.feed = new TerminalFeed(
      stream,
      sessionId,
      {
        snapshot: (message) => this.applySnapshot(message),
        output: (data) => this.mask.output(data),
        size: (message) => this.applySize(message),
      },
      shown,
    );
    this.feed.start();
    // 切換時已經畫上去的內容要換掉，重拿一次快照最直接。
    this.unsubscribeMask = useMaskMode.subscribe((state, previous) => {
      if (state.masking !== previous.masking) this.feed.resync();
    });
    this.budget.register(this);
  }

  get visible(): boolean {
    return this.shown;
  }

  get focused(): boolean {
    // focusout 不一定會來（textarea 被藏起來或拆下），以目前焦點實際所在為準。
    return !this.disposed && this.container.contains(document.activeElement);
  }

  get webglPreferred(): boolean {
    return this.preferWebgl;
  }

  setWebglPreferred(preferred: boolean): void {
    if (preferred === this.preferWebgl) return;
    this.preferWebgl = preferred;
    this.budget.changed(this, preferred);
  }

  get webglBroken(): boolean {
    return this.broken;
  }

  setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.feed.setVisible(visible);
    this.budget.changed(this, visible);
    if (visible) this.fitAndReport();
  }

  focus(): void {
    this.term.focus();
  }

  /** 改捲動保留行數。變多時重拿快照，已經被截掉的歷史才補得回來（例如小卡展開）。 */
  /**
   * 改捲動保留行數（小卡展開時 300 → 1000）。不重拿快照：重拿會 reset 再重排、跳到最底，
   * 展開時的畫面會閃；之後的輸出照新的行數保留。
   */
  setScrollback(lines: number): void {
    if (this.disposed || lines === this.term.options.scrollback) return;
    this.term.options.scrollback = lines;
  }

  dispose(): void {
    this.disposed = true;
    // 先交還 WebGL（釋放 context），別的終端機才能遞補。
    this.budget.unregister(this);
    this.dropWebgl();
    this.unsubscribeMask();
    this.mask.dispose();
    this.feed.stop();
    this.resizeDebounce.cancel();
    this.observer.disconnect();
    this.listeners.abort();
    terminals.delete(this.container);
    this.term.dispose();
  }

  /** 配額分到了：載入 WebGL addon。回傳持有 context 的物件，配額管理用來數 context 何時被回收。 */
  grantWebgl(): readonly object[] {
    if (this.disposed || this.broken || this.webgl) return [];
    const before = new Set(this.container.querySelectorAll('canvas'));
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => this.loseWebgl());
      this.term.loadAddon(addon);
      this.webgl = addon;
      this.webglCanvases = [...this.container.querySelectorAll('canvas')].filter(
        (canvas) => !before.has(canvas),
      );
      this.container.dataset.renderer = 'webgl';
      // 換 renderer 後字元格尺寸可能差一點，重新 fit 一次（有 debounce，同尺寸不會重送）。
      this.resizeDebounce.call();
      // 一個 addon 一個 WebGL context（另一個 canvas 是 2D 的），回收以 addon 為準。
      return [addon];
    } catch {
      // 不支援 WebGL2：維持 xterm 預設的 DOM renderer，之後也不再試。
      this.broken = true;
      this.container.dataset.renderer = 'dom';
      return [];
    }
  }

  /** 配額收回：退回 DOM renderer。 */
  revokeWebgl(): void {
    this.dropWebgl();
  }

  private listenFocus(): void {
    const options = { signal: this.listeners.signal };
    // addon 內建要等 3 秒看 context 會不會回來，這段時間是黑屏，所以一失去就立刻退回。
    this.container.addEventListener('webglcontextlost', () => this.loseWebgl(), {
      capture: true,
      signal: this.listeners.signal,
    });
    // 聚焦中的終端機優先拿 WebGL。
    this.container.addEventListener('focusin', () => this.setFocus(true), options);
    this.container.addEventListener('focusout', () => this.setFocus(false), options);
  }

  private setFocus(focused: boolean): void {
    if (focused === this.hasFocus) return;
    this.hasFocus = focused;
    this.budget.changed(this, focused);
  }

  /** context 被瀏覽器收走（GPU 重置等）：退回 DOM，這個終端機之後不再用 WebGL。 */
  private loseWebgl(): void {
    if (!this.webgl) return;
    this.broken = true;
    this.dropWebgl();
    this.budget.changed(this);
  }

  private dropWebgl(): void {
    const addon = this.webgl;
    if (!addon) return;
    this.webgl = null;
    const canvases = this.webglCanvases;
    this.webglCanvases = [];
    this.container.dataset.renderer = 'dom';
    addon.dispose();
    // addon 的 dispose 不會釋放 context，要等 GC；主動釋放，context 數才不會一路累積。
    // 這些 canvas 已經有 webgl2 context，getContext 只是拿回同一個，不會新建。
    for (const canvas of canvases) {
      try {
        const gl = canvas.getContext('webgl2');
        if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        // 已經失去或拿不到：沒有要釋放的。
      }
    }
    if (!this.disposed) {
      this.term.refresh(0, this.term.rows - 1);
      this.resizeDebounce.call();
    }
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
    if (!data || !this.ime.accept(data, performance.now())) return;
    this.claimSize();
    this.sendInput(data);
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
    this.term.write(this.mask.snapshot(message.data), () => {
      this.restoring -= 1;
      this.fitAndReport();
    });
  }

  /** hub 告訴我們 PTY 目前的尺寸與擁有者。 */
  private applySize(message: TerminalSizeMessage): void {
    this.size.update(message.owner, message.cols, message.rows);
    // 這是 PTY 的實際尺寸：自己 fit 出來不一樣才需要送。還沒人擁有時一定送一次，
    // 否則尺寸剛好相同的第一個人永遠不會成為擁有者，後來的人反而搶走。
    if (message.owner === 'none') this.gate.reset();
    else this.gate.sync(message.cols, message.rows);
    this.container.dataset.sizeOwner = message.owner;
    this.onSizeOwner(message.owner);
    this.fitAndReport();
  }

  /** 使用者在這個終端機打字或點擊：尺寸屬於別人時搶過來，改用自己的畫面大小。 */
  private claimSize(): void {
    if (this.disposed || !this.size.claim()) return;
    this.container.dataset.sizeOwner = 'you';
    this.onSizeOwner('you');
    this.unfollow();
    if (this.shown && this.restoring === 0) this.fitLocally();
    const { cols, rows } = this.term;
    this.gate.sync(cols, rows);
    this.stream.send({
      type: 'terminal.resize',
      sessionId: this.sessionId,
      cols,
      rows,
      claim: true,
    });
  }

  /** 尺寸屬於別人：xterm 用遠端的 cols/rows（輸出是照它排版的），等比縮小放進容器，比較小就留白。 */
  private follow(cols: number, rows: number): void {
    if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
    this.scaleToFit();
    // renderer 可能下一個 frame 才更新畫面尺寸，再量一次。
    requestAnimationFrame(() => {
      if (!this.disposed && this.size.following) this.scaleToFit();
    });
  }

  private scaleToFit(): void {
    const element = this.term.element;
    const screen = element?.querySelector<HTMLElement>('.xterm-screen');
    if (!element || !screen) return;
    const natural = { width: screen.offsetWidth, height: screen.offsetHeight };
    const scale = followScale(natural, {
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    });
    element.style.width = `${natural.width}px`;
    element.style.height = `${natural.height}px`;
    element.style.transformOrigin = '0 0';
    element.style.transform = `scale(${scale})`;
    this.container.dataset.followScale = scale.toFixed(3);
  }

  private unfollow(): void {
    const element = this.term.element;
    if (!element || this.container.dataset.followScale === undefined) return;
    element.style.width = '';
    element.style.height = '';
    element.style.transformOrigin = '';
    element.style.transform = '';
    delete this.container.dataset.followScale;
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
    if (this.disposed || !this.shown || this.restoring > 0) return;
    const remote = this.size.remote;
    if (this.size.following && remote) {
      this.follow(remote.cols, remote.rows);
      return;
    }
    this.unfollow();
    if (!this.fitLocally()) return;
    const { cols, rows } = this.term;
    if (this.gate.shouldSend(cols, rows)) {
      this.stream.send({ type: 'terminal.resize', sessionId: this.sessionId, cols, rows });
    }
  }
}
