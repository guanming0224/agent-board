// daemon ↔ session host 的本機協定（docs/session-host-spec.md §3.2、CONTRACTS §20）。
// 一行一則 JSON（NDJSON）。輸出資料用 base64（原始位元組，序號以位元組計）。
// session host 不懂 claude／codex、不解析畫面、不連網路、不呼叫 LLM。
import { z } from 'zod';

/** 協定版本。不相容的改動才加一；daemon 看到不同的值就退回自己開 PTY 的舊模式。 */
export const SESSION_HOST_PROTOCOL = 1;
/** 每個 session 保留的原始輸出上限（GM 2026-11-10：2 MB，只在記憶體）。 */
export const SESSION_HOST_BUFFER_BYTES = 2 * 1024 * 1024;
/** Unix socket 與 token 檔的檔名（放在資料夾 `AGENT_BOARD_DATA_DIR`，預設 `~/.agent-board/`）。 */
export const SESSION_HOST_SOCKET_FILE = 'session-host.sock';
export const SESSION_HOST_TOKEN_FILE = 'session-host.token';
/** Windows named pipe 的前綴；後面接使用者名稱（非預設資料夾再接一段雜湊）。 */
export const SESSION_HOST_PIPE_PREFIX = 'agent-board-session-host-';
/** 一行的上限（spawn 的 env 可能很大，輸出一塊不會超過這個量級）。 */
export const SESSION_HOST_MAX_LINE_BYTES = 16 * 1024 * 1024;

const SessionKey = z.string().min(1).max(200);
const Size = z.number().int().min(1).max(1000);
const Seq = z.number().int().min(0);

export const HostSignal = z.enum(['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGKILL']);
export type HostSignal = z.infer<typeof HostSignal>;

export const HostSessionInfo = z.object({
  id: SessionKey,
  pid: z.number().int().min(0),
  alive: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  /** 緩衝裡最舊的位元組序號（之前的已丟掉）。 */
  seqStart: Seq,
  /** 到目前為止總共輸出的位元組數（下一個位元組的序號）。 */
  seqEnd: Seq,
  cols: Size,
  rows: Size,
});
export type HostSessionInfo = z.infer<typeof HostSessionInfo>;

export const DaemonToHost = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int(), token: z.string().min(1) }),
  z.object({
    type: z.literal('spawn'),
    reqId: z.string().min(1),
    id: SessionKey,
    bin: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
    cwd: z.string().min(1),
    cols: Size,
    rows: Size,
  }),
  /** 接回：先回 `attached`，再重播 `fromSeq` 之後的緩衝（不夠就先送 `replay.gap`），最後 `replay.done`。 */
  z.object({ type: z.literal('attach'), id: SessionKey, fromSeq: Seq }),
  z.object({ type: z.literal('write'), id: SessionKey, data: z.string() }),
  z.object({ type: z.literal('resize'), id: SessionKey, cols: Size, rows: Size }),
  z.object({ type: z.literal('kill'), id: SessionKey, signal: HostSignal }),
  z.object({ type: z.literal('list'), reqId: z.string().min(1) }),
  /** session 結束、daemon 已處理完：丟掉緩衝與結束紀錄。還活著的不理。 */
  z.object({ type: z.literal('release'), id: SessionKey }),
]);
export type DaemonToHost = z.infer<typeof DaemonToHost>;

export const HostToDaemon = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello.ok'),
    protocol: z.number().int(),
    hostVersion: z.string(),
    sessions: z.array(HostSessionInfo),
  }),
  z.object({ type: z.literal('hello.error'), protocol: z.number().int(), error: z.string() }),
  /** spawn、list 的回覆。 */
  z.object({
    type: z.literal('result'),
    reqId: z.string().min(1),
    ok: z.boolean(),
    error: z.string().nullable(),
    pid: z.number().int().optional(),
    sessions: z.array(HostSessionInfo).optional(),
  }),
  z.object({ type: z.literal('attached'), session: HostSessionInfo }),
  z.object({ type: z.literal('output'), id: SessionKey, seq: Seq, data: z.string() }),
  z.object({ type: z.literal('replay.gap'), id: SessionKey, lostBytes: z.number().int().min(1) }),
  z.object({ type: z.literal('replay.done'), id: SessionKey, seq: Seq }),
  z.object({
    type: z.literal('exit'),
    id: SessionKey,
    code: z.number().int(),
    signal: z.number().int().nullable(),
  }),
  /** 指令對不到 session（attach、write 之類沒有 reqId 的）或格式錯。 */
  z.object({ type: z.literal('error'), id: SessionKey.nullable(), error: z.string() }),
]);
export type HostToDaemon = z.infer<typeof HostToDaemon>;
