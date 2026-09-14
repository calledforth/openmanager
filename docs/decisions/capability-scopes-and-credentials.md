# Capability scopes and client credentials

Status: Accepted, 2026-09-13. Recorded from
[CAL-45](https://linear.app/calledforth/issue/CAL-45/define-capability-scopes-and-token-storage).
Implements decisions D1 to D5, D7 and D10 of the
[threat model](../threat-model.md). The authenticated-socket work (CAL-46),
the local owner credential (CAL-49) and the Pairing project (CAL-102 to
CAL-107) build against this document.

## Decision

Every client holds its own opaque credential. The server stores only a hash of
it, together with the client's label, kind, capability set and last-seen time.
Access is split into five capabilities, and every protocol command and HTTP
route is mapped to exactly one of them. A credential stops working after 30
days without a connection, has no absolute expiry, is never rotated
automatically, and is revoked by deleting the grant, which also closes the
client's live sockets.

Pairing follows the T3 Code dialog the owner already knows: one checkbox per
capability, two presets, and a warning under the checkboxes that run code or
manage access. T3 Code was read closely for this decision (`.tmp/t3code`);
where OpenManager differs it is called out below.

## Capabilities

Five bits. A client's grant is any subset. `read` is the lowest tier and is
required for a connection to be useful at all; the server does not issue a
grant without it.

| Capability | Allows                                                                                                                                                        | T3 Code equivalent                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `read`     | Environment identity, workspace list, session list and history, live event subscriptions, provider catalog and health, file contents, git state and diffs.   | View environment (`orchestration:read`)                             |
| `operate`  | Create, rename, archive and delete sessions; composer preferences; write, move and delete files; upload attachments; stage, commit, branch, checkout, push.   | Operate tasks (`orchestration:operate`), minus prompts and approvals |
| `agent`    | Send prompts, interrupt turns, answer agent approvals and questions, set the model, mode and per-provider config for a session.                                | Folded into Operate tasks                                           |
| `terminal` | Create, attach to, type into, resize and close terminals.                                                                                                     | Use terminals (`terminal:operate`)                                  |
| `admin`    | List and revoke clients, mint and revoke pairing links, link and unlink the account, configure the tunnel or route.                                           | View access, Manage access, View relay, Manage relay                |

Notes on the boundaries:

- **`read` includes source.** There is no sessions-only tier. A client that can
  see a session can see the files the agent is editing. Splitting a
  narrower tier later is additive and needs no migration.
- **`operate` is one bit.** Session mutation, file writes and git mutation are
  all "changes the workspace without running code". Splitting file writes or
  git out later is additive.
- **`agent` and `terminal` both mean code execution** (D5). Agents run shell
  commands, so `agent` is not the safer option. The pairing dialog shows both
  under one "Runs code on this machine" warning. Answering agent approvals
  stays inside `agent`, as it does in T3 Code; an approve-only bit is a
  recorded follow-up, not part of Wave 2.
- **`admin` covers the four T3 Code access and relay bits.** Viewing the client
  list is administrative here because labels and last-seen times describe the
  owner's devices. Splitting `admin` into read and write halves is additive if
  a "can see but not revoke" persona turns out to matter.
- **Composer set commands are `agent`, not `operate`.** Model, mode and
  config-option changes decide how the next prompt runs, so they belong with
  prompting. Preferences (`composer.preferences.set`) are workspace settings
  and stay in `operate`.

### Presets

| Preset      | Grant                | Use                                            |
| ----------- | -------------------- | ---------------------------------------------- |
| Read only   | `read`               | Watch a session from a phone.                  |
| Standard    | `read`, `operate`    | Drive sessions and edit files from a device.   |

`agent`, `terminal` and `admin` are never included in a preset and are never
pre-ticked (D4). Ticking `admin` shows the warning "This client can create or
revoke access for other devices".

## Command mapping

The mapping is total: every command name known to the protocol package appears
here, and every future command must be added before it can be dispatched. The
implementation (CAL-46) encodes this as a `Record<CommandName, Capability>`
checked with `satisfies` so an unmapped command fails to compile, plus a unit
test that the map's key set equals the schema's key set.

### WebSocket commands that exist today

| Command                       | Capability | Note                                                       |
| ----------------------------- | ---------- | ---------------------------------------------------------- |
| `protocol.handshake`          | none       | Runs after the socket is authenticated; not a grant check. |
| `connection.heartbeat`        | none       | Same.                                                      |
| `environment.get`             | `read`     |                                                            |
| `workspace.list`              | `read`     |                                                            |
| `session.list`                | `read`     |                                                            |
| `session.open`                | `read`     | Replays history; no mutation.                              |
| `subscription.subscribe`      | `read`     | Event visibility is `read`; events never carry secrets.    |
| `subscription.unsubscribe`    | `read`     |                                                            |
| `provider.catalog.get`        | `read`     |                                                            |
| `provider.discovery`          | `read`     |                                                            |
| `provider.health`             | `read`     |                                                            |
| `provider.probe`              | `read`     | Read-only status of an installed CLI.                      |
| `composer.preferences.get`    | `read`     |                                                            |
| `session.create`              | `operate`  |                                                            |
| `workspace.add`               | `operate`  | Registers a folder by an environment-local path (CAL-50).  |
| `workspace.remove`            | `operate`  |                                                            |
| `composer.preferences.set`    | `operate`  |                                                            |
| `turn.send`                   | `agent`    |                                                            |
| `turn.interrupt`              | `agent`    |                                                            |
| `interaction.respond`         | `agent`    | Approvals and questions; see D5.                           |
| `composer.model.set`          | `agent`    |                                                            |
| `composer.mode.set`           | `agent`    |                                                            |
| `composer.config_option.set`  | `agent`    |                                                            |

### Planned commands and routes

Names are indicative; the owning issue fixes them. The capability is the
decision.

| Surface                                                          | Capability | Owner              |
| ---------------------------------------------------------------- | ---------- | ------------------ |
| `session.rename`, `session.archive`, `session.delete`            | `operate`  | Session work       |
| `file.list`, `file.read`, `file.search`                           | `read`     | CAL-120, CAL-121   |
| `file.write`, `file.move`, `file.delete`                          | `operate`  | CAL-120, CAL-121   |
| `git.status`, `git.diff`, `git.log`, `git.branch.list`            | `read`     | CAL-122, CAL-125   |
| `git.stage`, `git.commit`, `git.checkout`, `git.branch.create`    | `operate`  | CAL-122, CAL-125   |
| Attachment upload and download (HTTP)                            | `operate` / `read` | CAL-87       |
| `terminal.*`                                                     | `terminal` | CAL-127, CAL-128   |
| Client list, revoke client, revoke other clients (HTTP)          | `admin`    | CAL-104, CAL-105   |
| Mint pairing link, revoke pairing link (HTTP)                    | `admin`    | CAL-102, CAL-103   |
| Account link and unlink, tunnel and route configuration (HTTP)   | `admin`    | Cloud and tunnel   |
| `/health`, `/bootstrap`, pairing exchange (HTTP)                 | none       | D11, CAL-102       |

A command that is called without its capability fails with the existing
`capability_missing` error code, which the client treats as terminal for that
command (retry policy `never`). Missing or invalid credentials fail the
upgrade or request with `auth` before any command is read.

## Credentials

### Format

A credential is opaque: 32 random bytes from the platform CSPRNG, base64url
encoded without padding, with a version prefix, for example
`omc1.Qy9m…` (`omc1.` plus 43 characters). The prefix makes credentials
greppable in leaked logs and lets the format change later. The alphabet fits
the RFC 6455 subprotocol token charset the web client already validates
(`apps/web/src/lib/environment-store.ts`), so the same string is sent as
`Authorization: Bearer <credential>` over HTTP and as the
`openmanager.auth.<credential>` subprotocol on WebSocket upgrade. Nothing else
changes on the wire.

The credential carries no claims. Capabilities, expiry and identity live in the
server's row for that client, so a revoke or a grant change takes effect on
the next request without reissuing anything. T3 Code instead signs the scopes
into the token, but still looks up the session row on every request to check
revocation, so the signature buys nothing here and hashing is what D3 already
promises.

### Storage on the server

The existing `authorized_clients` table
([schema decision](./sqlite-persistence-schema.md)) holds one row per
credential. The raw credential is never written anywhere; the server stores
`credential_hash = SHA-256(credential)` and looks it up by hash on every
request. A random 256-bit input needs no salt or slow hash. Comparison is a
hash lookup followed by a constant-time equality check on the stored bytes.

Two columns are added by the implementation (CAL-46 for the migration, CAL-49
for the owner row):

| Column       | Purpose                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `kind`       | `owner`, `paired` or `cloud`. Decides who may revoke the row and whether it may carry `admin`.                |
| `expires_at` | Idle expiry, recomputed on every accepted connection. `NULL` is not used; every row has one.                  |

`scopes_json` stores the grant as a JSON array of capability names. `label`,
`created_at`, `last_seen_at` and `revoked_at` keep their current meaning.
`sessions.created_by_client_id` and `interactions.resolved_by_client_id`
continue to reference the row so audit (CAL-48) can name the device.

### Lifetime

| Kind     | Idle expiry | Absolute expiry | How it is issued                                                                   |
| -------- | ----------- | --------------- | ---------------------------------------------------------------------------------- |
| `owner`  | 30 days     | none            | Minted by the local server process on startup or by a local CLI command (CAL-49). |
| `paired` | 30 days     | none            | Exchanged from a single-use pairing link (CAL-102).                                |
| `cloud`  | 30 days     | none            | Minted for a signed account-service request (D6).                                  |

Idle expiry means `expires_at = last_seen_at + 30 days`, and every accepted
HTTP request or WebSocket upgrade moves `last_seen_at` forward. A device that
connects at least once a month never has to re-pair. There is no absolute cap
because the owner asked for none: a credential in use is a credential the
owner can see in the client list and revoke. T3 Code uses a fixed 30-day
absolute expiry with no idle rule; OpenManager inverts that.

A connection that is open when `expires_at` passes is not cut. Expiry is
checked at authentication time only. Revocation is the tool for cutting a live
client.

### Rotation

None is automatic in Wave 2. The owner credential is re-minted by the local
process, which revokes the previous owner row. A paired or cloud client that
wants a fresh credential re-pairs or re-enrolls, which creates a new row; the
old row is revoked once the new one is confirmed. The format's version prefix
is what allows a future rotation scheme (for example refresh-on-connect) to be
introduced without breaking stored credentials.

### Revocation

- Revoking sets `revoked_at`, and the server then closes every WebSocket
  authenticated by that row with close code `4401` and reason `revoked`, and
  publishes a client-list event to `admin` holders. T3 Code leaves live sockets
  open after revocation; OpenManager does not.
- The `owner` row cannot be revoked by any other client. It is replaced only
  by the local process re-minting it.
- A client cannot revoke itself. "Revoke all other clients" evicts every row
  except the caller and the owner.
- Unlinking the account revokes every `cloud` row (D6).
- Expired and revoked rows are kept for audit and purged after 90 days.

### Delegation cap

A client can never hand out more than it holds. When a client mints a pairing
link, every capability on the link must be in the minter's own grant, checked
at mint time. When the link is exchanged, the same check runs again against
the minter's row as it is at that moment, so revoking or narrowing the minter
also narrows or voids the links it created. The exchange may request a subset
of the link's grant, never a superset (D4). Cloud enrollment is capped by the
link's grant the same way.

`admin` can be granted through pairing, but only as an explicit tick with the
warning shown, and only by a client that holds `admin` itself. This is what
lets the owner revoke a lost phone from another phone. Cloud enrollment never
grants `admin` (D6). Together with the owner-row rule above, this closes the
T3 Code gap where a remote client with manage access can evict the desktop
owner.

### Pairing link

Owned by CAL-102; recorded here because the shape follows from D7.

- The pairing token is a separate short-lived secret, not a credential: 12
  characters from a 32-symbol alphabet with no ambiguous glyphs (about 60
  bits), single use, 5-minute lifetime.
- It travels in the URL fragment (`https://app.example/pair#token=…`) so the
  hosted app's server never sees it, and the client strips it from history
  after the exchange.
- The server stores the token hashed. Single use is enforced in one atomic
  `UPDATE … WHERE consumed_at IS NULL … RETURNING` so two concurrent
  exchanges cannot both succeed. T3 Code stores the token in clear to
  re-render the QR code; OpenManager re-renders from the minting client's
  memory instead.
- The row carries the grant, label and expiry; the token is only the lookup
  key.

## Storage on each client

The rule is the same everywhere: the credential is held by the client that
owns it, keyed by environment ID, never placed in a URL, and never sent
anywhere but the environment it belongs to (D7, D10).

| Client            | Store                                                                                                                                                                                                                                          | Why                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (hosted SPA)  | IndexedDB, one database for the app, one object store for the environment registry, one record per environment ID holding `{label, endpoints, credential, grant}`. Replaces the `openmanager-environments` `localStorage` key.                | IndexedDB is the only browser store that can later hold a non-extractable WebCrypto key next to the credential (D8 hardening). `localStorage` cannot. Same origin scope. |
| Electron desktop  | Main process only. The credential is encrypted at rest with `safeStorage` in the app's user-data directory and decrypted into memory at launch. The renderer never sees it; the preload exposes `connect(environmentId)` and the main process attaches the credential. | Keeps the credential out of the renderer's reach, so a renderer compromise cannot exfiltrate it. Matches T3 Code, which keeps its bearer in main and hands it over IPC. |
| Mobile (Expo)     | `expo-secure-store`, key `environment-credential:<environmentId>`, per CAL-149. Registry metadata (label, endpoints) in ordinary app storage.                                                                                                  | Backed by Keychain and Android Keystore; survives app restart, wiped on uninstall.                                                                                     |

The web app's environment registry is not encrypted at rest; a browser profile
is the trust boundary there, and the hosted origin is part of the trusted base
(D8). An open tab's credential is readable by any script on that origin, which
is why D8 requires a strict CSP.

## What this changes in existing code

- `apps/server/src/credential.ts` and the `client-token` file are the Wave 1
  development credential named in D3. CAL-46 replaces them with the
  `authorized_clients` lookup; the Bearer regex `^Bearer ([a-f0-9]{64})$` in
  `websocket.ts` is replaced by the `omc1.` format.
- `SERVER_CAPABILITIES` in `server.ts` today lists protocol features, not
  access capabilities. It keeps that meaning. Access capabilities are a
  separate field, returned after authentication (for example on
  `environment.get`) so the client can hide controls it cannot use. They are
  never returned from `/bootstrap` (D11).
- The `capability_missing` error code and its `never` retry policy in
  `packages/protocol/src/errors.ts` already exist and are used unchanged.
- `docs/SECURITY.md` describes the localhost-only baseline and is superseded by
  the threat model and this document.

## Follow-ups

- **CAL-49 wording.** The issue says the owner credential is "bound to
  loopback". D2 forbids that; it should read "minted only by the local
  process". The row is a normal `owner`-kind credential that works from any
  address.
- **Per-client agent approval policy (D5).** A real boundary between `agent`
  and `terminal` needs the server to enforce which clients may approve which
  tool calls. Not in Wave 2.
- **Approve-only capability.** If a "can answer approvals but not send
  prompts" persona is wanted, split `agent.approve` out of `agent`. Additive.
- **Refresh-on-connect rotation.** Reissue a credential on each successful
  connection so a stolen copy goes stale. The version prefix reserves room.
- **Non-extractable browser key.** Bind web credentials to a WebCrypto key
  stored beside them in IndexedDB (D8). Depends on the DPoP-style proof from
  D6.
