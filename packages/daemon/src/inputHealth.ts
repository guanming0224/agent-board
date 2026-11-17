// 偵測「session host 的輸入可能失效」（事故 9，CONTRACTS §20.8）：daemon 把使用者打的字寫給 Claude session，
// 一段時間內那個 PTY 完全沒有任何輸出（連回顯都沒有），而且連續發生，就判定可疑。
//
// 為什麼可以這樣判斷：Claude Code 在等輸入（輸入框看得到）時，打一個可見的字一定會重畫輸入框（終端機上看得到字），
// 所以一定有輸出。只算「可見的字」：方向鍵、Esc、退格、滑鼠、焦點事件、終端機查詢的回覆在空的輸入框上可能沒有輸出。
// 誤判控制：
// - 只算 host 模式、Claude、狀態是 waiting_input 而且輸入框看得到的 session（呼叫端判斷 eligible）；
// - 同一個 session 在等回顯時再打字不重複算；
// - 要「跨 2 個 session 各 1 次」或「同一個 session 3 次」，而且中間任何一個 session 的輸入有回顯就全部歸零；
// - 只看最近 10 分鐘內的。
// 一旦有輸入得到回顯，就解除可疑。

export const INPUT_ECHO_WINDOW_MS = 5_000;
export const INPUT_STRIKE_TTL_MS = 10 * 60_000;
/** 跨幾個 session 各沒回顯一次就算可疑。 */
export const INPUT_SUSPECT_SESSIONS = 2;
/** 同一個 session 沒回顯幾次就算可疑（只開一個 session 的人也偵測得到）。 */
export const INPUT_SUSPECT_SAME_SESSION = 3;

/**
 * 這段輸入裡有沒有可見的字（會讓輸入框重畫的）。去掉 CSI／SS3／OSC／DCS、X10 滑鼠（ESC [ M ＋3 bytes）、
 * 其他 ESC 開頭的雙字元序列與控制字元，剩下還有字就算。
 */
export function hasVisibleText(data: string): boolean {
  const stripped = data
    // X10 滑鼠：ESC [ M 後面固定 3 個字（可能是任何值）
    .replace(/\x1b\[M[\s\S]{0,3}/g, '')
    // OSC／DCS／APC／PM／SOS：到 BEL 或 ST 為止
    .replace(/\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    // CSI（含 SGR 滑鼠、焦點、方向鍵、終端機回覆、括號貼上的起訖記號）
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // SS3（應用模式的方向鍵等）
    .replace(/\x1bO[\s\S]?/g, '')
    // 其他 ESC＋一個字（Alt＋字、單獨的 Esc）
    .replace(/\x1b[\s\S]?/g, '')
    // 控制字元（Enter、Tab、退格、Ctrl 組合鍵）與 DEL
    .replace(/[\x00-\x1f\x7f]/g, '');
  return stripped.trim().length > 0;
}

export interface InputHealthOptions {
  windowMs?: number;
  strikeTtlMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 判定可疑（只在由正常轉可疑時呼叫一次）。 */
  onSuspect: () => void;
  /** 有輸入得到回顯，解除可疑。 */
  onRecover: () => void;
}

interface Strike {
  sessionId: string;
  at: number;
}

export class InputHealthMonitor {
  private readonly waiting = new Map<string, unknown>();
  private strikes: Strike[] = [];
  private suspectFlag = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: InputHealthOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return timer;
      });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  get suspect(): boolean {
    return this.suspectFlag;
  }

  /** daemon 把輸入寫給 session 之後呼叫。eligible：host 模式、Claude、waiting_input、輸入框看得到。 */
  onInput(sessionId: string, data: string, eligible: boolean): void {
    if (!eligible || this.waiting.has(sessionId) || !hasVisibleText(data)) return;
    const timer = this.setTimer(
      () => this.expire(sessionId),
      this.options.windowMs ?? INPUT_ECHO_WINDOW_MS,
    );
    this.waiting.set(sessionId, timer);
  }

  /** session 有任何輸出。 */
  onOutput(sessionId: string): void {
    const timer = this.waiting.get(sessionId);
    if (timer === undefined) return;
    this.clearTimer(timer);
    this.waiting.delete(sessionId);
    // 有輸入得到回顯：host 的寫入是通的。
    this.strikes = [];
    if (this.suspectFlag) {
      this.suspectFlag = false;
      this.options.onRecover();
    }
  }

  /** session 結束、被移除：不再等它。 */
  forget(sessionId: string): void {
    const timer = this.waiting.get(sessionId);
    if (timer !== undefined) this.clearTimer(timer);
    this.waiting.delete(sessionId);
  }

  /** host 換了（重啟、重連、退回舊模式）：從頭算，可疑狀態也解除（呼叫端自己回報）。 */
  reset(): void {
    for (const timer of this.waiting.values()) this.clearTimer(timer);
    this.waiting.clear();
    this.strikes = [];
    this.suspectFlag = false;
  }

  private expire(sessionId: string): void {
    if (!this.waiting.delete(sessionId)) return;
    const now = this.now();
    const ttl = this.options.strikeTtlMs ?? INPUT_STRIKE_TTL_MS;
    this.strikes = this.strikes.filter((s) => now - s.at < ttl);
    this.strikes.push({ sessionId, at: now });
    const sessions = new Set(this.strikes.map((s) => s.sessionId));
    const sameSession = this.strikes.filter((s) => s.sessionId === sessionId).length;
    if (
      !this.suspectFlag &&
      (sessions.size >= INPUT_SUSPECT_SESSIONS || sameSession >= INPUT_SUSPECT_SAME_SESSION)
    ) {
      this.suspectFlag = true;
      this.options.onSuspect();
    }
  }
}
