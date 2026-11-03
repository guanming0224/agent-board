// 從限流訊息讀出重置時間（§8-5 排隊用）。沒有官方的額度來源，這是 daemon 唯一帶得到的線索。
//
// 格式取自 claude 2.1.317 的 `$R(resetsAt, true)`：24 小時內是 `resets 3pm (Asia/Taipei)`、
// `resets 3:30pm (Asia/Taipei)`；更久是 `resets Nov 5, 3pm (Asia/Taipei)`，跨年再加年份。
// 時區一定帶（第二個參數為 true）。認不出來就回 null：排隊改等該帳號沒有限流中的 session。
// 未經真實限流驗證（docs/claude-code-notes.md）。

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const RESET_PATTERN =
  /\bresets? (?:([A-Z][a-z]{2}) (\d{1,2}),(?: (\d{4}),)? )?(\d{1,2})(?::(\d{2}))?\s?([ap]m)\s?\(([^)\s]+)\)/i;

const DAY_MS = 86_400_000;

/** 某時區在某個瞬間的 UTC 偏移（毫秒）。時區不認得就丟例外。 */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** 時區裡的牆上時間轉成 epoch 毫秒。夏令時間交界附近以第二次估算為準。 */
function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month, day, hour, minute);
  const first = naive - zoneOffsetMs(naive, timeZone);
  return naive - zoneOffsetMs(first, timeZone);
}

function zonedYear(at: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(at));
}

/**
 * `detail` 裡的重置時間（epoch 毫秒）；`since` 是進入限流的時間，只有時刻沒有日期時，
 * 取 `since` 之後第一個符合的時刻。
 */
export function parseRateLimitReset(detail: string | null, since: Date): number | null {
  if (!detail) return null;
  const match = RESET_PATTERN.exec(detail.replaceAll(' ', ' '));
  if (!match) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, timeZone] = match;
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  hour = (hour % 12) + (meridiem!.toLowerCase() === 'pm' ? 12 : 0);
  const base = since.getTime();
  try {
    if (monthName) {
      const month = MONTHS.indexOf(monthName.toLowerCase());
      if (month === -1) return null;
      const day = Number(dayText);
      let year = yearText ? Number(yearText) : zonedYear(base, timeZone!);
      let at = zonedTime(year, month, day, hour, minute, timeZone!);
      // 沒寫年份代表和現在同一年；算出來在過去很久，就是跨年了。
      if (!yearText && at < base - DAY_MS) {
        year += 1;
        at = zonedTime(year, month, day, hour, minute, timeZone!);
      }
      return at;
    }
    // 只有時刻：24 小時內的下一次。先用 since 當天的日期，在 since 之前就加一天。
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(new Date(base));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    let at = zonedTime(get('year'), get('month') - 1, get('day'), hour, minute, timeZone!);
    if (at <= base) {
      at = zonedTime(get('year'), get('month') - 1, get('day') + 1, hour, minute, timeZone!);
    }
    return at;
  } catch {
    // 不認得的時區。
    return null;
  }
}
