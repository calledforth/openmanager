# Running the environment server at sign-in on Windows

The environment server can register itself as a **per-user Windows logon
task**. After that, signing in starts the server in the background with no
window, closing the desktop app or a browser tab leaves it running, and
signing out or shutting down stops it. No administrator rights and no stored
password are needed. The reasoning behind this shape (and why it is not a
Windows service) is in
[decisions/windows-startup-task.md](./decisions/windows-startup-task.md).

Linux and WSL are handled separately with a systemd user unit; the `service`
commands below refuse to run there.

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

The `OPENMANAGER_*` environment variables of the installing shell are honoured
the same way flags are, and likewise frozen into the task.

What `install` does, in order:

1. Refuses if another process already answers on the chosen port (typically a
   `pnpm dev:web` server). Stop it or pick another `--port`.
2. If a task already exists, stops its server so the new one can bind.
3. Writes a task definition and registers it with `schtasks /Create`. The task
   is `\OpenManager\Environment Server` in Task Scheduler; it triggers at your
   logon, runs with your interactive token at least privilege, never times
   out, is not stopped on battery, and is restarted up to three times a minute
   apart if the server exits with an error.
4. Starts the task and waits up to 20 seconds for `GET /health` to answer.

The action is `conhost.exe --headless <node> <dist\main.js> <flags> --exit-with-parent`.
The headless console host is what keeps a terminal window from appearing; the
server watches that host and exits if Task Scheduler ends it.

## Check, start, stop, remove

```sh
node apps/server/dist/main.js service status
node apps/server/dist/main.js service start
node apps/server/dist/main.js service stop
node apps/server/dist/main.js service uninstall
```

- `status` prints the task state, the last run result, whether `/health`
  answers, the data directory and the log file. Exit code `0` means the server
  answered. Task Scheduler itself shows the same task under
  `Task Scheduler Library › OpenManager`.
- `stop` ends the running server but leaves the task registered; the next
  sign-in (or `start`) brings it back.
- `uninstall` stops the server and removes the task. The data directory,
  including the owner credential, SQLite database and logs, is left alone;
  delete it by hand if you want a clean slate. The now-empty `OpenManager`
  folder stays in the Task Scheduler tree; it is harmless and reused by the
  next `install`.

Stopping is abrupt from the server's point of view (Windows has no signal to
deliver to a windowless process), which is the same as `Ctrl+C` on Windows
today. The database uses WAL and survives it; an in-flight agent turn is cut.

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
uninstall`, signing out, or a crash does.

## Development alongside the task

`pnpm dev:web` starts its own server on port `43120`. While the task is
installed on the default port, either stop it first (`service stop`) or
install the task on another port and keep `43120` for development. `install`
detects the conflict and refuses rather than registering a task that would
crash-loop.

## Logs

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
- A graceful update handoff and richer supervision (logs viewer, restart
  command, crash reporting) are tracked as separate work in the same project.
