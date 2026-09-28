# Linux and WSL autostart: a systemd user unit with linger

Status: Accepted, 2026-09-28.

## Decision

On Linux, and on WSL distros that run systemd, the environment server is kept
alive by a **systemd user unit**, `openmanager-server.service`, written to the
user's unit directory and enabled under `default.target`. `service install`
also turns on **linger** for the user. The same
`service install|uninstall|start|stop|status` verbs as on Windows manage it;
the command flow is shared and only the supervisor backend differs.

It is not a system unit, and WSL gets no separate launcher: WSL's own
idle-shutdown setting is documented and detected instead.

## Context and rationale

The constraints from the Windows decision
([windows-startup-task.md](./windows-startup-task.md)) carry over: the server
spawns provider CLIs that keep their logins in the user's home, reads the
user's repositories, and must run as that user with their environment. A user
unit does this directly: it runs under the user's own `systemd --user`
manager, needs no root, and gets start-on-boot, restart-on-failure and
SIGTERM-then-SIGKILL stopping from systemd.

| Approach                                              | Assessment                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System unit with `User=`                              | Needs root to install, and runs outside the user's session and user manager (no user bus, different environment). Rejected for a per-user developer tool. |
| User unit, no linger                                  | Starts at the first login and stops when the last session ends. On a native machine that means the environment dies on logout.                            |
| **User unit + linger**                                | Starts at boot and survives logout. `loginctl enable-linger <self>` needs no root under the default polkit policy (`set-self-linger` is allowed).         |
| `nohup`/`setsid` from a shell profile, cron `@reboot` | No supervision, stop control or restart; nothing gained over systemd where systemd exists.                                                                |

Unit settings that matter: `Type=exec` (a missing Node binary fails `start`
instead of looking started), `Restart=on-failure` after 10 s with
`StartLimitBurst=5` in 300 s (a broken install ends up `failed`, not
looping), `KillMode=mixed` with `TimeoutStopSec=15` (SIGTERM to the server
alone so it can end its provider processes, then a kill of whatever remains),
and `Environment=PATH=` frozen from the installing shell with the Node
directory first. The user manager's default `PATH` misses nvm, `~/.local/bin`
and npm global folders, so without it neither `#!/usr/bin/env node` provider
CLIs nor the CLIs themselves resolve. Everything else a user wants to add goes
in a drop-in, which `install` never touches. The Windows `--exit-with-parent`
marker is not used: systemd tracks the unit's cgroup and stops every process
in it.

The server keeps writing to `--log-file` rather than only to the journal, so
both platforms keep one log location for the status/logs work that follows;
the journal still records the unit's lifecycle.

### Measured on WSL

WSL 2.7.13, Ubuntu 24.04, systemd 255, standard user, 2026-09-28:

- `loginctl enable-linger` with **no user argument** printed "Could not enable
  linger: No such device or address" and **exited 0**; with the user name it
  succeeded without sudo. `install` therefore always names the user and reads
  `Linger` back instead of trusting the exit code.
- WSL creates **one logind session per distro boot**, shared by every
  terminal and `wsl.exe` command, and ends it only when the distro stops. A
  user service kept running after all terminals closed even with linger off.
  Logging out of WSL is the distro stopping.
- With the default `.wslconfig`, WSL stopped the distro 8 to 20 s after the
  last session closed, **despite a running user service**, and the
  server with it. With `[general] instanceIdleTimeout=-1` the distro and the
  server stayed up with no session for the full 90 s observed, answering
  `/health` from Windows through localhost forwarding.
- After `wsl.exe --terminate`, the next `wsl.exe` invocation booted the distro
  and the unit answered `/health` within 2 s, with no login shell involved.
- `WorkingDirectory="/tmp/a b"` was rejected (`bad-setting`, "path is not
  absolute"); the unquoted `WorkingDirectory=/tmp/a b` worked. Only
  `ExecStart=` and `Environment=` are word-split, so the unit quotes those and
  writes the working directory verbatim with `%` doubled.
- `service stop` (SIGTERM) took ~0.4 s with exit status 0; a `SIGKILL` to the
  server was restarted by systemd after `RestartSec`, `NRestarts=1`.

So on WSL the unit behaves correctly, and whether it survives closing the
last terminal depends entirely on `instanceIdleTimeout`. That is a global
Windows-side setting that keeps VM memory reserved, so `install` does not
change it. It reads the file through interop (`cmd.exe` for `%USERPROFILE%`,
then `wslpath`) and says whether the distro will stay up, with the exact file
to edit when it will not.

When WSL runs without systemd (PID 1 is WSL's `init`), every command stops in
its preflight with the `/etc/wsl.conf` `[boot] systemd=true` steps. Detection
reads `/proc/1/comm`; WSL is recognised by `WSL_DISTRO_NAME` or a `microsoft`
kernel release.

## Consequences

- The Windows and systemd backends share validation, the port-conflict
  check, the `/health` wait and the command output; a backend only registers,
  starts, stops, removes and describes its own service.
- Root is refused: a root user unit would run without the user's provider
  logins, which is never what the owner wants.
- The Node and entry paths are absolute; moving either, or removing the nvm
  version, needs a reinstall.
- Native Linux logout/boot behaviour relies on systemd's documented linger
  semantics and is unit-tested against a scripted `systemctl`; the end-to-end
  run was on WSL only.
- Nothing starts a WSL distro at Windows sign-in. That is separate work,
  likely a Windows logon task that starts the distro, reusing the
  Windows launcher.

## Sources

- `systemd.service` (`Type=exec`, `Restart=`, `KillMode=`), `systemd.unit`
  (`StartLimitBurst=`, `[Install]`), `systemd.exec` (`Environment=`), and
  `systemd.syntax` for quoting and specifier escaping
  (https://www.freedesktop.org/software/systemd/man/)
- `loginctl enable-linger` (https://www.freedesktop.org/software/systemd/man/loginctl.html)
- WSL `wsl.conf` `[boot] systemd` and `.wslconfig` `[general]
instanceIdleTimeout` (https://learn.microsoft.com/windows/wsl/wsl-config)
- Measurements above come from throwaway probes (`systemd-run --user` sleepers
  and the real unit) run on 2026-09-28; they are not checked in.
