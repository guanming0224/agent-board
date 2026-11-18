import { registerMessages } from '../shared/i18n';

// 原因代碼（protocol 的 UpdateReason）翻成文字；推播（flows/pwa/sw.js）有一份同樣的，改這裡要一起改。
export const zhTW: Record<string, string> = {
  'machines.title': '版本與更新',
  'machines.open': '版本與更新',
  'machines.openHint': '各機器的版本、通道與自動更新',
  'machines.refresh': '重新整理',
  'machines.loading': '讀取版本資訊中',
  'machines.error': '讀不到版本資訊：{detail}。hub 恢復後會自動再讀。',
  'machines.memberNote':
    '只有管理員（owner）能檢查新版、升版、切換通道、更新或回滾；你可以看狀態。',

  'machines.channel.canary': 'canary',
  'machines.channel.stable': 'stable',
  'machines.channelLabel': '{name} 的通道',
  'machines.channelHint': 'canary 先拿到新版；stable 只在按「升為 stable」之後更新',
  'machines.none': '無',
  'machines.hub': 'hub {version}',

  'machines.check': '檢查新版',
  'machines.checking': '檢查中…',
  'machines.lastCheck': '上次檢查 {time}',
  'machines.neverChecked': '還沒檢查過',
  'machines.checkError': '上次檢查失敗：{error}',
  'machines.checked': '已檢查',

  'machines.gh.ok': 'gh 已登入',
  'machines.gh.unknown': 'gh 還沒檢查過（按「檢查新版」）',
  'machines.gh.missing':
    'hub 機器上找不到 gh（GitHub CLI）。在 hub 機器上安裝 gh（例如 brew install gh）後，再按「檢查新版」。',
  'machines.gh.not_logged_in':
    'hub 機器上的 gh 還沒登入。在 hub 機器上執行 gh auth login，登入後再按「檢查新版」。',
  'machines.gh.no_repo': '還沒設定 Release 所在的 GitHub repo。管理員在下面填 owner/name。',
  'machines.gh.error': 'gh 執行失敗{message}。在 hub 機器上執行 gh auth status 看原因。',

  'machines.repo': 'Release 的 repo',
  'machines.repoPlaceholder': 'owner/name',
  'machines.repoSave': '儲存',
  'machines.repoClear': '清除',
  'machines.repoSaved': '已儲存',
  'machines.repoInvalid': '格式是 owner/name',
  'machines.repoNone': '未設定',

  'machines.promote': '升為 stable',
  'machines.promoteVersion': '把 {version} 升為 stable',
  'machines.promoteConfirm': '確定升為 stable',
  'machines.promoteCancel': '取消',
  'machines.promoteShort':
    'canary {version} 才跑了 {age}，還不到 {hours} 小時。確定現在就讓所有 stable 機器更新到這一版？',
  // 面板資料是舊的（例如別的分頁剛把門檻從 0 改大）：hub 回 canary_too_new 時不知道實際小時數。
  'machines.promoteShortHub':
    'hub 說 canary {version} 還沒跑滿設定的時數。確定現在就讓所有 stable 機器更新到這一版？',
  'machines.promoted': '已升為 stable',
  'machines.promote.no_canary': '目前沒有 canary 版本',
  'machines.promote.same': 'canary 和 stable 是同一版',
  'machines.soak': 'canary 已跑 {age}',
  'machines.soakNone': 'canary 還沒開始',
  'machines.soakShort': '（建議跑滿 {hours} 小時）',
  'machines.stats': '期間 ERR {errors}・斷線 {disconnects}・更新失敗 {failures}',

  'machines.span.dhm': '{d} 天 {h} 小時',
  'machines.span.hm': '{h} 小時 {m} 分',
  'machines.span.m': '{m} 分',

  'machines.col.machine': '機器',
  'machines.col.version': '版本',
  'machines.col.channel': '通道',
  'machines.col.status': '更新狀態',
  'machines.online': '在線',
  'machines.offline': '離線',
  'machines.lastSeen': '最後連線 {time}',
  'machines.hasHub': '含 hub',
  'machines.unknownVersion': '未回報',
  'machines.target': '目標 {version}',
  'machines.previous': '上一版 {version}',

  'machines.status.latest': '最新',
  'machines.status.pending': '待更新到 {version}',
  'machines.status.updating': '更新中：{phase}',
  'machines.download.progress': '下載中 {pct}%（{received}/{total} MB，{speed}）',
  'machines.download.attempt': '，第 {attempt} 次嘗試',
  'machines.retryAt': '下載失敗會自動重試：{time}（第 {round}/{max} 輪）',
  'machines.status.deferred': '延後：{reason}',
  'machines.status.failed': '失敗：{reason}',
  'machines.status.rolled_back': '失敗已回滾：{reason}',
  'machines.status.rollback_failed': '回滾也失敗，需要處理：{reason}',
  'machines.status.needs_update': '需要更新：daemon 太舊，hub 不接受',
  'machines.status.hub_too_old': 'hub 太舊：先更新 hub 這台',
  'machines.status.dev': '開發模式，不自動更新',
  'machines.status.rolledBackTo': '已手動回滾到 {version}',
  'machines.block.dev': '開發模式，不能從這裡更新或回滾',
  'machines.status.unknown': '版本未知（daemon 太舊沒回報）',
  'machines.status.no_target': '沒有可用的版本（這個平台沒有成品，或還沒有 Release）',

  'machines.phase.downloading': '下載中',
  'machines.phase.installing': '安裝中',
  'machines.phase.checking': '健康檢查中',
  'machines.phase.rolling_back': '回滾中',

  'machines.reason.waiting_permission': '有 session 在等你允許',
  'machines.reason.host_busy': '這次要換 session host，但還有 session 在工作',
  'machines.reason.not_installed': '不是用安裝程式裝的（開發模式），不能自動更新',
  'machines.reason.unsupported_platform': '這個平台沒有成品',
  'machines.reason.download_failed': '下載失敗',
  'machines.reason.checksum_mismatch': 'SHA-256 不符',
  'machines.reason.extract_failed': '解壓失敗',
  'machines.reason.backup_failed': '資料庫備份失敗',
  'machines.reason.install_failed': '安裝失敗',
  'machines.reason.health_timeout': '60 秒內健康檢查沒過',
  'machines.reason.rollback_requested': '手動回滾',
  'machines.reason.no_previous': '沒有上一版',
  'machines.reason.schema_changed':
    '上一版之後 hub 資料庫升級過，回滾會丟資料，不自動做（要人處理）',
  'machines.reason.interrupted': '上次的更新中斷了（可以再試）',
  'machines.reason.spawn_failed': '啟動不了更新程式',
  'machines.note.hub_first': '等 hub 那台先升到這一版',
  'machines.note.rolled_back_hold': '已手動回滾，暫停這一版；按「立即更新」或通道換新版才解除',
  'machines.note.hub_update_failed': 'hub 更新失敗，其他機器暫停',
  'machines.reason.superseded': '延後中的回滾被「立即更新」取代',
  'machines.err.update_in_progress': '這台的更新還在進行，等它結束再試',
  'machines.note.platform_unverified': 'Windows 還沒實機驗證，暫不自動更新',
  'machines.unverified.offHint':
    '{platform} 還沒在實機驗證過自動更新，預設不自動更新（新版要手動安裝）。在這台照 README 實測過安裝、更新、回滾之後，再允許它自動更新。',
  'machines.unverified.onHint':
    '已允許這台 {platform} 機器自動更新（這個平台還沒在實機驗證過）。出問題時可以停止，改回手動安裝。',
  'machines.unverified.on': '允許自動更新',
  'machines.unverified.off': '停止自動更新',
  'machines.unverified.confirm':
    '「{name}」的平台還沒在實機驗證過自動更新：更新或回滾失敗時可能要到那台機器上手動處理。確定要允許它自動更新嗎？',
  'machines.unverified.yes': '確定允許',
  'machines.unverified.allowed': '已允許自動更新',
  'machines.unverified.stopped': '已停止自動更新',
  'machines.err.confirm_required': '要再確認一次才能打開',
  'machines.err.platform_verified': '這台不是未驗證的平台，不需要另外允許',
  'machines.note.abi_mismatch': '成品的原生模組和這台的 Node 版本不合，請手動安裝',
  'machines.note.node_too_old': '這台的 Node.js 版本太舊，請升級 Node.js 後再更新',
  'machines.block.previous_unsupported':
    '上一版沒有自動更新功能，不能從這裡回滾（用 install.sh --from 重裝）',
  'machines.err.previous_unsupported':
    '上一版沒有自動更新功能，不能從這裡回滾（用 install.sh --from 重裝）',
  'machines.err.no_target': '這台目前沒有可更新的版本',
  'machines.reason.busy': '另一個更新還在進行',
  'machines.reason.unknown': '原因不明',
  'machines.reason.none': '原因不明',

  'machines.update': '立即更新',
  'machines.rollback': '回滾到上一版',
  'machines.host.suspect':
    'session host 可能卡住：送給 session 的輸入連續沒有任何回應（連回顯都沒有）。打字沒反應時請重啟 session host。',
  'machines.host.legacy':
    '目前是舊模式：連不上 session host，daemon 自己開 agent（daemon 重啟時 agent 會結束、改用 --resume 接回）。host 回來後會自動切回。',
  'machines.host.unusable':
    'session host 還在跑但不能用（版本不相容或證明不了身分），新的 session 由 daemon 自己開。',
  'machines.host.restart': '重啟 session host',
  'machines.host.confirm':
    '重啟 {name} 的 session host？這台的所有 agent 會結束一次，之後自動用 --resume 接回（對話紀錄還在；正在進行的工作會中斷）。',
  'machines.host.busy':
    '這台有 {count} 個 session 正在執行、等你允許或等你看計畫，重啟會中斷它們。',
  'machines.host.confirmLegacy':
    '重啟 {name} 的 session host？這台目前是舊模式：daemon 自己開的 agent 不受影響；host 起來後，之後新開的 session 由 host 養。',
  'machines.host.yes': '確定重啟',
  'machines.host.started': '已送出重啟；agent 接回需要幾十秒',
  'machines.host.oldDaemon':
    '這台的 daemon 版本太舊，不支援從這裡重啟；請更新 daemon，或在那台機器上手動重啟 session host 服務。',
  'machines.host.unsupported':
    '這台不能從這裡重啟 session host（Windows 或沒有設定服務），請在那台機器上手動重啟。',
  'machines.err.daemon_too_old': '這台的 daemon 版本太舊，不支援這個操作',
  'machines.err.restart_unsupported': '這台不能從這裡重啟 session host',
  'machines.err.session_host_off': '這台設定成不用 session host',
  'machines.updateStarted': '已送出更新',
  'machines.rollbackStarted': '已送出回滾',
  'machines.block.offline': '機器離線',
  'machines.block.busy': '更新進行中',
  'machines.block.no_target': '沒有目標版本',
  'machines.block.latest': '已是目標版本',
  'machines.block.no_previous': '不知道上一版，不能回滾',
  'machines.block.member': '只有管理員能操作',

  'machines.err.canary_too_new': 'canary 還沒跑滿設定的時數，要再確認一次',
  'machines.err.not_cached': '這一版還沒下載驗證完成，先按「檢查新版」',
  'machines.err.machine_offline': '機器離線，連上後再試',
  'machines.err.no_previous': '不知道上一版，不能回滾',
  'machines.err.schema_changed': '上一版之後 hub 資料庫升級過，回滾會丟資料，不自動做',
  'machines.err.other': '失敗：{error}',
  'machines.empty': '還沒有機器。到設定的「機器」配對第一台。',
};

export const en: Record<string, string> = {
  'machines.title': 'Versions & updates',
  'machines.open': 'Versions & updates',
  'machines.openHint': 'Version, channel and auto-update for each machine',
  'machines.refresh': 'Refresh',
  'machines.loading': 'Loading version info',
  'machines.error': 'Couldn’t load version info: {detail}. It reloads when the hub is back.',
  'machines.memberNote':
    'Only an owner can check for releases, promote, switch channels, update or roll back. You can view the status.',

  'machines.channel.canary': 'canary',
  'machines.channel.stable': 'stable',
  'machines.channelLabel': 'Channel for {name}',
  'machines.channelHint':
    'canary gets new releases first; stable updates only after “Promote to stable”',
  'machines.none': 'none',
  'machines.hub': 'hub {version}',

  'machines.check': 'Check for releases',
  'machines.checking': 'Checking…',
  'machines.lastCheck': 'Last checked {time}',
  'machines.neverChecked': 'Not checked yet',
  'machines.checkError': 'Last check failed: {error}',
  'machines.checked': 'Checked',

  'machines.gh.ok': 'gh is signed in',
  'machines.gh.unknown': 'gh not checked yet (press “Check for releases”)',
  'machines.gh.missing':
    'gh (GitHub CLI) isn’t installed on the hub machine. Install it there (e.g. brew install gh), then press “Check for releases”.',
  'machines.gh.not_logged_in':
    'gh isn’t signed in on the hub machine. Run gh auth login there, then press “Check for releases”.',
  'machines.gh.no_repo': 'No GitHub repo set for releases. An owner can enter owner/name below.',
  'machines.gh.error': 'gh failed{message}. Run gh auth status on the hub machine to see why.',

  'machines.repo': 'Release repo',
  'machines.repoPlaceholder': 'owner/name',
  'machines.repoSave': 'Save',
  'machines.repoClear': 'Clear',
  'machines.repoSaved': 'Saved',
  'machines.repoInvalid': 'Use the form owner/name',
  'machines.repoNone': 'Not set',

  'machines.promote': 'Promote to stable',
  'machines.promoteVersion': 'Promote {version} to stable',
  'machines.promoteConfirm': 'Promote anyway',
  'machines.promoteCancel': 'Cancel',
  'machines.promoteShort':
    'canary {version} has only run for {age}, less than {hours} hours. Update every stable machine to it now?',
  'machines.promoteShortHub':
    'The hub says canary {version} hasn’t run for the configured time yet. Update every stable machine to it now?',
  'machines.promoted': 'Promoted to stable',
  'machines.promote.no_canary': 'No canary release yet',
  'machines.promote.same': 'canary and stable are the same release',
  'machines.soak': 'canary has run for {age}',
  'machines.soakNone': 'canary hasn’t started',
  'machines.soakShort': ' ({hours} hours recommended)',
  'machines.stats':
    'Since then: ERR {errors} · disconnects {disconnects} · failed updates {failures}',

  'machines.span.dhm': '{d}d {h}h',
  'machines.span.hm': '{h}h {m}m',
  'machines.span.m': '{m}m',

  'machines.col.machine': 'Machine',
  'machines.col.version': 'Version',
  'machines.col.channel': 'Channel',
  'machines.col.status': 'Update status',
  'machines.online': 'Online',
  'machines.offline': 'Offline',
  'machines.lastSeen': 'Last seen {time}',
  'machines.hasHub': 'runs the hub',
  'machines.unknownVersion': 'Not reported',
  'machines.target': 'target {version}',
  'machines.previous': 'previous {version}',

  'machines.status.latest': 'Up to date',
  'machines.status.pending': 'Will update to {version}',
  'machines.status.updating': 'Updating: {phase}',
  'machines.download.progress': 'downloading {pct}% ({received}/{total} MB, {speed})',
  'machines.download.attempt': ', attempt {attempt}',
  'machines.retryAt': 'Download will retry automatically at {time} (round {round}/{max})',
  'machines.status.deferred': 'Deferred: {reason}',
  'machines.status.failed': 'Failed: {reason}',
  'machines.status.rolled_back': 'Failed, rolled back: {reason}',
  'machines.status.rollback_failed': 'Rollback failed too, needs attention: {reason}',
  'machines.status.needs_update': 'Needs update: daemon too old for the hub',
  'machines.status.hub_too_old': 'Hub too old: update the hub machine first',
  'machines.status.dev': 'Dev mode, no auto-update',
  'machines.status.rolledBackTo': 'Rolled back to {version} manually',
  'machines.block.dev': 'Dev mode: can’t update or roll back from here',
  'machines.status.unknown': 'Version unknown (daemon too old to report it)',
  'machines.status.no_target':
    'No release available (no build for this platform, or no release yet)',

  'machines.phase.downloading': 'downloading',
  'machines.phase.installing': 'installing',
  'machines.phase.checking': 'health check',
  'machines.phase.rolling_back': 'rolling back',

  'machines.reason.waiting_permission': 'a session is waiting for your approval',
  'machines.reason.host_busy': 'the session host must restart but sessions are working',
  'machines.reason.not_installed': 'not installed by the installer (dev mode), can’t auto-update',
  'machines.reason.unsupported_platform': 'no build for this platform',
  'machines.reason.download_failed': 'download failed',
  'machines.reason.checksum_mismatch': 'SHA-256 mismatch',
  'machines.reason.extract_failed': 'extract failed',
  'machines.reason.backup_failed': 'database backup failed',
  'machines.reason.install_failed': 'install failed',
  'machines.reason.health_timeout': 'health check didn’t pass within 60s',
  'machines.reason.rollback_requested': 'manual rollback',
  'machines.reason.no_previous': 'no previous version',
  'machines.reason.schema_changed':
    'the hub database was upgraded since the previous version; rolling back would lose data, so it isn’t done automatically',
  'machines.reason.interrupted': 'the previous update was interrupted (you can retry)',
  'machines.reason.spawn_failed': 'could not start the updater',
  'machines.note.hub_first': 'waiting for the hub machine to update to this version first',
  'machines.note.rolled_back_hold':
    'rolled back by hand; this version is on hold until you press “Update now” or the channel moves to a new version',
  'machines.note.hub_update_failed': 'the hub machine failed to update; other machines are paused',
  'machines.reason.superseded': 'the deferred rollback was replaced by “Update now”',
  'machines.err.update_in_progress':
    'an update is still running on this machine; try again when it finishes',
  'machines.note.platform_unverified':
    'Windows is not verified on a real machine yet; no automatic updates',
  'machines.unverified.offHint':
    'Automatic updates on {platform} have not been verified on a real machine, so they are off by default (install new versions by hand). Allow them after you have tried install, update and rollback on this machine as described in the README.',
  'machines.unverified.onHint':
    'Automatic updates are allowed on this {platform} machine (the platform is not verified yet). Stop them if anything goes wrong and install by hand.',
  'machines.unverified.on': 'Allow automatic updates',
  'machines.unverified.off': 'Stop automatic updates',
  'machines.unverified.confirm':
    '“{name}” runs a platform whose automatic updates are not verified yet: a failed update or rollback may need fixing on that machine by hand. Allow automatic updates?',
  'machines.unverified.yes': 'Allow',
  'machines.unverified.allowed': 'Automatic updates allowed',
  'machines.unverified.stopped': 'Automatic updates stopped',
  'machines.err.confirm_required': 'This needs a second confirmation',
  'machines.err.platform_verified': 'This machine is not on an unverified platform',
  'machines.note.abi_mismatch':
    'the bundled native modules do not match this machine’s Node version; install by hand',
  'machines.note.node_too_old': 'Node.js on this machine is too old; upgrade Node.js to update',
  'machines.block.previous_unsupported':
    'the previous version predates automatic updates; reinstall it with install.sh --from',
  'machines.err.previous_unsupported':
    'the previous version predates automatic updates; reinstall it with install.sh --from',
  'machines.err.no_target': 'there is no version to update this machine to',
  'machines.reason.busy': 'another update is running',
  'machines.reason.unknown': 'unknown reason',
  'machines.reason.none': 'unknown reason',

  'machines.update': 'Update now',
  'machines.rollback': 'Roll back',
  'machines.host.suspect':
    'The session host may be stuck: input sent to sessions keeps getting no response at all (not even an echo). If typing does nothing, restart the session host.',
  'machines.host.legacy':
    'Fallback mode: the session host is unreachable, so the daemon runs agents itself (they end when the daemon restarts and resume with --resume). It switches back automatically when the host returns.',
  'machines.host.unusable':
    'The session host is running but unusable (incompatible version or failed to prove its identity); new sessions run under the daemon.',
  'machines.host.restart': 'Restart session host',
  'machines.host.confirm':
    'Restart the session host on {name}? Every agent on this machine ends once and resumes automatically with --resume (conversations are kept; work in progress is interrupted).',
  'machines.host.busy':
    '{count} session(s) on this machine are running, waiting for approval or waiting on a plan; restarting interrupts them.',
  'machines.host.confirmLegacy':
    'Restart the session host on {name}? This machine is in fallback mode: agents the daemon started itself are not affected; once the host is up, new sessions run under it.',
  'machines.host.yes': 'Restart',
  'machines.host.started': 'Restart sent; agents take a few seconds to come back',
  'machines.host.oldDaemon':
    'This daemon is too old to restart its session host from here; update the daemon or restart the session host service on that machine.',
  'machines.host.unsupported':
    'This machine cannot restart its session host from here (Windows or no service configured); restart it on that machine.',
  'machines.err.daemon_too_old': 'This daemon is too old for this action',
  'machines.err.restart_unsupported': 'This machine cannot restart its session host from here',
  'machines.err.session_host_off': 'This machine is set not to use a session host',
  'machines.updateStarted': 'Update requested',
  'machines.rollbackStarted': 'Rollback requested',
  'machines.block.offline': 'Machine is offline',
  'machines.block.busy': 'Update in progress',
  'machines.block.no_target': 'No target version',
  'machines.block.latest': 'Already on the target version',
  'machines.block.no_previous': 'Previous version unknown, can’t roll back',
  'machines.block.member': 'Owner only',

  'machines.err.canary_too_new': 'canary hasn’t run for the configured time yet; confirm again',
  'machines.err.not_cached':
    'This release isn’t downloaded and verified yet. Press “Check for releases” first.',
  'machines.err.machine_offline': 'Machine is offline. Try again once it reconnects.',
  'machines.err.no_previous': 'Previous version unknown, can’t roll back',
  'machines.err.schema_changed':
    'The hub database was upgraded since the previous version; rolling back would lose data, so it isn’t done automatically',
  'machines.err.other': 'Failed: {error}',
  'machines.empty': 'No machines yet. Pair the first one under Settings → Machines.',
};

registerMessages('zh-TW', zhTW);
registerMessages('en', en);
