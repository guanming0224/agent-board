// daemon 用的部分：客戶端與位置。伺服器本體（server.ts）會載入 node-pty，另外 import。
export {
  HostConnectError,
  HostRequestTimeoutError,
  probeHost,
  proveHost,
  SessionHostClient,
  type HostConnectFailure,
  type HostSessionHandlers,
  type SpawnRequest,
} from './client';
export {
  ensurePrivateDir,
  forgetLockedDirs,
  parseWhoamiSid,
  restrictToCurrentUser,
  type RunSync,
  installId,
  hostEndpoint,
  readToken,
  stableShortDir,
  writePrivateFile,
  type HostEndpoint,
} from './endpoint';
export { RingBuffer } from './ringBuffer';
