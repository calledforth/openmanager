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
and Windows ACLs are not changed. First boot creates `identity.json`; no database
is created yet.

Log levels are `debug`, `info`, `warn`, `error`, and `silent`. JSON log records at
or above the configured severity are printed; the startup record is `info`, so
`warn`, `error`, and `silent` suppress it. Startup failures always go to stderr.

The listener always binds to IPv4 loopback (`127.0.0.1`). Two unauthenticated
discovery endpoints return JSON with `Cache-Control: no-store`:

- `GET /health` returns only `{ "status": "ok" }` for process liveness. It does
  not check provider readiness or database availability.
- `GET /bootstrap` returns the persisted `environmentId` and `label`,
  `protocolVersion`, `capabilities`, and `websocketUrl`. The response validates
  against the protocol bootstrap schema. Capabilities remain empty until
  services are implemented. The socket URL is `ws://127.0.0.1:<bound-port>/ws`,
  including the actual port when configured with port `0`.

Neither response includes paths, session data or credentials. Other methods
and paths return 404. Request Host and forwarding headers never determine
advertised connection metadata. This is local connection discovery; remote
routes and their origin policy require separate configuration in later work.
The `/ws` address reserves the endpoint for the authenticated WebSocket
lifecycle; advertising it does not imply it is implemented or authenticated.
Database persistence and provider services also belong to subsequent work.
SIGINT/SIGTERM close the current HTTP connections; durable turn recovery is not
implemented yet.

## Stable environment identity

On first boot, the server saves a random UUID and the device hostname as its
human-readable label in the configured data directory. The label is limited to
128 characters with control characters removed; an empty hostname falls back to
`OpenManager` plus the first eight UUID characters. Subsequent boots read that
record unchanged, even if the device is renamed. Separate data directories on
the same device have distinct IDs and can share a label. The label is returned
by bootstrap, so clients can show a recognizable device name.
Ports, proxy/tunnel URLs, and the location of a restored data
directory do not define identity. Back up the whole data directory together: a
restored copy represents the same environment, not a newly authorized machine.

Identity publication uses a flushed temporary file and an atomic, non-replacing
hard link. Concurrent first boots converge on the same complete record. The data
directory must be on a filesystem supporting hard links (such as NTFS or ext4);
unsupported filesystems fail startup rather than weakening identity guarantees.
POSIX also flushes the containing directory. Windows uses file flushing and
atomic publication, without a directory-fsync power-loss guarantee.
An interrupted first boot can leave an unpublished `.identity-*.tmp` file; later
boots ignore it. Such temporary files can be removed while the server is stopped.

Invalid, unsupported-version or unreadable identity records stop startup; they
are never silently replaced. Restore a damaged record from backup. Do not edit
or delete `identity.json` independently of its environment data: losing this file
loses the environment's identity. There is no identity-rotation command. The
only supported way to deliberately create a new identity is to stop the server
and delete the **entire configured data directory**, which discards its state
and requires clients to treat the next boot as a new environment.

## Checks

```sh
pnpm --filter server typecheck
pnpm --filter server lint
pnpm --filter server test
pnpm --filter server build
```

`test` builds first so the CLI smoke test exercises the production JavaScript
entry point. Tests cover configuration precedence and rejection, occupied ports,
data-directory failures, concurrent identity initialization across processes,
identity preservation and corruption, bootstrap, log filtering, and compiled
and native-TypeScript startup. Build, typecheck and dev first compile the protocol
package; Node consumes its built `@openmanager/protocol/node` export.
The server CI workflow runs these checks on Node 24 on Windows and Linux.
Combined server/web CI and a unified dev command are separate work.
