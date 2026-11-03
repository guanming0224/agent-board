// 全尺寸終端機的網址：`#/terminal/<sessionId>`，重新載入也停在同一個 session。
export const terminalHash = (sessionId: string) => `#/terminal/${encodeURIComponent(sessionId)}`;

export function sessionFromHash(hash: string): string | null {
  const [route, segment] = hash.replace(/^#\/?/, '').split('/');
  if (route !== 'terminal' || !segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
