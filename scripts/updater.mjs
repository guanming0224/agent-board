// 獨立的更新程式 agent-board-updater（docs/release-update-spec.md §5、CONTRACTS §21.3）。
// daemon 下載、驗證、解壓新版之後，從「新版裡」以 detached 方式啟動這支（新的 process group，不是 daemon 的子程序樹）：
// 服務管理程式停掉 daemon 時不會連它一起收掉。只用 node 內建模組（與目前這版的 better-sqlite3 做備份）。
// 不對外連線：健康檢查只連本機的 hub（127.0.0.1／安裝時的位址）、讀本機狀態檔。
//
//   node updater.mjs update --source <解開的新版> --to <版本> --from <版本> --data <資料夾> --root <安裝根目錄>
//                           [--health-timeout-ms 60000]
//   node updater.mjs rollback --data <資料夾> --root <安裝根目錄> [--health-timeout-ms 60000]
//
// update：(有 hub 的機器) 先備份 hub.db（600）→ 執行新版的 installer.mjs install（裝到 releases/<版本>、換 current、
// 重啟 hub／daemon）→ 60 秒內新 daemon 連上 hub 並回報新版本、hub 的 /api/health 回 200 → 成功；
// 否則回滾：current 指回舊版、重啟（這次升級改了 hub.db 的 schema 就先用備份還原）。
// 每一步寫 <資料夾>/update-state.json，daemon 下次連上 hub 時回報。
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const HEALTH_TIMEOUT_MS = 60_000;
const POLL_MS = 1_000;

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** update-state.json：先寫暫存檔再改名，daemon 不會讀到寫一半的內容。 */
function writeState(data, state) {
  const full = { ...state, detail: state.detail ? String(state.detail).slice(0, 500) : null };
  full.at = new Date().toISOString();
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

/** 同一時間只能有一個更新程式（lock 檔記 pid；pid 已不在就當作過期）。 */
function takeLock(root) {
  const lock = join(root, 'update.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      writeFileSync(lock, String(process.pid));
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lock, 'utf8').trim());
      if (pid > 0 && pid !== process.pid && alive(pid)) return null;
      rmSync(lock, { force: true });
    }
  }
  return null;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** hub.db 的 schema 版本；沒有檔案或讀不到回 null。 */
function schemaVersion(root, dbPath) {
  if (!existsSync(dbPath)) return null;
  try {
    const Database = createRequire(join(root, 'current', 'package.json'))('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.pragma('user_version', { simple: true });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * 更新前備份 hub.db（hub 還在跑也可以：SQLite 線上備份，含 WAL 裡還沒寫回的內容）。檔案 600。
 * 用目前這版（current）帶的 better-sqlite3，不需要另外裝 sqlite3。
 */
async function backupHubDb(root, dbPath, fromVersion) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const target = `${dbPath}.pre-update-${fromVersion}-${stamp}`;
  closeSync(openSync(target, 'wx', 0o600));
  try {
    const Database = createRequire(join(root, 'current', 'package.json'))('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(target);
    } finally {
      db.close();
    }
    chmodSync(target, 0o600);
    return target;
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
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

function runInstaller(installer, args) {
  log(`執行 ${installer} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [installer, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, AGENT_BOARD_UPDATER: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (output.trim()) console.log(output.trimEnd());
  const lastLine = output.trim().split(/\r?\n/).at(-1) ?? '';
  return { ok: result.status === 0, detail: lastLine || `exit ${result.status}` };
}

/**
 * 健康檢查：新 daemon 起來而且連上 hub（daemon-status.json 的版本對、連上時間在更新開始之後、程序還活著），
 * 有 hub 的機器另外要 /api/health 回 200 而且是同一版。
 */
async function healthy({ data, root, version, since, timeoutMs }) {
  const state = installState(root);
  const roles = state.roles ?? [];
  const deadline = Date.now() + timeoutMs;
  const host = state.host && state.host !== 'localhost' ? state.host : '127.0.0.1';
  const hubUrl = `http://${host.includes(':') ? `[${host}]` : host}:${state.port ?? 8787}/api/health`;
  while (Date.now() < deadline) {
    let daemonOk = !roles.includes('daemon');
    if (!daemonOk) {
      const status = readJson(join(data, 'daemon-status.json'));
      daemonOk =
        status?.version === version &&
        Date.parse(status.connectedAt) >= since &&
        Number.isInteger(status.pid) &&
        alive(status.pid);
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
    if (daemonOk && hubOk) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

async function update(options) {
  const { source, to, from, data, root } = options;
  const timeoutMs = Number(options['health-timeout-ms']) || HEALTH_TIMEOUT_MS;
  if (!source || !to || !data || !root) throw new Error('缺少 --source、--to、--data 或 --root');
  const base = { fromVersion: from ?? null, toVersion: to };
  const release = takeLock(root);
  if (!release) {
    log('已經有更新程式在跑，這次不做。');
    return 0;
  }
  try {
    const before = installState(root);
    const fromRelease = currentRelease(root) ?? before.currentRelease;
    const roles = before.roles ?? [];
    const since = Date.now();
    writeState(data, { ...base, phase: 'installing', reason: null, detail: null });

    // 1. 有 hub 的機器先備份資料庫。
    const dbPath = join(data, 'hub.db');
    let backup = null;
    let schemaBefore = null;
    if (roles.includes('hub') && existsSync(dbPath)) {
      try {
        schemaBefore = schemaVersion(root, dbPath);
        backup = await backupHubDb(root, dbPath, from ?? 'unknown');
        log(`已備份 hub.db（schema v${schemaBefore}）到 ${backup}`);
      } catch (error) {
        writeState(data, {
          ...base,
          phase: 'failed',
          reason: 'backup_failed',
          detail: error.message,
        });
        return 1;
      }
    }

    // 2. 新版的安裝程式：裝到 releases/<版本>、換 current、重啟 hub／daemon（session host 只在協定變了才換）。
    const role = roles.includes('hub') ? 'hub' : 'daemon';
    const installed = runInstaller(join(source, 'scripts', 'installer.mjs'), [
      'install',
      role,
      '--source',
      source,
    ]);
    // 看實際的 current 連結（安裝程式可能在換完 current、寫 install.json 之前就失敗）。
    const switched = currentRelease(root) !== fromRelease;
    if (!installed.ok && !switched) {
      writeState(data, {
        ...base,
        phase: 'failed',
        reason: 'install_failed',
        detail: installed.detail,
      });
      return 1;
    }

    // 3. 健康檢查。
    let reason = 'install_failed';
    let detail = installed.detail;
    if (installed.ok) {
      writeState(data, { ...base, phase: 'checking', reason: null, detail: null });
      if (await healthy({ data, root, version: to, since, timeoutMs })) {
        writeState(data, { ...base, phase: 'succeeded', reason: null, detail: null });
        rmSync(dirname(source), { recursive: true, force: true });
        return 0;
      }
      reason = 'health_timeout';
      detail = `新版 ${timeoutMs / 1000} 秒內沒有通過健康檢查`;
    }

    // 4. 回滾：schema 有變就用備份還原（舊版 hub 開不了新 schema 的資料庫）。
    writeState(data, { ...base, phase: 'rolling_back', reason, detail });
    if (!fromRelease) {
      writeState(data, { ...base, phase: 'rollback_failed', reason, detail: '不知道上一版' });
      return 1;
    }
    const schemaAfter = backup ? schemaVersion(root, dbPath) : null;
    const restore = backup && schemaAfter !== null && schemaAfter !== schemaBefore ? backup : null;
    if (restore) log(`schema 從 v${schemaBefore} 變成 v${schemaAfter}，回滾時還原備份`);
    const rollbackSince = Date.now();
    // 先用新版的安裝程式切回；新版的安裝程式本身壞了，就用舊版裡的（有 switch 指令的話）。
    const switchArgs = [
      'switch',
      '--to',
      fromRelease,
      ...(restore ? ['--restore-db', restore] : []),
    ];
    let switchedBack = runInstaller(join(source, 'scripts', 'installer.mjs'), switchArgs);
    const oldInstaller = join(root, 'releases', fromRelease, 'scripts', 'installer.mjs');
    if (!switchedBack.ok && supportsSwitch(oldInstaller)) {
      switchedBack = runInstaller(oldInstaller, switchArgs);
    }
    const back =
      switchedBack.ok &&
      (await healthy({
        data,
        root,
        version: from ?? before.currentVersion,
        since: rollbackSince,
        timeoutMs,
      }));
    writeState(data, {
      ...base,
      phase: back ? 'rolled_back' : 'rollback_failed',
      reason,
      detail: back
        ? detail
        : `${detail}；回滾：${switchedBack.ok ? '舊版也沒通過健康檢查' : switchedBack.detail}`,
    });
    rmSync(dirname(source), { recursive: true, force: true });
    return 1;
  } finally {
    release();
  }
}

/** 某一版 hub 認得的 schema 版本（`agent-board-hub schema-version`）；舊版沒有這個指令回 null。 */
function hubSchemaOf(releaseDir) {
  const result = spawnSync(
    process.execPath,
    [join(releaseDir, 'hub', 'dist', 'main.mjs'), 'schema-version'],
    { encoding: 'utf8', timeout: 15_000 },
  );
  const value = Number((result.stdout ?? '').trim());
  return result.status === 0 && Number.isInteger(value) ? value : null;
}

/**
 * 面板「回滾到上一版」：current 指回 install.json 的 previousRelease。
 * 上一版的 hub 讀不了現在的資料庫（schema 比它新）就不做：還原備份會丟掉之後寫的資料，交給人處理。
 * 上一版沒通過健康檢查：切回原本的版本，回報失敗。
 */
async function rollback(options) {
  const { data, root } = options;
  const timeoutMs = Number(options['health-timeout-ms']) || HEALTH_TIMEOUT_MS;
  if (!data || !root) throw new Error('缺少 --data 或 --root');
  const release = takeLock(root);
  if (!release) {
    log('已經有更新程式在跑，這次不做。');
    return 0;
  }
  try {
    const before = installState(root);
    const base = {
      fromVersion: before.currentVersion ?? null,
      toVersion: before.previousVersion ?? null,
    };
    const target = before.previousRelease;
    const fromRelease = currentRelease(root) ?? before.currentRelease;
    if (!target || !existsSync(join(root, 'releases', target))) {
      writeState(data, { ...base, phase: 'failed', reason: 'no_previous', detail: null });
      return 1;
    }
    const dbPath = join(data, 'hub.db');
    if ((before.roles ?? []).includes('hub') && existsSync(dbPath)) {
      const now = schemaVersion(root, dbPath);
      const old = hubSchemaOf(join(root, 'releases', target));
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
    const switched = runInstaller(installer, ['switch', '--to', target]);
    if (
      switched.ok &&
      (await healthy({ data, root, version: before.previousVersion, since, timeoutMs }))
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
      runInstaller(join(root, 'releases', fromRelease, 'scripts', 'installer.mjs'), [
        'switch',
        '--to',
        fromRelease,
      ]).ok;
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
