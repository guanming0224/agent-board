// 發版與自動更新的純函式（CONTRACTS §21）。
import { describe, expect, it } from 'vitest';
import {
  channelTarget,
  compareVersions,
  isVersion,
  parseSha256Sums,
  platformKey,
  PROTOCOL_VERSION,
  protocolCompat,
  releaseAssetName,
  updateDeferReason,
  versionFromTag,
} from './release';
import { DaemonToHub, HubToDaemon } from './ws';

describe('版本比較', () => {
  it('主、次、修依數字比，不是字串', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.2', '0.1.10')).toBeLessThan(0);
  });

  it('預發布比正式版小，預發布內依 semver 規則', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('0.0.0-legacy', '0.1.0')).toBeLessThan(0);
  });

  it('排序結果正確；不是版本的排最前面', () => {
    const sorted = ['0.2.0', 'garbage', '0.1.0', '0.2.0-rc.1', '0.10.0'].sort(compareVersions);
    expect(sorted).toEqual(['garbage', '0.1.0', '0.2.0-rc.1', '0.2.0', '0.10.0']);
  });

  it('tag 轉版本；不是 v<semver> 的不收', () => {
    expect(versionFromTag('v0.1.2')).toBe('0.1.2');
    expect(versionFromTag('v1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(versionFromTag('0.1.2')).toBeNull();
    expect(versionFromTag('v1.2')).toBeNull();
    expect(versionFromTag('v01.2.3')).toBeNull();
    expect(isVersion('0.1.0+build')).toBe(false);
  });
});

describe('通道目標', () => {
  it('canary 跟 canary，沒有就跟 stable；stable 只跟 stable', () => {
    expect(channelTarget('canary', { canary: '0.2.0', stable: '0.1.0' })).toBe('0.2.0');
    expect(channelTarget('canary', { canary: null, stable: '0.1.0' })).toBe('0.1.0');
    expect(channelTarget('stable', { canary: '0.2.0', stable: '0.1.0' })).toBe('0.1.0');
    expect(channelTarget('stable', { canary: '0.2.0', stable: null })).toBeNull();
  });

  it('stable 比 canary 新（升了更新的版本）時 canary 也跟 stable', () => {
    expect(channelTarget('canary', { canary: '0.2.0', stable: '0.3.0' })).toBe('0.3.0');
  });
});

describe('平台與成品', () => {
  it('Node 的 win32 寫成 win', () => {
    expect(platformKey('win32', 'x64')).toBe('win-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
  });

  it('檔名：Windows 是 zip，其他是 tar.gz', () => {
    expect(releaseAssetName('0.1.0', 'darwin-arm64')).toBe('agent-board-0.1.0-darwin-arm64.tar.gz');
    expect(releaseAssetName('0.1.0', 'win-x64')).toBe('agent-board-0.1.0-win-x64.zip');
  });

  it('SHA256SUMS：sha256sum 格式（含 * 二進位標記），壞行略過、hex 轉小寫', () => {
    const a = 'A'.repeat(64);
    const b = 'b'.repeat(64);
    const sums = parseSha256Sums(
      `${a}  x.tar.gz\r\n${b} *y.zip\nnot a line\n${'c'.repeat(10)}  z\n`,
    );
    expect([...sums]).toEqual([
      ['x.tar.gz', 'a'.repeat(64)],
      ['y.zip', b],
    ]);
  });
});

describe('延後條件', () => {
  it('有 PERM 一律延後', () => {
    expect(updateDeferReason(['running', 'waiting_permission'], false)).toBe('waiting_permission');
  });

  it('不換 session host 時 RUN、PLAN 不擋', () => {
    expect(updateDeferReason(['running', 'plan_review', 'starting', 'done'], false)).toBeNull();
  });

  it('要換 session host 時 RUN／PLAN／starting 都延後，ASK、DONE 不擋', () => {
    expect(updateDeferReason(['running'], true)).toBe('host_busy');
    expect(updateDeferReason(['plan_review'], true)).toBe('host_busy');
    expect(updateDeferReason(['starting'], true)).toBe('host_busy');
    expect(updateDeferReason(['waiting_input', 'done', 'error'], true)).toBeNull();
  });
});

describe('協定版本相容（§21.4）', () => {
  it('hub 接受目前版、前一版與新一版的 daemon', () => {
    expect(protocolCompat(3, 3)).toBe('ok');
    expect(protocolCompat(3, 2)).toBe('ok');
    expect(protocolCompat(3, 4)).toBe('ok');
  });

  it('差兩版以上：舊的要更新 daemon、新的要更新 hub', () => {
    expect(protocolCompat(3, 1)).toBe('needs_update');
    expect(protocolCompat(3, 5)).toBe('hub_too_old');
  });

  it('hello 不帶新欄位（舊 daemon）照樣收；壞掉的 update 當沒送', () => {
    const parsed = DaemonToHub.parse({
      type: 'daemon.hello',
      name: 'm',
      os: 'darwin',
      version: '0.0.0',
      capabilities: {
        hasGpu: false,
        gpuName: null,
        cpuCores: 1,
        memoryBytes: 1,
        claudeVersion: null,
      },
      sessions: [],
      pendingApprovals: [],
      update: { phase: 'nope' },
    });
    expect(parsed.type === 'daemon.hello' && parsed.protocolVersion).toBeUndefined();
    expect(parsed.type === 'daemon.hello' && parsed.update).toBeUndefined();
  });

  it('welcome 帶協定版本與目標；daemon.rejected 帶可更新到的版本', () => {
    const target = {
      version: '0.2.0',
      platform: 'darwin-arm64',
      asset: 'agent-board-0.2.0-darwin-arm64.tar.gz',
      sha256: 'f'.repeat(64),
      size: 10,
    };
    expect(
      HubToDaemon.parse({
        type: 'daemon.rejected',
        reason: 'needs_update',
        hubProtocolVersion: PROTOCOL_VERSION,
        release: target,
      }).type,
    ).toBe('daemon.rejected');
    expect(() =>
      HubToDaemon.parse({
        type: 'release.target',
        target: { ...target, sha256: 'xyz' },
        force: false,
      }),
    ).toThrow();
  });
});
