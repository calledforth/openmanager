# SQLite persistence schema

Status: Accepted, 2026-09-10.

## Decision

Each environment owns one `openmanager.sqlite` database. Migration 2 adds the
durable relational model for environment metadata, workspaces, sessions,
threads, turns, messages and their complete parts, interactions, attachments,
composer drafts, stash items, authorized clients, and replay events. The schema
is additive to the composer tables introduced by migration 1.

Migration 2 defines storage and deletion semantics only. Migration 3 adds the
bounded indexes and the event retention policy described below. There is
intentionally no replacement for Convex `pending_jobs` or `stream_chunks`.

## Transaction and streaming policy

The event repository allocates scope-local sequence numbers from
`event_streams`, inserts every `event_log` row, updates the projected domain
rows, and advances the stream head inside one `BEGIN IMMEDIATE` transaction.
`finalizeTurn` uses that same boundary for the final buffered message content,
the terminal turn event, the message `is_final` flags, and session/turn status.
Repository callers publish to clients only after the repository call returns.
The live server is not yet wired to this repository.

Retries of an identical retained event ID return the original durable record
without reapplying its projection or advancing the cursor; retries of a pruned
event ID are answered from its tombstone the same way. Reusing an ID for
a different event is rejected. Mixed batches allocate cursors only for new IDs.
Session creation requires a host `sessionProviderId` resolver because the public
session summary does not contain provider identity; missing identity rolls back
the event and cursor instead of inventing a provider. Lifecycle projections are
state-guarded: a terminal, `interaction.requested`, or `interaction.resolved`
event for a turn that already finished, or a resolution for an interaction that
is no longer pending, rolls back rather than rewriting settled rows.

Token-sized `message.delta` and `message.reasoning` inputs are buffered in
memory and coalesced before persistence. A batch flushes when its serialized
payload reaches **16 KiB**, after **100 ms**, when its scope changes, or at a
non-stream ordering barrier. A terminal turn event flushes the remaining
stream content and terminal event together through `finalizeTurn`, so the last
content cannot commit without the terminal state. A crash may lose only the
uncommitted in-memory tail; it cannot leave a durable cursor ahead of its event
or projection. Non-stream events are never delayed behind the timer. Failed batches remain
frozen for retry through `flush()`, `close()`, or the next `append()`; new input
is accepted only after that retry succeeds. Timer failures are reported through
`onError` when supplied and retain the batch without starting an unbounded retry
loop. Publication may repeat after a post-commit failure; consumers deduplicate
using the original durable cursor.

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
| `event_streams`, `event_log`     | Environment                                                                                                             | The stream row owns epoch/head/retention metadata; `(scope_key, sequence)` is the durable order and `event_id` is globally idempotent.                              |
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
it. Older `event_log` rows are bounded by the retention policy below.

## Bounded queries

Migration 3 pins an index for every query that must stay fast as an environment
accumulates history. `apps/server/src/db/queries.ts` holds the SQL and
`tests/query-plans.test.ts` asserts each plan with `EXPLAIN QUERY PLAN`: the
statement must search a named index and must not contain a `SCAN` step or a
`TEMP B-TREE` sort.

| Query                                 | Shape                                                                  | Index                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Session list for the environment      | row-value keyset `(updated_at, session_id) < (?, ?)`, descending       | `sessions_updated_at_idx (updated_at DESC, session_id DESC)`                           |
| Session list for a workspace          | `workspace_id = ?` plus the same keyset page                           | `sessions_workspace_updated_at_idx (workspace_id, updated_at DESC, session_id DESC)`   |
| Session history: threads              | `session_id = ?` ordered by `(created_at, thread_id)`                  | `threads_session_created_at_idx`                                                       |
| Session history: turns of a thread    | `thread_id = ?` ordered by `(started_at, turn_id)`                     | `turns_thread_started_at_idx`                                                          |
| Session history: message page         | `thread_id = ? AND ordinal < ?` ordered by `ordinal DESC`, limited     | migration 2 `UNIQUE (thread_id, ordinal)` autoindex                                    |
| Session history: parts of a message   | `message_id = ?` ordered by `ordinal`                                  | migration 2 `UNIQUE (message_id, ordinal)` autoindex                                   |
| Events after a cursor for a scope     | `scope_key = ? AND sequence > ?` ordered by `sequence`, limited        | migration 2 `PRIMARY KEY (scope_key, sequence)` on the `WITHOUT ROWID` table           |
| Retention: expired rows               | `created_at < ?` grouped by `scope_key`, `INDEXED BY` pinned           | `event_log_created_at_idx (created_at, scope_key, sequence)`, covering                 |
| Retention: rows to prune / boundary   | `scope_key = ? AND sequence < ?`                                       | migration 2 `PRIMARY KEY (scope_key, sequence)`                                        |
| Idempotency: pruned event ID          | `event_id = ?`                                                         | `event_id_tombstones` primary key                                                      |
| Retention: expired tombstones         | `pruned_at < ?`                                                        | `event_id_tombstones_pruned_at_idx`                                                    |

The composite session, thread, and turn indexes are left-prefixed by the
foreign key column, so migration 3 drops the single-column
`sessions_workspace_id_idx`, `threads_session_id_idx`, and `turns_thread_id_idx`
they supersede. Session history is paginated per thread: a client lists the
session's threads, then pages a thread's messages backwards by ordinal and
hydrates each page's parts. Pages are keyset-based, never `OFFSET`, so the cost
of a page does not grow with its distance from the head. The session list uses
a SQLite row-value comparison with both index columns descending; an `OR`-form
keyset or a mixed-direction index degrades to a scan plus a temporary sort. The
retention selector names its index with `INDEXED BY` because, without
statistics, the planner prefers walking the whole primary key to satisfy
`GROUP BY scope_key` in order; the plan test pins the covering range search.

## Event retention

`event_log` is a replay tail, not the history source. Messages, parts, turns,
and interactions are projected relational rows and are never pruned by
retention; only the replay tail shrinks. The policy, implemented in
`apps/server/src/db/event-retention.ts`, bounds that tail two ways:

- **Window: 7 days.** A durable event whose `created_at` (its protocol
  `timestamp`, stamped by the environment when the event is created) is older
  than `now - 7d` is pruned.
- **Cap: 10,000 events per scope.** Each environment, session, and thread stream
  keeps at most its newest 10,000 events regardless of age.

A pruning pass runs inside one `BEGIN IMMEDIATE` transaction. For every stream
it computes the first retained sequence as the larger of the window boundary
and `head_sequence - cap + 1`, deletes `event_log` rows below it through the
primary key, and rewrites `event_streams.oldest_sequence` to the new minimum
retained sequence, or `NULL` when nothing remains. The window boundary is one
past the newest expired row when the expired rows form a contiguous prefix of
the stream, which is the normal case. If timestamps ever run out of order and a
row still inside the window sorts below an expired one, the boundary drops back
to the oldest in-window row: the retained range must stay contiguous because
replay cannot skip a hole, and an event inside the window is never pruned, so
an out-of-order expired row simply survives until the rows below it expire
too. `head_sequence` and
`epoch` never change: cursor allocation keeps counting from the head, so a
pruned stream is not a stream reset. Because `decideReplay` reads
`oldest_sequence` and `head_sequence` together, a reconnecting client whose
cursor is below `oldest_sequence - 1` receives a `gap_expired` snapshot instead
of a replay, and a client at or after the boundary replays exactly the retained
range. A stream with `oldest_sequence = NULL` and a non-zero head forces a
snapshot for every cursor except the head itself.

Pruning must not weaken idempotency. The repository deduplicates retried
events by looking up `event_id` in `event_log`, so deleting a row would let a
late retry of that event, or a reuse of its ID, be appended and projected
again. Before a pass deletes a row it writes an `event_id_tombstones` record
inside the same transaction: the event ID, its scope and sequence, a SHA-256 of
its serialized payload, and `pruned_at`. A retry that misses `event_log` and
hits a tombstone returns the original cursor without projecting anything; a
different payload under a pruned ID is rejected exactly as it is for a retained
one. Tombstones are about 100 bytes each and are bounded by their own window,
**30 days after pruning**, so the idempotency horizon is time-based and does
not shrink when the per-scope cap prunes a busy stream early. Deleting a
session cascades through its streams to their tombstones.

The default job interval is 15 minutes with an unreferenced timer so it never
holds the process open; failures are reported through `onError` and the next
tick retries. Pruning is idempotent: a pass that finds nothing below the
boundary touches no rows. The live server does not yet schedule the job because
it is not yet wired to the event repository; the host that wires the repository
must also call `createEventRetention(database).schedule()` at startup.

### What is never stored here

This database holds environment-owned conversation and replay state only. File
trees, git objects, and terminal scrollback are never written to it, neither as
events nor as projected rows. They are large, reproducible from the workspace
on disk, and would turn every filesystem or terminal change into database I/O.
Attachments follow the same rule: SQLite keeps the metadata row and the bytes
stay in environment-managed blob storage.

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
