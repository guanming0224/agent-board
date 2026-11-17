// node-pty 1.1.0 在 macOS 開 session 時漏掉的 fd（事故 9，CONTRACTS §20.8）。
//
// node-pty 的 pty_posix_spawn（src/unix/pty.cc）每開一個 session 會在呼叫的程序（session host）留下：
// 1. 一個沒有 grantpt／unlockpt、也沒人開 slave 的 /dev/ptmx（low_fds 迴圈的 off-by-one：第一個 fd 就 ≥ 2 時一個都不關）。
//    它是**阻塞模式**：誰寫它，寫入就永遠卡在核心裡等 slave 打開；
// 2. slave（/dev/ttysNNN）：開來設 termios／視窗大小後沒關；agent 結束後變成 lsof 的 `(revoked)`；
// 3. 結束通知用的 kqueue（在另一條執行緒開、不關）——這個分不出是誰的，不動。
// 事故那台 host 5 天下來有 35 個 ptmx、19 個 revoked、30 個 KQUEUE，對得上每次 spawn 漏一組。
// fd 編號會被重用：某個寫入拿著舊編號時，就可能寫到 1. 而卡住一條 threadpool（見 ptyWriter.ts）。
//
// 做法：spawn 前記下現有的 fd，spawn 後把新出現、而且是「另一個 /dev/ptmx」或「這個 session 的 slave」的字元裝置關掉。
// 只在 macOS 做（Linux 的 node-pty 用 forkpty，沒有這個問題；Windows 是 ConPTY）。
import { closeSync, fstatSync, readdirSync, statSync } from 'node:fs';

/** 目前開著的 fd（列 /dev/fd 時自己用的那個目錄 fd 已經關了，fstat 會失敗，不算）。 */
export function openFds(): Set<number> {
  const fds = new Set<number>();
  let entries: string[];
  try {
    entries = readdirSync('/dev/fd');
  } catch {
    return fds;
  }
  for (const entry of entries) {
    const fd = Number(entry);
    if (!Number.isInteger(fd)) continue;
    try {
      fstatSync(fd);
      fds.add(fd);
    } catch {
      // 列目錄用的 fd（已關）
    }
  }
  return fds;
}

/**
 * 關掉 spawn 時漏掉的 ptmx 與 slave。回傳關掉幾個。
 * before：spawn 前的 openFds()；masterFd／slavePath：這個 session 的 PTY。
 */
export function closeLeakedPtyFds(
  before: ReadonlySet<number>,
  masterFd: number,
  slavePath: string | undefined,
): number {
  let master;
  try {
    master = fstatSync(masterFd);
  } catch {
    return 0;
  }
  let slaveRdev: number | null = null;
  if (slavePath) {
    try {
      slaveRdev = statSync(slavePath).rdev;
    } catch {
      slaveRdev = null;
    }
  }
  let closed = 0;
  for (const fd of openFds()) {
    if (before.has(fd) || fd === masterFd) continue;
    let st;
    try {
      st = fstatSync(fd);
    } catch {
      continue;
    }
    if (!st.isCharacterDevice()) continue;
    const anotherPtmx = st.dev === master.dev && st.ino === master.ino;
    const ourSlave = slaveRdev !== null && st.rdev === slaveRdev;
    if (!anotherPtmx && !ourSlave) continue;
    try {
      closeSync(fd);
      closed += 1;
    } catch {
      // 已經被關了
    }
  }
  return closed;
}
