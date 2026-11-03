// 用量的共用狀態與定期查詢（純函式在 usage.ts）。
import { useEffect } from 'react';
import { create } from 'zustand';
import { useBoard } from '../shared/store';
import { fetchUsage, USAGE_REFRESH_MS, type UsageState } from './usage';

export const useUsageStore = create<UsageState>(() => ({
  byMachine: {},
  loaded: false,
  failed: false,
}));

/**
 * 定期向 hub 要用量。只由頁首掛（頁首在所有有側欄的畫面都在），側欄直接讀 useUsageStore，
 * 免得兩邊各問一次。機器清單或上線狀態變了立刻重問：daemon 一連上就會回報。
 */
export function useUsagePolling(): void {
  const backend = useBoard((s) => s.backend);
  const connected = useBoard((s) => s.connected);
  const machineKey = useBoard((s) =>
    s.machines.map((m) => `${m.id}:${m.online ? 1 : 0}`).join(','),
  );

  useEffect(() => {
    if (!connected) return;
    const ids = machineKey ? machineKey.split(',').map((x) => x.slice(0, x.lastIndexOf(':'))) : [];
    let live = true;
    const tick = async () => {
      const next = await fetchUsage(backend, ids, useUsageStore.getState().byMachine);
      if (live) useUsageStore.setState({ ...next, loaded: true });
    };
    void tick();
    const timer = setInterval(() => void tick(), USAGE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [backend, connected, machineKey]);
}
