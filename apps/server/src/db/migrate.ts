import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  readonly version: number
  readonly name: string
  up(database: DatabaseSync): void
}

export class SchemaTooNewError extends Error {
  readonly found: number
  readonly supported: number

  constructor(found: number, supported: number) {
    super(
      `Database schema version ${found} is newer than this server supports (latest known is ${supported}).`,
    )
    this.name = 'SchemaTooNewError'
    this.found = found
    this.supported = supported
  }
}

export function latestMigrationVersion(migrations: readonly Migration[]): number {
  return migrations.at(-1)?.version ?? 0
}

/** Apply pending numbered migrations in one IMMEDIATE transaction. */
export function runMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[],
): number {
  assertCatalog(migrations)
  const supported = latestMigrationVersion(migrations)
  const existing = readSchemaVersion(database)
  if (existing > supported) throw new SchemaTooNewError(existing, supported)
  if (existing === supported && tableExists(database, 'schema_version')) return existing

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version >= 0)
      ) STRICT
    `)
    const current = seedSchemaVersion(database)
    if (current > supported) throw new SchemaTooNewError(current, supported)
    for (const migration of migrations) {
      if (migration.version <= current) continue
      migration.up(database)
      recordVersion(database, migration.version)
    }
    recordVersion(database, Math.max(current, supported))
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      /* The failed statement may already have aborted the transaction. */
    }
    throw error
  }
  return readSchemaVersion(database)
}

export function readSchemaVersion(database: DatabaseSync): number {
  if (!tableExists(database, 'schema_version')) return readUserVersion(database)
  const row = database.prepare('SELECT version FROM schema_version WHERE singleton = 1').get() as
    | { version: number }
    | undefined
  return parseVersion(row?.version, 'schema_version')
}

function seedSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('SELECT version FROM schema_version WHERE singleton = 1').get() as
    | { version: number }
    | undefined
  if (row) return parseVersion(row.version, 'schema_version')
  const version = readUserVersion(database)
  recordVersion(database, version)
  return version
}

function recordVersion(database: DatabaseSync, version: number): void {
  parseVersion(version, 'schema version')
  database
    .prepare(
      `INSERT INTO schema_version (singleton, version) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET version = excluded.version`,
    )
    .run(version)
  database.exec(`PRAGMA user_version = ${version}`)
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  return parseVersion(row?.user_version, 'user_version')
}

function parseVersion(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Database ${label} is invalid; restore openmanager.sqlite from backup instead of regenerating it.`,
    )
  }
  return value
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return (
    database
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  )
}

function assertCatalog(migrations: readonly Migration[]): void {
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1
    if (migration.version !== expected || migration.name.trim().length === 0) {
      throw new Error(`Migrations must be named and numbered contiguously from 1 (expected ${expected}).`)
    }
  }
}
