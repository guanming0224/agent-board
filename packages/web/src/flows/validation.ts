// 設定頁的輸入檢查。hub 也會擋 0.0.0.0／::（CONTRACTS.md §7），這裡是讓使用者當場看到。

export type ListenAddressError = 'required' | 'unspecified' | 'format';

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIpv6(value: string): boolean {
  const halves = value.split('::');
  if (!value.includes(':') || halves.length > 2) return false;
  const groups = value.split(':').filter(Boolean);
  const last = groups[groups.length - 1] ?? '';
  const endsWithIpv4 = last.includes('.');
  if (endsWithIpv4 && !isIpv4(last)) return false;
  const hex = endsWithIpv4 ? groups.slice(0, -1) : groups;
  if (!hex.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return false;
  const count = hex.length + (endsWithIpv4 ? 2 : 0);
  return halves.length === 2 ? count < 8 : count === 8;
}

export function listenAddressError(input: string): ListenAddressError | null {
  const raw = input.trim().toLowerCase();
  const value = raw.replace(/^\[|\]$/g, '');
  if (!value) return 'required';
  // 所有寫法的「全部網卡」：0.0.0.0、::、::0、0:0:0:0:0:0:0:0、000.000.000.000、::ffff:0.0.0.0。
  if (/(^|:)0+(\.0+){3}$/.test(value) || (value.includes(':') && /^[0:]+$/.test(value))) {
    return 'unspecified';
  }
  // 方括號只是網址寫法，綁定時不能帶。
  if (raw === 'localhost' || isIpv4(raw) || isIpv6(raw)) return null;
  return 'format';
}

export function originError(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  try {
    return !/^https?:$/.test(new URL(value).protocol);
  } catch {
    return true;
  }
}
