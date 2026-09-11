import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openEnvironmentDatabase } from '../src/db/database.js'
import {
  EVENTS_AFTER_CURSOR_SQL,
  EXPIRED_EVENTS_BY_SCOPE_SQL,
  MESSAGE_HISTORY_PAGE_SQL,
  MESSAGE_PARTS_SQL,
  SESSION_LIST_FOR_ENVIRONMENT_SQL,
  SESSION_LIST_FOR_WORKSPACE_SQL,
  STREAM_BOUNDS_SQL,
  THREADS_FOR_SESSION_SQL,
  TURNS_FOR_THREAD_SQL,
} from '../src/db/queries.js'

const directories: string[] = []
const databases: DatabaseSync[] = []

async function createDatabase(): Promise<DatabaseSync> {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-plans-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  return database
}

/** The `detail` column of every step SQLite plans for the statement. */
function plan(database: DatabaseSync, sql: string): string[] {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => (row as { detail: string }).detail)
}

function expectIndexed(steps: string[], index: string): void {
  expect(steps.some((step) => step.includes(`INDEX ${index}`))).toBe(true)
  expect(steps.some((step) => step.startsWith('SCAN'))).toBe(false)
  expect(steps.some((step) => step.includes('TEMP B-TREE'))).toBe(false)
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('bounded query plans', () => {
  it('lists sessions for the environment as one range of the updated_at index', async () => {
    const database = await createDatabase()
    expect(plan(database, SESSION_LIST_FOR_ENVIRONMENT_SQL)).toEqual([
      'SEARCH sessions USING INDEX sessions_updated_at_idx ((updated_at,session_id)<(?,?))',
    ])
  })

  it('lists sessions for a workspace as one range of the composite index', async () => {
    const database = await createDatabase()
    expect(plan(database, SESSION_LIST_FOR_WORKSPACE_SQL)).toEqual([
      'SEARCH sessions USING INDEX sessions_workspace_updated_at_idx (workspace_id=? AND (updated_at,session_id)<(?,?))',
    ])
  })

  it('walks session history through indexed threads, turns, messages, and parts', async () => {
    const database = await createDatabase()
    expectIndexed(plan(database, THREADS_FOR_SESSION_SQL), 'threads_session_created_at_idx')
    expectIndexed(plan(database, TURNS_FOR_THREAD_SQL), 'turns_thread_started_at_idx')
    expectIndexed(plan(database, MESSAGE_HISTORY_PAGE_SQL), 'sqlite_autoindex_messages_')
    expectIndexed(plan(database, MESSAGE_PARTS_SQL), 'sqlite_autoindex_message_parts_')
  })

  it('reads events after a cursor straight from the (scope_key, sequence) primary key', async () => {
    const database = await createDatabase()
    const steps = plan(database, EVENTS_AFTER_CURSOR_SQL)
    expect(steps).toEqual([
      'SEARCH event_log USING PRIMARY KEY (scope_key=? AND sequence>?)',
    ])
    expect(plan(database, STREAM_BOUNDS_SQL)).toEqual([
      'SEARCH event_streams USING INDEX sqlite_autoindex_event_streams_1 (scope_key=?)',
    ])
  })

  it('selects expired events from the covering created_at index, not the whole log', async () => {
    const database = await createDatabase()
    const steps = plan(database, EXPIRED_EVENTS_BY_SCOPE_SQL)
    // The GROUP BY sorts only the expired range, never the retained log.
    expect(steps).toEqual([
      'SEARCH event_log USING COVERING INDEX event_log_created_at_idx (created_at<?)',
      'USE TEMP B-TREE FOR GROUP BY',
    ])
  })

  it('drops the single-column indexes the composites supersede', async () => {
    const database = await createDatabase()
    const indexes = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name)
    expect(indexes).not.toContain('sessions_workspace_id_idx')
    expect(indexes).not.toContain('threads_session_id_idx')
    expect(indexes).not.toContain('turns_thread_id_idx')
    expect(indexes).toEqual(
      expect.arrayContaining([
        'sessions_updated_at_idx',
        'sessions_workspace_updated_at_idx',
        'threads_session_created_at_idx',
        'turns_thread_started_at_idx',
        'event_log_created_at_idx',
      ]),
    )
  })
})
