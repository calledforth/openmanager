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
    return database
  } catch (error) {
    database.close()
    throw error
  }
}
