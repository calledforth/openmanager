import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUSY_TIMEOUT_MS,
  DATABASE_FILENAME,
  configureConnection,
  openEnvironmentDatabase,
} from '../src/db/database.js'
import {
  SchemaTooNewError,
  readSchemaVersion,
  runMigrations,
  type Migration,
} from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'

const directories: string[] = []
const databases: DatabaseSync[] = []

async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-migrate-test-'))
  directories.push(directory)
  return directory
}

function openRaw(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  databases.push(database)
  configureConnection(database)
  return database
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name)
}

const sequential: readonly Migration[] = [
  {
    version: 1,
    name: 'items',
    up(database) {
      database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY) STRICT')
    },
  },
  {
    version: 2,
    name: 'items_name',
    up(database) {
      database.exec('ALTER TABLE items ADD COLUMN name TEXT')
    },
  },
]

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      /* already closed in the test body */
    }
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('schema migrations', () => {
  it('initializes a fresh database to the latest numbered version', async () => {
    const database = openEnvironmentDatabase(await dataDir())
    databases.push(database)
    expect(readSchemaVersion(database)).toBe(1)
    expect(
      database.prepare('PRAGMA user_version').get() as { user_version: number },
    ).toEqual({ user_version: 1 })
    expect(
      database.prepare('PRAGMA journal_mode').get() as { journal_mode: string },
    ).toEqual({ journal_mode: 'wal' })
    expect(
      database.prepare('PRAGMA synchronous').get() as { synchronous: number },
    ).toEqual({ synchronous: 1 })
    expect(
      database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number },
    ).toEqual({ foreign_keys: 1 })
    expect(
      database.prepare('PRAGMA busy_timeout').get() as { timeout: number },
    ).toEqual({ timeout: BUSY_TIMEOUT_MS })
    expect(tableNames(database)).toEqual([
      'provider_profiles',
      'schema_version',
      'workspace_composer_preferences',
    ])
    expect(runMigrations(database, MIGRATIONS)).toBe(1)
  })

  it('upgrades sequentially across restarts and leaves already-applied versions untouched', async () => {
    const directory = await dataDir()
    const first = openEnvironmentDatabase(directory, sequential.slice(0, 1))
    first.prepare('INSERT INTO items (id) VALUES (?)').run(1)
    expect(readSchemaVersion(first)).toBe(1)
    expect(first.prepare('PRAGMA table_info(items)').all()).toHaveLength(1)
    first.close()

    const upgraded = openEnvironmentDatabase(directory, sequential)
    databases.push(upgraded)
    expect(readSchemaVersion(upgraded)).toBe(2)
    expect(upgraded.prepare('SELECT id, name FROM items').all()).toEqual([{ id: 1, name: null }])
    expect(runMigrations(upgraded, sequential)).toBe(2)
  })

  it('refuses to open a database whose schema is newer than this server knows', async () => {
    const directory = await dataDir()
    const current = openEnvironmentDatabase(directory, sequential)
    current.exec('UPDATE schema_version SET version = 99')
    current.exec('PRAGMA user_version = 99')
    current.close()

    expect(() => openEnvironmentDatabase(directory, sequential)).toThrow(SchemaTooNewError)
    expect(() => openEnvironmentDatabase(directory, sequential)).toThrow(
      'Database schema version 99 is newer than this server supports (latest known is 2).',
    )
    const database = openRaw(join(directory, DATABASE_FILENAME))
    expect(readSchemaVersion(database)).toBe(99)
    expect(tableNames(database)).toEqual(['items', 'schema_version'])
  })

  it('rolls back a failed upgrade so neither objects nor the recorded version leak', async () => {
    const directory = await dataDir()
    const first = openEnvironmentDatabase(directory, sequential.slice(0, 1))
    first.close()

    expect(() =>
      openEnvironmentDatabase(directory, [
        sequential[0]!,
        {
          version: 2,
          name: 'broken',
          up(database) {
            database.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY) STRICT')
            throw new Error('migration failed')
          },
        },
      ]),
    ).toThrow('migration failed')

    const database = openRaw(join(directory, DATABASE_FILENAME))
    expect(readSchemaVersion(database)).toBe(1)
    expect(tableNames(database)).toEqual(['items', 'schema_version'])
  })

  it('adopts a legacy user_version=1 composer database without rewriting tables', async () => {
    const directory = await dataDir()
    const legacy = openRaw(join(directory, DATABASE_FILENAME))
    legacy.exec(`
      CREATE TABLE provider_profiles (
        provider_id TEXT PRIMARY KEY NOT NULL,
        agent_info_json TEXT,
        available_models_json TEXT,
        available_modes_json TEXT,
        default_model_id TEXT,
        default_mode_id TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE workspace_composer_preferences (
        workspace_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT,
        mode_id TEXT,
        config_values_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, provider_id)
      ) STRICT;
      INSERT INTO provider_profiles (provider_id, updated_at) VALUES ('cursor', 1);
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const database = openEnvironmentDatabase(directory)
    databases.push(database)
    expect(readSchemaVersion(database)).toBe(1)
    expect(database.prepare('SELECT provider_id FROM provider_profiles').all()).toEqual([
      { provider_id: 'cursor' },
    ])
  })

  it('rejects a catalog that skips versions', () => {
    const database = new DatabaseSync(':memory:')
    databases.push(database)
    expect(() =>
      runMigrations(database, [{ version: 2, name: 'gap', up() {} }]),
    ).toThrow('numbered contiguously from 1')
  })
})
