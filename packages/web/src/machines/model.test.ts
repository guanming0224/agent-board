// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CANARY_SOAK_MS,
  UpdatePhase,
  UpdateReason,
  type MachineRelease,
  type UpdateState,
} from '@agent-board/protocol';
import { translate } from '../shared/i18n';
import { en, zhTW } from './messages';
import {
  canarySoak,
  canaryTroubled,
  formatAge,
  ghProblem,
  isRepo,
  promoteBlock,
  releaseStatus,
  rollbackBlock,
  shortBuild,
  spanParts,
  statusText,
  statusTone,
  updateBlock,
} from './model';

const update = (phase: UpdateState['phase'], over: Partial<UpdateState> = {}): UpdateState => ({
  phase,
  fromVersion: '0.1.0',
  toVersion: '0.1.1',
  reason: null,
  detail: null,
  at: '2026-11-11T00:00:00.000Z',
  ...over,
});

const machine = (over: Partial<MachineRelease> = {}): MachineRelease => ({
  machineId: 'm1',
  name: 'mini',
  os: 'darwin',
  online: true,
  lastSeenAt: '2026-11-11T00:00:00.000Z',
  platform: 'darwin-arm64',
  version: '0.1.0',
  buildId: '0123456789abcdef',
  protocolVersion: 1,
  previousVersion: '0.0.9',
  channel: 'stable',
  targetVersion: '0.1.0',
  compat: 'ok',
  hasHub: false,
  update: null,
  ...over,
});

describe('更新狀態（MachineRelease → 畫面）', () => {
  it('最新、待更新、沒有目標、版本未知', () => {
    expect(releaseStatus(machine())).toEqual({ kind: 'latest' });
    expect(releaseStatus(machine({ targetVersion: '0.1.1' }))).toEqual({
      kind: 'pending',
      toVersion: '0.1.1',
    });
    expect(releaseStatus(machine({ targetVersion: null }))).toEqual({ kind: 'no_target' });
    expect(releaseStatus(machine({ version: null }))).toEqual({ kind: 'unknown' });
    // 成功過也是最新
    expect(releaseStatus(machine({ update: update('succeeded', { toVersion: '0.1.0' }) }))).toEqual(
      { kind: 'latest' },
    );
  });

  it('相容性最優先：hub 太舊、需要更新', () => {
    expect(
      releaseStatus(machine({ compat: 'hub_too_old', update: update('downloading') })).kind,
    ).toBe('hub_too_old');
    expect(releaseStatus(machine({ compat: 'needs_update', version: null })).kind).toBe(
      'needs_update',
    );
  });

  it('進行中、延後（含原因）', () => {
    for (const phase of ['downloading', 'installing', 'checking', 'rolling_back'] as const) {
      expect(releaseStatus(machine({ update: update(phase) }))).toEqual({
        kind: 'updating',
        phase,
        toVersion: '0.1.1',
      });
    }
    expect(
      releaseStatus(
        machine({
          targetVersion: '0.1.1',
          update: update('deferred', { reason: 'waiting_permission' }),
        }),
      ),
    ).toEqual({ kind: 'deferred', reason: 'waiting_permission', toVersion: '0.1.1' });
  });

  it('失敗、已回滾、回滾失敗；之後版本已經是目標就不再顯示失敗', () => {
    const rolled = machine({
      targetVersion: '0.1.1',
      update: update('rolled_back', { reason: 'health_timeout' }),
    });
    expect(releaseStatus(rolled)).toEqual({
      kind: 'failed',
      phase: 'rolled_back',
      reason: 'health_timeout',
      toVersion: '0.1.1',
    });
    expect(releaseStatus(machine({ targetVersion: '0.1.1', update: update('failed') })).kind).toBe(
      'failed',
    );
    expect(
      releaseStatus(machine({ targetVersion: '0.1.1', update: update('rollback_failed') })).kind,
    ).toBe('failed');
    expect(releaseStatus({ ...rolled, version: '0.1.1' })).toEqual({ kind: 'latest' });
  });

  it('手動回滾成功（succeeded＋rollback_requested）、開發模式（idle＋not_installed）', () => {
    const back = machine({
      version: '0.0.9',
      targetVersion: '0.1.0',
      update: update('succeeded', {
        fromVersion: '0.1.0',
        toVersion: '0.0.9',
        reason: 'rollback_requested',
      }),
    });
    expect(releaseStatus(back)).toEqual({ kind: 'rolled_back', toVersion: '0.0.9' });
    const zh = (key: string, vars?: Record<string, string | number>) =>
      translate('zh-TW', key, vars);
    expect(statusText(releaseStatus(back), zh)).toBe('已手動回滾到 0.0.9');
    // 回滾後可以再按「立即更新」回到目標版本
    expect(updateBlock(back)).toBeNull();

    const dev = machine({
      targetVersion: '0.1.1',
      update: update('idle', { reason: 'not_installed' }),
    });
    expect(releaseStatus(dev)).toEqual({ kind: 'dev' });
    expect(statusText({ kind: 'dev' }, zh)).toBe('開發模式，不自動更新');
    expect(updateBlock(dev)).toBe('dev');
    expect(rollbackBlock(dev)).toBe('dev');
    // schema_changed 要人處理：失敗原因翻得出來
    expect(
      statusText(
        { kind: 'failed', phase: 'failed', reason: 'schema_changed', toVersion: null },
        zh,
      ),
    ).toContain('hub 資料庫升級過');
  });

  it('語氣：失敗與 hub 太舊紅、延後與需要更新琥珀、其他不上色', () => {
    expect(statusTone({ kind: 'failed', phase: 'failed', reason: null, toVersion: null })).toBe(
      'fault',
    );
    expect(statusTone({ kind: 'hub_too_old' })).toBe('fault');
    expect(statusTone({ kind: 'deferred', reason: null, toVersion: null })).toBe('you');
    expect(statusTone({ kind: 'needs_update' })).toBe('you');
    expect(statusTone({ kind: 'latest' })).toBe('plain');
  });

  it('狀態文字：原因代碼翻成中文與英文', () => {
    const zh = (key: string, vars?: Record<string, string | number>) =>
      translate('zh-TW', key, vars);
    const enT = (key: string, vars?: Record<string, string | number>) => translate('en', key, vars);
    const deferred = releaseStatus(
      machine({
        targetVersion: '0.1.1',
        update: update('deferred', { reason: 'waiting_permission' }),
      }),
    );
    expect(statusText(deferred, zh)).toBe('延後：有 session 在等你允許');
    expect(statusText(deferred, enT)).toBe('Deferred: a session is waiting for your approval');
    const rolled = releaseStatus(
      machine({
        targetVersion: '0.1.1',
        update: update('rolled_back', { reason: 'health_timeout' }),
      }),
    );
    expect(statusText(rolled, zh)).toBe('失敗已回滾：60 秒內健康檢查沒過');
    expect(statusText({ kind: 'failed', phase: 'failed', reason: null, toVersion: null }, zh)).toBe(
      '失敗：原因不明',
    );
    expect(statusText({ kind: 'updating', phase: 'installing', toVersion: '0.1.1' }, zh)).toBe(
      '更新中：安裝中',
    );
    expect(statusText({ kind: 'latest' }, zh)).toBe('最新');
    expect(statusText({ kind: 'needs_update' }, enT)).toBe(
      'Needs update: daemon too old for the hub',
    );
    expect(statusText({ kind: 'pending', toVersion: '0.2.0' }, zh)).toBe('待更新到 0.2.0');
  });

  it('每個原因代碼與進行中的階段都有中英文', () => {
    for (const reason of UpdateReason.options) {
      expect(zhTW[`machines.reason.${reason}`], reason).toBeTruthy();
      expect(en[`machines.reason.${reason}`], reason).toBeTruthy();
    }
    for (const phase of ['downloading', 'installing', 'checking', 'rolling_back']) {
      expect(UpdatePhase.options).toContain(phase);
      expect(zhTW[`machines.phase.${phase}`]).toBeTruthy();
      expect(en[`machines.phase.${phase}`]).toBeTruthy();
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
  });
});

describe('按鈕能不能按', () => {
  it('立即更新：離線、進行中、沒有目標、已是目標不能按；失敗過可以再試', () => {
    expect(updateBlock(machine({ online: false, targetVersion: '0.1.1' }))).toBe('offline');
    expect(updateBlock(machine({ targetVersion: '0.1.1', update: update('checking') }))).toBe(
      'busy',
    );
    expect(updateBlock(machine({ targetVersion: null }))).toBe('no_target');
    expect(updateBlock(machine())).toBe('latest');
    expect(updateBlock(machine({ targetVersion: '0.1.1' }))).toBeNull();
    expect(updateBlock(machine({ update: update('failed', { toVersion: '0.1.0' }) }))).toBeNull();
  });

  it('回滾：沒有上一版最先說明，其次離線、進行中', () => {
    expect(rollbackBlock(machine({ previousVersion: null, online: false }))).toBe('no_previous');
    expect(rollbackBlock(machine({ online: false }))).toBe('offline');
    expect(rollbackBlock(machine({ update: update('rolling_back') }))).toBe('busy');
    expect(rollbackBlock(machine())).toBeNull();
  });

  it('升為 stable：沒有 canary、canary 不比 stable 新不能按', () => {
    expect(promoteBlock({ canary: null, stable: '0.1.0' })).toBe('no_canary');
    expect(promoteBlock({ canary: '0.1.0', stable: '0.1.0' })).toBe('same');
    expect(promoteBlock({ canary: '0.1.0', stable: '0.1.1' })).toBe('same');
    expect(promoteBlock({ canary: '0.1.1', stable: '0.1.0' })).toBeNull();
    expect(promoteBlock({ canary: '0.1.0', stable: null })).toBeNull();
    expect(promoteBlock({ canary: '0.2.0', stable: '0.2.0-rc.1' })).toBeNull();
  });
});

describe('canary 跑了多久', () => {
  const stats = (since: string | null, n = 0) => ({
    canaryStats: { since, errors: n, disconnects: 0, updateFailures: 0 },
  });
  const now = Date.parse('2026-11-11T12:00:00.000Z');

  it('不到 24 小時要再確認；滿了不用；沒有 canary 為 null', () => {
    expect(canarySoak(stats('2026-11-11T06:00:00.000Z'), now)).toEqual({
      ms: 6 * 3600_000,
      short: true,
    });
    expect(canarySoak(stats(new Date(now - CANARY_SOAK_MS).toISOString()), now)).toEqual({
      ms: CANARY_SOAK_MS,
      short: false,
    });
    expect(canarySoak(stats(null), now)).toEqual({ ms: null, short: true });
    // 時鐘比 hub 慢：不出現負數
    expect(canarySoak(stats('2026-11-11T13:00:00.000Z'), now).ms).toBe(0);
  });

  it('期間有任何 ERR／斷線／更新失敗就標出來', () => {
    expect(canaryTroubled(stats(null).canaryStats)).toBe(false);
    expect(canaryTroubled(stats(null, 2).canaryStats)).toBe(true);
  });

  it('時長文字', () => {
    expect(spanParts(26 * 3600_000 + 5 * 60_000)).toEqual({ d: 1, h: 2, m: 5 });
    const zh = (key: string, vars?: Record<string, string | number>) =>
      translate('zh-TW', key, vars);
    expect(formatAge(26 * 3600_000 + 5 * 60_000, zh)).toBe('1 天 2 小時');
    expect(formatAge(6 * 3600_000 + 12 * 60_000, zh)).toBe('6 小時 12 分');
    expect(formatAge(59_000, zh)).toBe('0 分');
  });
});

describe('其他小工具', () => {
  it('gh 狀態：ok、還沒檢查過不算問題', () => {
    expect(ghProblem('ok')).toBe(false);
    expect(ghProblem('unknown')).toBe(false);
    for (const state of ['missing', 'not_logged_in', 'no_repo', 'error'] as const) {
      expect(ghProblem(state)).toBe(true);
    }
  });

  it('buildId 前 8 碼；repo 格式 owner/name', () => {
    expect(shortBuild('0123456789abcdef')).toBe('01234567');
    expect(shortBuild(null)).toBeNull();
    expect(isRepo('demo-owner/agent-board')).toBe(true);
    expect(isRepo('  a/b  ')).toBe(true);
    expect(isRepo('agent-board')).toBe(false);
    expect(isRepo('a/b/c')).toBe(false);
    expect(isRepo('')).toBe(false);
  });
});
