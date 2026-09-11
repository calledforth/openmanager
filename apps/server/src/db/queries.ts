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
  SELECT session_id, workspace_id, parent_session_id, provider_id, title, status,
         created_at, updated_at
  FROM sessions
  WHERE (updated_at, session_id) < (?, ?)
  ORDER BY updated_at DESC, session_id DESC
  LIMIT ?`

/** Newest sessions for one workspace, keyset-paginated by `(updated_at, session_id)`. */
export const SESSION_LIST_FOR_WORKSPACE_SQL = `
  SELECT session_id, workspace_id, parent_session_id, provider_id, title, status,
         created_at, updated_at
  FROM sessions
  WHERE workspace_id = ? AND (updated_at, session_id) < (?, ?)
  ORDER BY updated_at DESC, session_id DESC
  LIMIT ?`

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

/** Replay: durable events for a scope strictly after a cursor sequence, bounded. */
export const EVENTS_AFTER_CURSOR_SQL = `
  SELECT sequence, event_id, event_name, event_json, created_at
  FROM event_log
  WHERE scope_key = ? AND sequence > ?
  ORDER BY sequence
  LIMIT ?`

/** Retention: newest expired sequence per scope, from the covering created_at index. */
export const EXPIRED_EVENTS_BY_SCOPE_SQL = `
  SELECT scope_key, MAX(sequence) + 1 AS keep_from
  FROM event_log INDEXED BY event_log_created_at_idx
  WHERE created_at < ?
  GROUP BY scope_key`

/** Replay decision input: head and retention boundary for a scope, read atomically. */
export const STREAM_BOUNDS_SQL = `
  SELECT epoch, head_sequence, oldest_sequence
  FROM event_streams
  WHERE scope_key = ?`
