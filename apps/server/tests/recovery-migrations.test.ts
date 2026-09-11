import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DATABASE_FILENAME, openEnvironmentDatabase } from '../src/db/database.js'
import { readSchemaVersion } from '../src/db/migrate.js'
import {
  MESSAGE_HISTORY_PAGE_SQL,
  MESSAGE_PARTS_SQL,
  SESSION_LIST_FOR_ENVIRONMENT_SQL,
  THREADS_FOR_SESSION_SQL,
  TURNS_FOR_THREAD_SQL,
} from '../src/db/queries.js'

const fixtureDirectory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const directories: string[] = []
const databases: DatabaseSync[] = []
const children: ChildProcess[] = []

async function copyFixture(version: 1 | 2): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `openmanager-schema-v${version}-`))
  directories.push(directory)
  await copyFile(
    join(fixtureDirectory, `schema-v${version}.sqlite`),
    join(directory, DATABASE_FILENAME),
  )
  return directory
}

function sessionList(database: DatabaseSync) {
  return database
    .prepare(SESSION_LIST_FOR_ENVIRONMENT_SQL)
    .all(Number.MAX_SAFE_INTEGER, '\uffff', 20)
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('checked-in schema fixtures', () => {
  it('migrates the v1 composer fixture through every later schema version', async () => {
    const database = openEnvironmentDatabase(await copyFixture(1))
    databases.push(database)

    expect(readSchemaVersion(database)).toBe(3)
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    expect(
      database.prepare('SELECT provider_id, default_model_id FROM provider_profiles').all(),
    ).toEqual([{ provider_id: 'cursor', default_model_id: 'composer-2.5' }])
    expect(sessionList(database)).toEqual([])
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('migrates the v2 domain fixture and preserves its session list and complete history', async () => {
    const database = openEnvironmentDatabase(await copyFixture(2))
    databases.push(database)

    expect(readSchemaVersion(database)).toBe(3)
    expect(sessionList(database)).toMatchObject([
      { session_id: 'session-recent', title: 'Recent session', status: 'idle' },
      { session_id: 'session-old', title: 'Older session', status: 'idle' },
    ])
    expect(database.prepare(THREADS_FOR_SESSION_SQL).all('session-recent')).toMatchObject([
      { thread_id: 'thread-recent', session_id: 'session-recent' },
    ])
    expect(database.prepare(TURNS_FOR_THREAD_SQL).all('thread-recent')).toMatchObject([
      { turn_id: 'turn-complete', state: 'completed' },
    ])
    const messages = database
      .prepare(MESSAGE_HISTORY_PAGE_SQL)
      .all('thread-recent', Number.MAX_SAFE_INTEGER, 20)
    expect(messages).toMatchObject([
      { message_id: 'message-assistant', role: 'assistant', ordinal: 1, is_final: 1 },
      { message_id: 'message-user', role: 'user', ordinal: 0, is_final: 1 },
    ])
    expect(database.prepare(MESSAGE_PARTS_SQL).all('message-assistant')).toEqual([
      {
        part_id: 'part-answer',
        ordinal: 0,
        part_type: 'text',
        content_json: '{"type":"text","text":"Answer"}',
      },
    ])
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})

describe('crash recovery', () => {
  it('opens a killed writer database with consistent sessions and an interrupted turn', async () => {
    const directory = await copyFixture(2)
    const databasePath = join(directory, DATABASE_FILENAME)
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      const database = new DatabaseSync(process.argv[1]);
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON');
      database.exec(\`
        BEGIN IMMEDIATE;
        INSERT INTO sessions (
          session_id, workspace_id, provider_id, title, status, created_at, updated_at
        ) VALUES ('session-crashed', 'workspace-1', 'cursor', 'Interrupted work', 'waiting', 400, 400);
        INSERT INTO threads (
          thread_id, session_id, workspace_id, created_at, updated_at
        ) VALUES ('thread-crashed', 'session-crashed', 'workspace-1', 400, 400);
        INSERT INTO turns (
          turn_id, thread_id, workspace_id, state, started_at, updated_at
        ) VALUES ('turn-crashed', 'thread-crashed', 'workspace-1', 'waiting', 400, 410);
        INSERT INTO messages (
          message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final,
          created_at, updated_at
        ) VALUES
          ('message-crash-user', 'workspace-1', 'thread-crashed', 'turn-crashed', 'user', 0, 1, 400, 400),
          ('message-crash-assistant', 'workspace-1', 'thread-crashed', 'turn-crashed', 'assistant', 1, 0, 405, 410);
        INSERT INTO message_parts (
          part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
        ) VALUES (
          'part-crash-assistant', 'message-crash-assistant', 0, 'text',
          '{"type":"text","text":"Partial answer"}', 405, 410
        );
        INSERT INTO interactions (
          interaction_id, turn_id, kind, state, request_json, created_at, updated_at
        ) VALUES (
          'interaction-crashed', 'turn-crashed', 'question', 'pending',
          '{"questions":[]}', 410, 410
        );
        COMMIT;
      \`);
      process.stdout.write('READY\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, databasePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    let output = ''
    let errorOutput = ''
    await new Promise<void>((resolveReady, reject) => {
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('READY')) resolveReady()
      })
      child.stderr!.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString()
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (!output.includes('READY')) {
          reject(new Error(`writer exited early (${code}): ${errorOutput}`))
        }
      })
    })
    expect(child.kill('SIGKILL')).toBe(true)
    await once(child, 'exit')
    children.splice(children.indexOf(child), 1)

    const recovered = openEnvironmentDatabase(directory)
    databases.push(recovered)

    expect(readSchemaVersion(recovered)).toBe(3)
    expect(sessionList(recovered)).toMatchObject([
      { session_id: 'session-crashed', title: 'Interrupted work', status: 'idle' },
      { session_id: 'session-recent', status: 'idle' },
      { session_id: 'session-old', status: 'idle' },
    ])
    expect(recovered.prepare(TURNS_FOR_THREAD_SQL).all('thread-crashed')).toMatchObject([
      { turn_id: 'turn-crashed', state: 'interrupted', failure_reason: null },
    ])
    expect(
      recovered.prepare(MESSAGE_HISTORY_PAGE_SQL).all('thread-crashed', Number.MAX_SAFE_INTEGER, 20),
    ).toMatchObject([
      { message_id: 'message-crash-assistant', is_final: 1 },
      { message_id: 'message-crash-user', is_final: 1 },
    ])
    expect(
      recovered.prepare('SELECT state, resolved_at FROM interactions WHERE interaction_id = ?').get(
        'interaction-crashed',
      ),
    ).toMatchObject({ state: 'cancelled', resolved_at: expect.any(Number) })
    expect(recovered.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(recovered.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
