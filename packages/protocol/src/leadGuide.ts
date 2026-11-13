// 隊長守則（GM 2026-11-10「隊長自主擴編」，CONTRACTS §11.1）：給 session 裡的 Claude 看的固定英文文字，
// 集中在這一處。用在兩個地方，都是 Claude 自己呼叫工具才看得到，中控台不會主動送字（docs/no-llm-review.md）：
//   1. agent-board MCP server（hook/src/mcp.ts）的 server instructions 與工具說明；
//   2. hub 回給 list_members、get_progress 的 `staffing.guide`（dispatch.ts、progress.ts）。
// 這個檔案不能 import 任何東西（包括 zod）：MCP server 只用 node 內建模組，直接用 node 執行，打包時也不能帶 zod。

/** 隊長的擴編節奏（server instructions 一段、list_members／spawn_member 說明的根據）。 */
export const LEAD_STAFFING_RHYTHM =
  'Staffing rhythm for team leads (you are the lead when list_members shows yourRole "lead"; with no team yet, your first spawn_member makes you the lead of a new team): ' +
  '(1) When you receive a task, before starting, decide which roles it needs (worker edits code, tester writes and runs tests, researcher investigates read-only, reviewer reviews read-only) and compare with list_members, which shows team size, the limit, and how many members of each role exist and what they are doing. ' +
  '(2) If a role is missing or the work is too big for the current members, add one with spawn_member and give a short reason. ' +
  '(3) Write the split of work into the progress card (update_progress next), send_task to members, and wait for their results. ' +
  '(4) While the work runs, if you are stuck, the workload is too large, or a skill is missing, add a member the same way. ' +
  '(5) When a member is done and will not be needed again, release_member to free its slot. ' +
  'Limits: the team size limit set by the user (list_members shows it) and at most 4 new members per team in 10 minutes. Past either limit, spawn_member does not start the member: it sends the user a request to approve instead (status "pending_approval"; only one request per team can wait at a time). Then end your turn; the decision is typed back to you as "[Agent Board] …" (approved: the member has been started for you; rejected, or expired after 30 minutes unanswered: continue with the current members). ' +
  'Do not add members for work you can finish yourself in a few minutes. The user is notified of every member you add or release, with your reason.';

/** 不是隊長的成員：不能自己開人，向隊長回報。 */
export const MEMBER_STAFFING_GUIDE =
  'You are a team member, not the lead: you cannot add or release members. If the work needs more people or a skill nobody on the team has, say so in your reply; it goes back to your lead.';

/** 隊長看的回傳裡的一句提醒（list_members、get_progress 的 staffing.guide）。 */
export const LEAD_STAFFING_REMINDER =
  "You lead this team. Check staffing against the task: if a role is missing, the work is stuck or too big, spawn_member (reason required); when a member is done and not needed again, release_member to free its slot. Members that are still in a turn (running, starting, waiting for the user's approval or plan review) or still owe you a result cannot be released.";

/** 設定「隊長自主擴編」關著時，隊長看到的提醒。 */
export const AUTOSTAFF_OFF_GUIDE =
  'The user turned off lead auto-staffing: you cannot add or release members now. Work with the current members (send_task), or ask the user.';

/** 團隊滿了時多加的一句（GM 2026-11-13：超過上限改成向使用者申請，CONTRACTS §23）。 */
export const TEAM_FULL_GUIDE =
  'The team is at its size limit: release_member a finished member before adding another. If you still need one more, spawn_member sends the user a request to approve instead of starting it; then end your turn (the decision is typed back to you as "[Agent Board] …").';

/**
 * 加開申請送出後給隊長的說明（spawn_member 回 pending_approval 時的 result）。說「end your turn」而不是「wait」：
 * 實測說 wait 會讓模型在回合裡 sleep 互等（CONTRACTS §22.4）。
 */
export const STAFF_REQUEST_PENDING_GUIDE =
  'This was sent to the user as a request to add a member; nothing has been started yet. The decision is typed back to you as "[Agent Board] …" after your current turn ends, so end your turn now: do not sleep, poll or keep working just to wait for it. If the user approves, the member is started with exactly the arguments of this call. The request expires after 30 minutes without an answer. Meanwhile you may keep using your current members (send_task).';

/** GM 對這一隊按了全隊暫停／停止（CONTRACTS §17）時，新增、封存都擋。 */
export const TEAM_HELD_GUIDE =
  'The user paused this team; do not add or release members until it is resumed. Wait for the user.';

/** MCP server instructions 的派工段落（原本的說明，加上擴編節奏）。 */
export const DISPATCH_INSTRUCTIONS: readonly string[] = [
  'Agent Board tools let you delegate work to other Claude Code sessions shown on the Agent Board canvas, like subagents that keep running.',
  'list_members shows your team and its staffing. spawn_member starts a new member in this same project (writers — worker and tester — get their own git worktree; researcher/reviewer are read-only) and gives it your prompt. release_member archives a member you no longer need.',
  'send_task types a new task into one of your members once it is waiting for input.',
  'When a member finishes the turn that handled your work, its result is typed back into this session automatically as "[Result from <name>] Summary: … | Detected file edits: … | Branch: …". It is typed in only after your current turn ends, so end your turn now: do not sleep, poll or keep working just to wait for it.',
  "get_result shows a member's latest summary, files and branch on demand.",
  'request_review (team lead only) asks Agent Board to have both Claude and Codex review a change read-only: a member\'s uncommitted changes, or a branch against its base. A reason is required, the user is notified, and each team has an hourly limit. The verdicts come back here as "[Review from Agent Board] …" when both finish (after your current turn ends); do not sleep or poll for them.',
  LEAD_STAFFING_RHYTHM,
  `If you are not the lead: ${MEMBER_STAFFING_GUIDE}`,
];

/** 工具說明（MCP tools/list）。和 DispatchTool 的名稱一一對應；mcp.ts 只負責加上 inputSchema。 */
export const DISPATCH_TOOL_DESCRIPTIONS = {
  list_members:
    'List the members of your Agent Board team(s): name, role, status, current task, last screen line, read-only, branch, who added them and why, and whether they still owe you a result. For a team you lead it also returns staffing: team size, the size limit, free slots, members per role (and how many are running), how many members you may still add in the next 10 minutes, and a reminder. Call it when you receive a task, to decide whether the team has the roles the work needs. Empty if you have no team.',
  spawn_member:
    'Add a member to the team you lead: start a new Claude Code session in the same machine and project folder and give it a first prompt. Use it when you receive a task and a needed role is missing, or while working when you are stuck, the workload is too large, or a skill is missing. role worker edits files (gets its own git worktree by default); tester writes and runs tests (also its own worktree, asks before each step by default); researcher and reviewer are read-only and share the folder. reason is required: one short sentence on why the team needs this member (shown to the user). Its permission mode cannot exceed yours. The whole team (lead included) is capped by a size limit the user sets (list_members shows it), and at most 4 members can be added per team in 10 minutes. Past either limit the call does not start anyone: it becomes a request the user must approve (status "pending_approval", one per team at a time); end your turn, and the decision is typed back to you as "[Agent Board] …" (approved: the member has been started). Releasing a finished member first avoids the request. Refused while the board or this team is paused, while this account is rate-limited, or when the user turned auto-staffing off. Only the team lead can add members. The result comes back to you automatically when it finishes the turn.',
  send_task:
    'Give one of your members (a member of a team you lead, or one you spawned) a new task. It is typed in when the member is waiting for input; if it is busy the task waits in a queue. The result comes back to you automatically after your current turn ends; end your turn instead of sleeping or polling.',
  get_result:
    "Show a member's latest one-sentence summary, detected file edits and branch, and whether it is still working on your task.",
  request_review:
    "Team lead only. Ask Agent Board for a cross review: Claude and Codex each review the change read-only, side by side, using the user's own CLI subscriptions. Target either a member of your team (member: its uncommitted changes, including new files) or a branch (branch, optional base default main, optional repoPath default your repository). reason is required (shown in the user's audit log and team activity). The user is notified; each team may request a limited number of reviews per hour. Returns at once with a review id; when both reviews finish, a one-line summary of each verdict is typed back to you as \"[Review from Agent Board] …\" and the full text is in the user's inbox.",
  release_member:
    "Release (archive) a member of a team you lead to free its slot, when it has finished and will not be needed again. Its session is stopped, handoff rules touching it are paused, and its conversation is kept; the user can restore it from Settings → Archived. reason is required (shown to the user). A member still in a turn (running, starting, waiting for the user's approval or plan review) or that still owes you a result cannot be released: wait for its result first. You cannot release yourself. Only the team lead can release members.",
} as const;

/** 參數說明（inputSchema 的 description）。 */
export const SPAWN_REASON_DESCRIPTION =
  'Required. One short sentence: why the team needs this member now (for example "No tester yet; the change needs regression tests"). Shown to the user.';
export const REVIEW_REASON_DESCRIPTION =
  'Required. One short sentence: why this change needs a cross review now (shown to the user).';
export const RELEASE_REASON_DESCRIPTION =
  'Required. One short sentence: why this member is no longer needed (shown to the user).';

/** reason 的長度上限（字元）。超過截斷。 */
export const STAFFING_REASON_MAX = 200;

/**
 * 不是 git 的資料夾、這一隊又沒勾「共用資料夾」時，spawn_member 開會改檔案的成員被擋下的說明（CONTRACTS §24）。
 * 固定文字：最後一句是給使用者的中文操作說明，隊長原樣轉述即可。
 */
export const NOT_GIT_WRITER_GUIDE =
  'This folder is not a git repository, so a member that edits files cannot get its own worktree, and this team does not allow members that edit files to share the folder. Ask the user to press "git init" for this folder in the Agent Board panel, or to allow this team to share the folder (the "shared folder" option on the team page). Until then, use role researcher or reviewer (read-only) or do the work yourself. ' +
  '（請使用者在面板按「git init」，或允許這一隊共用資料夾。）';
