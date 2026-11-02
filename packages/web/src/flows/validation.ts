// 設定頁的輸入檢查。hub 也會擋 0.0.0.0／::（CONTRACTS.md §7），這裡是讓使用者當場看到。

export type ListenAddressError = 'required' | 'unspecified' | 'format' | 'public';

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

/** 和 hub 的 assertBindableHost 同一份範圍：loopback、RFC1918、100.64/10、link-local、IPv6 ULA。 */
function isPrivateIpv4(value: string): boolean {
  const [a = 0, b = 0] = value.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

function isPrivateIpv6(value: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return /^(0*:)*:?0*1$/.test(value) || /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
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
  if (raw === 'localhost') return null;
  if (isIpv4(raw)) return isPrivateIpv4(raw) ? null : 'public';
  if (isIpv6(raw)) return isPrivateIpv6(raw) ? null : 'public';
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
