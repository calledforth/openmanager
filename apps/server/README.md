# Environment server

A standalone, headless Node 24 LTS application. It starts without Electron,
Convex configuration, or running agent providers. See the
[runtime decision](../../docs/decisions/environment-server-runtime.md).

From the repository root, using Node 24 and the pinned pnpm version:

```sh
pnpm install
pnpm --filter @openmanager/server dev
```

The development watcher restarts on source edits. The default startup message
reports `http://127.0.0.1:43120`. The short filter `pnpm --filter server dev`
also selects this package.

To build and run without the development watcher:

```sh
pnpm --filter @openmanager/server build
pnpm --filter @openmanager/server start
```

## Configuration

Flags override environment variables, which override defaults. Invalid values,
unknown flags, occupied ports, and data-directory creation failures stop startup
with a nonzero exit code and an error on stderr.

| Flag          | Environment variable    | Default                                     |
| ------------- | ----------------------- | ------------------------------------------- |
| `--port`      | `OPENMANAGER_PORT`      | `43120`                                     |
| `--data-dir`  | `OPENMANAGER_DATA_DIR`  | `.openmanager` in the user's home directory |
| `--log-level` | `OPENMANAGER_LOG_LEVEL` | `info`                                      |

```sh
pnpm --filter server dev --port 0 --data-dir "./local data" --log-level debug
```

Port `0` asks the OS for an available port; the startup log contains the actual
port. Relative paths resolve from the process working directory (normally
`apps/server` when launched through pnpm). The directory is created recursively;
POSIX creation requests owner-only permissions. Existing directory permissions
and Windows ACLs are not changed. No environment identity or database is created.

Log levels are `debug`, `info`, `warn`, `error`, and `silent`. JSON log records at
or above the configured severity are printed; the startup record is `info`, so
`warn`, `error`, and `silent` suppress it. Startup failures always go to stderr.

The listener always binds to IPv4 loopback (`127.0.0.1`). Every request currently
returns 404, including `/health`. HTTP bootstrap, identity, authenticated
WebSockets, persistence, and provider services belong to subsequent work. This
scaffold is not a remote-access endpoint. SIGINT/SIGTERM close the current HTTP
connections; durable turn recovery is not implemented yet.

## Checks

```sh
pnpm --filter server typecheck
pnpm --filter server lint
pnpm --filter server test
pnpm --filter server build
```

`test` builds first so the CLI smoke test exercises the production JavaScript
entry point. Tests cover configuration precedence and rejection, occupied ports,
data-directory failures, the listener, log filtering, and compiled startup.
The server CI workflow runs these checks on Node 24 on Windows and Linux.
Combined server/web CI and a unified dev command are separate work.
