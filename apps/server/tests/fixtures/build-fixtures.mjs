import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openEnvironmentDatabase } from '../../src/db/database.ts'
import { MIGRATIONS } from '../../src/db/migrations.ts'

const fixtures = dirname(fileURLToPath(import.meta.url))

function create(version, seed) {
  const directory = join(fixtures, `.build-v${version}`)
  const target = join(fixtures, `schema-v${version}.sqlite`)
  rmSync(directory, { recursive: true, force: true })
  rmSync(target, { force: true })
  mkdirSync(directory, { recursive: true })
  const database = openEnvironmentDatabase(directory, MIGRATIONS.slice(0, version))
  seed(database)
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  database.exec('PRAGMA journal_mode = DELETE')
  database.close()
  rmSync(target, { force: true })
  const source = join(directory, 'openmanager.sqlite')
  // Rename on the same volume so the checked-in fixture is a byte-for-byte DB,
  // never a live WAL plus an incomplete main file.
  renameSync(source, target)
  rmSync(directory, { recursive: true, force: true })
}

create(1, (database) => {
  database.exec(`
    INSERT INTO provider_profiles (
      provider_id, agent_info_json, default_model_id, updated_at
    ) VALUES ('cursor', '{"name":"Cursor"}', 'composer-2.5', 100);
    INSERT INTO workspace_composer_preferences (
      workspace_id, provider_id, model_id, updated_at
    ) VALUES ('C:/fixture/workspace', 'cursor', 'composer-2.5', 100);
  `)
})

create(2, (database) => {
  database.exec(`
    INSERT INTO environment_metadata (
      singleton, environment_id, label, created_at, updated_at
    ) VALUES (1, 'environment-fixture', 'Fixture environment', 100, 100);
    INSERT INTO workspaces (
      workspace_id, name, path, created_at, updated_at
    ) VALUES ('workspace-1', 'Fixture workspace', '/fixture/workspace', 100, 300);
    INSERT INTO sessions (
      session_id, workspace_id, provider_id, title, title_source, status,
      created_at, updated_at
    ) VALUES
      ('session-old', 'workspace-1', 'cursor', 'Older session', 'user', 'idle', 100, 200),
      ('session-recent', 'workspace-1', 'cursor', 'Recent session', 'provider', 'idle', 200, 300);
    INSERT INTO threads (
      thread_id, session_id, workspace_id, created_at, updated_at
    ) VALUES ('thread-recent', 'session-recent', 'workspace-1', 210, 300);
    INSERT INTO turns (
      turn_id, thread_id, workspace_id, state, started_at, finished_at, updated_at
    ) VALUES ('turn-complete', 'thread-recent', 'workspace-1', 'completed', 220, 250, 250);
    INSERT INTO messages (
      message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final,
      created_at, updated_at
    ) VALUES
      ('message-user', 'workspace-1', 'thread-recent', 'turn-complete', 'user', 0, 1, 220, 220),
      ('message-assistant', 'workspace-1', 'thread-recent', 'turn-complete', 'assistant', 1, 1, 230, 250);
    INSERT INTO message_parts (
      part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
    ) VALUES
      ('part-user', 'message-user', 0, 'text', '{"type":"text","text":"Question"}', 220, 220),
      ('part-answer', 'message-assistant', 0, 'text', '{"type":"text","text":"Answer"}', 230, 250);
  `)
})
