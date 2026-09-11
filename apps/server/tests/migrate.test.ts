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
    expect(readSchemaVersion(database)).toBe(3)
    expect(database.prepare('PRAGMA user_version').get() as { user_version: number }).toEqual({
      user_version: 3,
    })
    expect(database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).toEqual({
      journal_mode: 'wal',
    })
    expect(database.prepare('PRAGMA synchronous').get() as { synchronous: number }).toEqual({
      synchronous: 1,
    })
    expect(database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).toEqual({
      foreign_keys: 1,
    })
    expect(database.prepare('PRAGMA busy_timeout').get() as { timeout: number }).toEqual({
      timeout: BUSY_TIMEOUT_MS,
    })
    expect(tableNames(database)).toEqual([
      'attachments',
      'authorized_clients',
      'drafts',
      'environment_metadata',
      'event_log',
      'event_streams',
      'interactions',
      'message_parts',
      'messages',
      'provider_profiles',
      'schema_version',
      'sessions',
      'stash_items',
      'threads',
      'turns',
      'workspace_composer_preferences',
      'workspaces',
    ])
    expect(runMigrations(database, MIGRATIONS)).toBe(3)
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

  it('upgrades a legacy v1 composer database without losing its data', async () => {
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
    expect(readSchemaVersion(database)).toBe(3)
    expect(database.prepare('SELECT provider_id FROM provider_profiles').all()).toEqual([
      { provider_id: 'cursor' },
    ])
    expect(tableNames(database)).toContain('message_parts')
  })

  it('stores complete ordered message parts without stream chunks', async () => {
    const database = openEnvironmentDatabase(await dataDir())
    databases.push(database)
    database.exec(`
      INSERT INTO workspaces (
        workspace_id, name, path, created_at, updated_at
      ) VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
      INSERT INTO sessions (
        session_id, workspace_id, provider_id, status, created_at, updated_at
      ) VALUES ('session-1', 'workspace-1', 'cursor', 'idle', 1, 1);
      INSERT INTO threads (
        thread_id, session_id, workspace_id, created_at, updated_at
      ) VALUES ('thread-1', 'session-1', 'workspace-1', 1, 1);
      INSERT INTO turns (
        turn_id, thread_id, workspace_id, state, started_at, updated_at
      ) VALUES ('turn-1', 'thread-1', 'workspace-1', 'completed', 1, 1);
      INSERT INTO messages (
        message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final,
        created_at, updated_at
      ) VALUES (
        'message-1', 'workspace-1', 'thread-1', 'turn-1', 'assistant', 0, 1, 1, 1
      );
      INSERT INTO message_parts (
        part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
      ) VALUES
        ('part-2', 'message-1', 1, 'resource_link',
         '{"type":"resource_link","uri":"file:///two"}', 1, 1),
        ('part-1', 'message-1', 0, 'text',
         '{"type":"text","text":"complete response"}', 1, 1);
    `)

    expect(
      database
        .prepare(
          `SELECT part_type, content_json FROM message_parts
           WHERE message_id = ? ORDER BY ordinal`,
        )
        .all('message-1'),
    ).toEqual([
      { part_type: 'text', content_json: '{"type":"text","text":"complete response"}' },
      {
        part_type: 'resource_link',
        content_json: '{"type":"resource_link","uri":"file:///two"}',
      },
    ])
    expect(tableNames(database)).not.toContain('stream_chunks')
  })

  it('rejects relationships that cross workspace ownership', async () => {
    const database = openEnvironmentDatabase(await dataDir())
    databases.push(database)
    database.exec(`
      INSERT INTO workspaces (
        workspace_id, name, path, created_at, updated_at
      ) VALUES
        ('workspace-1', 'One', '/one', 1, 1),
        ('workspace-2', 'Two', '/two', 1, 1);
      INSERT INTO sessions (
        session_id, workspace_id, provider_id, status, created_at, updated_at
      ) VALUES
        ('session-1', 'workspace-1', 'cursor', 'idle', 1, 1),
        ('session-2', 'workspace-2', 'cursor', 'idle', 1, 1);
      INSERT INTO threads (
        thread_id, session_id, workspace_id, created_at, updated_at
      ) VALUES ('thread-2', 'session-2', 'workspace-2', 1, 1);
      INSERT INTO turns (
        turn_id, thread_id, workspace_id, state, started_at, updated_at
      ) VALUES ('turn-2', 'thread-2', 'workspace-2', 'completed', 1, 1);
      INSERT INTO messages (
        message_id, workspace_id, thread_id, turn_id, role, ordinal, created_at, updated_at
      ) VALUES (
        'message-2', 'workspace-2', 'thread-2', 'turn-2', 'assistant', 0, 1, 1
      );
    `)

    expect(() =>
      database.exec(`
        INSERT INTO sessions (
          session_id, workspace_id, parent_session_id, provider_id, status,
          created_at, updated_at
        ) VALUES (
          'cross-workspace-child', 'workspace-2', 'session-1', 'cursor', 'idle', 1, 1
        )
      `),
    ).toThrow(/FOREIGN KEY constraint failed/)
    expect(() =>
      database.exec(`
        INSERT INTO attachments (
          attachment_id, workspace_id, message_id, storage_key, name, mime_type,
          size_bytes, created_at
        ) VALUES (
          'cross-workspace-attachment', 'workspace-1', 'message-2', 'blob-cross',
          'note.txt', 'text/plain', 1, 1
        )
      `),
    ).toThrow(/FOREIGN KEY constraint failed/)
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('keeps client credentials unique without making attribution an owner', async () => {
    const database = openEnvironmentDatabase(await dataDir())
    databases.push(database)
    database.exec(`
      INSERT INTO authorized_clients (
        client_id, label, credential_hash, scopes_json, created_at
      ) VALUES ('client-1', 'Browser', X'0102', '["environment"]', 1);
      INSERT INTO stash_items (
        stash_item_id, content_json, created_by_client_id, created_at, updated_at
      ) VALUES ('stash-1', '{"text":"shared"}', 'client-1', 1, 1);
    `)

    expect(() =>
      database.exec(`
        INSERT INTO authorized_clients (
          client_id, label, credential_hash, scopes_json, created_at
        ) VALUES ('client-2', 'Duplicate', X'0102', '["environment"]', 1)
      `),
    ).toThrow(/UNIQUE constraint failed/)

    database.prepare('DELETE FROM authorized_clients WHERE client_id = ?').run('client-1')
    expect(database.prepare('SELECT created_by_client_id FROM stash_items').get()).toEqual({
      created_by_client_id: null,
    })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('enforces the documented session deletion graph', async () => {
    const database = openEnvironmentDatabase(await dataDir())
    databases.push(database)
    database.exec(`
      INSERT INTO authorized_clients (
        client_id, label, credential_hash, scopes_json, created_at
      ) VALUES ('client-1', 'Browser', X'0102', '["environment"]', 1);
      INSERT INTO workspaces (
        workspace_id, name, path, created_at, updated_at
      ) VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
      INSERT INTO sessions (
        session_id, workspace_id, provider_id, created_by_client_id, status,
        created_at, updated_at
      ) VALUES ('session-1', 'workspace-1', 'cursor', 'client-1', 'idle', 1, 1);
      INSERT INTO sessions (
        session_id, workspace_id, parent_session_id, provider_id, status,
        created_at, updated_at
      ) VALUES ('session-child', 'workspace-1', 'session-1', 'cursor', 'idle', 1, 1);
      INSERT INTO threads (
        thread_id, session_id, workspace_id, created_at, updated_at
      ) VALUES ('thread-1', 'session-1', 'workspace-1', 1, 1);
      INSERT INTO turns (
        turn_id, thread_id, workspace_id, state, started_at, updated_at
      ) VALUES ('turn-1', 'thread-1', 'workspace-1', 'waiting', 1, 1);
      INSERT INTO messages (
        message_id, workspace_id, thread_id, turn_id, role, ordinal, created_at, updated_at
      ) VALUES (
        'message-1', 'workspace-1', 'thread-1', 'turn-1', 'assistant', 0, 1, 1
      );
      INSERT INTO message_parts (
        part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
      ) VALUES ('part-1', 'message-1', 0, 'text', '{"type":"text","text":"partial"}', 1, 1);
      INSERT INTO interactions (
        interaction_id, turn_id, kind, state, request_json, created_at, updated_at
      ) VALUES ('interaction-1', 'turn-1', 'question', 'pending',
                '{"questions":[]}', 1, 1);
      INSERT INTO drafts (
        session_id, content_json, updated_by_client_id, created_at, updated_at
      ) VALUES ('session-1', '{"text":"unfinished"}', 'client-1', 1, 1);
      INSERT INTO stash_items (
        stash_item_id, workspace_id, source_session_id, content_json,
        created_by_client_id, created_at, updated_at
      ) VALUES ('stash-1', 'workspace-1', 'session-1', '{"text":"keep me"}',
                'client-1', 1, 1);
      INSERT INTO attachments (
        attachment_id, workspace_id, message_id, storage_key, name, mime_type,
        size_bytes, created_at
      ) VALUES ('attachment-1', 'workspace-1', 'message-1', 'blob-1', 'note.txt',
                'text/plain', 7, 1);
      INSERT INTO event_streams (
        scope_key, scope_type, epoch, head_sequence, updated_at
      ) VALUES ('environment:1', 'environment', 'epoch-1', 1, 1);
      INSERT INTO event_streams (
        scope_key, scope_type, session_id, epoch, head_sequence, updated_at
      ) VALUES ('session:1', 'session', 'session-1', 'epoch-1', 1, 1);
      INSERT INTO event_streams (
        scope_key, scope_type, session_id, thread_id, epoch, head_sequence, updated_at
      ) VALUES ('thread:1', 'thread', 'session-1', 'thread-1', 'epoch-1', 1, 1);
      INSERT INTO event_log (
        scope_key, sequence, event_id, event_name, event_json, created_at
      ) VALUES
        ('environment:1', 1, 'event-environment', 'session.deleted', '{}', 1),
        ('session:1', 1, 'event-session', 'thread.created', '{}', 1),
        ('thread:1', 1, 'event-thread', 'message.delta', '{}', 1);
    `)

    database.prepare('DELETE FROM sessions WHERE session_id = ?').run('session-1')

    for (const table of [
      'sessions',
      'threads',
      'turns',
      'messages',
      'message_parts',
      'interactions',
      'drafts',
      'attachments',
    ]) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    expect(database.prepare('SELECT scope_key FROM event_streams').all()).toEqual([
      { scope_key: 'environment:1' },
    ])
    expect(database.prepare('SELECT event_id FROM event_log').all()).toEqual([
      { event_id: 'event-environment' },
    ])
    expect(database.prepare('SELECT source_session_id FROM stash_items').get()).toEqual({
      source_session_id: null,
    })
    expect(database.prepare('SELECT workspace_id FROM workspaces').all()).toEqual([
      { workspace_id: 'workspace-1' },
    ])
    expect(database.prepare('SELECT client_id FROM authorized_clients').all()).toEqual([
      { client_id: 'client-1' },
    ])
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('rejects a catalog that skips versions', () => {
    const database = new DatabaseSync(':memory:')
    databases.push(database)
    expect(() => runMigrations(database, [{ version: 2, name: 'gap', up() {} }])).toThrow(
      'numbered contiguously from 1',
    )
  })
})
