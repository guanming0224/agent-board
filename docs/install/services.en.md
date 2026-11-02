# Auto-start and releases

The installer generates service files for each platform. Templates are in `deploy/`; values are filled in and escaped by `scripts/lib/service-templates.mjs`. Most people never need this page.

## Per platform

| Platform | Mechanism                                               | Starts           | After a crash     | Verified                                                   |
| -------- | ------------------------------------------------------- | ---------------- | ----------------- | ---------------------------------------------------------- |
| macOS    | LaunchAgent (`~/Library/LaunchAgents`)                  | At desktop login | Restarts in 10 s  | Service file and environment; not loaded into real launchd |
| Linux    | systemd `--user` (`~/.config/systemd/user`) with linger | At boot          | Restarts in 10 s  | **No.** File contents only                                 |
| Windows  | Task Scheduler (`AgentBoard-hub`, `AgentBoard-daemon`)  | At login         | Restarts in 1 min | **No.** File contents only                                 |

A clean exit (code 0, such as stopping the service) doesn't restart. An unpaired daemon exits with code 1 and the service keeps retrying, so nothing needs starting by hand after pairing.

## Environment

Services don't get your shell's environment. launchd's `PATH` in particular is only `/usr/bin:/bin:/usr/sbin:/sbin`. The installer writes these into the service file:

- `PATH`: the folders of node and claude, then your `PATH` at install time, then common locations, without duplicates. Claude's tools rely on this too. **If you later install a tool in a folder outside these, run the installer again.**
- `AGENT_BOARD_CLAUDE_BIN`: the absolute path of `claude`.
- `LANG`, `SHELL`, `HOME`: launchd sets no locale, and without a UTF-8 `LANG` non-ASCII text breaks.
- `CLAUDE_CONFIG_DIR` and `AGENT_BOARD_DATA_DIR`, if set at install time.

The machine token is never written here. It stays in `machine.json`.

## How the hook is found

Before starting a session, the daemon confirms it can find `agent-board-hook`, and refuses to start otherwise, because the dangerous-command check would silently be skipped. In a release, `daemon/dist/index.mjs` finds `daemon/node_modules/.bin/agent-board-hook` by relative path. The daemon then adds that folder to the PTY's `PATH`, so the folder holds only the hook.

`~/.local/bin/agent-board-hook` serves a different case. When you open `claude` yourself, project settings still call the hook. With no session marker it exits 0 immediately, so you don't see exit 127 errors.

## Why Windows uses Task Scheduler rather than a service

|               | Task Scheduler (used)                          | Windows service                                                |
| ------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| Rights        | Any user                                       | Administrator to install                                       |
| Identity      | The logged-in user, who has the `claude` login | SYSTEM by default; reaching the login needs stored credentials |
| Session       | Interactive                                    | Session 0, no desktop                                          |
| Starts        | **After login**                                | At boot, no login needed                                       |
| Crash restart | After 1 minute, up to 999 times                | Configurable                                                   |

The cost is that after a reboot, nothing runs until someone logs in. Windows auto-login is an option if you need it at boot.

Some managed environments forbid regular users from creating logon-triggered tasks. The installer then falls back to the Startup folder and says so: it starts at login but doesn't restart after a crash.

It runs in the background through `conhost.exe --headless`, so no terminal window appears (Windows 10 1809 or later).

## Publishing a release (maintainers)

```sh
corepack pnpm build:release   # creates release/
corepack pnpm smoke:release   # macOS only: installs to a temp HOME and pairs and starts a session with a fake claude
corepack pnpm test:install    # service template escaping
corepack pnpm notices         # refresh THIRD_PARTY_NOTICES.md when dependencies change
corepack pnpm screenshots     # refresh docs/screenshots/ when the UI changes (demo data only)
```

Upload these four files from `release/` to a GitHub Release: `agent-board.tar.gz`, `agent-board.tar.gz.sha256`, `install.sh`, `install.ps1`.

**Before the first release:** replace `OWNER` in `README.md`, `README.zh-TW.md`, `scripts/install.sh`, and `scripts/install.ps1` with the real GitHub account or organization. While it still says `OWNER`, the install scripts require `--from` and won't try to download.

`smoke:release` replaces `launchctl`, `systemctl`, and `loginctl` with stubs that only record their arguments, so it doesn't touch the machine's system services.
