import type { DatabaseSync } from 'node:sqlite'
import { EVENT_FORMAT_VERSION } from '@openmanager/protocol/node'

/** The format the log was written in; a database from before the record is format 1. */
export function storedEventFormat(database: DatabaseSync): number {
  const row = database.prepare('SELECT version FROM event_format WHERE id = 1').get() as
    { version: number } | undefined
  return row?.version ?? 1
}

/**
 * When this server writes events in a newer format than the log holds, hide
 * every stored event from replay: one transaction sets each stream's floor to
 * its head and records the new format. A client whose cursor is below a floor
 * catches up by snapshot (rule 4: the log no longer has those events in a
 * form this protocol can state). Log rows are never rewritten. Returns how
 * many streams got a floor; 0 when the format did not move.
 * (docs/sync-foundations.md §4.7.7)
 */
export function raiseReplayFloors(database: DatabaseSync, now = Date.now()): number {
  const stored = storedEventFormat(database)
  if (stored >= EVENT_FORMAT_VERSION) return 0
  database.exec('BEGIN IMMEDIATE')
  try {
    const raised = Number(
      database
        .prepare('UPDATE event_streams SET replay_floor = head_sequence WHERE head_sequence > 0')
        .run().changes,
    )
    database
      .prepare(
        `INSERT INTO event_format (id, version, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
      )
      .run(EVENT_FORMAT_VERSION, now)
    database.exec('COMMIT')
    return raised
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      /* The failed statement may already have ended the transaction. */
    }
    throw error
  }
}
