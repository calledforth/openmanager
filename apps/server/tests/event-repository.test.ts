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

const interactionRequested = () =>
  ProofEventSchemas['interaction.requested'].parse({
    type: 'event',
    name: 'interaction.requested',
    eventId: 'interaction-requested',
    timestamp: started().timestamp,
    scope,
    payload: {
      turnId: 'turn-1',
      interaction: {
        kind: 'plan',
        interactionId: 'interaction-1',
        markdown: 'Plan',
        todos: [],
        continuation: 'same_turn',
      },
    },
  })

const interactionResolved = () =>
  ProofEventSchemas['interaction.resolved'].parse({
    type: 'event',
    name: 'interaction.resolved',
    eventId: 'interaction-resolved',
    timestamp: completed().timestamp,
    scope,
    payload: {
      turnId: 'turn-1',
      response: {
        kind: 'plan',
        interactionId: 'interaction-1',
        outcome: { outcome: 'accepted' },
      },
    },
  })

function createOtherThread(database: DatabaseSync) {
  database.exec(`
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
    VALUES ('session-2', 'workspace-1', 'cursor', 'idle', 1, 1);
    INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
    VALUES ('thread-2', 'session-2', 'workspace-1', 1, 1);
  `)
  return { ...scope, sessionId: 'session-2', threadId: 'thread-2' }
}

function projectionSnapshot(database: DatabaseSync) {
  return Object.fromEntries(
    [
      'event_streams',
      'event_log',
      'sessions',
      'turns',
      'messages',
      'message_parts',
      'interactions',
    ].map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
  )
}

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

  it('returns original cursors across restarts and mixed duplicate/new batches', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1' })
    const first = repository.appendEvents(scope, [started()])
    const restarted = createEventRepository(database, { epoch: 'epoch-2' })
    expect(restarted.appendEvents(scope, [started()])).toEqual(first)
    const event = delta('Hello', 'event-delta')
    expect(
      restarted
        .appendEvents(scope, [started(), event, event, started()])
        .map((record) => record.cursor.sequence),
    ).toEqual([1, 2, 2, 1])
    expect(database.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 2,
    })
    expect(
      database
        .prepare('SELECT content_json FROM message_parts WHERE message_id = ?')
        .get('message-assistant'),
    ).toEqual({ content_json: '{"type":"text","text":"Hello"}' })
    expect(() => restarted.appendEvents(scope, [delta('changed', 'event-delta')])).toThrow(
      'different event',
    )
    expect(database.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 2,
    })
  })

  it('creates a session and then its thread using host provider identity', async () => {
    const { database } = await createDatabase()
    const environmentScope = { type: 'environment', environmentId: scope.environmentId } as const
    const sessionEvent = ProofEventSchemas['session.created'].parse({
      type: 'event',
      name: 'session.created',
      eventId: 'session-created',
      timestamp: started().timestamp,
      scope: environmentScope,
      payload: { session: { sessionId: 'session-2', workspaceId: 'workspace-1', title: 'New' } },
    })
    expect(() =>
      createEventRepository(database).appendEvents(environmentScope, [sessionEvent]),
    ).toThrow('sessionProviderId')
    expect(database.prepare('SELECT count(*) AS count FROM event_log').get()).toEqual({ count: 0 })
    const repository = createEventRepository(database, { sessionProviderId: () => 'cursor' })
    repository.appendEvents(environmentScope, [sessionEvent])
    const sessionScope = {
      type: 'session',
      environmentId: scope.environmentId,
      sessionId: 'session-2',
    } as const
    repository.appendEvents(sessionScope, [
      ProofEventSchemas['thread.created'].parse({
        type: 'event',
        name: 'thread.created',
        eventId: 'thread-created',
        timestamp: started().timestamp,
        scope: sessionScope,
        payload: { thread: { threadId: 'thread-2', sessionId: 'session-2' } },
      }),
    ])
    expect(
      database
        .prepare('SELECT provider_id, title, status FROM sessions WHERE session_id = ?')
        .get('session-2'),
    ).toEqual({ provider_id: 'cursor', title: 'New', status: 'idle' })
    expect(
      database.prepare('SELECT session_id FROM threads WHERE thread_id = ?').get('thread-2'),
    ).toEqual({ session_id: 'session-2' })
  })

  it('retries rolled-back finalization with the complete buffered output', async () => {
    const { database } = await createDatabase()
    let fail = false
    const repository = createEventRepository(database, {
      beforeCommit: () => {
        if (fail) throw new Error('commit failed')
      },
    })
    repository.appendEvents(scope, [started()])
    const batcher = createRepositoryEventBatcher(repository)
    batcher.append(delta('Done', 'event-delta'))
    fail = true
    expect(() => batcher.append(completed())).toThrow('commit failed')
    expect(database.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 1,
    })
    fail = false
    batcher.flush()
    expect(database.prepare('SELECT state FROM turns').get()).toEqual({ state: 'completed' })
    expect(database.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 3,
    })
    expect(
      database
        .prepare('SELECT content_json FROM message_parts WHERE message_id = ?')
        .get('message-assistant'),
    ).toEqual({ content_json: '{"type":"text","text":"Done"}' })
  })

  it('retries publication after commit without projecting the output twice', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, [started()])
    const publish = vi.fn().mockImplementationOnce(() => {
      throw new Error('publish failed')
    })
    const batcher = createRepositoryEventBatcher(repository, publish)
    batcher.append(delta('Done', 'event-delta'))
    expect(() => batcher.append(completed())).toThrow('publish failed')
    batcher.flush()
    expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0])
    expect(database.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 3,
    })
    expect(
      database
        .prepare('SELECT content_json FROM message_parts WHERE message_id = ?')
        .get('message-assistant'),
    ).toEqual({ content_json: '{"type":"text","text":"Done"}' })
  })

  it('rejects repeated terminal references and mixed-turn finalization', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, [started()])
    const terminal = completed()
    expect(() => repository.finalizeTurn(scope, [terminal, terminal])).toThrow('exactly one')
    const other = delta('Wrong turn', 'other')
    other.payload.turnId = 'turn-2'
    expect(() => repository.finalizeTurn(scope, [other, terminal])).toThrow('terminal turn')
    expect(database.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 1,
    })
  })

  it.each(['turn', 'thread', 'role', 'finalized'] as const)(
    'rolls back deltas that reuse a message with a different %s',
    async (mismatch) => {
      const { database } = await createDatabase()
      const repository = createEventRepository(database)
      repository.appendEvents(scope, [started(), delta('Original', 'original')])
      const incoming = delta('Corrupt', 'incoming')
      if (mismatch === 'turn' || mismatch === 'thread') {
        const other = started('other-start')
        other.payload.turn.turnId = 'turn-2'
        other.payload.userMessage.turnId = 'turn-2'
        other.payload.userMessage.messageId = 'user-2'
        if (mismatch === 'thread') {
          database.exec(`INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
            VALUES ('thread-2', 'session-1', 'workspace-1', 1, 1)`)
          other.scope.threadId = 'thread-2'
          other.payload.turn.threadId = 'thread-2'
          other.payload.userMessage.threadId = 'thread-2'
          incoming.scope.threadId = 'thread-2'
        }
        repository.appendEvents(other.scope, [other])
        incoming.payload.turnId = 'turn-2'
      } else if (mismatch === 'role') {
        incoming.payload.role = 'user'
      } else {
        repository.finalizeTurn(scope, [completed()])
      }
      const before = projectionSnapshot(database)
      expect(() => repository.appendEvents(incoming.scope, [incoming])).toThrow(
        'mismatched or finalized message',
      )
      expect(projectionSnapshot(database)).toEqual(before)
    },
  )

  it('rolls back interaction requests for a turn in another session/thread', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, [started()])
    const otherScope = createOtherThread(database)
    const request = interactionRequested()
    request.scope = otherScope
    const before = projectionSnapshot(database)
    expect(() => repository.appendEvents(otherScope, [request])).toThrow('missing turn')
    expect(projectionSnapshot(database)).toEqual(before)
  })

  it.each(['thread', 'turn', 'missing', 'kind'] as const)(
    'rolls back interaction resolution with a mismatched %s',
    async (mismatch) => {
      const { database } = await createDatabase()
      const repository = createEventRepository(database)
      repository.appendEvents(scope, [started(), interactionRequested()])
      const resolution = interactionResolved()
      if (mismatch === 'thread') {
        resolution.scope = createOtherThread(database)
      } else if (mismatch === 'turn') {
        const other = started('other-start')
        other.payload.turn.turnId = 'turn-2'
        other.payload.userMessage.turnId = 'turn-2'
        other.payload.userMessage.messageId = 'user-2'
        repository.appendEvents(scope, [other])
        resolution.payload.turnId = 'turn-2'
      } else if (mismatch === 'missing') {
        resolution.payload.response.interactionId = 'missing'
      } else {
        resolution.payload.response = {
          kind: 'question',
          interactionId: 'interaction-1',
          outcome: { outcome: 'answered', answers: [] },
        }
      }
      const before = projectionSnapshot(database)
      expect(() => repository.appendEvents(resolution.scope, [resolution])).toThrow()
      expect(projectionSnapshot(database)).toEqual(before)
    },
  )

  it('projects a matching interaction request and resolution', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, [started(), interactionRequested()])
    expect(database.prepare('SELECT state FROM turns').get()).toEqual({ state: 'waiting' })
    expect(database.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'waiting' })
    repository.appendEvents(scope, [interactionResolved()])
    expect(database.prepare('SELECT state FROM turns').get()).toEqual({ state: 'running' })
    expect(database.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'running' })
    expect(database.prepare('SELECT state FROM interactions').get()).toEqual({ state: 'resolved' })
    expect(database.prepare('SELECT head_sequence FROM event_streams').get()).toEqual({
      head_sequence: 3,
    })
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

  it('reports timer failures and retries the frozen batch before accepting new deltas', () => {
    vi.useFakeTimers()
    const flush = vi.fn().mockImplementationOnce(() => {
      throw new Error('busy')
    })
    const onError = vi.fn()
    const batcher = createStreamingEventBatcher(flush, { onError })
    batcher.append(delta('Hello', 'first'))
    vi.advanceTimersByTime(100)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'busy' }))
    batcher.append(delta(' world', 'second'))
    expect(flush.mock.calls[1]).toEqual(flush.mock.calls[0])
    batcher.close()
    expect(flush.mock.calls[2]?.[1]).toEqual([delta(' world', 'second')])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a terminal event even when no deltas were buffered', () => {
    const flush = vi.fn().mockImplementationOnce(() => {
      throw new Error('busy')
    })
    const batcher = createStreamingEventBatcher(flush)
    expect(() => batcher.append(completed())).toThrow('busy')
    batcher.close()
    expect(flush.mock.calls[1]).toEqual([scope, [completed()]])
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
