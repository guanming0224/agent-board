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

/**
 * 狀態以外的原因（hub push.ts 的 AttentionReason）。{n} 是上限（輪數或退回次數），{task} 是任務編號。
 * team_member_added／team_member_released（隊長自主擴編）：標題是隊長名稱，{member} 是成員名稱；理由不在推播裡。
 */
const REASON_TEXT = {
  'zh-TW': {
    handoff_round_limit: '雙向交接已來回 {n} 輪，自動交接停下，等你決定',
    task_reject_limit: '任務 #{task} 被退回 {n} 次，自動執行停下，等你決定',
    auto_continued: '額度恢復，已自動接續',
    team_member_added: '新增了成員 {member}（理由在收件匣的團隊動態）',
    team_member_released: '封存了成員 {member}（理由在收件匣的團隊動態）',
  },
  en: {
    handoff_round_limit: 'Two-way handoff reached {n} rounds and stopped. Waiting for you.',
    task_reject_limit: 'Task #{task} was sent back {n} times and stopped. Waiting for you.',
    auto_continued: 'Usage limit reset. Continued automatically.',
    team_member_added: 'Added member {member} (reason under Team activity in the inbox)',
    team_member_released: 'Released member {member} (reason under Team activity in the inbox)',
  },
};

/**
 * 合併通知（hub attention.ts 的 SummaryPayload）：一則列出所有在等你的。
 * 每一項是「名稱 + 短句」，例如「BD1 問權限、RV 退回 #3、EX 來回到上限」。
 */
const SUMMARY_TEXT = {
  'zh-TW': {
    title: '{count} 個 session 在等你',
    titleOver: '{count} 個 session 在等你（超過上限 {limit}）',
    titleNone: 'Agent Board',
    titleTeam: '團隊動態',
    sep: '、',
    more: '還有 {n} 個',
    auto: '{name} 已自動接續',
    team: {
      team_member_added: '{lead} 新增了 {member}',
      team_member_released: '{lead} 封存了 {member}',
    },
    status: {
      waiting_permission: '{name} 問權限',
      waiting_input: '{name} 等你回覆',
      plan_review: '{name} 等你審計畫',
      error: '{name} 錯誤',
      stuck: '{name} 卡住',
    },
    reason: {
      handoff_round_limit: '{name} 來回到上限',
      task_reject_limit: '{name} 退回 #{task}',
    },
    overloadTitle: '等你的 session 超過上限',
    overloadBody: '現在有 {count} 個在等你（上限 {limit}）',
  },
  en: {
    title: '{count} sessions waiting on you',
    titleOver: '{count} sessions waiting on you (over your limit of {limit})',
    titleNone: 'Agent Board',
    titleTeam: 'Team activity',
    sep: ', ',
    more: '{n} more',
    auto: '{name} auto-continued',
    team: {
      team_member_added: '{lead} added {member}',
      team_member_released: '{lead} released {member}',
    },
    status: {
      waiting_permission: '{name} needs approval',
      waiting_input: '{name} needs a reply',
      plan_review: '{name} has a plan to review',
      error: '{name} errored',
      stuck: '{name} is stuck',
    },
    reason: {
      handoff_round_limit: '{name} hit the round limit',
      task_reject_limit: '{name} sent back #{task}',
    },
    overloadTitle: 'Too many sessions waiting',
    overloadBody: '{count} are waiting on you (limit {limit})',
  },
};

/**
 * 更新失敗（發版與自動更新，hub 送 { kind: 'update_failed', machineId, machine, version, phase, reason, at }）。
 * machine 是機器名稱；phase 是 failed／rolled_back／rollback_failed；reason 是 UpdateReason 代碼或 null。
 * 原因文字和 machines/messages.ts 的 machines.reason.* 保持一致。
 */
const UPDATE_TEXT = {
  'zh-TW': {
    title: 'Agent Board 更新失敗',
    failed: '{machine}：更新到 {version} 失敗{reason}',
    rolled_back: '{machine}：{version} 已回滾{reason}',
    rollback_failed: '{machine}：{version} 回滾也失敗，需要處理{reason}',
    reasonWrap: '（{reason}）',
    reason: {
      download_failed: '下載失敗',
      checksum_mismatch: 'SHA-256 不符',
      extract_failed: '解壓失敗',
      backup_failed: '資料庫備份失敗',
      install_failed: '安裝失敗',
      health_timeout: '60 秒內健康檢查沒過',
      unsupported_platform: '這個平台沒有成品',
      not_installed: '不是用安裝程式裝的',
      no_previous: '沒有上一版',
      schema_changed: 'hub 資料庫升級過，不能自動回滾',
      interrupted: '上次的更新中斷了',
      spawn_failed: '啟動不了更新程式',
      busy: '另一個更新還在進行',
      unknown: '原因不明',
    },
  },
  en: {
    title: 'Agent Board update failed',
    failed: '{machine}: update to {version} failed{reason}',
    rolled_back: '{machine}: {version} was rolled back{reason}',
    rollback_failed: '{machine}: {version} rollback failed too, needs attention{reason}',
    reasonWrap: ' ({reason})',
    reason: {
      download_failed: 'download failed',
      checksum_mismatch: 'SHA-256 mismatch',
      extract_failed: 'extract failed',
      backup_failed: 'database backup failed',
      install_failed: 'install failed',
      health_timeout: 'health check didn’t pass within 60s',
      unsupported_platform: 'no build for this platform',
      not_installed: 'not installed by the installer',
      no_previous: 'no previous version',
      schema_changed: 'hub database was upgraded, can’t roll back automatically',
      interrupted: 'the previous update was interrupted',
      spawn_failed: 'could not start the updater',
      busy: 'another update is running',
      unknown: 'unknown reason',
    },
  },
};

const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (_, key) => (key in values ? String(values[key]) : ''));

const textOf = (value) => (typeof value === 'string' && value ? value : '?');

/** 合併通知的標題、內文、點了去哪。內容只來自 payload 的名稱、狀態與數字。 */
function summaryNotification(data, lang) {
  const text = SUMMARY_TEXT[lang];
  const items = Array.isArray(data.items) ? data.items : [];
  const autos = Array.isArray(data.autoContinued) ? data.autoContinued : [];
  const team = Array.isArray(data.team) ? data.team : [];
  const count = Number.isInteger(data.count) ? data.count : items.length;
  const parts = items.map((item) => {
    const name = textOf(item && item.name);
    const reason = item && typeof item.reason === 'string' ? text.reason[item.reason] : undefined;
    if (reason) return fill(reason, { name, task: intText(item.task) });
    return fill(text.status[item && item.status] || '{name}', { name });
  });
  if (Number.isInteger(data.more) && data.more > 0) parts.push(fill(text.more, { n: data.more }));
  for (const auto of autos) parts.push(fill(text.auto, { name: textOf(auto && auto.name) }));
  for (const entry of team) {
    const template =
      entry && typeof entry.reason === 'string' ? text.team[entry.reason] : undefined;
    if (template) {
      parts.push(fill(template, { lead: textOf(entry.lead), member: textOf(entry.member) }));
    }
  }
  const over = Number.isInteger(data.overLimit);
  const title =
    count > 0
      ? fill(over ? text.titleOver : text.title, { count, limit: data.overLimit })
      : team.length > 0 && autos.length === 0
        ? text.titleTeam
        : text.titleNone;
  // 只有一個在等你時直接捲到那一項；多個就開收件匣。
  const only = count === 1 && items[0] && typeof items[0].sessionId === 'string';
  return {
    title,
    body: parts.join(text.sep) || FALLBACK[lang].body,
    url: inboxUrl(only ? items[0].sessionId : null),
  };
}

const intText = (value) => String(Number.isInteger(value) ? value : '?');

/** 單則推播的 tag：上限、自動接續各自一則，不被同一個 session 接著來的「等你回覆」蓋掉。 */
const tagPrefix = (reason) =>
  reason === 'task_reject_limit'
    ? 'task'
    : reason === 'handoff_round_limit'
      ? 'handoff'
      : reason === 'auto_continued'
        ? 'auto'
        : reason === 'team_member_added' || reason === 'team_member_released'
          ? 'team'
          : 'session';

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
 * 團隊動態（不合併時）：{ reason: 'team_member_added'|'team_member_released', name: 隊長, member, sessionId, at }。
 * 合併通知是 { kind: 'summary', count, items, more, autoContinued, overLimit?, at }，
 * 超過上限（不合併時）是 { kind: 'overload', count, limit, at }。
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

/** 更新失敗的標題、內文。只用機器名稱、版本與代碼。 */
function updateFailedNotification(data, lang) {
  const text = UPDATE_TEXT[lang];
  const template = text[data.phase] || text.failed;
  const reason =
    typeof data.reason === 'string' && data.reason
      ? fill(text.reasonWrap, { reason: text.reason[data.reason] || text.reason.unknown })
      : '';
  return {
    title: text.title,
    body: fill(template, {
      machine: textOf(data.machine),
      version: textOf(data.version),
      reason,
    }),
  };
}

const machinesUrl = () => new URL('/#/machines', self.location.origin).href;

/** 新的一則總表取代舊的（同一個 tag），還是會響（renotify）。 */
const SUMMARY_TAG = 'agent-board-summary';
const OVERLOAD_TAG = 'agent-board-overload';
/** 更新失敗：新的一則取代舊的（多台一起失敗只留最新一則，點了在機器面板看全部）。 */
const UPDATE_TAG = 'agent-board-update';

function show(title, body, tag, url, at) {
  return self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    timestamp: typeof at === 'string' ? Date.parse(at) || Date.now() : Date.now(),
    data: { url },
  });
}

self.addEventListener('push', (event) => {
  const lang = locale();
  const data = readPayload(event);
  if (data && data.kind === 'summary') {
    const n = summaryNotification(data, lang);
    event.waitUntil(show(n.title, n.body, SUMMARY_TAG, n.url, data.at));
    return;
  }
  if (data && data.kind === 'update_failed') {
    const n = updateFailedNotification(data, lang);
    event.waitUntil(show(n.title, n.body, UPDATE_TAG, machinesUrl(), data.at));
    return;
  }
  if (data && data.kind === 'overload') {
    const text = SUMMARY_TEXT[lang];
    const values = { count: intText(data.count), limit: intText(data.limit) };
    event.waitUntil(
      show(
        text.overloadTitle,
        fill(text.overloadBody, values),
        OVERLOAD_TAG,
        inboxUrl(null),
        data.at,
      ),
    );
    return;
  }
  const reasonTemplate =
    data && typeof data.reason === 'string' ? REASON_TEXT[lang][data.reason] : undefined;
  const reason =
    reasonTemplate &&
    reasonTemplate
      .replace('{n}', intText(data.maxRounds))
      .replace('{task}', intText(data.task))
      .replace('{member}', textOf(data.member));
  const status = reason || (data && STATUS_TEXT[lang][data.status]);
  const title =
    data && typeof data.name === 'string' && data.name ? data.name : FALLBACK[lang].title;
  const sessionId = data && typeof data.sessionId === 'string' ? data.sessionId : null;
  // 同一個 session 只留最新一則；renotify 讓狀態換了還是會響。
  event.waitUntil(
    self.registration.showNotification(title, {
      body: status || FALLBACK[lang].body,
      // 上限另外一則：不能被同一個 session 接著來的「等你回覆」蓋掉。
      tag: sessionId ? `${tagPrefix(reason ? data.reason : null)}-${sessionId}` : 'agent-board',
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
