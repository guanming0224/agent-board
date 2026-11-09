// 本機保存 daemon 重啟後要接回的 session（CONTRACTS §3.2）。不含 token 與終端機內容。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Id, IsoTime, SessionRuntime, SessionSpec } from '@agent-board/protocol';
import { z } from 'zod';
import { errorMessage, log } from './log';

export const PersistedSession = z.object({
  sessionId: Id,
  spec: SessionSpec,
  /** CLI 的對話 id。Codex 新開、SessionStart 還沒回報 thread id 前是 null（§19）。 */
  claudeSessionId: z.string().min(1).nullable(),
  cwd: z.string().min(1),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  /** 還沒送進 PTY 的 firstPrompt；送出後清掉，重啟才不會再送一次。 */
  pendingFirstPrompt: z.string().nullable(),
  createdAt: IsoTime,
});
export type PersistedSession = z.infer<typeof PersistedSession>;

const PersistedState = z.object({
  version: z.literal(1),
  /** 上次 hub.welcome 下發的值，hub 連不上時危險指令比對仍照這份。 */
  dangerRules: z.array(z.string()).nullable(),
  stuckMinutes: z.number().int().positive().nullable(),
  /**
   * 上次 hub.welcome 的 `dispatch`：daemon 重啟、hub 還沒連上時接回的 session 要不要掛派工工具。
   * 預設和 hub 的 Settings.dispatch 一樣是開：舊版 daemon 的檔案沒有這個欄位，預設關的話升級後
   * 第一次接回的 session 全都不會掛上（2026-11-06 上架時遇到）。
   */
  dispatch: z.boolean().default(true),
  /**
   * 上次 hub.welcome 的 `memory`（進度卡工具，P3 項目一）。和 dispatch 不同，預設關：只有 hub 明確送過
   * `memory: true` 才當開。新 daemon 搭舊 hub 時，舊 hub 不認得進度卡工具、會直接丟掉呼叫（Claude 要等逾時）；
   * 代價是 daemon 第一次升級、還沒收到新 hub 的 welcome 前接回的 session 不掛進度卡工具（下次開或重啟就有）。
   */
  memory: z.boolean().default(false),
  sessions: z.array(PersistedSession),
  /** 已結束但結果還沒送到 hub 的 session。hello 只列活著的，hub 只能靠這個知道結果。 */
  endedRuntimes: z.array(SessionRuntime).default([]),
  /**
   * 這台開過 session 的帳號設定目錄（CLAUDE_CONFIG_DIR，非預設的那些）。深層搜尋只讀這些目錄底下的對話紀錄
   * （P3 ③b）：session 結束、daemon 重啟後還認得。舊檔沒有這個欄位：升級後開過的才算。
   */
  accountProfiles: z.array(z.string()).default([]),
});
type PersistedState = z.infer<typeof PersistedState>;

export class SessionStore {
  private readonly file: string;
  private state: PersistedState = {
    version: 1,
    dangerRules: null,
    stuckMinutes: null,
    dispatch: true,
    memory: false,
    sessions: [],
    endedRuntimes: [],
    accountProfiles: [],
  };

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'sessions.json');
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return; // 第一次啟動
    }
    try {
      this.state = PersistedState.parse(JSON.parse(raw));
    } catch (error) {
      // 壞檔留著給人查，不覆蓋；daemon 仍要能啟動。
      const aside = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, aside);
      log.error(`sessions.json 無法解析，已移到 ${aside}：${errorMessage(error)}`);
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      // 磁碟滿之類：正在跑的 session 不該受影響，只是重啟後可能接不回最新狀態。
      log.error(`無法寫入 sessions.json：${errorMessage(error)}`);
    }
  }

  get sessions(): readonly PersistedSession[] {
    return this.state.sessions;
  }

  get dangerRules(): string[] | null {
    return this.state.dangerRules;
  }

  get stuckMinutes(): number | null {
    return this.state.stuckMinutes;
  }

  get dispatch(): boolean {
    return this.state.dispatch;
  }

  get memory(): boolean {
    return this.state.memory;
  }

  setHubSettings(
    dangerRules: string[],
    stuckMinutes: number,
    dispatch: boolean,
    memory: boolean,
  ): void {
    this.state.dangerRules = dangerRules;
    this.state.stuckMinutes = stuckMinutes;
    this.state.dispatch = dispatch;
    this.state.memory = memory;
    this.save();
  }

  get accountProfiles(): readonly string[] {
    return this.state.accountProfiles;
  }

  /** 記下開過 session 的帳號設定目錄（已記過就不寫檔）。 */
  rememberAccountProfile(profile: string): void {
    if (this.state.accountProfiles.includes(profile)) return;
    this.state.accountProfiles = [...this.state.accountProfiles, profile];
    this.save();
  }

  get endedRuntimes(): readonly SessionRuntime[] {
    return this.state.endedRuntimes;
  }

  isCurrentEnded(runtime: SessionRuntime): boolean {
    return this.state.endedRuntimes.includes(runtime);
  }

  setEnded(runtime: SessionRuntime): void {
    const rest = this.state.endedRuntimes.filter((r) => r.id !== runtime.id);
    this.state.endedRuntimes = [...rest, runtime];
    this.save();
  }

  removeEnded(sessionId: string): void {
    const rest = this.state.endedRuntimes.filter((r) => r.id !== sessionId);
    if (rest.length === this.state.endedRuntimes.length) return;
    this.state.endedRuntimes = rest;
    this.save();
  }

  upsert(session: PersistedSession): void {
    const rest = this.state.sessions.filter((s) => s.sessionId !== session.sessionId);
    this.state.sessions = [...rest, session];
    this.save();
  }

  patch(sessionId: string, patch: Partial<PersistedSession>): void {
    const current = this.state.sessions.find((s) => s.sessionId === sessionId);
    if (!current) return;
    this.upsert({ ...current, ...patch });
  }

  remove(sessionId: string): void {
    this.state.sessions = this.state.sessions.filter((s) => s.sessionId !== sessionId);
    this.save();
  }
}
