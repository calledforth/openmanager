/**
 * Read queries whose plans are pinned by `tests/query-plans.test.ts`.
 * Each one must be served by an index from `migrations.ts`; a change here that
 * introduces a table scan or a temporary sort fails that test.
 */

/**
 * Newest sessions across the whole environment, keyset-paginated by
 * `(updated_at, session_id)`. The row-value comparison lets SQLite bind both
 * cursor columns to one descending index range. The first page passes a cursor
 * above every real row, such as `(MAX_SAFE_INTEGER, '')`.
 */
export const SESSION_LIST_FOR_ENVIRONMENT_SQL = `
  SELECT session_id, workspace_id, parent_session_id, provider_id, title, title_source, status,
         composer_json, created_at, updated_at
  FROM sessions
  WHERE (updated_at, session_id) < (?, ?)
  ORDER BY updated_at DESC, session_id DESC
  LIMIT ?`

/** Newest sessions for one workspace, keyset-paginated by `(updated_at, session_id)`. */
export const SESSION_LIST_FOR_WORKSPACE_SQL = `
  SELECT session_id, workspace_id, parent_session_id, provider_id, title, title_source, status,
         composer_json, created_at, updated_at
  FROM sessions
  WHERE workspace_id = ? AND (updated_at, session_id) < (?, ?)
  ORDER BY updated_at DESC, session_id DESC
  LIMIT ?`

/** One thread, only if it belongs to the named session. */
export const THREAD_IN_SESSION_SQL = `
  SELECT thread_id, session_id
  FROM threads
  WHERE thread_id = ? AND session_id = ?`

/** Threads of a session in creation order; the first step of session history. */
export const THREADS_FOR_SESSION_SQL = `
  SELECT thread_id, session_id, workspace_id, provider_thread_id, created_at, updated_at
  FROM threads
  WHERE session_id = ?
  ORDER BY created_at, thread_id`

/** One page of a thread's history, walking backwards from a message ordinal. */
export const MESSAGE_HISTORY_PAGE_SQL = `
  SELECT message_id, workspace_id, thread_id, turn_id, external_id, role, ordinal,
         metadata_json, is_final, created_at, updated_at
  FROM messages
  WHERE thread_id = ? AND ordinal < ?
  ORDER BY ordinal DESC
  LIMIT ?`

/** Complete ordered content blocks for one message on a history page. */
export const MESSAGE_PARTS_SQL = `
  SELECT part_id, ordinal, part_type, content_json
  FROM message_parts
  WHERE message_id = ?
  ORDER BY ordinal`

/** Turns of a thread in start order, joined to messages by callers hydrating a page. */
export const TURNS_FOR_THREAD_SQL = `
  SELECT turn_id, thread_id, workspace_id, state, failure_reason, started_at, finished_at,
         updated_at
  FROM turns
  WHERE thread_id = ?
  ORDER BY started_at, turn_id`

/**
 * The reasoning blocks and tool calls of one turn in the order they happened.
 * `ordinal` shares the thread-wide counter with `messages.ordinal`, so callers
 * interleave the two by sorting on it.
 */
export const TURN_ACTIVITY_FOR_TURN_SQL = `
  SELECT activity_id, turn_id, kind, ordinal, state_json
  FROM turn_activity
  WHERE turn_id = ?
  ORDER BY ordinal`

/** Pending interactions of one turn; settled rows stay out of history. Sorted by callers. */
export const INTERACTIONS_FOR_TURN_SQL = `
  SELECT interaction_id, turn_id, kind, state, request_json, response_json, expires_at,
         created_at, resolved_at, resolved_by_client_id
  FROM interactions
  WHERE turn_id = ? AND state = 'pending'`

/** Retry dedupe: the turn a command id already started in a thread, if any. */
export const TURN_FOR_COMMAND_ID_SQL = `
  SELECT turn_id, thread_id, state
  FROM turns
  WHERE thread_id = ? AND command_id = ?`

/** Whether a session's thread ever raised this interaction, whatever became of it. */
export const INTERACTION_IN_THREAD_SQL = `
  SELECT 1
  FROM interactions
  JOIN turns ON turns.turn_id = interactions.turn_id
  JOIN threads ON threads.thread_id = turns.thread_id
  WHERE interactions.interaction_id = ? AND threads.thread_id = ? AND threads.session_id = ?`

/** The prompt a turn started with, replayed when its send is retried. */
export const USER_MESSAGE_FOR_TURN_SQL = `
  SELECT message_id, thread_id, turn_id, role, ordinal
  FROM messages
  WHERE turn_id = ? AND role = 'user'
  LIMIT 1`

/** Replay: durable events for a scope strictly after a cursor sequence, bounded. */
export const EVENTS_AFTER_CURSOR_SQL = `
  SELECT sequence, event_id, event_name, event_json, created_at
  FROM event_log
  WHERE scope_key = ? AND sequence > ?
  ORDER BY sequence
  LIMIT ?`

/**
 * Retention: how many rows per scope have expired and the newest of them, from
 * the covering created_at index. The pass only touches scopes returned here.
 */
export const EXPIRED_EVENTS_BY_SCOPE_SQL = `
  SELECT scope_key, COUNT(*) AS expired_count, MAX(sequence) AS expired_max
  FROM event_log INDEXED BY event_log_created_at_idx
  WHERE created_at < ?
  GROUP BY scope_key`

/**
 * Retention: the oldest sequence in one scope that is still inside the window.
 * Used only when a scope's expired rows are not a contiguous prefix; it walks
 * that scope's primary key, which the per-scope cap bounds.
 */
export const FIRST_UNEXPIRED_SEQUENCE_SQL = `
  SELECT MIN(sequence) AS first_retained
  FROM event_log
  WHERE scope_key = ? AND created_at >= ?`

/** Retention: the rows a pass is about to delete, so their IDs can be tombstoned first. */
export const EVENTS_TO_PRUNE_SQL = `
  SELECT event_id, sequence, event_json
  FROM event_log
  WHERE scope_key = ? AND sequence < ?
  ORDER BY sequence`

/** Idempotency: the cursor and payload hash of a pruned event ID. */
export const EVENT_TOMBSTONE_SQL = `
  SELECT scope_key, sequence, event_hash
  FROM event_id_tombstones
  WHERE event_id = ?`

/** Replay decision input: head and retention boundary for a scope, read atomically. */
export const STREAM_BOUNDS_SQL = `
  SELECT epoch, head_sequence, oldest_sequence
  FROM event_streams
  WHERE scope_key = ?`

/** Authentication: the client row for one credential hash, served by the UNIQUE index. */
export const AUTHORIZED_CLIENT_BY_HASH_SQL = `
  SELECT client_id, label, kind, credential_hash, scopes_json, expires_at, revoked_at
  FROM authorized_clients
  WHERE credential_hash = ?`

/** Startup: the live owner row, if one exists, from the kind index. */
export const ACTIVE_OWNER_CLIENT_SQL = `
  SELECT client_id, label, credential_hash, scopes_json, expires_at
  FROM authorized_clients
  WHERE kind = 'owner' AND revoked_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1`

/**
 * Newest audit events, keyset-paginated by `(at, event_id)`. The first page
 * passes a cursor above every real row, such as `(MAX_SAFE_INTEGER, '')`.
 */
export const AUDIT_EVENTS_RECENT_SQL = `
  SELECT event_id, type, outcome, at, client_id, command, remote_address, details_json
  FROM audit_events
  WHERE (at, event_id) < (?, ?)
  ORDER BY at DESC, event_id DESC
  LIMIT ?`

/** Newest audit events for one client, same keyset. */
export const AUDIT_EVENTS_FOR_CLIENT_SQL = `
  SELECT event_id, type, outcome, at, client_id, command, remote_address, details_json
  FROM audit_events
  WHERE client_id = ? AND (at, event_id) < (?, ?)
  ORDER BY at DESC, event_id DESC
  LIMIT ?`

/** Newest audit events of one type, same keyset. */
export const AUDIT_EVENTS_FOR_TYPE_SQL = `
  SELECT event_id, type, outcome, at, client_id, command, remote_address, details_json
  FROM audit_events
  WHERE type = ? AND (at, event_id) < (?, ?)
  ORDER BY at DESC, event_id DESC
  LIMIT ?`
