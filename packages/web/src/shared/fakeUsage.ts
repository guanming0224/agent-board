// demo／e2e 用的用量細項（GM 2026-11-09 用量詳情）。數字是固定種子的假資料，日期跟著今天走；
// 對應到看板 session 的規則和 hub 同一份（protocol 的 buildUsageReport）。
// demo-laptop 沒回報（和頁首、側欄的 demo 一致）；要測「daemon 太舊沒細項」時 e2e 自己換掉 usageReport。
import {
  buildUsageReport,
  localUsageDay,
  shiftUsageDay,
  USAGE_DETAIL_VERSION,
  type LatestUsage,
  type Machine,
  type Project,
  type Session,
  type Team,
  type TeamMember,
  type UsageDetail,
  type UsageDetailRow,
  type UsageReport,
  type Zone,
} from '@agent-board/protocol';

const DAYS = 90;

/** 固定種子的亂數（mulberry32）：每次開 demo 數字都一樣，截圖與 e2e 才穩。 */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DemoConversation {
  id: string;
  cwd: string;
  /** 每天大約多少輸出 token。 */
  scale: number;
  /** 從幾天前開始、到幾天前為止有用量（0 = 今天）。 */
  from: number;
  to: number;
  model: number;
}

const MODELS = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];

const CONVERSATIONS: Record<string, { earliest: number; list: DemoConversation[] }> = {
  'm-studio': {
    // Claude Code 預設只留 30 天紀錄：這台最早只到 33 天前，「近 30 天」的前一期資料不完整。
    earliest: 33,
    list: [
      {
        id: '5a1e7c2d-3b4f-4a6e-9c8d-1f2e3d4c5b6a',
        cwd: '/home/demo/.agent-board-wt/fix-auth',
        scale: 26_000,
        from: 6,
        to: 0,
        model: 0,
      },
      {
        id: '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c',
        cwd: '/home/demo/.agent-board-wt/auth-tests',
        scale: 18_000,
        from: 7,
        to: 0,
        model: 1,
      },
      {
        id: '0b7c6a52-3f1e-4c2a-9a51-6f2d8e1c4b90',
        cwd: '/home/demo/api',
        scale: 30_000,
        from: 20,
        to: 2,
        model: 0,
      },
      {
        id: 'e1d2c3b4-a5f6-4789-8abc-def012345678',
        cwd: '/home/demo/scripts',
        scale: 9_000,
        from: 33,
        to: 1,
        model: 2,
      },
      {
        id: 'f0e1d2c3-b4a5-4687-9abc-0123456789ab',
        cwd: '/home/demo/notebooks',
        scale: 6_000,
        from: 14,
        to: 5,
        model: 1,
      },
    ],
  },
  'm-gpu': {
    earliest: 70,
    list: [
      {
        id: '6b2f8d3e-4c5a-4b7f-8d9e-2a3b4c5d6e7f',
        cwd: '/home/demo/project',
        scale: 14_000,
        from: 5,
        to: 0,
        model: 1,
      },
      {
        id: '7d0e2f44-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
        cwd: '/home/demo/project',
        scale: 8_000,
        from: 12,
        to: 8,
        model: 0,
      },
      {
        id: 'a9b8c7d6-e5f4-4321-8fed-cba987654321',
        cwd: '/home/demo/ml-sandbox',
        scale: 7_000,
        from: 70,
        to: 0,
        model: 2,
      },
    ],
  },
};

function demoDetail(machineId: string, today: string, seed: number): UsageDetail | null {
  const plan = CONVERSATIONS[machineId];
  if (!plan) return null;
  const rand = random(seed);
  const days = Array.from({ length: DAYS }, (_, i) => shiftUsageDay(today, i - (DAYS - 1)));
  const rows: UsageDetailRow[] = [];
  plan.list.forEach((c, s) => {
    for (let ago = c.from; ago >= c.to; ago -= 1) {
      // 週末少一點、偶爾整天沒用。
      if (rand() < 0.15) continue;
      const output = Math.round(c.scale * (0.4 + rand() * 1.2));
      const input = Math.round(output * (0.12 + rand() * 0.1));
      const read = Math.round(output * (35 + rand() * 20));
      const write = Math.round(output * (2 + rand() * 1.5));
      const d = DAYS - 1 - ago;
      rows.push([d, c.model, s, input, output, read, write]);
      // 一部分交給較小的模型（subagent 之類）。
      if (c.model === 0 && rand() < 0.5) {
        rows.push(
          [d, 2, s, Math.round(input / 4), Math.round(output / 5), read / 10, 0].map(
            Math.round,
          ) as UsageDetailRow,
        );
      }
    }
  });
  // 超過上限併進「其他」的零星 session。
  for (let ago = 20; ago >= 0; ago -= 2) {
    const output = Math.round(1_500 + rand() * 2_000);
    rows.push([DAYS - 1 - ago, 1, -1, Math.round(output / 6), output, output * 30, output * 2]);
  }
  return {
    version: USAGE_DETAIL_VERSION,
    timeZone: 'Asia/Taipei',
    days,
    models: MODELS,
    sessions: plan.list.map((c) => ({ id: c.id, cwd: c.cwd })),
    otherSessions: 4,
    earliestAt: new Date(Date.now() - plan.earliest * 24 * 60 * 60_000).toISOString(),
    rows,
  };
}

/** 總數用細項近 30 天加總（demo 不分「30×24 小時」和「30 個日曆日」）。 */
function summaryOf(machineId: string, detail: UsageDetail, countedAt: string) {
  const first = detail.days.length - 30;
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const [d, , , i, o, r, w] of detail.rows) {
    if (d < first) continue;
    sum.inputTokens += i;
    sum.outputTokens += o;
    sum.cacheReadTokens += r;
    sum.cacheCreationTokens += w;
  }
  return {
    machineId,
    from: new Date(Date.parse(countedAt) - 30 * 24 * 60 * 60_000).toISOString(),
    to: countedAt,
    ...sum,
  };
}

export function demoUsageReport(state: {
  machines: readonly Machine[];
  sessions: readonly Session[];
  teams: readonly Team[];
  members: readonly TeamMember[];
  zones: readonly Zone[];
  projects: readonly Project[];
}): UsageReport {
  const now = new Date();
  const today = localUsageDay(now);
  const countedAt = new Date(now.getTime() - 6 * 60_000).toISOString();
  const latest = new Map<string, LatestUsage>();
  state.machines.forEach((m, i) => {
    const detail = demoDetail(m.id, today, 20261109 + i);
    if (detail) {
      latest.set(m.id, { summary: summaryOf(m.id, detail, countedAt), detail, restored: false });
    }
  });
  return buildUsageReport({ now, latest, ...state });
}
