# Running the environment server at sign-in on Windows

The environment server can register itself as a **per-user Windows logon
task**. After that, signing in starts the server in the background with no
window, closing the desktop app or a browser tab leaves it running, and
signing out or shutting down stops it. No administrator rights and no stored
password are needed. The reasoning behind this shape (and why it is not a
Windows service) is in
[decisions/windows-startup-task.md](./decisions/windows-startup-task.md).

Linux and WSL use the same `service` commands, which install a systemd user
unit there instead; see [linux-systemd.md](./linux-systemd.md).

## Prerequisites

- Native Windows 10 or 11, signed in as the user whose provider logins
  (Claude Code, Codex, Cursor, OpenCode) the environment should use.
- Node 24 LTS on disk. The task records the absolute path of the `node.exe`
  that runs `service install`, so install with the Node you intend to keep.
  Version managers that swap the binary under a stable path (nvm-windows,
  fnm's `installation` folders) are fine as long as that path keeps existing.
- A built server: the task runs `apps/server/dist/main.js`.

## Install

From the repository root:

```sh
pnpm install
pnpm --filter @openmanager/server build
node apps/server/dist/main.js service install
```

`install` accepts the normal server flags and bakes the resolved values into
the task, so a later shell environment cannot change what the task runs:

```sh
node apps/server/dist/main.js service install --port 43120 --workspace C:\src\my-repo --log-level debug
```

| Flag                                 | Effect in the task                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `--port`                             | Fixed listen port. Port `0` is refused because the task could not be found again.     |
| `--data-dir`                         | Where identity, SQLite, the owner credential and logs live. Also the task's start-in. |
| `--log-level`                        | Server log level.                                                                     |
| `--workspace` (repeatable)           | Folders registered on every start.                                                    |
| `--allowed-origin`, `--allowed-host` | Browser origins and proxy hosts, as for a manual start.                               |
| `--log-file`                         | Log destination. Defaults to `<data-dir>\logs\server.log`.                            |

The environment variables behind these flags (`OPENMANAGER_PORT`,
`OPENMANAGER_DATA_DIR`, `OPENMANAGER_LOG_LEVEL`, `OPENMANAGER_ALLOWED_ORIGINS`,
`OPENMANAGER_ALLOWED_HOSTS`, `OPENMANAGER_WORKSPACES`, `OPENMANAGER_LOG_FILE`)
are honoured the same way flags are, and likewise frozen into the task as
flags. Anything else set only in the installing shell, such as
`OPENMANAGER_LOCAL_OWNER_CLAIM_KEY`, is not: the task runs with your normal
user environment. Set persistent variables as user environment variables in
Windows instead.

To use the hosted web client, add its origin, for example
`--allowed-origin https://openmanager.pages.dev`. A later `install` replaces
every stored flag, so repeat the ones you installed with. See
[deploying the web client](./web-deploy.md#allow-the-origin-on-the-environment).

What `install` does, in order:

1. Refuses if another process already answers on the chosen port (typically a
   `pnpm dev:web` server). Stop it or pick another `--port`.
2. If a task already exists, stops its server so the new one can bind.
3. Writes a task definition and registers it with `schtasks /Create`. The task
   is `\OpenManager\Environment Server` in Task Scheduler; it triggers at your
   logon, runs with your interactive token at least privilege, never times
   out, and is not stopped on battery. A launcher restarts a crashed server
   after 10 seconds, at most three times in a rolling five-minute window.
4. Starts the task and waits up to 20 seconds for `GET /health` to answer.

The action is `conhost.exe --headless <node> <dist\main.js> --supervise <flags> --exit-with-parent`.
The headless console host keeps a terminal window from appearing. It can report
exit code 0 even when its child crashes, so the launcher observes server exits
directly instead of relying on Task Scheduler's restart-on-failure setting. The
server runs detached from the host, watches the launcher and exits gracefully
when its parent disappears. The launcher also follows its console host and uses
IPC to request normal server shutdown. A clean exit or intentional stop is not
restarted. After the crash limit, inspect the log and run `service start`; Task
Scheduler's last result may still be 0 because of conhost.

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

- `status` prints the task state, the last run result, whether `/health`
  answers (and whether the answer comes from the task's server or from some
  other server on the port), the data directory and the log file. Exit code
  `0` means the task's server is running and answered. Task Scheduler itself
  shows the same task under `Task Scheduler Library › OpenManager`.
- `start` refuses while another server holds the task's port.
- `stop` ends the running server but leaves the task registered; the next
  sign-in (or `start`) brings it back.
- `restart` stops the installed server, verifies shutdown, starts the same
  service definition and waits up to 20 seconds for health. Its port, data
  directory, identity, SQLite database and credentials remain unchanged.
- `uninstall` stops the server and removes the task. The data directory,
  including the owner credential, SQLite database and logs, is left alone;
  delete it by hand if you want a clean slate. The now-empty `OpenManager`
  folder stays in the Task Scheduler tree; it is harmless and reused by the
  next `install`.

Stopping is abrupt from the server's point of view (Windows has no signal to
deliver to a windowless process), which is the same as `Ctrl+C` on Windows
today. The database uses WAL and survives it; an in-flight agent turn is cut.

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

## Connecting a UI to the background server

Nothing about the task changes how clients authenticate. The server publishes
the owner credential to `<data-dir>\owner-credential` on first start, and
every UI presents that credential:

- **Web shell (`apps/web`)**: paste the endpoint `http://127.0.0.1:<port>` and
  the contents of `owner-credential` into the connection form. The
  `/local-owner` shortcut used by `pnpm dev:web` is not available, because the
  task does not hold that process-scoped claim key.
- **Desktop app on the WebSocket backend**: start it with
  `OPENMANAGER_ENVIRONMENT_CLIENT=websocket`, `OPENMANAGER_ENVIRONMENT_URL=http://127.0.0.1:<port>`
  and `OPENMANAGER_CLIENT_TOKEN=<contents of owner-credential>`.

Closing either UI does not affect the server; only `service stop`, `service
uninstall`, signing out, or exhausting the crash-restart limit does.

## Development alongside the task

`pnpm dev:web` starts its own server on port `43120`. While the task is
installed on the default port, either stop it first (`service stop`) or
install the task on another port and keep `43120` for development. `install`
detects the conflict and refuses rather than registering a task that would
crash-loop.

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
`<data-dir>\logs\server.log`). Startup failures land there too, since the task
has no console. When the file reaches 10 MiB it is renamed to `server.log.1`
at the next start; older content is dropped. Task Scheduler's own history for
the task (start, stop, restart-on-failure) is in the task's **History** tab if
task history is enabled on the machine.

## Limits and follow-ups

- The server runs only while you are signed in. A machine that boots to the
  lock screen has no environment until the first sign-in; a second user
  signing in does not get your task. This is a consequence of running with
  your interactive token, which is what makes provider CLIs, OneDrive files
  and user-owned folders work without configuration.
- Moving Node or the repository breaks the recorded paths; `status` shows the
  failure and `install` again fixes it.
- The launcher records crash/retry details in the server log; Task Scheduler only sees the console host.
