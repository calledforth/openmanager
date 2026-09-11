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
 * restarted. Keeping this in one transaction prevents clients from observing a
 * session whose status disagrees with its turn, messages, or interactions.
 */
export function recoverInterruptedTurns(database: DatabaseSync, now = Date.now()): number {
  if (!tableExists(database, 'turns')) return 0

  database.exec('BEGIN IMMEDIATE')
  try {
    database
      .prepare(
        `UPDATE sessions
         SET status = 'idle', updated_at = ?
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
