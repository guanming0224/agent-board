// 獨立的更新程式 agent-board-updater（docs/release-update-spec.md §5、CONTRACTS §21.3）。
// daemon 下載、驗證、解壓新版之後，從「新版裡」以 detached 方式啟動這支（新的 process group，不是 daemon 的子程序樹）：
// 服務管理程式停掉 daemon 時不會連它一起收掉。只用 node 內建模組（與舊版的 better-sqlite3 讀 schema 版本）。
// 不對外連線：健康檢查只連本機的 hub（127.0.0.1／安裝時的位址）、讀本機狀態檔。
//
//   node updater.mjs update --source <解開的新版> --to <版本> --from <版本> --data <資料夾> --root <安裝根目錄>
//                           [--health-timeout-ms 60000] [--connect-timeout-ms 300000]
//   node updater.mjs rollback --data <資料夾> --root <安裝根目錄> [同上的時限]
//
// update：執行新版的 installer.mjs install（有 hub 的機器帶 --backup-db：在停 hub 前一刻備份 hub.db、600）→
// 裝到 releases/<版本>、換 current、重啟 hub／daemon → 健康檢查 → 成功；否則回滾：current 指回舊版、重啟
// （這次升級改了 hub.db 的 schema 就用備份還原）。session 忙碌、這次要換 session host 時安裝程式以 75 結束，
// 狀態寫 deferred/host_busy（daemon 5 分鐘後再試，不算失敗）。
// 健康檢查（S3b）：新 daemon 起來而且連上 hub、hub 的 /api/health 回新版。新 daemon 程序活著但還連不到 hub
// （例如 hub 也在重啟）時最多等 5 分鐘；daemon 本身起不來或崩潰就照 60 秒回滾。
// 每一步寫 <資料夾>/update-state.json（帶這個程序的 pid 與開始時間），daemon 下次連上 hub 時回報。
// Node（CONTRACTS §21.10）：發布檔不自帶 Node。daemon 用安裝時記下的系統 node（AGENT_BOARD_NODE）啟動這支；
// 舊版 daemon（0.1.0 的系統 node、0.1.1 的自帶 node）用它自己的 node 啟動，所以這支只用 node 內建模組、不在自己
// 的程序裡載入原生模組。安裝程式、讀 schema、hub 的 schema-version 一律用系統的 node 另開程序跑
// （0.1.1 自帶的 runtime 不算系統的 node）。
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isBundledRuntime } from './lib/node-runtime.mjs';

const HEALTH_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1_000;
/** 剛建立（或內容還是空的）的鎖一律當作有人拿著（W1）。 */
const LOCK_FRESH_MS = 10_000;
/** 安裝程式因為 session 忙碌而中止（什麼都沒改）的結束碼（W5，同 installer.mjs）。 */
const EXIT_BUSY = 75;
/** hub.db.pre-update-* 留幾份（W3）。 */
const KEEP_DB_BACKUPS = 5;

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

let startedAt = new Date().toISOString();

/** update-state.json：先寫暫存檔再改名，daemon 不會讀到寫一半的內容。 */
function writeState(data, state) {
  const full = {
    ...state,
    detail: state.detail ? String(state.detail).slice(0, 500) : null,
    at: new Date().toISOString(),
    pid: process.pid,
    startedAt,
  };
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const temp = join(data, `.update-state.json.${process.pid}`);
  writeFileSync(temp, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, join(data, 'update-state.json'));
  log(
    `狀態：${full.phase}${full.reason ? `（${full.reason}）` : ''}${full.detail ? ` ${full.detail}` : ''}`,
  );
  return full;
}

const installState = (root) => readJson(join(root, 'install.json')) ?? { roles: [] };

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * 同一時間只能有一個更新程式（W1）：先把自己的 pid 寫進 update.lock.<pid>，再用 link 原子地放成 update.lock
 * （已經有就失敗，不會兩個都拿到）。已有的鎖內容是空的或很新：當作有人拿著；pid 不在了才清掉重試。
 */
export function takeLock(root) {
  const lock = join(root, 'update.lock');
  const mine = `${lock}.${process.pid}`;
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, lock);
        return () => {
          if (readJson(lock) === process.pid) rmSync(lock, { force: true });
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let pid = 0;
      let age = 0;
      try {
        pid = Number(readFileSync(lock, 'utf8').trim());
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // 剛被拿掉：再試一次
      }
      if (!(pid > 0) || age < LOCK_FRESH_MS || alive(pid)) return null;
      rmSync(lock, { force: true });
    }
    return null;
  } finally {
    rmSync(mine, { force: true });
  }
}

/** path 不能當系統的 node：在安裝資料夾裡，或是任何發布檔自帶的 runtime（§21.10）。 */
const isInside = (root, path) => {
  if (isBundledRuntime(path)) return true;
  try {
    const base = realpathSync(root);
    const real = realpathSync(path);
    return real === base || real.startsWith(`${base}${process.platform === 'win32' ? '\\' : '/'}`);
  } catch {
    return false;
  }
};

/** PATH 上第一個 node（不是 Agent Board 自帶的那支）。 */
function nodeOnPath(root) {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && !isInside(root, candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 跑安裝程式、讀 schema 用的系統 node（§21.10）：install.json 記的 systemNode、daemon 給的 AGENT_BOARD_NODE、
 * 執行這支的 node、PATH 上的 node，依序取第一個存在而且不是自帶 runtime（0.1.1 的殘留）的。
 * 不做 realpath（安裝程式照 0.1.0 的寫法決定服務的路徑）。releaseDir 不影響結果（保留參數給呼叫端看得懂）。
 */
export function nodeFor(_releaseDir, root) {
  for (const candidate of [
    installState(root).systemNode,
    process.env.AGENT_BOARD_NODE,
    process.execPath,
  ]) {
    if (candidate && existsSync(candidate) && !isInside(root, candidate)) return candidate;
  }
  return nodeOnPath(root) ?? process.execPath;
}

/** 某一版的 better-sqlite3（用那一版的 node 另開程序）讀 hub.db 的 schema 版本；沒有檔案或讀不到回 null。 */
function schemaVersion(releaseDir, dbPath, root) {
  if (!existsSync(dbPath) || !releaseDir) return null;
  const script = `
const Database = require('better-sqlite3');
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
try { console.log(db.pragma('user_version', { simple: true })); } finally { db.close(); }
`;
  const result = spawnSync(nodeFor(releaseDir, root), ['-e', script, dbPath], {
    cwd: releaseDir,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const value = Number((result.stdout ?? '').trim());
  return result.status === 0 && Number.isInteger(value) ? value : null;
}

/** 某一版 hub 認得的 schema 版本（`agent-board-hub schema-version`）；舊版沒有這個指令回 null。 */
function hubSchemaOf(releaseDir, root) {
  const result = spawnSync(
    nodeFor(releaseDir, root),
    [join(releaseDir, 'hub', 'dist', 'main.mjs'), 'schema-version'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  const value = Number((result.stdout ?? '').trim());
  return result.status === 0 && Number.isInteger(value) ? value : null;
}

/** current 指向的版本資料夾名稱。 */
function currentRelease(root) {
  try {
    return basename(realpathSync(join(root, 'current')));
  } catch {
    try {
      return basename(readlinkSync(join(root, 'current')));
    } catch {
      return null;
    }
  }
}

/** 這份安裝程式有沒有 switch 指令（0.1.0 之前的沒有）。 */
function supportsSwitch(installer) {
  try {
    return readFileSync(installer, 'utf8').includes("command === 'switch'");
  } catch {
    return false;
  }
}

/** 用那一版的 node 跑它的安裝程式（舊版的安裝程式會用 process.execPath 寫服務設定，要是它自己的 node）。 */
function runInstaller(installer, args, root) {
  const node = nodeFor(dirname(dirname(installer)), root);
  log(`執行 ${node} ${installer} ${args.join(' ')}`);
  const result = spawnSync(node, [installer, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, AGENT_BOARD_UPDATER: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.trim()) console.log(output.trimEnd());
  const lastLine = output.trim().split(/\r?\n/).at(-1) ?? '';
  return {
    ok: result.status === 0,
    status: result.status,
    detail: lastLine || `exit ${result.status}`,
  };
}

/**
 * 刪掉 daemon 解好的 .incoming/<版本>。這支（與它跑的安裝程式）可能是用那裡面自帶的 node 執行的：
 * Windows 會鎖住執行中的 node.exe 刪不掉，留著也無妨（daemon 下次會重新解到 .partial），不能讓更新因此失敗。
 */
function removeIncoming(source) {
  try {
    rmSync(dirname(source), { recursive: true, force: true });
  } catch (error) {
    log(`.incoming 清不掉（下次再清）：${error.message}`);
  }
}

/** hub.db.pre-update-* 只留最近幾份（W3）。 */
function pruneDbBackups(data) {
  try {
    const backups = readdirSync(data)
      .filter((name) => name.startsWith('hub.db.pre-update-'))
      .map((name) => ({ name, at: statSync(join(data, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const { name } of backups.slice(KEEP_DB_BACKUPS))
      rmSync(join(data, name), { force: true });
  } catch (error) {
    log(`清舊備份失敗（下次再清）：${error.message}`);
  }
}

/**
 * 健康檢查（S3b）：新 daemon 起來而且連上 hub（daemon-status.json 的版本對、啟動與連上時間在這次之後、程序活著），
 * 有 hub 的機器另外要 /api/health 回 200 而且是同一版。
 * 新 daemon 程序活著（本機 hub 也正常）只是還連不到 hub：等到 connectTimeoutMs；否則 timeoutMs 一到就失敗。
 */
export async function healthy({ data, root, version, since, timeoutMs, connectTimeoutMs }) {
  const state = installState(root);
  const roles = state.roles ?? [];
  const host = state.host && state.host !== 'localhost' ? state.host : '127.0.0.1';
  const hubUrl = `http://${host.includes(':') ? `[${host}]` : host}:${state.port ?? 8787}/api/health`;
  const deadline = since + timeoutMs;
  const connectDeadline = since + Math.max(timeoutMs, connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  let waitingForHub = false;
  for (;;) {
    let started = true;
    let connected = true;
    if (roles.includes('daemon')) {
      const status = readJson(join(data, 'daemon-status.json'));
      const live = status?.version === version && Number.isInteger(status.pid) && alive(status.pid);
      started = live && Date.parse(status.startedAt ?? status.connectedAt) >= since;
      connected = live && status.connectedAt !== null && Date.parse(status.connectedAt) >= since;
    }
    let hubOk = !roles.includes('hub');
    if (!hubOk) {
      try {
        const response = await fetch(hubUrl, { signal: AbortSignal.timeout(2_000) });
        hubOk = response.ok && (await response.json()).version === version;
      } catch {
        hubOk = false;
      }
    }
    if (started && connected && hubOk) return true;
    const extend = started && hubOk && !connected;
    if (extend && !waitingForHub) {
      log('新 daemon 已經起來，但還連不上 hub：最多等到連線逾時再判斷');
    }
    waitingForHub = extend;
    if (Date.now() > (extend ? connectDeadline : deadline)) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function timeouts(options) {
  return {
    timeoutMs: Number(options['health-timeout-ms']) || HEALTH_TIMEOUT_MS,
    connectTimeoutMs: Number(options['connect-timeout-ms']) || CONNECT_TIMEOUT_MS,
  };
}

/** 拿不到鎖：另一個更新程式還在跑（或剛結束），這次不做，記成 failed/busy（S1）。 */
function lockBusy(data, base) {
  writeState(data, {
    ...base,
    phase: 'failed',
    reason: 'busy',
    detail: '已經有更新程式在跑，這次不做',
  });
  return 1;
}

async function update(options) {
  const { source, to, from, data, root } = options;
  const { timeoutMs, connectTimeoutMs } = timeouts(options);
  if (!source || !to || !data || !root) throw new Error('缺少 --source、--to、--data 或 --root');
  const base = { fromVersion: from ?? null, toVersion: to };
  const release = takeLock(root);
  if (!release) return lockBusy(data, base);
  // 開始時間＝拿到鎖的時間（daemon 用它算 60 分鐘的硬上限，N2）。
  startedAt = new Date().toISOString();
  try {
    const before = installState(root);
    const fromRelease = currentRelease(root) ?? before.currentRelease;
    const fromDir = fromRelease ? join(root, 'releases', fromRelease) : null;
    const roles = before.roles ?? [];
    const since = Date.now();
    writeState(data, { ...base, phase: 'installing', reason: null, detail: null });

    // 1. 新版的安裝程式：裝到 releases/<版本>、換 current、重啟 hub／daemon（session host 只在協定變了才換）。
    //    有 hub 的機器由安裝程式在停 hub 前一刻備份資料庫（W3）；schema 版本用舊版的模組先讀起來。
    const dbPath = join(data, 'hub.db');
    const hasHubDb = roles.includes('hub') && existsSync(dbPath);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const backup = hasHubDb ? `${dbPath}.pre-update-${from ?? 'unknown'}-${stamp}` : null;
    const schemaBefore = hasHubDb ? schemaVersion(fromDir, dbPath, root) : null;
    const role = roles.includes('hub') ? 'hub' : 'daemon';
    const installed = runInstaller(
      join(source, 'scripts', 'installer.mjs'),
      ['install', role, '--source', source, ...(backup ? ['--backup-db', backup] : [])],
      root,
    );
    if (backup) pruneDbBackups(data);
    // 看實際的 current 連結（安裝程式可能在換完 current、寫 install.json 之前就失敗）。
    const switched = currentRelease(root) !== fromRelease;
    if (!installed.ok && !switched) {
      if (installed.status === EXIT_BUSY) {
        // session 忙碌、這次要換 session host：什麼都沒改，daemon 5 分鐘後再試（W5）。
        writeState(data, { ...base, phase: 'deferred', reason: 'host_busy', detail: null });
        return 0;
      }
      const reason = /hub\.db/.test(installed.detail) ? 'backup_failed' : 'install_failed';
      writeState(data, { ...base, phase: 'failed', reason, detail: installed.detail });
      return 1;
    }

    // 2. 健康檢查。
    let reason = 'install_failed';
    let detail = installed.detail;
    if (installed.ok) {
      writeState(data, { ...base, phase: 'checking', reason: null, detail: null });
      if (await healthy({ data, root, version: to, since, timeoutMs, connectTimeoutMs })) {
        writeState(data, { ...base, phase: 'succeeded', reason: null, detail: null });
        removeIncoming(source);
        return 0;
      }
      reason = 'health_timeout';
      detail = `新版 ${timeoutMs / 1000} 秒內沒有通過健康檢查`;
    }

    // 3. 回滾：schema 有變就用備份還原（舊版 hub 開不了新 schema 的資料庫）。
    writeState(data, { ...base, phase: 'rolling_back', reason, detail });
    if (!fromRelease) {
      writeState(data, { ...base, phase: 'rollback_failed', reason, detail: '不知道上一版' });
      return 1;
    }
    let restore = null;
    if (backup && existsSync(backup)) {
      const schemaAfter = schemaVersion(fromDir, dbPath, root);
      // 舊版模組讀不到（例如新 schema 舊程式開不了）時保守比對：比舊版 hub 認得的新就還原（W3）。
      const oldSchema = schemaBefore ?? hubSchemaOf(fromDir, root);
      const changed =
        schemaAfter === null ? true : oldSchema === null ? false : schemaAfter > oldSchema;
      if (changed || (schemaBefore !== null && schemaAfter !== schemaBefore)) {
        restore = backup;
        log(`schema 從 v${oldSchema} 變成 v${schemaAfter ?? '?'}，回滾時還原備份`);
      }
    }
    const rollbackSince = Date.now();
    // 先用新版的安裝程式切回；新版的安裝程式本身壞了，就用舊版裡的（有 switch 指令的話）。
    const switchArgs = [
      'switch',
      '--to',
      fromRelease,
      ...(restore ? ['--restore-db', restore] : []),
    ];
    let switchedBack = runInstaller(join(source, 'scripts', 'installer.mjs'), switchArgs, root);
    const oldInstaller = join(root, 'releases', fromRelease, 'scripts', 'installer.mjs');
    if (!switchedBack.ok && supportsSwitch(oldInstaller)) {
      switchedBack = runInstaller(oldInstaller, switchArgs, root);
    }
    const back =
      switchedBack.ok &&
      (await healthy({
        data,
        root,
        version: from ?? before.currentVersion,
        since: rollbackSince,
        timeoutMs,
        connectTimeoutMs,
      }));
    writeState(data, {
      ...base,
      phase: back ? 'rolled_back' : 'rollback_failed',
      reason,
      detail: back
        ? detail
        : `${detail}；回滾：${switchedBack.ok ? '舊版也沒通過健康檢查' : switchedBack.detail}`,
    });
    removeIncoming(source);
    return 1;
  } finally {
    release();
  }
}

/**
 * 面板「回滾到上一版」：current 指回 install.json 的 previousRelease。
 * 上一版的 hub 讀不了現在的資料庫（schema 比它新）就不做：還原備份會丟掉之後寫的資料，交給人處理。
 * 上一版沒通過健康檢查：切回原本的版本，回報失敗。延後條件由 daemon 先看過（W6）。
 */
async function rollback(options) {
  const { data, root } = options;
  const { timeoutMs, connectTimeoutMs } = timeouts(options);
  if (!data || !root) throw new Error('缺少 --data 或 --root');
  const before = installState(root);
  const base = {
    fromVersion: before.currentVersion ?? null,
    toVersion: before.previousVersion ?? null,
  };
  const release = takeLock(root);
  if (!release) return lockBusy(data, base);
  startedAt = new Date().toISOString();
  try {
    const target = before.previousRelease;
    const fromRelease = currentRelease(root) ?? before.currentRelease;
    if (!target || !existsSync(join(root, 'releases', target))) {
      writeState(data, { ...base, phase: 'failed', reason: 'no_previous', detail: null });
      return 1;
    }
    const dbPath = join(data, 'hub.db');
    if ((before.roles ?? []).includes('hub') && existsSync(dbPath)) {
      const now = schemaVersion(join(root, 'current'), dbPath, root);
      const old = hubSchemaOf(join(root, 'releases', target), root);
      if (old !== null && now !== null && now > old) {
        writeState(data, {
          ...base,
          phase: 'failed',
          reason: 'schema_changed',
          detail: `hub.db 已是 schema v${now}，${target} 只認得 v${old}`,
        });
        return 1;
      }
    }
    writeState(data, {
      ...base,
      phase: 'rolling_back',
      reason: 'rollback_requested',
      detail: null,
    });
    const installer = join(root, 'current', 'scripts', 'installer.mjs');
    const since = Date.now();
    const switched = runInstaller(installer, ['switch', '--to', target], root);
    if (
      switched.ok &&
      (await healthy({
        data,
        root,
        version: before.previousVersion,
        since,
        timeoutMs,
        connectTimeoutMs,
      }))
    ) {
      // 手動回滾成功不算失敗（不推播）。
      writeState(data, {
        ...base,
        phase: 'succeeded',
        reason: 'rollback_requested',
        detail: null,
      });
      return 0;
    }
    // 上一版起不來：切回原本的版本。
    const restored =
      fromRelease &&
      runInstaller(
        join(root, 'releases', fromRelease, 'scripts', 'installer.mjs'),
        ['switch', '--to', fromRelease],
        root,
      ).ok;
    writeState(data, {
      ...base,
      phase: restored ? 'failed' : 'rollback_failed',
      reason: 'health_timeout',
      detail: `${target} 沒通過健康檢查${restored ? `，已切回 ${fromRelease}` : '，也切不回原本的版本'}`,
    });
    return 1;
  } finally {
    release();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      source: { type: 'string' },
      to: { type: 'string' },
      from: { type: 'string' },
      data: { type: 'string' },
      root: { type: 'string' },
      'health-timeout-ms': { type: 'string' },
      'connect-timeout-ms': { type: 'string' },
    },
  });
  log(`agent-board-updater ${command} 開始（pid ${process.pid}）`);
  try {
    const code =
      command === 'update'
        ? await update(values)
        : command === 'rollback'
          ? await rollback(values)
          : (console.error('用法：updater.mjs update|rollback …'), 2);
    log(`結束（${code}）`);
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    if (values.data) {
      writeState(values.data, {
        fromVersion: values.from ?? null,
        toVersion: values.to ?? null,
        phase: command === 'update' ? 'failed' : 'rollback_failed',
        reason: 'unknown',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    process.exit(1);
  }
}
