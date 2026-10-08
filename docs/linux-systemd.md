# Running the environment server in the background on Linux and WSL

On Linux, and on WSL distros with systemd turned on, the environment server
can install itself as a **systemd user unit**. After that the server runs in
the background as you, starts on its own, restarts if it crashes, and keeps
running when you close your terminals. No root and no system-wide unit are
needed. The reasoning behind this shape is in
[decisions/linux-systemd-user-unit.md](./decisions/linux-systemd-user-unit.md);
native Windows uses a logon task instead ([windows-startup.md](./windows-startup.md)).
The commands are the same on both.

## When the server runs

|                                 | Native Linux                                                 | WSL                                                                                                                |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Starts                          | At boot (linger on), or at your first login                  | Whenever the distro starts: opening a WSL terminal, or any `wsl.exe` command                                       |
| Closing terminals / logging out | Keeps running (linger on)                                    | Keeps running only while the distro does; by default Windows stops the distro ~15 s after the last terminal closes |
| Crash                           | Restarted after 10 s; gives up after 5 failures in 5 minutes | Same                                                                                                               |
| Stops                           | `service stop`/`uninstall`, shutdown                         | `service stop`/`uninstall`, `wsl.exe --shutdown`/`--terminate`, the distro idling out, Windows shutdown            |

`install` turns on **linger** for your user (`loginctl enable-linger <you>`),
which is what lets the unit start at boot and outlive your login sessions on a
normal Linux machine. On WSL the distro itself is the limit: see
[Keep the WSL distro running](#keep-the-wsl-distro-running).

## Prerequisites

- systemd as the init system, with a user manager for your account
  (`systemctl --user status` works). Most desktop and server distributions
  have this; containers usually do not.
- Node 24 LTS on disk. The unit records the absolute path of the `node` that
  runs `service install`, so install with the Node you intend to keep. nvm
  and fnm paths are fine as long as that version stays installed; after
  `nvm uninstall` of that version, run `install` again.
- A built server: the unit runs `apps/server/dist/main.js`.
- Run the commands as yourself, from a normal login shell, not with `sudo`.
  The service runs as whoever installs it, and provider CLI logins
  (`~/.claude`, `~/.codex`, ...) are per user.

### WSL: turn systemd on

WSL starts distros without systemd unless it is asked for. Check with:

```sh
ps -p 1 -o comm=    # prints "systemd" when it is on
```

If it prints something else (`init`), add this to `/etc/wsl.conf` inside the
distro (with `sudo`):

```ini
[boot]
systemd=true
```

Then run `wsl.exe --shutdown` from Windows (this stops every running distro)
and open the distro again. systemd support needs WSL 0.67.6 or later
(`wsl.exe --version`); the Microsoft Store build of WSL has it.

Without systemd, every `service` command stops before changing anything and
prints these same steps. Nothing is half-installed.

On WSL, keep the repository on the Linux filesystem (for example
`~/src/openmanager`), not under `/mnt/c`: installs and the server's file
access are far faster there, and Windows-side sync tools such as OneDrive do
not interfere.

## Install

From the repository root, inside Linux or the WSL distro:

```sh
pnpm install
pnpm --filter @openmanager/server build
node apps/server/dist/main.js service install
```

`install` accepts the normal server flags and bakes the resolved values into
the unit, exactly as on Windows:

```sh
node apps/server/dist/main.js service install --port 43120 --workspace ~/src/my-repo --log-level debug
```

| Flag                                 | Effect in the unit                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `--port`                             | Fixed listen port. Port `0` is refused because the service could not be found again. |
| `--data-dir`                         | Identity, SQLite, the owner credential and logs. Also the unit's working directory.  |
| `--log-level`                        | Server log level.                                                                    |
| `--workspace` (repeatable)           | Folders registered on every start.                                                   |
| `--allowed-origin`, `--allowed-host` | Browser origins and proxy hosts, as for a manual start.                              |
| `--tunnel-hostname`, `--tunnel-token-file`, `--cloudflared` | The Cloudflare tunnel. The token is saved to the data directory, never into the unit; see [cloudflare-tunnel.md](./cloudflare-tunnel.md#background-service). |
| `--log-file`                         | Log destination. Defaults to `<data-dir>/logs/server.log`.                           |

The environment variables behind these flags (`OPENMANAGER_PORT`,
`OPENMANAGER_DATA_DIR`, `OPENMANAGER_LOG_LEVEL`, `OPENMANAGER_ALLOWED_ORIGINS`,
`OPENMANAGER_ALLOWED_HOSTS`, `OPENMANAGER_WORKSPACES`, `OPENMANAGER_LOG_FILE`,
`OPENMANAGER_TUNNEL_HOSTNAME`, `OPENMANAGER_TUNNEL_TOKEN_FILE`,
`OPENMANAGER_CLOUDFLARED`)
are honoured the same way flags are, and likewise frozen into the unit as
flags. No other variable of the installing shell is carried over apart from
`PATH` (below): the service does not see `OPENMANAGER_LOCAL_OWNER_CLAIM_KEY`,
so `/local-owner` stays hidden, nor provider settings you export in your
shell. Put environment-only settings in a drop-in.

To use the hosted web client, add its origin, for example
`--allowed-origin https://openmanager.pages.dev`. A later `install` replaces
every stored flag, so repeat the ones you installed with. See
[deploying the web client](./web-deploy.md#allow-the-origin-on-the-environment).

What `install` does, in order:

1. Refuses if you are root, if systemd is not running (with the WSL steps
   above when it is WSL), or if `systemctl --user` cannot reach your user
   manager (typically a shell entered through `sudo` or `su`).
2. If the unit already exists, stops its server so the new one can bind.
3. Refuses if another process still answers on the chosen port, such as a
   `pnpm dev:web` server. Stop it or pick another `--port`.
4. Writes `~/.config/systemd/user/openmanager-server.service`, runs
   `systemctl --user daemon-reload`, checks that systemd loaded the file, and
   runs `systemctl --user enable openmanager-server.service`. The directory
   follows the user manager's `XDG_CONFIG_HOME` (from
   `systemctl --user show-environment`), not your shell's, so a value set only
   in a shell profile cannot hide the unit from systemd or from the other
   `service` commands.
5. Turns linger on if it is off. If your system's policy refuses that, install
   still finishes and prints the `sudo loginctl enable-linger <you>` command to
   run; until then the server stops when you log out.
6. On WSL, reports whether the distro will stay running (below).
7. Starts the unit and waits up to 20 seconds for `GET /health` to answer.

### What the unit contains

The unit runs `<node> <dist/main.js> <flags>` with `Type=exec`,
`Restart=on-failure` after 10 seconds, at most 5 starts in 5 minutes,
`KillMode=mixed` (the server gets SIGTERM and can end its provider processes
itself; anything left after 15 seconds is killed) and `WantedBy=default.target`.

It also sets **`PATH` to the installing shell's `PATH`**, with the Node
directory first. systemd's own `PATH` for user services is minimal and would
miss nvm, `~/.local/bin` and npm global folders, where Node and the provider
CLIs usually live. Rerun `install` after installing a provider CLI somewhere
new. On WSL this includes the Windows folders WSL appends to `PATH`, exactly
as in your terminal.

To add anything else, such as an environment variable a provider needs, use a
drop-in rather than editing the unit, because `install` rewrites the unit file:

```sh
systemctl --user edit openmanager-server
# [Service]
# Environment=SOME_VARIABLE=value
node apps/server/dist/main.js service restart
```

Drop-ins live in `~/.config/systemd/user/openmanager-server.service.d/`,
survive reinstalls, and are left in place by `uninstall`.

## Keep the WSL distro running

WSL shuts a distro down about 15 seconds after its last Windows-side process
exits, however many systemd services are running inside it. Closing the last
WSL terminal therefore stops the server shortly after. To keep the distro, and
the server, running, set this in `%UserProfile%\.wslconfig` on Windows:

```ini
[general]
instanceIdleTimeout=-1
```

and run `wsl.exe --shutdown` once so WSL picks it up. The setting applies to
every distro and keeps the WSL VM's memory reserved while a distro runs. When
you are done with the environment for the day, `wsl.exe --terminate <distro>`
stops it.

`install` and `status` read this file through WSL interop and say which case
you are in; if interop is turned off they print the advice regardless.

Nothing starts WSL when Windows boots or you sign in. With the setting above
the server comes up as soon as anything starts the distro (opening a WSL
terminal, or a `wsl.exe` command) and then stays up.

Inside WSL there is exactly one login session per distro boot, shared by all
terminals, so "logging out" of WSL means the distro stopping. Linger is still
turned on so the unit behaves the same if that ever changes.

## Upgrade without losing the environment

Build or unpack the new release into a **separate directory**, then run its entry
with the Node binary you want the service to use:

```sh
node /path/to/new-release/apps/server/dist/main.js service update
```

On Windows, use the corresponding Windows path. `update` takes no server flags:
it reads the installed definition, prepares the replacement, stops the old
process and waits for shutdown, switches the Node/entry paths, then starts the
new build and waits up to 20 seconds for health. No manual process kill is needed.
Keep the old release in place until the command finishes; do not overwrite a
running release's files or Node executable.

The stored port, data directory, workspaces, origins, hosts, logging settings and
supervisor settings stay unchanged. Identity, owner credentials and SQLite stay
in the existing data directory; the invoking shell's server settings are ignored.
Use `service install` when you intend to change configuration, and `service
restart` to restart the same build. On Windows, updating an older task also adds
the crash launcher. On Linux, the stored PATH and systemd drop-ins are retained;
keep executable overrides out of drop-ins so the unit owns the entry path.

An unconfirmed stop prevents the definition from being replaced. If registration
or startup fails, the command exits unsuccessfully: inspect `service status` and
`service logs`, correct the problem and retry `update` or `start`. Data is never
removed. There is no automatic binary rollback, since startup may already have
migrated SQLite; downgrading requires a release-compatible database backup.

### In-flight work and crash recovery

Updates and intentional stops use the server-core shutdown policy: close client
sockets with `server_shutdown`, settle pending interactions, terminate in-flight
provider runtimes and wait for cleanup before closing the database. They do not
wait for a turn to finish or automatically replay a prompt. The supervisor allows
15 seconds before forced termination. A forced exit falls back to startup recovery.

On restart, any durable running/waiting turn left unfinished becomes interrupted,
its session is marked as an error, partial messages are finalized, and pending
interactions are cancelled. Completed history remains available; clients reconnect
with the same credential and the user can explicitly start another turn.

## Check, start, stop, restart, remove

```sh
node apps/server/dist/main.js service status
node apps/server/dist/main.js service status --json
node apps/server/dist/main.js service start
node apps/server/dist/main.js service stop
node apps/server/dist/main.js service restart
node apps/server/dist/main.js service uninstall
```

- `status` prints the unit state (for example `active, running; enabled`),
  a warning if systemd cannot use the unit file, the last exit when it is not
  running, the restart count after crashes,
  linger, the WSL idle setting, whether `/health` answers (and whether the
  answer comes from the unit or from some other server on the port), the data
  directory and the log file. Exit code `0` means the unit is running and its
  server answered.
- `start` clears a previous crash-loop `failed` state and starts the unit. It
  refuses while another server holds the port.
- `stop` stops the server (SIGTERM, a clean shutdown) but leaves the unit
  installed and enabled; the next boot, login or distro start brings it back.
- `restart` stops the installed server, verifies shutdown, starts the same
  service definition and waits up to 20 seconds for health. Its port, data
  directory, identity, SQLite database and credentials remain unchanged.
- `uninstall` stops the server, disables and deletes the unit and reloads
  systemd. Linger stays on, since other user services may rely on it; turn it
  off with `loginctl disable-linger <you>` if nothing else needs it. The data
  directory is left alone; delete it by hand for a clean slate.

`systemctl --user status openmanager-server` and
`journalctl --user -u openmanager-server` work too; they show systemd's view
(starts, stops, crashes).

### Scriptable status and retained data

`status --json` prints one object with `installed`, `state`, `healthy`, `port`,
`dataDir` and `logFile` (paths are omitted if unavailable). States are `running`,
`stopped`, `failed`, `unknown` (the supervisor/process lookup cannot confirm a
state), or `not-installed`. A running process can still be unhealthy. Exit
code 0 requires both confirmed running state and a successful health response;
all other states return 1. Credential values are never included.

Restart and uninstall fail if shutdown cannot be confirmed, keeping the
registration available for a retry. Uninstall intentionally retains the
**whole data directory together**, including identity, SQLite authorization
records and `owner-credential`; it prints that location. Reinstall with the
same `--data-dir` reuses them. No credentials are copied into the service
registration. For permanent removal, first complete uninstall successfully,
then remove the reported data directory yourself (this also deletes stored
sessions), any custom log location, and saved credentials in connected UIs.
Deleting only `owner-credential` does not revoke the authorization records in
SQLite. Provider CLI logins belong to the user and are not removed.

## Connecting a UI

Clients authenticate exactly as with a manual start. The server publishes the
owner credential to `<data-dir>/owner-credential` (mode `0600`) on first
start. Paste the endpoint `http://127.0.0.1:<port>` and that credential into
the web shell's connection form, or pass them to the desktop app as described
in [windows-startup.md](./windows-startup.md#connecting-a-ui-to-the-background-server).

On WSL with the default NAT networking, Windows reaches the server at
`http://127.0.0.1:<port>` through localhost forwarding. The WSL server has its
own data directory (`~/.openmanager` inside the distro) and so its own owner
credential; read it with `cat ~/.openmanager/owner-credential` in WSL. If you
also run the Windows logon task, give the two servers different ports so it
is clear which one a Windows client reaches.

## Logs

```sh
node apps/server/dist/main.js service logs
node apps/server/dist/main.js service logs --lines 200 --follow
```

`logs` reads the installed log path, including a custom `--log-file`, rather
than guessing from the current shell. It prints the last 100 lines by default;
`--lines` (or `-n`) accepts 0 to 10000. The initial tail examines at most the last
1 MiB, so very large records may yield fewer lines. `--follow` (or `-f`) waits
for a missing file, follows new records across restart/rotation and truncation,
and stops with Ctrl+C. Without `--follow`, a missing file is an error. The
location is printed to stderr and log records to stdout. These commands read
application logs; supervisor diagnostics remain available in the tools below.

The server writes one JSON record per line to the log file (default
`<data-dir>/logs/server.log`), including startup failures. At 10 MiB the file
is renamed to `server.log.1` at the next start. systemd's journal
(`journalctl --user -u openmanager-server`) records the unit's own events:
start, stop, exit status and restarts.

## Limits and follow-ups

- The logout and boot behaviour on native Linux is systemd's documented linger
  behaviour; it was verified end to end on WSL (Ubuntu 24.04, systemd 255),
  not yet on a native Linux machine.
- Starting the WSL distro at Windows sign-in, so a WSL environment is ready
  without opening a terminal, is separate work.
- Moving Node or the repository breaks the recorded paths: `status` shows the
  unit as failed and `install` again fixes it.
- Packaging and downloading new releases are separate from the `service update` handoff.
