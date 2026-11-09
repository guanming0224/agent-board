// 推播端對端：真 hub、vite build 出來的 sw.js、真的 service worker 註冊與通知權限。
// headless Chromium 沒有推播服務（subscribe 會 AbortError），所以只把 PushManager 換成假的，
// 其餘（權限、註冊、公鑰、POST／DELETE 給 hub、hub 檢查 endpoint）都是真的。真手機推播這裡驗不到。
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';

const HUB = 'http://127.0.0.1:5191';

/** e2e 的 tsconfig 沒有 WebWorker lib；worker.evaluate 裡只用到這些。 */
type EventCtor = new (type: string, init: Record<string, unknown>) => Event;
type WorkerScope = EventTarget & {
  registration: ServiceWorkerRegistration;
  PushEvent: EventCtor;
  NotificationEvent: EventCtor;
};
const ENDPOINT = 'https://push.example/e2e-device';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
const violations: string[] = [];

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: 'zh-TW' });
  const setup = await context.request.post(`${HUB}/api/auth/setup`, {
    headers: { origin: HUB },
    data: { name: 'owner', password: 'push-e2e-password', locale: 'zh-TW' },
  });
  expect(setup.ok()).toBe(true);
  await context.grantPermissions(['notifications'], { origin: HUB });
  // 假的 PushManager：記下 app 傳進來的公鑰，回一個 hub 會接受的 https endpoint。
  await context.addInitScript((endpoint) => {
    const w = window as unknown as Record<string, unknown>;
    const b64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    let current: unknown = null;
    PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
    PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
      const key = new Uint8Array(options!.applicationServerKey as Uint8Array);
      w.__pushKey = b64url(key);
      const subscription = {
        endpoint,
        options: { applicationServerKey: key.buffer, userVisibleOnly: true },
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'p256', auth: 'auth' } }),
        unsubscribe: async () => {
          current = null;
          w.__unsubscribed = true;
          return true;
        },
      };
      current = subscription;
      return subscription as unknown as PushSubscription;
    };
  }, ENDPOINT);
  page = await context.newPage();
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
});

test.afterAll(async () => {
  await context.close();
});

async function serviceWorker(): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

test('hub 提供 /sw.js：JavaScript、no-cache、CSP 允許同源 worker', async () => {
  const res = await context.request.get(`${HUB}/sw.js`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/javascript/);
  expect(res.headers()['cache-control']).toBe('no-cache');
  expect(res.headers()['content-security-policy']).toContain("worker-src 'self'");
  expect(await res.text()).toContain("addEventListener('push'");
});

test('載入就註冊 service worker，scope 是整個網站', async () => {
  await page.goto(`${HUB}/#/settings`);
  const reg = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return { scope: ready.scope, script: ready.active?.scriptURL };
  });
  expect(reg).toEqual({ scope: `${HUB}/`, script: `${HUB}/sw.js` });
});

test('設定頁開啟推播：用 hub 的公鑰訂閱並送給 hub；關閉時通知 hub 再退訂', async () => {
  await page.goto(`${HUB}/#/settings`);
  const section = page.locator('#s-push');
  await expect(section.getByTestId('push-state')).toHaveText('這台裝置目前不收推播。');
  // 狀態晶片（審視報告 inbox #26）：關著是灰框，開著是白框。
  await expect(section.getByTestId('push-chip')).toHaveText('推播：關');
  await expect(section.getByTestId('push-chip')).not.toHaveClass(/\bon\b/);

  const posted = page.waitForRequest(
    (r) => r.url() === `${HUB}/api/push/subscriptions` && r.method() === 'POST',
  );
  await section.getByRole('button', { name: '在這台裝置開啟推播' }).click();
  const post = await posted;
  expect(post.postDataJSON()).toEqual({
    endpoint: ENDPOINT,
    keys: { p256dh: 'p256', auth: 'auth' },
  });
  expect((await post.response())!.status()).toBe(200);
  await expect(section.getByTestId('push-state')).toHaveText('這台裝置會收到推播。');
  await expect(section.getByTestId('push-chip')).toHaveText('推播：開');
  await expect(section.getByTestId('push-chip')).toHaveCSS('border-color', 'rgb(255, 255, 255)');
  await expect(section.getByRole('status')).toContainText('已開啟');

  const { publicKey } = await (await context.request.get(`${HUB}/api/push/vapid-key`)).json();
  expect(await page.evaluate(() => (window as unknown as { __pushKey: string }).__pushKey)).toBe(
    publicKey,
  );

  const deleted = page.waitForRequest(
    (r) => r.url() === `${HUB}/api/push/subscriptions` && r.method() === 'DELETE',
  );
  await section.getByRole('button', { name: '關閉這台裝置的推播' }).click();
  const del = await deleted;
  expect(del.postDataJSON()).toEqual({ endpoint: ENDPOINT });
  expect((await del.response())!.status()).toBe(200);
  await expect(section.getByTestId('push-state')).toHaveText('這台裝置目前不收推播。');
  expect(
    await page.evaluate(() => (window as unknown as { __unsubscribed: boolean }).__unsubscribed),
  ).toBe(true);
  expect(violations).toEqual([]);
});

test('service worker 收到 hub 格式的推播就顯示通知；點通知把開著的分頁帶到收件匣那一項', async () => {
  await page.goto(`${HUB}/#/canvas`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const worker = await serviceWorker();
  const shown = await worker.evaluate(async () => {
    const scope = self as unknown as WorkerScope;
    const data = JSON.stringify({
      sessionId: 's-e2e',
      name: 'api 重構',
      status: 'waiting_permission',
      at: new Date().toISOString(),
    });
    // 合成事件的 waitUntil 會丟 InvalidStateError，但 handler 已經開始做事，等通知出現就好。
    try {
      scope.dispatchEvent(new scope.PushEvent('push', { data }));
    } catch {
      // 見上
    }
    for (let i = 0; i < 50; i++) {
      const [notification] = await scope.registration.getNotifications();
      if (notification) {
        return {
          title: notification.title,
          body: notification.body,
          tag: notification.tag,
          data: notification.data as unknown,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  });
  expect(shown).toEqual({
    title: 'api 重構',
    body: expect.stringMatching(/^(等你允許|Needs approval)$/),
    tag: 'session-s-e2e',
    data: { url: `${HUB}/#/inbox/s-e2e` },
  });

  await worker.evaluate(async () => {
    const scope = self as unknown as WorkerScope;
    const [notification] = await scope.registration.getNotifications();
    try {
      scope.dispatchEvent(
        new scope.NotificationEvent('notificationclick', { notification: notification! }),
      );
    } catch {
      // 合成事件的 waitUntil，同上
    }
  });
  await expect(page).toHaveURL(`${HUB}/#/inbox/s-e2e`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('收件匣');
});
