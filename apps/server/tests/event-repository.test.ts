import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProofEventSchemas,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import {
  createEventRepository,
  createRepositoryEventBatcher,
  createStreamingEventBatcher,
  type EventRepository,
} from '../src/db/event-repository.js'

const directories: string[] = []
const databases: DatabaseSync[] = []
const scope = {
  type: 'thread',
  environmentId: 'environment-1',
  sessionId: 'session-1',
  threadId: 'thread-1',
} as const

async function createDatabase(): Promise<{ database: DatabaseSync; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-events-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
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
  `)
  return { database, directory }
}

const started = (eventId = 'event-started') =>
  ProofEventSchemas['turn.started'].parse({
    type: 'event',
    name: 'turn.started',
    eventId,
    timestamp: '2026-09-10T10:00:00.000Z',
    scope,
    payload: {
      turn: { turnId: 'turn-1', threadId: 'thread-1', state: 'running' },
      userMessage: {
        messageId: 'message-user',
        threadId: 'thread-1',
        turnId: 'turn-1',
        role: 'user',
        content: [{ type: 'text', text: 'Prompt' }],
      },
    },
  })

const delta = (text: string, eventId: string) =>
  ProofEventSchemas['message.delta'].parse({
    type: 'event',
    name: 'message.delta',
    eventId,
    timestamp: '2026-09-10T10:00:01.000Z',
    scope,
    payload: {
      messageId: 'message-assistant',
      turnId: 'turn-1',
      role: 'assistant',
      content: { type: 'text', text },
    },
  })

const completed = (eventId = 'event-completed') =>
  ProofEventSchemas['turn.completed'].parse({
    type: 'event',
    name: 'turn.completed',
    eventId,
    timestamp: '2026-09-10T10:00:02.000Z',
    scope,
    payload: { turnId: 'turn-1' },
  })

afterEach(async () => {
  vi.useRealTimers()
  for (const database of databases.splice(0)) {
    try {
      database.close()
    } catch {
      // The crash test closes its setup connection before starting the child.
    }
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('event repository transactions', () => {
  it('atomically appends a batch, advances its cursor, and projects complete message parts', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1' })

    expect(repository.appendEvents(scope, [started()])[0]?.cursor.sequence).toBe(1)
    const records = repository.appendEvents(scope, [
      delta('Hello', 'event-2'),
      delta(' world', 'event-3'),
    ])

    expect(records.map((record) => record.cursor.sequence)).toEqual([2, 3])
    expect(
      database.prepare('SELECT head_sequence, oldest_sequence FROM event_streams').get(),
    ).toEqual({
      head_sequence: 3,
      oldest_sequence: 1,
    })
    expect(database.prepare('SELECT sequence FROM event_log ORDER BY sequence').all()).toEqual([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ])
    expect(
      database
        .prepare('SELECT content_json FROM message_parts WHERE message_id = ?')
        .get('message-assistant'),
    ).toEqual({
      content_json: '{"type":"text","text":"Hello world"}',
    })
  })

  it('finalizes the last streamed content, turn, messages, session, event log, and cursor together', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1' })
    repository.appendEvents(scope, [started()])

    const records = repository.finalizeTurn(scope, [delta('Done', 'event-delta'), completed()])

    expect(records.map((record) => record.cursor.sequence)).toEqual([2, 3])
    expect(
      database.prepare('SELECT state, finished_at FROM turns WHERE turn_id = ?').get('turn-1'),
    ).toEqual({
      state: 'completed',
      finished_at: Date.parse('2026-09-10T10:00:02.000Z'),
    })
    expect(
      database.prepare('SELECT status FROM sessions WHERE session_id = ?').get('session-1'),
    ).toEqual({ status: 'idle' })
    expect(database.prepare('SELECT role, is_final FROM messages ORDER BY ordinal').all()).toEqual([
      { role: 'user', is_final: 1 },
      { role: 'assistant', is_final: 1 },
    ])
  })

  it('rolls back the event and cursor when projection fails', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1' })

    expect(() => repository.appendEvents(scope, [delta('orphan', 'event-orphan')])).toThrow(
      'missing turn',
    )
    expect(database.prepare('SELECT count(*) AS count FROM event_streams').get()).toEqual({
      count: 0,
    })
    expect(database.prepare('SELECT count(*) AS count FROM event_log').get()).toEqual({ count: 0 })
  })

  it('recovers with the old cursor and projection when the process dies before commit', async () => {
    const { database, directory } = await createDatabase()
    createEventRepository(database, { epoch: 'epoch-1' }).appendEvents(scope, [started()])
    database.close()

    const modulePath = resolve('dist/db/event-repository.js').replaceAll('\\', '/')
    const databaseModulePath = resolve('dist/db/database.js').replaceAll('\\', '/')
    const script = `
      import { openEnvironmentDatabase } from ${JSON.stringify(`file:///${databaseModulePath}`)};
      import { createEventRepository } from ${JSON.stringify(`file:///${modulePath}`)};
      const database = openEnvironmentDatabase(process.argv[1]);
      const scope = ${JSON.stringify(scope)};
      const events = ${JSON.stringify([delta('uncommitted', 'event-child-delta'), completed('event-child-completed')])};
      createEventRepository(database, {
        epoch: 'epoch-1',
        beforeCommit() {
          process.stdout.write('READY\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        },
      }).finalizeTurn(scope, events);
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script, directory], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
          reject(new Error(`child exited before transaction seam (${code}): ${errorOutput}`))
        }
      })
    })
    child.kill('SIGKILL')
    await once(child, 'exit')

    const recovered = openEnvironmentDatabase(directory)
    databases.push(recovered)
    expect(recovered.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 1,
    })
    expect(recovered.prepare('SELECT sequence FROM event_log ORDER BY sequence').all()).toEqual([
      { sequence: 1 },
    ])
    expect(recovered.prepare('SELECT state FROM turns WHERE turn_id = ?').get('turn-1')).toEqual({
      state: 'running',
    })
    expect(
      recovered.prepare('SELECT status FROM sessions WHERE session_id = ?').get('session-1'),
    ).toEqual({
      status: 'running',
    })
    expect(recovered.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({ count: 1 })
  })
})

describe('streaming event batching', () => {
  it('routes the terminal batch through finalizeTurn', () => {
    const repository: EventRepository = {
      appendEvents: vi.fn(() => []),
      finalizeTurn: vi.fn(() => []),
    }
    const batcher = createRepositoryEventBatcher(repository)

    batcher.append(delta('final content', 'event-final-token'))
    batcher.append(completed())

    expect(repository.appendEvents).not.toHaveBeenCalled()
    expect(repository.finalizeTurn).toHaveBeenCalledWith(scope, [
      delta('final content', 'event-final-token'),
      completed(),
    ])
  })

  it('coalesces token deltas by time and carries the final delta into the terminal flush', () => {
    vi.useFakeTimers()
    const batches: Array<{ scope: SubscriptionScope; events: readonly ProofEvent[] }> = []
    const batcher = createStreamingEventBatcher(
      (batchScope, events) => batches.push({ scope: batchScope, events }),
      { maxBytes: 1_000, maxWaitMs: 100 },
    )

    batcher.append(delta('Hel', 'event-token-1'))
    batcher.append(delta('lo', 'event-token-2'))
    vi.advanceTimersByTime(99)
    expect(batches).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(batches[0]?.events).toHaveLength(1)
    expect(batches[0]?.events[0]).toMatchObject({ payload: { content: { text: 'Hello' } } })

    batcher.append(delta('!', 'event-token-3'))
    batcher.append(completed())
    expect(batches[1]?.events.map((event) => event.name)).toEqual([
      'message.delta',
      'turn.completed',
    ])
  })

  it('flushes as soon as the byte threshold is reached', () => {
    const batches: ProofEvent[][] = []
    const batcher = createStreamingEventBatcher(
      (_batchScope, events) => batches.push([...events]),
      { maxBytes: 1, maxWaitMs: 10_000 },
    )

    batcher.append(delta('token', 'event-token'))

    expect(batches).toHaveLength(1)
  })
})
