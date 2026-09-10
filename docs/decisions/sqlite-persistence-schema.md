# SQLite persistence schema

Status: Accepted, 2026-09-10.

## Decision

Each environment owns one `openmanager.sqlite` database. Migration 2 adds the
durable relational model for environment metadata, workspaces, sessions,
threads, turns, messages and their complete parts, interactions, attachments,
composer drafts, stash items, authorized clients, and replay events. The schema
is additive to the composer tables introduced by migration 1.

This migration defines storage and deletion semantics only. Repository methods,
query-plan checks, and event retention are separate work. In particular, there
is intentionally no replacement for Convex `pending_jobs` or `stream_chunks`.

## Transaction and streaming policy

The event repository allocates scope-local sequence numbers from
`event_streams`, inserts every `event_log` row, updates the projected domain
rows, and advances the stream head inside one `BEGIN IMMEDIATE` transaction.
`finalizeTurn` uses that same boundary for the final buffered message content,
the terminal turn event, the message `is_final` flags, and session/turn status.
Events are published to clients only after the repository call returns.

Token-sized `message.delta` and `message.reasoning` inputs are buffered in
memory and coalesced before persistence. A batch flushes when its serialized
payload reaches **16 KiB**, after **100 ms**, when its scope changes, or at a
non-stream ordering barrier. A terminal turn event flushes the remaining
stream content and terminal event together through `finalizeTurn`, so the last
content cannot commit without the terminal state. A crash may lose only the
uncommitted in-memory tail; it cannot leave a durable cursor ahead of its event
or projection. Non-stream events are never delayed behind the timer.

## Ownership

| Record                           | Authority                                                                                                               | Notes                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_metadata`           | Bootstrap identity is authoritative in `identity.json`; this row is its relational projection plus environment metadata | A mismatch must fail or be reconciled explicitly; a database move does not create a new environment.                                                      |
| `workspaces`                     | Environment                                                                                                             | Paths and availability are determined on the environment that can access them. Clients receive summaries only.                                            |
| `sessions`, `threads`, `turns`   | Environment                                                                                                             | Provider IDs are linkage metadata. Provider processes do not own OpenManager lifecycle state.                                                             |
| `messages`, `message_parts`      | Environment                                                                                                             | `message_parts.content_json` stores complete ordered content blocks. Token deltas are transport input, never the history source.                          |
| `interactions`                   | Environment                                                                                                             | One row replaces pending permissions, questions, and plans. Request and resolution payloads remain durable.                                               |
| `attachments`                    | Environment database plus environment-managed blob storage                                                              | SQLite owns attachment metadata and `storage_key`; bytes are not embedded in the database.                                                                |
| `drafts`, `stash_items`          | Environment                                                                                                             | Drafts are one conflict-versioned record per session. Stash is an intentional environment-owned idea queue and outlives a source session.                 |
| `authorized_clients`             | Environment                                                                                                             | Only credential hashes are stored. Labels, scopes, last-seen time, and revocation are authoritative; raw credentials remain outside SQLite.               |
| `provider_profiles`              | Cache                                                                                                                   | Provider-reported catalog data is replaceable and must never be required to recover history.                                                              |
| `workspace_composer_preferences` | Environment                                                                                                             | User selection is authoritative. Its v1 `workspace_id` key intentionally remains unconstrained until path-based callers migrate to durable workspace IDs. |
| `event_streams`, `event_log`     | Environment                                                                                                             | The stream row owns epoch/head metadata; `(scope_key, sequence)` is the durable order and `event_id` is globally idempotent.                              |
| Client stores and Convex tables  | Cache or legacy projection                                                                                              | Clients rebuild from snapshots/events. Convex is not authoritative for this local model.                                                                  |

Migration 2 JSON columns hold versioned protocol/domain payloads whose internal
shape can evolve without a migration for every optional field. SQLite validates
those values as JSON; application schemas validate their semantic shape at the
read/write boundary. The v1 composer cache columns predate that database
constraint and remain validated by the composer store when read and written.

## Relational shape

```text
workspaces
  └─ sessions
      ├─ child sessions
      ├─ threads
      │   └─ turns
      │       ├─ messages
      │       │   ├─ message_parts
      │       │   └─ attachments
      │       └─ interactions
      ├─ drafts
      └─ session/thread event_streams
              └─ event_log

authorized_clients ──(SET NULL attribution)──> sessions/interactions/drafts/
                                              stash_items/attachments
stash_items ──(SET NULL provenance)──> workspaces and sessions
```

Host IDs are the primary keys exposed by the environment protocol. Native
provider session/thread/message IDs are optional linkage fields and are never
used as cross-table ownership keys. Composite foreign keys carry `workspace_id`
through sessions, threads, turns, messages, and message-linked attachments. This
prevents child sessions, conversation records, or attachment metadata from
crossing workspace ownership boundaries. Messages also belong to a matching
`(turn, thread)` pair.
Ordered message parts have a unique `(message_id, ordinal)` and store the whole
content block in `content_json`; history hydration reads these rows directly and
does not replay or concatenate token chunks.

`event_streams` represents exact environment, session, and thread scopes. Its
shape check requires the matching nullable foreign keys for each scope kind.
Environment-scoped streams have no session/thread foreign key and therefore
survive session deletion, including the durable `session.deleted` event.
Session- and thread-scoped streams are owned by the session and are removed with
it. Retention behavior for older `event_log` rows is deliberately deferred.

## Session deletion rules

Foreign keys are enabled on every connection. Deleting a session has these
effects:

- `CASCADE`: child sessions, threads, turns, messages, message parts,
  interactions, message attachments, drafts, session/thread event streams, and
  their event-log rows are removed.
- `SET NULL`: stash items retain their content but lose `source_session_id`.
- no effect: environment-scoped events, workspaces, provider profiles,
  composer preferences, authorized clients, and unrelated attachments remain.

Deleting a workspace cascades through its sessions and unattached workspace
attachments. Stash items are environment-owned, so their `workspace_id` becomes
null instead of deleting the reusable content. Revoking or deleting a client
does not delete domain records; attribution columns become null.

The immediate implementation should delete a session in one transaction and
let these foreign keys enforce the graph cleanup. It must not manually delete a
partial subset of child rows.

## Convex mapping

| Convex source                                       | SQLite target                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `workspaces`                                        | `workspaces`                                                                                                            |
| `sessions`                                          | `sessions`, with provider linkage and child ownership                                                                   |
| `messages`                                          | `messages` plus ordered `message_parts`                                                                                 |
| `attachments`                                       | `attachments`; bytes live in environment blob storage                                                                   |
| `pending_permissions`, `pending_questions`, `plans` | `interactions` with `kind`, request, state, and optional response                                                       |
| `provider_profiles`                                 | existing `provider_profiles` cache                                                                                      |
| `workspace_composer_preferences`                    | existing `workspace_composer_preferences`                                                                               |
| none                                                | `environment_metadata`, `threads`, `turns`, `drafts`, `stash_items`, `authorized_clients`, `event_streams`, `event_log` |
| `pending_jobs`, `stream_chunks`                     | no equivalent by design                                                                                                 |
