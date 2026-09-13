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
instead. It starts the server watcher and the Vite app together, allows the
Vite origins, and registers the repository as the only workspace unless
`OPENMANAGER_WORKSPACES` is set:

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
| `--allowed-host` (repeatable) | `OPENMANAGER_ALLOWED_HOSTS` (comma-separated) | none |
| `--workspace` (repeatable) | `OPENMANAGER_WORKSPACES` (separated by the platform PATH delimiter) | none |

```sh
pnpm --filter server dev --port 0 --data-dir "./local data" --log-level debug
```

Port `0` asks the OS for an available port; the startup log contains the actual
port. Relative paths resolve from the process working directory (normally
`apps/server` when launched through pnpm). The directory is created recursively;
POSIX creation requests owner-only permissions. Existing directory permissions
and Windows ACLs are not changed. First boot creates `identity.json` and
`openmanager.sqlite`. Startup opens that database with WAL, `synchronous=NORMAL`,
foreign keys, and a 5s busy timeout, then applies numbered migrations from
[`src/db/migrations.ts`](src/db/migrations.ts) inside one transaction. SQLite
stores the environment-owned domain model and composer state in the environment
data directory. The schema and its authority/cascade rules are documented in
[`docs/decisions/sqlite-persistence-schema.md`](../../docs/decisions/sqlite-persistence-schema.md).
A database whose `schema_version` is newer than this server knows causes startup
to fail without binding a port.

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

Every WebSocket carries a per-client credential, loopback included; network
position grants nothing (threat model D2). Credentials and their grants follow
[capability scopes and client credentials](../../docs/decisions/capability-scopes-and-credentials.md):

- A credential is opaque: `omc1.` followed by 32 CSPRNG bytes in unpadded
  base64url (48 characters in total). The server stores only its SHA-256 in
  `authorized_clients`, together with the client's label, kind (`owner`,
  `paired` or `cloud`), capability grant, last-seen time and idle expiry.
- A credential stops working 30 days after its last accepted connection; every
  accepted upgrade moves that window forward. There is no absolute expiry.
- Revoking a row (`server.revokeClient`) closes that client's live sockets with
  close code `4401` and reason `revoked`, and its next upgrade is rejected. The
  owner row cannot be revoked this way.

**Local first run needs no pairing UI.** On startup the process makes sure a
live `owner` row exists and that its credential is published in
`owner-credential` in the data directory (owner-only permissions on POSIX; the
data directory's ACLs on Windows). Restarts reuse it. If the file is missing,
corrupt, or names a credential the database never issued, or if the owner row
has expired, the process mints a new owner credential and revokes the previous
owner row in the same transaction, so deleting the file rotates the owner.
Read the file locally to configure a trusted client; it carries every
capability. The raw credential is never logged, never in discovery responses,
and never stored by the server outside that file. Pairing (`paired` rows) and
cloud enrollment (`cloud` rows) are issued through `clients.issue` and are
separate work.

Native clients authenticate with `Authorization: Bearer <credential>` on the
upgrade. Browser clients use two WebSocket subprotocols because the browser API
cannot set that header:

```ts
const socket = new WebSocket(bootstrap.websocketUrl, [
  'openmanager.v1',
  `openmanager.auth.${credential}`,
])
```

The server selects only `openmanager.v1`; it does not echo the credential in
its response. Credentials in query strings, cookies, or messages after upgrade
are not accepted. Upgrade rejection returns an HTTP error with the protocol
error envelope (`auth` for missing, malformed, unknown, revoked and expired
credentials alike). Browsers expose a generic WebSocket error for a failed
upgrade, so UI must not rely on reading that HTTP body.

### Per-operation authorization

Authenticated is not enough. Every command name is mapped to exactly one access
capability (`read`, `operate`, `agent`, `terminal`, `admin`) in
`COMMAND_ACCESS` in the protocol package, checked with `satisfies` so an
unmapped command does not compile. After the handshake, the socket looks up the
command's capability before any service sees it:

- A name the protocol does not know is a `validation` error for every grant.
- A known command outside the caller's grant fails with `capability_missing`
  and `details.requiredCapability`; the client retry policy for that code is
  `never`. The command's service is not invoked.
- `protocol.handshake` and heartbeat messages need no capability beyond a
  valid credential.

The mapping for today's commands: `read` covers subscriptions, `session.open`,
provider catalog, discovery, health and probe, and `composer.preferences.get`;
`operate` covers `session.create` and `composer.preferences.set`; `agent`
covers `turn.send`, `turn.interrupt`, `interaction.respond` and the composer
model, mode and config-option setters. The owner grant holds all five.

## Host and origin policy

Every HTTP request and WebSocket upgrade passes the same two checks, in this
order, before anything else is read. Both fail closed.

**Host.** The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`
for the bound port, or one of the configured allowed hosts. Anything else,
including a missing header, an unexpected port or a hostname that merely
resolves to loopback, is refused with `403` and the `auth` error code. This
is what defeats DNS rebinding: a page on `attacker.example` that points at
`127.0.0.1` reaches the socket but never a route. A tunnel or reverse proxy
hostname is added explicitly:

```sh
pnpm --filter server dev --allowed-host tunnel.example --allowed-host proxy.example:8443
```

Entries are exact `host` or `host:port` values, compared case-insensitively.
Forwarded headers (`X-Forwarded-Host`, `X-Forwarded-Proto`, `Forwarded`) are
never consulted, for the host check or for the advertised socket URL; a proxy
cannot vouch for a hostname it was not configured for.

**Origin.** Browser origins must be explicitly approved, independently of
authentication:

```sh
pnpm --filter server dev --allowed-origin http://localhost:5173
```

Use exact HTTP(S) origins, without paths, wildcards, trailing slashes or
credentials. The same allowlist applies to HTTP CORS and WebSocket upgrades.
Unlisted origins, including opaque `null` origins, are rejected even with a valid
credential. Native requests without an Origin header are permitted, but sockets still
require authentication. HTTP discovery is a simple GET without credentials;
allowed origins receive an exact `Access-Control-Allow-Origin` and `Vary: Origin`.
Remote TLS routes and hosted-browser local-network permission handling remain
separate work; the listener and advertised socket URL are still loopback-only.

Every refusal is recorded as an audit event (see below).

## Rate limits

Fixed windows, defined in [`src/rate-limit.ts`](src/rate-limit.ts) as
`RATE_LIMITS` and pinned by `tests/rate-limit.test.ts`:

| Policy         | Key            | Limit          | Applies to                                                             |
| -------------- | -------------- | -------------- | ---------------------------------------------------------------------- |
| `auth_failure` | remote address | 10 per minute  | Failed credential checks on WebSocket upgrade.                         |
| `pairing`      | remote address | 5 per minute   | Pairing-link exchange attempts; reserved for the pairing endpoint (CAL-102). |
| `prompt`       | client         | 30 per minute  | `turn.send`.                                                           |
| `mutation`     | client         | 120 per minute | Every other `operate`, `agent`, `terminal` or `admin` command.         |

An address over its `auth_failure` budget receives `429` with a `Retry-After`
header and the `unavailable` error code, and no credential it presents is
checked until the window ends. Behind the tunnel every request arrives from
`127.0.0.1`, so that lockout is shared by everyone on the tunnel for the rest
of the minute; that is the accepted cost of not trusting a forwarded address.
A client over a per-client budget receives an `unavailable` error with
`details.policy` and `details.retryAfterMs` for that command; the protocol's
retry policy for `unavailable` is `after_backoff`. Replays of an
already-answered request ID return the cached result and are not counted.
`read` commands are not budgeted. At most 4,096 keys are tracked per policy;
beyond that the window closest to expiry is forgotten first.

## Workspaces and path boundaries

Clients name a workspace by ID, never by path. The roots this environment
exposes are configured at startup:

```sh
pnpm --filter server dev --workspace ~/code/app --workspace ~/code/lib
```

Each root is canonicalized with `realpath` (following symlinks, Windows
junctions and 8.3 short names) and registered in the `workspaces` table, which
assigns the ID a client sees. The ID is stable across restarts; the path is
not returned by any command. A root that does not exist fails startup. A root
configured inside another configured root is folded into the outer one. Only
the roots configured for the running process are resolvable, even if the table
still holds earlier rows.

`workspace.list` (`read`) returns `{ workspaceId, name }` for each registered
root. `session.create` and `provider.probe` take a `workspaceId` and run in
that root; an unknown ID, including a root path sent in place of an ID, fails
with `not_found` and a `workspace.rejected` audit event before any runtime
work. File, git, upload and terminal commands added later obtain their absolute
path from the registry's `resolvePath(workspaceId, relativePath)`, which:

- refuses absolute paths on either platform, drive-relative paths (`C:file`)
  and UNC paths (`\\server`, `//server`, `\\wsl$`);
- treats both `/` and `\` as separators, refuses NUL, and on Windows refuses
  reserved device names and alternate data streams;
- resolves the deepest existing ancestor with `realpath`, so a symlink or
  junction that leaves the root is refused even when the target does not exist
  yet, and compares final on-disk locations (case-insensitively on Windows and
  macOS);
- records a `path.rejected` audit event naming the client, workspace, path and
  reason.

The boundary covers OpenManager's own APIs. It does not constrain what a
provider CLI reads once it is running in the root; that is governed by the
provider's own permission mode.

## Audit events

Security events are recorded through [`src/audit.ts`](src/audit.ts) and stored
in the `audit_events` SQLite table. Each row has a `type`, an `outcome`
(`rejected`, `denied`, `failed`, `issued`, `revoked`, `exchanged`), a
timestamp, the `clientId` when the request had one, the `command` or HTTP
surface, the remote address for pre-authentication refusals, and bounded
`details`. Query locally with `server.audit.query({ clientId, type, outcome })`.

Types written today:

| Type                  | When                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| `host.rejected`       | `Host` is missing or not allowlisted.                                |
| `origin.rejected`     | Browser `Origin` is not allowlisted.                                 |
| `auth.failed`         | Missing, malformed, unknown, expired or revoked credential.          |
| `rate_limited`        | Auth-failure lockout or a per-client command budget.                 |
| `workspace.rejected`  | Unknown workspace ID or a root path sent in place of an ID.          |
| `path.rejected`       | A relative path that escapes a registered workspace.                 |
| `capability.denied`   | Authenticated command whose grant lacks the required capability.     |
| `token.issued`        | A credential is minted (owner, paired or cloud).                     |
| `token.revoked`       | A credential is revoked, including owner rotation.                   |
| `pairing.issued`      | A pairing link is minted (CAL-102).                                  |
| `pairing.exchanged`   | A pairing link is exchanged for a credential (CAL-102).              |
| `pairing.rejected`    | A pairing exchange is refused (CAL-102).                             |
| `upload.rejected`     | An attachment exceeds `MAX_ATTACHMENT_BYTES` (CAL-87).               |

Refusals are also written to the structured log at `warn`; issue and revoke
events are `info`, so a first-run mint does not look like a startup failure.
The record shape is `{"level":"...","message":"audit","audit":{...}}`. Events
are delivered to in-process subscribers (`server.audit.subscribe`). Structured
logs and audit rows never
contain credentials, file contents or provider secrets: secret-named fields
and `omc1.` / `Bearer` / `sk-` values are replaced with `[redacted]`, and
client-supplied strings are truncated to 256 characters.

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

`provider.catalog.get` returns the discovery rows enriched with the latest
persisted model/mode profile learned from probes and live sessions.
`composer.preferences.get` and `composer.preferences.set` read and patch the
selection for one workspace/provider pair. `composer.model.set`,
`composer.mode.set`, and `composer.config_option.set` apply a selection to the
addressed live session before persisting it. A model change also reconciles the
remembered config values against the provider's refreshed option list, matching
the desktop runtime behavior. New and respawned provider processes automatically
pull the durable model and config values from SQLite. Mode remains a persisted
composer choice but is only applied by explicit commands, so a respawn does not
fight provider plan/execute transitions. Restarting with the same data directory
retains every preference field.

`session.create`, `session.open`, `turn.send`, and `turn.interrupt` route directly
to the mounted runtime. Session creation resolves its workspace ID through the
registry to a canonical root and, until workspace/provider preferences land,
uses the desktop-compatible OpenCode fallback as the provider for every root.
The server accepts or rejects each command synchronously before queueing provider
work, so even a provider that emits during startup cannot overtake its response.
Known missing, unauthenticated, or unhealthy providers are rejected without
starting work. An accepted interrupt retains ownership if the prompt settles
before cancellation is acknowledged and emits one protocol `turn.interrupted`
event. If the cancellation request fails, the turn remains active to prevent
concurrent provider work and permit another interrupt attempt; a later provider
completion or failure emits the eventual terminal event. Routing records are
currently process-local and will move into the planned SQLite persistence service.

Raw runtime events pass through the provider-neutral projection boundary before
delivery. The thread service resolves host turn/message/tool/interaction IDs and
classifies terminal outcomes; provider IDs, native IDs, stop reasons, process
details and diagnostic payloads do not cross that boundary. An unexpected
process exit during an active turn emits `turn.failed` with a generic
`provider_process_exited` or `provider_process_crashed` reason.

The SQLite event repository (not yet wired into the running server) exposes `appendEvents(scope, events)` and
`finalizeTurn(scope, events)`. It allocates contiguous sequence numbers from the
durable scope head, inserts event rows, updates message/session/turn projections,
and advances the cursor in one transaction. Streaming token deltas are
coalesced and flushed at 16 KiB or 100 ms; the terminal event shares the final
batch so content and final state commit together. Callers publish only records
returned after commit; the transport does not manufacture cursors. Any client
with `read` may subscribe to any scope in this environment; scoped
subscriptions are routing, not per-resource ACLs.

The running server still uses the in-memory event service and publishes directly
to sockets; its epoch and sequences reset on restart. Integrating the repository
with live session/provider services is separate work.

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
Per-client command budgets are listed under [Rate limits](#rate-limits).

## Shutdown and turn recovery contract

SIGINT and SIGTERM put the process into a one-way drain: new socket upgrades are
rejected, existing sockets receive `1001 / server_shutdown`, HTTP keep-alive
connections close, and the process exits only after those listeners and the
agent runtime finish closing. Restarting with the same data directory reuses the
exact environment identity, client credential rows and owner credential. Windows does not
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

## SQLite migrations

The environment database is `openmanager.sqlite` in the configured data
directory. `openEnvironmentDatabase` applies connection pragmas, then
`runMigrations` applies every numbered step after the recorded version inside
one `BEGIN IMMEDIATE` transaction. The current integer lives in the
`schema_version` table (a single row) and is mirrored to SQLite's
`user_version` so databases created by the earlier composer store keep opening.
There are no down migrations. If `schema_version` is newer than the catalog
shipped with this process, startup throws and does not listen.

### Adding a migration

1. Append an object to `MIGRATIONS` in [`src/db/migrations.ts`](src/db/migrations.ts)
   with the next contiguous integer `version` and a short `name`. Do not edit or
   reorder a migration that has already shipped.
2. Put only forward schema changes in `up`. Prefer `IF NOT EXISTS` for objects
   that a remigration of that same version must tolerate.
3. Add tests in `tests/migrate.test.ts`: a fresh database ends at the new
   version, a database left at the previous version upgrades without data loss,
   and a database stamped with an unknown newer version still refuses to open.
4. Keep the new migration in this package so `pnpm --filter @openmanager/server test`
   (and `ci:server`) exercises it.

The domain model begins in migration 2. Migration 3 adds the composite indexes
behind the session list, session history, and replay queries in
[`src/db/queries.ts`](src/db/queries.ts); `tests/query-plans.test.ts` pins each
plan with `EXPLAIN QUERY PLAN`, so a query or index change that introduces a
scan or a temporary sort fails the suite. Migration 4 adds `kind` and
`expires_at` to `authorized_clients` (existing rows become `paired` with a
30-day window from their last activity; a row inserted without an explicit
expiry is already expired) and the index behind the owner lookup. Migration 5
adds `audit_events` and the indexes behind `server.audit.query`. Keep later
changes in new numbered migrations rather than editing a shipped migration.

### Event retention

[`src/db/event-retention.ts`](src/db/event-retention.ts) bounds the replay
`event_log` to a 7-day window and 10,000 events per scope. `prune()` runs one
pass in a single transaction and moves `event_streams.oldest_sequence`, which
is what forces a stale reconnecting client onto a snapshot; `schedule()` runs
it every 15 minutes on an unreferenced timer. Projected history rows are never
pruned. Each pruned event leaves an `event_id_tombstones` row (cursor plus
payload hash, kept for 30 days) so a late retry still deduplicates instead of
being appended and projected again. The policy and its rationale are in the
[schema decision](../../docs/decisions/sqlite-persistence-schema.md#event-retention).

## Checks

```sh
pnpm --filter server typecheck
pnpm --filter server lint
pnpm --filter server test
pnpm --filter server build
```

`test` builds first so the CLI smoke test exercises the production JavaScript
entry point. Negative security tests in `tests/security-negative.test.ts` assert
the specific refusal (status and error code) so a crash or missing route cannot
satisfy them. Tests cover configuration precedence and rejection, occupied ports,
data-directory failures, concurrent identity initialization across processes,
identity preservation and corruption, bootstrap, log filtering, compiled and
native-TypeScript startup, process restart durability, the close code/reason
delivered to an active socket during SIGTERM, and SQLite migrations (fresh
database, sequential upgrade, and unknown newer schema). Build, typecheck and
dev first compile the protocol package; Node consumes its built
`@openmanager/protocol/node` export.
The shared CI workflow runs typecheck, tests and build for this package on
Node 24 on Windows and Linux, alongside the protocol package and the web app.
