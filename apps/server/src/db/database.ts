import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations, type Migration } from './migrate.ts'
import { MIGRATIONS } from './migrations.ts'

export const DATABASE_FILENAME = 'openmanager.sqlite'
export const BUSY_TIMEOUT_MS = 5000

export function configureConnection(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA synchronous = NORMAL')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
}

/** Open the environment database, apply connection pragmas, then run pending migrations. */
export function openEnvironmentDatabase(
  dataDir: string,
  migrations: readonly Migration[] = MIGRATIONS,
): DatabaseSync {
  const database = new DatabaseSync(join(dataDir, DATABASE_FILENAME), {
    enableForeignKeyConstraints: true,
    timeout: BUSY_TIMEOUT_MS,
  })
  try {
    configureConnection(database)
    runMigrations(database, migrations)
    recoverInterruptedTurns(database)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

/**
 * Reconcile work that cannot still be live after the owning server process has
 * restarted. The turn is recorded as interrupted, but its session shows as
 * failed: nobody asked for it to stop, so the user should notice. Tools left
 * open are cancelled, and the threads affected start a new stream epoch so a
 * reconnecting client takes a snapshot. Keeping this in one transaction prevents clients from observing a
 * session whose status disagrees with its turn, messages, or interactions.
 */
export function recoverInterruptedTurns(database: DatabaseSync, now = Date.now()): number {
  if (!tableExists(database, 'turns')) return 0

  database.exec('BEGIN IMMEDIATE')
  try {
    database
      .prepare(
        `UPDATE sessions
         SET status = 'error', updated_at = ?
         WHERE session_id IN (
           SELECT threads.session_id
           FROM threads
           JOIN turns ON turns.thread_id = threads.thread_id
           WHERE turns.state IN ('running', 'waiting')
         )`,
      )
      .run(now)
    database
      .prepare(
        `UPDATE threads
         SET updated_at = ?
         WHERE thread_id IN (
           SELECT thread_id FROM turns WHERE state IN ('running', 'waiting')
         )`,
      )
      .run(now)
    database
      .prepare(
        `UPDATE interactions
         SET state = 'cancelled', resolved_at = ?, updated_at = ?
         WHERE state = 'pending' AND turn_id IN (
           SELECT turn_id FROM turns WHERE state IN ('running', 'waiting')
         )`,
      )
      .run(now, now)
    database
      .prepare(
        `UPDATE messages
         SET is_final = 1, updated_at = ?
         WHERE is_final = 0 AND turn_id IN (
           SELECT turn_id FROM turns WHERE state IN ('running', 'waiting')
         )`,
      )
      .run(now)
    if (tableExists(database, 'event_streams')) {
      // Recovery rewrites rows without writing events, so a client resuming
      // one of these threads from a cursor saved before the crash would replay
      // nothing and keep showing the turn and its tools as running. A new
      // epoch makes its next replay a `stream_reset` snapshot of the recovered
      // state; the sequence carries on, so later events append as before.
      const threads = database
        .prepare(`SELECT DISTINCT thread_id FROM turns WHERE state IN ('running', 'waiting')`)
        .all() as { thread_id: string }[]
      const reset = database.prepare(
        `UPDATE event_streams SET epoch = ?, updated_at = ?
         WHERE scope_type = 'thread' AND thread_id = ?`,
      )
      for (const { thread_id: threadId } of threads) reset.run(randomUUID(), now, threadId)
    }
    if (tableExists(database, 'turn_activity')) {
      // A tool still open when its turn died never reported a result: it was
      // cancelled with the turn. `json_insert` keeps a finish time already set.
      database
        .prepare(
          `UPDATE turn_activity
           SET state_json = json_insert(
                 json_set(state_json, '$.status', 'cancelled'), '$.finishedAt', ?
               ),
               updated_at = ?
           WHERE kind = 'tool'
             AND COALESCE(json_extract(state_json, '$.status'), 'pending')
                 IN ('pending', 'in_progress')
             AND turn_id IN (
               SELECT turn_id FROM turns WHERE state IN ('running', 'waiting')
             )`,
        )
        .run(new Date(now).toISOString(), now)
    }
    const recovered = Number(
      database
        .prepare(
          `UPDATE turns
           SET state = 'interrupted', failure_reason = NULL, finished_at = ?, updated_at = ?
           WHERE state IN ('running', 'waiting')`,
        )
        .run(now, now).changes,
    )
    database.exec('COMMIT')
    return recovered
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      /* The failed statement may already have aborted the transaction. */
    }
    throw error
  }
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return (
    database
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}
