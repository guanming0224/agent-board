// 工作區與團隊群發（P2 項目二）的字串。中英都要（STYLE §6）。
import { registerMessages } from '../shared/i18n';

registerMessages('zh-TW', {
  'zones.aria': '工作區',
  'zones.tab.hint': '點一下切換；右鍵（觸控長按）改名或刪除；把團隊框的標籤拖到這裡＝移過來',
  'zones.tab.waiting': '{n} 個在等你',
  'zones.option.waiting': '{name}（等你 {n}）',
  'zones.more': '更多',
  'zones.add.aria': '新增工作區',
  'zones.rename.aria': '「{name}」的新名稱',
  'zones.menu.aria': '工作區「{name}」',
  'zones.menu.rename': '重新命名',
  'zones.menu.delete': '刪除',
  'zones.menu.notEmpty': '先把 {teams} 個團隊、{sessions} 個 session 移到別的工作區',
  'zones.menu.lastOne': '最後一個工作區不能刪',
  'zones.moved': '已移到「{name}」',
  'zones.moved.go': '前往',
  'zones.moveTo': '移到工作區',
  'zones.moveToItem': '移到「{name}」',
  'zones.chip': '工作區：{name}',
});

registerMessages('en', {
  'zones.aria': 'Workspaces',
  'zones.tab.hint':
    'Click to switch; right-click (long-press on touch) to rename or delete; drop a team frame label here to move it',
  'zones.tab.waiting': '{n} waiting on you',
  'zones.option.waiting': '{name} ({n} waiting)',
  'zones.more': 'More',
  'zones.add.aria': 'New workspace',
  'zones.rename.aria': 'New name for "{name}"',
  'zones.menu.aria': 'Workspace "{name}"',
  'zones.menu.rename': 'Rename',
  'zones.menu.delete': 'Delete',
  'zones.menu.notEmpty':
    'Move {teams} team(s) and {sessions} session(s) to another workspace first',
  'zones.menu.lastOne': 'The last workspace cannot be deleted',
  'zones.moved': 'Moved to "{name}"',
  'zones.moved.go': 'Go there',
  'zones.moveTo': 'Move to workspace',
  'zones.moveToItem': 'Move to "{name}"',
  'zones.chip': 'Workspace: {name}',
});
