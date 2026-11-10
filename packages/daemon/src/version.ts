// 這一份 daemon 的版本（CONTRACTS §21.1）。發布檔：`<發布檔>/package.json` 的 version 與 `BUILD_ID`
// （daemon/dist/index.mjs 往上兩層）；開發模式：repo 根目錄 package.json 的 version，buildId 是 `dev`。
// 執行期讀檔（不在打包時寫死），測試才能拿同一份發布檔改 package.json 當成別的版本。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import rootPkg from '../../../package.json' with { type: 'json' };

export interface AppVersion {
  version: string;
  buildId: string;
}

export function readAppVersion(dir: string = import.meta.dirname): AppVersion {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, '..', '..', 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (manifest.name === 'agent-board-release' && typeof manifest.version === 'string') {
      let buildId = 'unknown';
      try {
        buildId = readFileSync(join(dir, '..', '..', 'BUILD_ID'), 'utf8').trim() || buildId;
      } catch {
        // 沒有 BUILD_ID：當成未知
      }
      return { version: manifest.version, buildId };
    }
  } catch {
    // 不是發布檔：開發模式
  }
  return { version: rootPkg.version, buildId: 'dev' };
}

export const APP_VERSION: AppVersion = readAppVersion();
