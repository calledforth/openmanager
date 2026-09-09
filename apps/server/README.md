# Environment server

A standalone, headless Node 24 LTS application. It starts without Electron or
Convex configuration and owns the shared `@agentpack/runtime` lifecycle. Provider
processes remain demand-driven, so mounting the runtime does not spawn one. See the
[runtime decision](../../docs/decisions/environment-server-runtime.md).

From the repository root, using Node 24 and the pinned pnpm version:

```sh
pnpm install
pnpm --filter @openmanager/server dev
```

To develop the browser shell against this process, use the combined command
instead. It starts the server watcher and the Vite app together and allows the
Vite origins:

```sh
pnpm dev:web
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
| `--allowed-origin` (repeatable) | `OPENMANAGER_ALLOWED_ORIGINS` (comma-separated) | none |

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
  `protocolVersion`, `capabilities`, a privacy-safe provider catalog and health
  snapshot, and `websocketUrl`. The response validates against the protocol
  bootstrap schema. Provider health omits executable paths, account labels,
  thread IDs and diagnostic messages. The socket URL is `ws://127.0.0.1:<bound-port>/ws`,
  including the actual port when configured with port `0`.

Neither response includes paths, session data or credentials. Other methods
and paths return 404. Request Host and forwarding headers never determine
advertised connection metadata. This is local connection discovery; remote
routes and their origin policy require separate configuration in later work.
The `/ws` endpoint requires a client credential before upgrading. SIGINT/SIGTERM
close HTTP connections and WebSockets (code `1001`, reason `server_shutdown`).
The server mounts the same OpenCode, Cursor, and Claude Code registrations used
by the desktop. Provider executables and their CLI-owned credentials/config are
resolved only in this trusted process and are not included in HTTP or WebSocket
payloads. Protocol routing now invokes the runtime directly; database persistence
and durable turn recovery belong to subsequent work.

## Authenticated connections

First boot also creates `client-token` in the data directory: a random 256-bit,
hex-encoded environment-wide development credential. It is persisted atomically
and reused after restart; concurrent starts converge on the same token. POSIX
creation requests owner-only file permissions. Windows uses the data directory's
ACLs. The token is never logged or included in discovery responses. Read the file
locally to configure a trusted client; anyone holding it has access to the entire
environment. Pairing and per-client credentials will replace this initial issuance.
An invalid credential file fails startup rather than silently replacing it.

Native clients authenticate with `Authorization: Bearer <token>` on the upgrade.
Browser clients use two WebSocket subprotocols because the browser API cannot set
that header:

```ts
const socket = new WebSocket(bootstrap.websocketUrl, [
  'openmanager.v1',
  `openmanager.auth.${token}`,
])
```

The server selects only `openmanager.v1`; it does not echo the token in its
response. Tokens in query strings, cookies, or messages after upgrade are not
accepted. Upgrade rejection returns an HTTP error with the protocol error
envelope (`auth` for missing/invalid credentials). Browsers expose a generic
WebSocket error for a failed upgrade, so UI must not rely on reading that HTTP body.

Browser origins must be explicitly approved, independently of authentication:

```sh
pnpm --filter server dev --allowed-origin http://localhost:5173
```

Use exact HTTP(S) origins, without paths, wildcards, trailing slashes or
credentials. The same allowlist applies to HTTP CORS and WebSocket upgrades.
Unlisted origins, including opaque `null` origins, are rejected even with a valid
token. Native requests without an Origin header are permitted, but sockets still
require authentication. HTTP discovery is a simple GET without credentials;
allowed origins receive an exact `Access-Control-Allow-Origin` and `Vary: Origin`.
Remote TLS routes and hosted-browser local-network permission handling remain
separate work; the listener and advertised socket URL are still loopback-only.

After upgrade, the first command must be `protocol.handshake`, carrying
`protocolVersion` and `requiredCapabilities`. Rejected handshakes receive their
correlated protocol error and close. Connections that do not handshake within
10 seconds close with `1008 / handshake_timeout`.

Handshaken clients can subscribe/unsubscribe using the existing protocol schemas.
Scopes are exact, non-recursive environment/session/thread streams; foreign
environment IDs are rejected. Subscription IDs and command results belong to the
connection. Duplicate command IDs replay identical results without a second
effect; conflicting reuse produces an uncorrelated `conflict` and closes the
connection. This cache lasts only for the connection: reconnect requires a fresh
handshake and fresh subscriptions. Durable command recovery is not implemented.

The `provider.discovery`, `provider.health`, and `provider.probe` capabilities
expose server-owned provider discovery. `provider.probe` accepts a provider ID
and workspace path, runs the existing `desktop-bootstrap:<provider>` probe path,
and never creates a session runtime. Matching provider/workspace probes coalesce;
distinct probes share one global tail so only one bootstrap CLI runs at a time.
Authenticated, handshaken clients receive `provider_health_changed` events when
the public health snapshot transitions; the handshake bootstrap supplies the
latest snapshot across reconnect gaps.

`session.create`, `session.open`, `turn.send`, and `turn.interrupt` route directly
to the mounted runtime. Session creation supplies the provider ID and trusted
workspace path; later commands resolve that route from server-owned host IDs.
The server accepts or rejects each command synchronously before queueing provider
work, so even a provider that emits during startup cannot overtake its response.
Known missing, unauthenticated, or unhealthy providers are rejected without
starting work. An accepted interrupt retains ownership if the prompt settles
before cancellation is acknowledged and emits one protocol `turn.interrupted`
event. Routing records are currently process-local and will move into the planned
SQLite persistence service.

The embedding host calls `server.sockets.publish(record)` with an already
persisted, protocol-valid `DurableEvent` to deliver `subscription.event` to matching
subscriptions. The transport does not manufacture cursors, persist events, resolve
resource existence or implement replay/snapshot commands. Those belong to the
future domain/persistence services. The development credential authorizes all
scopes in this environment; scoped subscriptions are routing, not per-resource ACLs.

Heartbeat uses the protocol's monotonic-clock helpers: a fresh application ping
every 15 seconds after handshake, with 10 seconds to return its matching pong.
Other traffic and stale pongs do not extend that deadline. Timeout closes with
`4000 / heartbeat_timeout` and immediately releases live subscriptions and command
state. Graceful and abrupt socket closes also release all connection state.
Close handshakes have a one-second termination fallback for unresponsive peers.

Transport limits bound memory: 128 sockets, 128 subscriptions and 1,024 retained
command results per connection, 64 KiB inbound messages and 1 MiB outbound buffers.
Connection/subscription exhaustion returns `unavailable`; command-cache exhaustion
returns `unavailable` and closes so callers establish a fresh connection. Slow
consumers close with `1008 / slow_consumer`. WebSocket compression is disabled.

## Shutdown and turn recovery contract

SIGINT and SIGTERM put the process into a one-way drain: new socket upgrades are
rejected, existing sockets receive `1001 / server_shutdown`, HTTP keep-alive
connections close, and the process exits only after those listeners and the
agent runtime finish closing. Restarting with the same data directory reuses the
exact environment identity and client credential records. Windows does not
deliver POSIX signals to Node child processes, so its programmatic close path
provides the equivalent graceful behavior; service managers must use a Windows
shutdown mechanism rather than relying on SIGTERM.

The current server does not execute agent turns or own their durable event store.
When those services are attached, they must follow this lifecycle contract:

1. A turn and every accepted message, content delta, tool update, or interaction
   is durably committed before it is published to sockets. Published data is
   therefore never the only copy.
2. Graceful shutdown stops accepting new turns, asks providers to cancel active
   work, appends a durable `turn.interrupted` terminal event after all already
   committed parts, and flushes those writes before sockets and providers close.
3. Startup recovery runs before readiness. Any persisted `running` or `waiting`
   turn without a terminal event is atomically marked `interrupted`. This covers
   process crashes and forced termination where the shutdown hook could not run.
4. Recovery retains every committed partial message and tool/interaction record
   in its original order. It does not silently retry a provider call or invent a
   completion; a later user retry is a new turn.

These rules make interruption explicit while preserving useful partial output.
The persistence integration must add recovery tests using its real store; the
process-level tests here cover the currently durable identity and credential
records.

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
identity preservation and corruption, bootstrap, log filtering, compiled and
native-TypeScript startup, process restart durability, and the close code/reason
delivered to an active socket during SIGTERM. Build, typecheck and dev first
compile the protocol package; Node consumes its built
`@openmanager/protocol/node` export.
The shared CI workflow runs typecheck, tests and build for this package on
Node 24 on Windows and Linux, alongside the protocol package and the web app.
