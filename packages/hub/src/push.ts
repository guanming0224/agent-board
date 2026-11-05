// Web Push。傳送層可注入：測試不打外部服務。
import webpush from 'web-push';
import type { Session, Settings } from '@agent-board/protocol';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export type PushResult = 'ok' | 'gone' | 'retry' | 'failed';

export interface PushTransport {
  send(
    subscription: PushSubscriptionRecord,
    payload: string,
    vapid: VapidKeys,
    subject: string,
  ): Promise<PushResult>;
}

const PUSH_TIMEOUT_MS = 10_000;

export const webPushTransport: PushTransport = {
  async send(subscription, payload, vapid, subject) {
    try {
      await webpush.sendNotification(subscription, payload, {
        TTL: 3600,
        urgency: 'high',
        timeout: PUSH_TIMEOUT_MS,
        vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      });
      return 'ok';
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      if (status === undefined || status === 429 || status >= 500) return 'retry';
      return 'failed';
    }
  },
};

export const generateVapidKeys = (): VapidKeys => webpush.generateVAPIDKeys();

const minutes = (value: string): number | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export const isValidClockTime = (value: string): boolean => minutes(value) !== null;

/** 以 hub 所在機器的時區判斷；start > end 表示跨午夜。start == end 視為沒有勿擾。 */
export function inQuietHours(quiet: Settings['notifications']['quietHours'], at: Date): boolean {
  if (!quiet) return false;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  if (start === null || end === null || start === end) return false;
  const current = at.getHours() * 60 + at.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** 狀態以外要人決定的事。目前只有雙向交接來回到上限（迴圈停下等使用者）。 */
export interface AttentionReason {
  reason: 'handoff_round_limit';
  maxRounds: number;
}

/**
 * 推播內容經過第三方推播服務（已加密），只放 session 名稱與狀態，絕不放終端機內容。
 * 有 `extra` 時多帶原因代碼與輪數（數字，不是內容）。
 */
export const attentionPayload = (session: Session, extra?: AttentionReason): string =>
  JSON.stringify({
    sessionId: session.id,
    name: session.name,
    status: session.status,
    at: session.statusSince,
    ...extra,
  });

/** 擋掉明顯指向內網的 endpoint：hub 會對這個網址發 POST，不能變成內網探測工具。 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  return !host.endsWith('.ts.net');
}
