// 推播用的 service worker。只處理推播與點通知，不快取任何東西：API、WebSocket 一律直連 hub。
// vite 的 publicDir 會原樣複製到 dist 根目錄，hub 以 /sw.js、Cache-Control: no-cache 提供。
// 刻意寫成純 JS、不經打包，所以這裡的狀態文字要和 shared/i18n.ts 的 status.* 保持一致。

const STATUS_TEXT = {
  'zh-TW': {
    waiting_permission: '等你允許',
    waiting_input: '等你回覆',
    plan_review: '等你審計畫',
    error: '錯誤',
    stuck: '卡住',
  },
  en: {
    waiting_permission: 'Needs approval',
    waiting_input: 'Needs reply',
    plan_review: 'Plan review',
    error: 'Error',
    stuck: 'Stuck',
  },
};

/** 狀態以外的原因（hub push.ts 的 AttentionReason）。{n} 是上限（輪數或退回次數），{task} 是任務編號。 */
const REASON_TEXT = {
  'zh-TW': {
    handoff_round_limit: '雙向交接已來回 {n} 輪，自動交接停下，等你決定',
    task_reject_limit: '任務 #{task} 被退回 {n} 次，自動執行停下，等你決定',
  },
  en: {
    handoff_round_limit: 'Two-way handoff reached {n} rounds and stopped. Waiting for you.',
    task_reject_limit: 'Task #{task} was sent back {n} times and stopped. Waiting for you.',
  },
};

const intText = (value) => String(Number.isInteger(value) ? value : '?');

const FALLBACK = {
  'zh-TW': { title: 'Agent Board', body: '有 session 在等你' },
  en: { title: 'Agent Board', body: 'A session is waiting on you' },
};

const locale = () => (/^zh/i.test(self.navigator.language || '') ? 'zh-TW' : 'en');

/** 收件匣網址；帶 session id 時收件匣會捲到那一項。 */
const inboxUrl = (sessionId) =>
  new URL(
    typeof sessionId === 'string' && sessionId
      ? `/#/inbox/${encodeURIComponent(sessionId)}`
      : '/#/inbox',
    self.location.origin,
  ).href;

/**
 * hub 的 attentionPayload：{ sessionId, name, status, at }，有時多帶 { reason, maxRounds }。
 * 只有名稱、狀態與原因代碼，沒有終端機內容。
 */
function readPayload(event) {
  if (!event.data) return null;
  try {
    const data = event.data.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

self.addEventListener('install', () => {
  // 沒有快取要準備，新版直接接手。
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const lang = locale();
  const data = readPayload(event);
  const reasonTemplate =
    data && typeof data.reason === 'string' ? REASON_TEXT[lang][data.reason] : undefined;
  const reason =
    reasonTemplate &&
    reasonTemplate.replace('{n}', intText(data.maxRounds)).replace('{task}', intText(data.task));
  const status = reason || (data && STATUS_TEXT[lang][data.status]);
  const title =
    data && typeof data.name === 'string' && data.name ? data.name : FALLBACK[lang].title;
  const sessionId = data && typeof data.sessionId === 'string' ? data.sessionId : null;
  // 同一個 session 只留最新一則；renotify 讓狀態換了還是會響。
  event.waitUntil(
    self.registration.showNotification(title, {
      body: status || FALLBACK[lang].body,
      // 上限另外一則：不能被同一個 session 接著來的「等你回覆」蓋掉。
      tag: sessionId
        ? `${reason ? (data.reason === 'task_reject_limit' ? 'task' : 'handoff') : 'session'}-${sessionId}`
        : 'agent-board',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      timestamp:
        data && typeof data.at === 'string' ? Date.parse(data.at) || Date.now() : Date.now(),
      data: { url: inboxUrl(sessionId) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || inboxUrl(null);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // 已經開著就切過去，請頁面自己換 hash（main.tsx 的 registerServiceWorker），不重新載入。
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        // 先換頁再搶焦點：瀏覽器不准 focus（例如不是使用者點的）時至少頁面已經在收件匣。
        existing.postMessage({ type: 'agent-board.open', url });
        await existing.focus().catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
