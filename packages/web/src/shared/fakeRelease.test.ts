// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseOverview } from '@agent-board/protocol';
import { demoSnapshot } from './fakeBackend';
import { createFakeReleases, FAKE_UPDATE_STEP_MS } from './fakeRelease';

const codeOf = (e: unknown) => (e as { code?: string }).code;

describe('假的機器面板（demo／e2e）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const snapshot = demoSnapshot();
    const releases = createFakeReleases(
      () => snapshot.machines,
      (id) => snapshot.sessions.filter((s) => s.machineId === id).map((s) => s.status),
    );
    return { snapshot, releases };
  };

  it('一開始：canary 0.1.1、stable 0.1.0，三台各一種狀態，符合 protocol 的形狀', async () => {
    const { releases } = setup();
    const overview = await releases.releases();
    expect(ReleaseOverview.parse(overview)).toEqual(overview);
    expect([overview.canary, overview.stable, overview.gh.state]).toEqual(['0.1.1', '0.1.0', 'ok']);
    const phase = Object.fromEntries(overview.machines.map((m) => [m.machineId, m.update?.phase]));
    expect(phase).toEqual({
      'm-studio': 'deferred',
      'm-gpu': 'succeeded',
      'm-laptop': 'rolled_back',
    });
  });

  it('升 stable：不到 24 小時要第二次確認；確認後 stable 換版', async () => {
    const { releases } = setup();
    await expect(releases.promoteRelease('0.1.1', false)).rejects.toSatisfy(
      (e) => codeOf(e) === 'canary_too_new',
    );
    await expect(releases.promoteRelease('9.9.9', true)).rejects.toSatisfy(
      (e) => codeOf(e) === 'not_cached',
    );
    const overview = await releases.promoteRelease('0.1.1', true);
    expect(overview.stable).toBe('0.1.1');
    expect(overview.machines.find((m) => m.machineId === 'm-studio')!.targetVersion).toBe('0.1.1');
  });

  it('立即更新：有 session 在等你允許就延後；切通道、更新、回滾會改資料', async () => {
    const { snapshot, releases } = setup();
    let overview = await releases.updateMachine('m-studio');
    expect(overview.machines.find((m) => m.machineId === 'm-studio')!.update).toMatchObject({
      phase: 'deferred',
      reason: 'waiting_permission',
    });
    // 允許之後就能更新
    for (const s of snapshot.sessions) if (s.machineId === 'm-studio') s.status = 'running';
    overview = await releases.updateMachine('m-studio');
    expect(overview.machines.find((m) => m.machineId === 'm-studio')!.update?.phase).toBe(
      'downloading',
    );
    await vi.advanceTimersByTimeAsync(FAKE_UPDATE_STEP_MS * 4);
    overview = await releases.releases();
    const studio = overview.machines.find((m) => m.machineId === 'm-studio')!;
    expect([studio.version, studio.previousVersion, studio.update?.phase]).toEqual([
      '0.1.0',
      '0.0.9',
      'succeeded',
    ]);

    overview = await releases.setMachineChannel('m-studio', 'canary');
    expect(overview.machines.find((m) => m.machineId === 'm-studio')!.targetVersion).toBe('0.1.1');

    await releases.rollbackMachine('m-gpu');
    await vi.advanceTimersByTimeAsync(FAKE_UPDATE_STEP_MS * 2);
    const gpu = (await releases.releases()).machines.find((m) => m.machineId === 'm-gpu')!;
    expect([gpu.version, gpu.previousVersion]).toEqual(['0.1.0', null]);
    await expect(releases.rollbackMachine('m-gpu')).rejects.toSatisfy(
      (e) => codeOf(e) === 'no_previous',
    );
  });

  it('離線的機器不能更新或回滾；清掉 repo 時 gh 狀態是 no_repo', async () => {
    const { releases } = setup();
    await expect(releases.updateMachine('m-laptop')).rejects.toSatisfy(
      (e) => codeOf(e) === 'machine_offline',
    );
    await expect(releases.rollbackMachine('m-laptop')).rejects.toSatisfy(
      (e) => codeOf(e) === 'machine_offline' || codeOf(e) === 'no_previous',
    );
    const overview = await releases.setReleaseRepo(null);
    expect([overview.repo, overview.gh.state]).toEqual([null, 'no_repo']);
  });
});
