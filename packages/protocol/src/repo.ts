// 「會不會改到同一份檔案」的判斷，hub（團隊成員檢查）與前端（新 session 建議 worktree）共用。

export interface WorkPlace {
  /** 實際工作的資料夾。 */
  dir: string;
  /** 所在 working tree 的根目錄（`git rev-parse --show-toplevel`）；不知道或不是 git 就是 null。 */
  repoRoot: string | null;
}

const normalize = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '');

const nested = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * 同一個 working tree 才會互相改到檔案：同 repo 的不同子資料夾算；同 repo 但各自在
 * linked worktree（`git worktree add` 出來的）不算，它們的根目錄不同。
 * 兩邊都知道根目錄就只比根目錄，因為 linked worktree 可能放在主 repo 資料夾裡面；
 * 有一邊不知道時，退回比較資料夾是否相同或互相包含（知道根目錄的那邊用根目錄）。
 */
export function sameWorkingTree(a: WorkPlace, b: WorkPlace): boolean {
  const dirA = normalize(a.dir);
  const dirB = normalize(b.dir);
  if (!dirA || !dirB) return false;
  if (a.repoRoot && b.repoRoot) return normalize(a.repoRoot) === normalize(b.repoRoot);
  return nested(normalize(a.repoRoot ?? dirA), normalize(b.repoRoot ?? dirB));
}

/**
 * 唯讀 session 拿掉的改檔工具（daemon 帶 `--disallowedTools`）。不放 MultiEdit：2.1.318 已沒有這個工具，
 * 帶了會印「matches no known tool」警告（Lead 實測 2026-11-06）。
 */
export const READ_ONLY_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/** 團隊裡可以和別人共用資料夾的角色（GM 2026-11-06）。測試（tester）會寫檔，不在這裡（Q5）。 */
export const READ_ONLY_ROLES = ['researcher', 'reviewer'] as const;

/**
 * 只讀成員：角色是研究或審查，**而且** session 建立時就是唯讀（`readOnly`）。
 * 不看權限模式：plan 模式會被 ExitPlanMode 或 Shift+Tab 切掉，hub 不會知道。
 * hub（團隊成員檢查）與前端共用：兩個成員都不是只讀成員，才算會互相改到檔案。
 */
export function isReadOnlyMember(role: string, session: { readOnly: boolean }): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role) && session.readOnly;
}
