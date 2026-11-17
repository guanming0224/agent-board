// 連不上 session host 時把它拉起來（CONTRACTS §20.2）：它是另一個服務，不是 daemon 的子程序
// （launchd 停 daemon 會殺掉整個程序群組，agent 要活下來就不能掛在 daemon 底下）。
import { execFile } from 'node:child_process';
import { errorMessage, log } from './log';

const LAUNCH_TIMEOUT_MS = 5_000;

/** 服務管理程式的指令（純函式，方便測試）。不認得的平台回 null。 */
export function launchCommand(
  service: string,
  platform: NodeJS.Platform = process.platform,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
): { command: string; args: string[] } | null {
  if (platform === 'darwin' && uid !== null) {
    return { command: 'launchctl', args: ['kickstart', `gui/${uid}/${service}`] };
  }
  if (platform === 'linux') return { command: 'systemctl', args: ['--user', 'start', service] };
  if (platform === 'win32') return { command: 'schtasks', args: ['/Run', '/TN', service] };
  return null;
}

/** 叫服務管理程式啟動 session host；回傳指令有沒有成功（不代表 host 已經能連）。 */
export function launchSessionHost(service: string): Promise<boolean> {
  const launch = launchCommand(service);
  if (!launch) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(launch.command, launch.args, { timeout: LAUNCH_TIMEOUT_MS }, (error) => {
      if (error) log.warn(`無法啟動 session host（${service}）：${errorMessage(error)}`);
      resolve(!error);
    });
  });
}

/**
 * 重啟 session host 的指令（機器面板「重啟 session host」，CONTRACTS §20.8）。host 會先把養著的 agent 全部結束
 * （送 shutdown 給 daemon），再由服務管理程式重開。只支援 macOS（launchctl kickstart -k）與 Linux（systemctl restart）：
 * Windows 的 schtasks /End 收不到 cmd 底下的 node（事故 6），不在這裡做。不支援回 null。
 */
export function restartCommand(
  service: string,
  platform: NodeJS.Platform = process.platform,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
): { command: string; args: string[] } | null {
  if (platform === 'darwin' && uid !== null) {
    return { command: 'launchctl', args: ['kickstart', '-k', `gui/${uid}/${service}`] };
  }
  if (platform === 'linux') return { command: 'systemctl', args: ['--user', 'restart', service] };
  return null;
}

/** 叫服務管理程式重啟 session host；回傳指令有沒有成功。 */
export function restartSessionHost(service: string): Promise<boolean> {
  const restart = restartCommand(service);
  if (!restart) return Promise.resolve(false);
  return new Promise((resolve) => {
    // host 結束 agent 最多要 4 秒左右，kickstart -k 會等它結束：時限放寬。
    execFile(restart.command, restart.args, { timeout: 30_000 }, (error) => {
      if (error) log.warn(`無法重啟 session host（${service}）：${errorMessage(error)}`);
      resolve(!error);
    });
  });
}
