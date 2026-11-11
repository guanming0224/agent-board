// 安裝配置裡的連結與舊版清理（CONTRACTS §21.2、§21.10）。安裝程式用；windows-paths.test.mjs 在 Windows 上實測。
// 只用 node 內建模組。
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** 清舊版時暫放的資料夾前綴（releases\.trash-<名稱>-<亂數>）。 */
export const TRASH_PREFIX = '.trash-';

/** 是 symlink 或 junction（Windows 的 junction 在 lstat 裡也是 isSymbolicLink）。 */
export function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 只拿掉連結本身，不碰它指的資料夾。Windows 的 junction：libuv 的 unlink 會用 RemoveDirectory 拿掉 reparse point；
 * 萬一不行再用 rmdir（同樣只拿掉連結）。**不用 rmSync recursive**：那會刪到目標裡的東西。
 */
export function removeLink(link) {
  try {
    unlinkSync(link);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    rmdirSync(link);
  }
}

/**
 * 把 link 指向 target（資料夾）。
 * Mac／Linux：先建暫時的 symlink 再 rename 蓋過去（原子操作，任何時刻 current 都指著一個完整的版本）；
 * 目標用相對路徑，整個安裝資料夾搬家也不會斷。
 * Windows：junction（不需要系統管理員或開發人員模式）；junction 不能 rename 蓋過，先拿掉再建（有極短的空窗），
 * 目標一律是絕對路徑。
 */
export function pointLink(
  link,
  target,
  { windows = process.platform === 'win32', symlink = symlinkSync } = {},
) {
  if (windows) {
    let previous = null;
    if (isLink(link)) {
      try {
        previous = readlinkSync(link);
      } catch {
        previous = null;
      }
      removeLink(link);
    } else if (existsSync(link)) {
      throw new Error(`${link} 是一般資料夾或檔案，不是連結，不會蓋掉它`);
    }
    try {
      symlink(target, link, 'junction');
    } catch (error) {
      // 拿掉了舊的、新的卻建不起來：指回原本的目標，不讓 current 消失（服務與捷徑都指著它）。
      if (previous !== null) {
        try {
          symlink(previous, link, 'junction');
        } catch {
          // 指不回去：照樣丟出原本的錯誤，安裝程式會說明
        }
      }
      throw error;
    }
    return;
  }
  const base = dirname(link);
  const relativeTarget = target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target;
  const temp = `${link}.new-${randomBytes(4).toString('hex')}`;
  symlinkSync(relativeTarget, temp);
  renameSync(temp, link);
}

/** 上次沒刪完的 .trash-*：再刪一次，還是刪不掉就留著（下次再清）。回傳還留著的名稱。 */
export function cleanTrash(releasesDir) {
  let names = [];
  try {
    names = readdirSync(releasesDir).filter((name) => name.startsWith(TRASH_PREFIX));
  } catch {
    return [];
  }
  const left = [];
  for (const name of names) {
    try {
      rmSync(join(releasesDir, name), { recursive: true, force: true, maxRetries: 2 });
    } catch {
      // Windows 檔案被鎖住：下次再清
    }
    if (existsSync(join(releasesDir, name))) left.push(name);
  }
  return left;
}

/**
 * 清掉一個舊版。Windows：檔案被鎖住時 rmSync 會刪到一半（例如 node_modules 裡的 .node 還在、其他檔不見了），
 * 留下半殘的版本；所以先把整個資料夾改名成 `.trash-<名稱>-<亂數>`（亂數：上次同名的 trash 還沒刪掉也不衝突），
 * 改得了名才刪。被鎖住改不了名就丟例外、整個留著（呼叫端說明、下次再清）；改了名卻刪不完的留在 trash 下次再清。
 * Mac／Linux 直接刪。回傳 'removed'｜'trashed'（改名了但還有東西刪不掉）。
 */
export function removeRelease(releasesDir, name, { windows = process.platform === 'win32' } = {}) {
  const dir = join(releasesDir, name);
  if (!windows) {
    rmSync(dir, { recursive: true, force: true });
    return 'removed';
  }
  const trash = join(releasesDir, `${TRASH_PREFIX}${name}-${randomBytes(4).toString('hex')}`);
  renameSync(dir, trash);
  try {
    rmSync(trash, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // 刪不完：下次 cleanTrash
  }
  return existsSync(trash) ? 'trashed' : 'removed';
}
