/**
 * 使用者選的團隊框色（STYLE.md §4），不是狀態色。存的是名稱，不把任意字串放進 CSS；
 * 不認得的名稱一律當 teal。前四個是最早的，資料庫裡已有，不能改名。色碼在 team.css。
 */
export const TEAM_COLORS = [
  'teal',
  'lime',
  'indigo',
  'apricot',
  'ice',
  'sand',
  'plum',
  'violet',
] as const;

export function teamColorVar(color: string): string {
  const known = TEAM_COLORS.find((c) => c === color) ?? 'teal';
  return `var(--team-${known})`;
}
