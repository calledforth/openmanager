import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { DurableProofEvent } from './event-repository.ts'

/**
 * A tool's output (docs/sync-foundations.md §6.7). Text stays out of the chat:
 * while a tool runs it travels in events and is appended here as they project,
 * so a snapshot and its cursor always agree; the text a tool settles with stays
 * out of the event altogether, like an artifact's bytes, and reaches this table
 * in the event's transaction. Append-only because a row rewritten per delta is
 * quadratic in the output, on the server's one thread (measured in F6: 100 ms
 * per delta at 10 MB, against 0.3 ms for an insert).
 */
export type ToolOutputStore = {
  /** Add text to a running call. */
  append(activityId: string, text: string): void
  /** Replace all of a call's text. */
  replace(activityId: string, text: string): void
  /** A call's whole text, or undefined when it has none. */
  read(activityId: string): string | undefined
  /** The UTF-8 bytes a call holds. */
  bytes(activityId: string): number
}

const statements = new WeakMap<
  DatabaseSync,
  {
    next: StatementSync
    insert: StatementSync
    clear: StatementSync
    read: StatementSync
    bytes: StatementSync
  }
>()

export function createToolOutputStore(database: DatabaseSync): ToolOutputStore {
  let s = statements.get(database)
  if (!s) {
    s = {
      next: database.prepare(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM tool_output WHERE activity_id = ?',
      ),
      insert: database.prepare('INSERT INTO tool_output (activity_id, seq, text) VALUES (?, ?, ?)'),
      clear: database.prepare('DELETE FROM tool_output WHERE activity_id = ?'),
      read: database.prepare('SELECT text FROM tool_output WHERE activity_id = ? ORDER BY seq'),
      bytes: database.prepare(
        'SELECT COALESCE(SUM(octet_length(text)), 0) AS bytes FROM tool_output WHERE activity_id = ?',
      ),
    }
    statements.set(database, s)
  }
  const { next, insert, clear, read, bytes } = s
  return {
    append(activityId, text) {
      const { seq } = next.get(activityId) as { seq: number }
      insert.run(activityId, seq, text)
    },
    replace(activityId, text) {
      clear.run(activityId)
      insert.run(activityId, 0, text)
    },
    read(activityId) {
      const rows = read.all(activityId) as { text: string }[]
      return rows.length > 0 ? rows.map((row) => row.text).join('') : undefined
    },
    bytes(activityId) {
      return (bytes.get(activityId) as { bytes: number }).bytes
    },
  }
}

/** A tool's text, read only under the session that owns the tool. */
export function createToolOutputReader(database: DatabaseSync) {
  const store = createToolOutputStore(database)
  const owned = database.prepare(
    `SELECT a.activity_id FROM turn_activity a
     JOIN threads t ON t.thread_id = a.thread_id
     WHERE a.activity_id = ? AND a.kind = 'tool' AND t.session_id = ?`,
  )
  return (sessionId: string, toolCallId: string): string | undefined =>
    owned.get(toolCallId, sessionId) ? store.read(toolCallId) : undefined
}

/**
 * The text a settling event brings. It never enters the event, so it travels
 * beside it, by object, through the batcher and into the projection, and is
 * written in the event's transaction. Nothing keeps it alive past the event.
 */
const settledText = new WeakMap<DurableProofEvent, string>()

/** Attach the text a settling `tool.updated` stores. */
export function withSettledText<E extends DurableProofEvent>(event: E, text: string): E {
  settledText.set(event, text)
  return event
}

export const settledTextOf = (event: DurableProofEvent) => settledText.get(event)
