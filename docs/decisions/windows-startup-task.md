# Windows autostart: a per-user logon task, not a Windows service

Status: Accepted, 2026-09-23.

## Decision

On native Windows the environment server is kept alive by a **Task Scheduler
logon task** registered for the signed-in user, run with that user's
interactive token at least privilege, executed through `conhost.exe --headless`
so no terminal window appears. The server exposes
`service install|uninstall|start|stop|status` to manage it and gains
`--log-file` and `--exit-with-parent` so it can live without a console.

It is not a Windows service.

## Context and rationale

The environment server spawns provider CLIs (Claude Code, Codex, Cursor,
OpenCode) that keep their logins under the user's profile, reads the user's
repositories, and on this project's own development machines works out of
OneDrive-synced folders. Whatever starts it must therefore run **as the
user, inside the user's session, with the user's profile loaded**. Measured
on Windows 11 (build 26200) with a standard, non-elevated account:

| Approach                                                | Result                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows service (`sc.exe`, winsw/nssm-style wrapper)    | Runs in session 0 as LocalSystem unless a password is stored; the user's CLI logins and files are not there. Needs administrator rights.           |
| Logon task, `S4U` logon type (no window, no password)   | `schtasks /Create` fails with _Access is denied_ for a standard user; it needs the _Log on as a batch job_ right, which only administrators hold.  |
| Logon task, interactive token, direct `node.exe` action | Works: user profile, `%USERPROFILE%\.claude`, OneDrive paths and network all available. But Windows 11 opens a **Windows Terminal window** for it. |
| Same, wrapped in `wscript.exe //B` + JScript            | No process started on the test machine (Windows Script Host is a deprecated on-demand feature). Not a supported base.                              |
| Same, wrapped in `powershell -WindowStyle Hidden`       | Hides its own console only after start-up; with Windows Terminal as the default host the window is not reliably hidden. Not measured further.      |
| Same, wrapped in `conhost.exe --headless`               | Works: no window (`MainWindowHandle` 0, no Windows Terminal spawned), full user context, `RestartOnFailure` fires when the server exits.           |

`conhost.exe --headless` is the pseudo-console entry point Windows uses for
ConPTY hosts; it has shipped in `System32` since Windows 10 1809 and is the
only window-free launcher available on every machine without an extra binary.

Two consequences shape the implementation:

- **Ending the task ends only the console host.** Task Scheduler terminates
  the process it started (`conhost.exe`) and not the `node.exe` under it. The
  server therefore takes `--exit-with-parent` and polls its parent PID every
  two seconds, stopping when the host is gone. `service stop`/`uninstall` end
  the task, wait for that shutdown, and only then fall back to `taskkill` on
  processes whose command line carries the entry path and the marker flag.
- **There is no console to log to.** `--log-file` appends JSON records to
  `<data-dir>\logs\server.log`, and start-up failures go to the same file. A
  single once-per-start rotation at 10 MiB bounds disk use until the service
  status/logs work adds real retention.

Task settings that matter, all written into the XML the command registers:
`ExecutionTimeLimit` of `PT0S` (the default is a 72-hour kill), `IgnoreNew`
so a second instance cannot bind, no battery or idle stops, `StartWhenAvailable`,
priority 5 (normal class; the task default of 7 is below-normal CPU and I/O),
and `RestartOnFailure` three times a minute apart.

## Alternatives considered

| Alternative                                     | Assessment                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HKCU\...\Run` key or Startup folder shortcut   | Same window problem as a direct task action, minus restart-on-failure and stop control. Nothing gained.                                                                                               |
| Ship a tiny GUI-subsystem launcher `.exe`       | Would remove the `conhost` hop, but means a compiled, signed binary in the repository or a build step for it. Revisit if `conhost --headless` ever regresses.                                         |
| Electron's binary with `ELECTRON_RUN_AS_NODE=1` | Electron 40 embeds Node 24.15 with `node:sqlite`, and is a GUI-subsystem executable, so it could run the server windowless. The desktop app does not bundle the server yet; a packaging option later. |
| Windows service with the user's stored password | Password rotation and Microsoft-account sign-ins make this brittle, and it still needs administrator rights. Rejected for a per-user developer tool.                                                  |

## Consequences and validation

- The server runs only while the owner is signed in. Boot-to-lock-screen has
  no environment; a second user does not inherit the task. Acceptable for a
  single-user developer machine and documented in `docs/windows-startup.md`.
- `install` bakes the absolute Node and entry paths. Moving either breaks the
  task until `install` runs again; `status` surfaces the failure code.
- The command flow is unit-tested against a scripted Task Scheduler; the
  behaviour of `conhost --headless`, `/End`, `/Query /FO CSV /V` column
  positions and the unescaped _Task To Run_ column were verified by hand on
  the machine above and are the basis for the parsers.
- Linux and WSL follow with a systemd user unit; the `service` verbs are
  reserved so both platforms share one command surface.

## Sources

- Task Scheduler schema: `LogonTrigger`, `Principal/LogonType`, `Settings/ExecutionTimeLimit`, `RestartOnFailure`
  (https://learn.microsoft.com/windows/win32/taskschd/task-scheduler-schema)
- `schtasks.exe` reference (https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks)
- Windows Script Host deprecation
  (https://learn.microsoft.com/windows/whats-new/deprecated-features)
- Measurements in the table above come from throwaway `schtasks` probes run on
  2026-09-23 while implementing this; they are not checked in.
