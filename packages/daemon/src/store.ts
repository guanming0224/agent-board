// 本機保存 daemon 重啟後要接回的 session（CONTRACTS §3.2）。不含 token 與終端機內容。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Id, IsoTime, SessionSpec } from '@agent-board/protocol';
import { z } from 'zod';
import { errorMessage, log } from './log';

export const PersistedSession = z.object({
  sessionId: Id,
  spec: SessionSpec,
  claudeSessionId: z.string().min(1),
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
  sessions: z.array(PersistedSession),
});
type PersistedState = z.infer<typeof PersistedState>;

export class SessionStore {
  private readonly file: string;
  private state: PersistedState = {
    version: 1,
    dangerRules: null,
    stuckMinutes: null,
    sessions: [],
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

  setHubSettings(dangerRules: string[], stuckMinutes: number): void {
    this.state.dangerRules = dangerRules;
    this.state.stuckMinutes = stuckMinutes;
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
