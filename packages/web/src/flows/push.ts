// 這台裝置的 Web Push：註冊 service worker、訂閱、交給 hub（CONTRACTS.md /api/push/*）。
// 判斷能不能開的邏輯寫成純函式，測試不必有瀏覽器。

/** 瀏覽器沒給 PushManager 的原因要分清楚，各自有不同的解法。 */
export type PushSupport = 'ok' | 'insecure' | 'ios-install' | 'unsupported';

export interface PushEnv {
  isSecureContext: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** 從主畫面圖示打開（iOS 的 navigator.standalone 或 display-mode: standalone）。 */
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}

export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushApi {
  pushVapidKey(): Promise<string>;
  pushSubscribe(subscription: PushSubscriptionBody): Promise<void>;
  pushUnsubscribe(endpoint: string): Promise<void>;
}

export const SERVICE_WORKER_URL = '/sw.js';
/** sw.js 點通知時送來的訊息：已經開著的分頁自己換到收件匣。 */
export const OPEN_MESSAGE = 'agent-board.open';

/** iPadOS 13 起 Safari 自稱 Mac，只能靠觸控點數分辨。 */
export function isIos(env: Pick<PushEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  return (
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    (env.platform === 'MacIntel' && env.maxTouchPoints > 1)
  );
}

export function pushSupport(env: PushEnv): PushSupport {
  // 非 HTTPS 時瀏覽器直接不給 serviceWorker，先講這個，不然使用者會以為是瀏覽器不支援。
  if (!env.isSecureContext) return 'insecure';
  const ready = env.hasServiceWorker && env.hasPushManager && env.hasNotification;
  // iOS 16.4 起只有加到主畫面的 PWA 有推播；Safari 分頁裡一律沒有。
  if (isIos(env) && !env.standalone) return 'ios-install';
  return ready ? 'ok' : 'unsupported';
}

export function readPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    isSecureContext: globalThis.isSecureContext === true,
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone:
      nav.standalone === true || globalThis.matchMedia?.('(display-mode: standalone)').matches,
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in globalThis,
    hasNotification: 'Notification' in globalThis,
  };
}

/** VAPID 公鑰是 base64url；subscribe 要原始位元組。 */
export function vapidKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 舊訂閱用的是別的公鑰（例如 hub 重建過資料）就不能沿用，要先退訂。 */
export function sameKey(current: ArrayBuffer | null | undefined, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((byte, i) => byte === wanted[i]);
}

/** PushSubscription.toJSON() 的欄位型別都是選用的，缺了就是瀏覽器給了不能用的訂閱。 */
export function subscriptionBody(json: PushSubscriptionJSON): PushSubscriptionBody | null {
  const { endpoint, keys } = json;
  if (!endpoint || !keys?.p256dh || !keys.auth) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/**
 * 頁面一載入就註冊，點通知時才有 worker 能開收件匣。
 * 已經開著的分頁收到 sw.js 的訊息就換 hash，不重新載入。
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== OPEN_MESSAGE || typeof data.url !== 'string') return;
    const url = new URL(data.url, location.href);
    if (url.origin !== location.origin) return;
    // 同一則通知點第二次：網址沒變，瀏覽器不會送 hashchange；自己送一次，收件匣才會重新捲到那一項。
    if (location.hash === url.hash) {
      dispatchEvent(
        new HashChangeEvent('hashchange', { oldURL: location.href, newURL: location.href }),
      );
    } else location.hash = url.hash;
  });
  navigator.serviceWorker.register(SERVICE_WORKER_URL).catch(() => {
    // 註冊失敗只影響推播；設定頁開推播時會再試一次並顯示原因。
  });
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ? existing.pushManager.getSubscription() : null;
}

export type EnableResult = 'on' | 'denied' | 'dismissed';

/**
 * 必須直接由點擊觸發：Safari 只在使用者動作當下准許 requestPermission，
 * 所以公鑰要事先拿好（publicKey），不能先 await 網路再要權限。
 */
export async function enablePush(api: PushApi, publicKey?: string): Promise<EnableResult> {
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'dismissed';
  const key = vapidKeyBytes(publicKey ?? (await api.pushVapidKey()));
  const reg = await registration();
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  const body = subscriptionBody(subscription.toJSON());
  if (!body) {
    await subscription.unsubscribe();
    throw new Error('browser returned an incomplete subscription');
  }
  try {
    await api.pushSubscribe(body);
  } catch (error) {
    // hub 沒記下來就不算開啟，不留一個收不到東西的訂閱。
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }
  return 'on';
}

/** 先通知 hub 再退訂；hub 沒回應也照樣退訂，hub 之後送出時會收到 410 自己清掉。 */
export async function disablePush(api: PushApi): Promise<{ hubError: unknown }> {
  const subscription = await currentSubscription();
  if (!subscription) return { hubError: null };
  let hubError: unknown = null;
  try {
    await api.pushUnsubscribe(subscription.endpoint);
  } catch (error) {
    hubError = error;
  }
  await subscription.unsubscribe();
  return { hubError };
}
