import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProofEventSchemas,
  ProofResponseSchemas,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { createPersistentEventService } from '../src/event-service.js'
import { createThreadService } from '../src/thread-service.js'
import { createEventRetention } from '../src/db/event-retention.js'
import { openEnvironmentDatabase } from '../src/db/database.js'
import {
  createRepositoryEventBatcher,
  createStreamingEventBatcher,
} from '../src/db/event-batcher.js'
import { createEventRepository, type EventRepository } from '../src/db/event-repository.js'
import { REASONING_TEXT_BUDGET_BYTES, listSessionHistory } from '../src/db/session-store.js'

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

const interactionResolved = (eventId = 'interaction-resolved') =>
  ProofEventSchemas['interaction.resolved'].parse({
    type: 'event',
    name: 'interaction.resolved',
    eventId,
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
  it('commits status broadcasts with lifecycle rows and stays waiting until every interaction resolves', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const statuses: unknown[] = []
    const append = (event: Exclude<ProofEvent, { name: 'turn.notice' }>) => {
      const records = repository.appendEvents(event.scope, [event])
      for (const record of records) {
        if (record.event.name !== 'session.updated') continue
        expect(record.cursor.scope.type).toBe('environment')
        statuses.push(ProofEventSchemas['session.updated'].parse(record.event).payload.status)
      }
      return records
    }
    append(started())
    append(interactionRequested())
    append(
      ProofEventSchemas['interaction.requested'].parse({
        ...interactionRequested(),
        eventId: 'question-requested',
        payload: {
          turnId: 'turn-1',
          interaction: {
            kind: 'question',
            interactionId: 'question-1',
            questions: [{ questionId: 'q', prompt: 'Which?', options: [] }],
          },
        },
      }),
    )
    append(
      ProofEventSchemas['interaction.requested'].parse({
        ...interactionRequested(),
        eventId: 'permission-requested',
        payload: {
          turnId: 'turn-1',
          interaction: {
            kind: 'permission',
            interactionId: 'permission-1',
            toolCall: { toolCallId: 'tool-1', title: 'Read file' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          },
        },
      }),
    )
    append(interactionResolved())
    expect(
      database.prepare('SELECT status FROM sessions WHERE session_id = ?').get('session-1'),
    ).toEqual({ status: 'waiting' })
    for (const kind of ['question', 'permission'] as const) {
      append(
        ProofEventSchemas['interaction.resolved'].parse({
          ...interactionResolved(),
          eventId: `${kind}-resolved`,
          payload: {
            turnId: 'turn-1',
            response: {
              kind,
              interactionId: `${kind}-1`,
              outcome: { outcome: 'cancelled' },
            },
          },
        }),
      )
    }
    expect(statuses).toEqual(['running', 'waiting', 'running'])
    append(completed())
    expect(statuses).toEqual(['running', 'waiting', 'running', 'idle'])
    expect(
      database.prepare('SELECT status FROM sessions WHERE session_id = ?').get('session-1'),
    ).toEqual({ status: 'idle' })
    // Retried events return both original cursors and do not duplicate broadcasts.
    expect(append(completed()).map((record) => record.event.eventId)).toEqual([
      'event-completed',
      'event-completed:status',
    ])
    expect(
      database
        .prepare("SELECT count(*) AS n FROM event_log WHERE event_name = 'session.updated'")
        .get(),
    ).toEqual({ n: 4 })
  })

  it('settles without reordering and unsettles on the next turn through the status broadcast', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const environment = { type: 'environment', environmentId: 'environment-1' } as const
    const settle = (eventId: string, settledAt: string | null) =>
      ProofEventSchemas['session.updated'].parse({
        type: 'event',
        name: 'session.updated',
        eventId,
        timestamp: '2026-09-10T09:00:00.000Z',
        scope: environment,
        payload: { sessionId: 'session-1', settledAt },
      })
    const row = () =>
      database
        .prepare('SELECT settled_at, updated_at FROM sessions WHERE session_id = ?')
        .get('session-1')
    const broadcasts = (records: ReturnType<EventRepository['appendEvents']>) =>
      records
        .filter((record) => record.event.name === 'session.updated')
        .map((record) => ProofEventSchemas['session.updated'].parse(record.event).payload)

    repository.appendEvents(environment, [settle('settle-1', '2026-09-10T09:00:00.000Z')])
    expect(row()).toEqual({ settled_at: Date.parse('2026-09-10T09:00:00.000Z'), updated_at: 1 })

    expect(broadcasts(repository.appendEvents(scope, [started()]))).toEqual([
      { sessionId: 'session-1', status: 'running', settledAt: null },
    ])
    expect(row()).toMatchObject({ settled_at: null })
    // Only the transition carries it; later status changes leave settling alone.
    expect(broadcasts(repository.appendEvents(scope, [completed()]))).toEqual([
      { sessionId: 'session-1', status: 'idle', doneAt: expect.any(String) },
    ])

    repository.appendEvents(environment, [settle('settle-2', '2026-09-10T11:00:00.000Z')])
    repository.appendEvents(environment, [settle('unsettle-2', null)])
    expect(row()).toMatchObject({ settled_at: null })
    expect(() =>
      repository.appendEvents(environment, [
        ProofEventSchemas['session.updated'].parse({
          ...settle('settle-missing', '2026-09-10T11:00:00.000Z'),
          payload: { sessionId: 'session-missing', settledAt: '2026-09-10T11:00:00.000Z' },
        }),
      ]),
    ).toThrow(/missing session/)
  })

  it('marks a completed turn done until acknowledged, and a new turn clears it', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const environment = { type: 'environment', environmentId: 'environment-1' } as const
    const doneAt = () =>
      (
        database.prepare('SELECT done_at FROM sessions WHERE session_id = ?').get('session-1') as {
          done_at: number | null
        }
      ).done_at
    const broadcasts = (records: ReturnType<EventRepository['appendEvents']>) =>
      records
        .filter((record) => record.event.name === 'session.updated')
        .map((record) => ProofEventSchemas['session.updated'].parse(record.event).payload)
    const acknowledge = (eventId: string) =>
      ProofEventSchemas['session.updated'].parse({
        type: 'event',
        name: 'session.updated',
        eventId,
        timestamp: '2026-09-10T10:05:00.000Z',
        scope: environment,
        payload: { sessionId: 'session-1', doneAt: null },
      })
    const secondTurn = (name: 'turn.started', eventId: string) => {
      const first = started(eventId)
      return ProofEventSchemas[name].parse({
        ...first,
        payload: {
          ...first.payload,
          turn: { ...first.payload.turn, turnId: 'turn-2' },
          userMessage: {
            ...first.payload.userMessage,
            messageId: 'message-user-2',
            turnId: 'turn-2',
          },
        },
      })
    }

    // Starting is not news.
    expect(broadcasts(repository.appendEvents(scope, [started()]))).toEqual([
      { sessionId: 'session-1', status: 'running' },
    ])
    expect(doneAt()).toBeNull()

    const [finished] = broadcasts(repository.appendEvents(scope, [completed()]))
    expect(finished).toEqual({ sessionId: 'session-1', status: 'idle', doneAt: expect.any(String) })
    expect(doneAt()).toBe(Date.parse(finished!.doneAt!))

    // Acknowledging clears it and leaves the session's place in the list alone.
    const before = database
      .prepare('SELECT updated_at FROM sessions WHERE session_id = ?')
      .get('session-1')
    repository.appendEvents(environment, [acknowledge('ack-1')])
    expect(doneAt()).toBeNull()
    expect(
      database.prepare('SELECT updated_at FROM sessions WHERE session_id = ?').get('session-1'),
    ).toEqual(before)

    // Unacknowledged results are superseded by the next turn, which says so.
    repository.appendEvents(scope, [secondTurn('turn.started', 'started-2')])
    repository.appendEvents(scope, [
      ProofEventSchemas['turn.completed'].parse({
        ...completed('completed-2'),
        payload: { turnId: 'turn-2' },
      }),
    ])
    expect(doneAt()).not.toBeNull()
    const third = started('started-3')
    expect(
      broadcasts(
        repository.appendEvents(scope, [
          ProofEventSchemas['turn.started'].parse({
            ...third,
            payload: {
              ...third.payload,
              turn: { ...third.payload.turn, turnId: 'turn-3' },
              userMessage: {
                ...third.payload.userMessage,
                messageId: 'message-user-3',
                turnId: 'turn-3',
              },
            },
          }),
        ]),
      ),
    ).toEqual([{ sessionId: 'session-1', status: 'running', doneAt: null }])
    expect(doneAt()).toBeNull()

    // A failed turn is not done: it shows as the error status instead.
    expect(
      broadcasts(
        repository.appendEvents(scope, [
          ProofEventSchemas['turn.failed'].parse({
            type: 'event',
            name: 'turn.failed',
            eventId: 'failed-3',
            timestamp: '2026-09-10T10:09:00.000Z',
            scope,
            payload: { turnId: 'turn-3', reason: 'provider_error', message: 'Boom.' },
          }),
        ]),
      ),
    ).toEqual([{ sessionId: 'session-1', status: 'error' }])
    expect(doneAt()).toBeNull()

    expect(() =>
      repository.appendEvents(environment, [
        ProofEventSchemas['session.updated'].parse({
          ...acknowledge('ack-missing'),
          payload: { sessionId: 'session-missing', doneAt: null },
        }),
      ]),
    ).toThrow(/missing session/)
  })

  it('expires durably, stays waiting for another request, and rejects a late resolution', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const request = interactionRequested()
    repository.appendEvents(scope, [
      started(),
      request,
      {
        ...request,
        eventId: 'second-request',
        payload: {
          ...request.payload,
          interaction: { ...request.payload.interaction, interactionId: 'second' },
        },
      },
    ])
    const expiry = ProofEventSchemas['interaction.expired'].parse({
      ...interactionResolved(),
      name: 'interaction.expired',
      eventId: 'expired',
      payload: {
        turnId: 'turn-1',
        response: {
          kind: 'plan',
          interactionId: 'interaction-1',
          outcome: { outcome: 'cancelled', reason: 'timeout' },
        },
      },
    })
    const records = repository.appendEvents(scope, [expiry])
    expect(database.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'waiting' })
    expect(
      database
        .prepare('SELECT state, resolved_by_client_id FROM interactions WHERE interaction_id = ?')
        .get('interaction-1'),
    ).toEqual({ state: 'expired', resolved_by_client_id: null })
    expect(repository.appendEvents(scope, [expiry])).toEqual(records)
    const before = projectionSnapshot(database)
    expect(() => repository.appendEvents(scope, [interactionResolved()])).toThrow(
      'settled interaction',
    )
    expect(projectionSnapshot(database)).toEqual(before)
    const final = repository.appendEvents(scope, [
      {
        ...expiry,
        eventId: 'second-expired',
        payload: {
          ...expiry.payload,
          response: { ...expiry.payload.response, interactionId: 'second' },
        },
      },
    ])
    expect(database.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'running' })
    expect(final.at(-1)?.event).toMatchObject({
      name: 'session.updated',
      payload: { status: 'running' },
    })
  })

  it('retries a retained status broadcast even after its triggering thread event is pruned', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const original = repository.appendEvents(scope, [started()])
    repository.appendEvents(scope, [delta('Hello', 'event-delta')])
    const retention = createEventRetention(database, {
      maxEventsPerScope: 1,
      now: () => Date.parse('2026-09-10T10:00:03.000Z'),
    })
    expect(retention.prune().deleted).toBe(1)

    expect(repository.appendEvents(scope, [started()])).toEqual(original)
    expect(database.prepare('SELECT count(*) AS n FROM event_log').get()).toEqual({ n: 2 })
    expect(database.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'running' })
  })

  it.each(['turn.completed', 'turn.interrupted', 'turn.failed'] as const)(
    '%s settles pending interactions and broadcasts the terminal status atomically',
    async (name) => {
      const { database } = await createDatabase()
      const repository = createEventRepository(database)
      repository.appendEvents(scope, [started(), interactionRequested()])
      const terminal = ProofEventSchemas[name].parse({
        ...completed(),
        name,
        payload: {
          turnId: 'turn-1',
          reason: 'provider_process_crashed',
          message: 'Provider crashed',
        },
      })
      const records = repository.finalizeTurn(scope, [terminal])
      const status = name === 'turn.failed' ? 'error' : 'idle'
      expect(records.at(-1)?.event).toMatchObject({
        name: 'session.updated',
        payload: { sessionId: 'session-1', status },
      })
      expect(
        database.prepare('SELECT status FROM sessions WHERE session_id = ?').get('session-1'),
      ).toEqual({ status })
      expect(database.prepare('SELECT state FROM interactions').get()).toEqual({
        state: 'cancelled',
      })
    },
  )

  it('atomically appends a batch, advances its cursor, and projects complete message parts', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1' })

    expect(repository.appendEvents(scope, [started()])[0]?.cursor.sequence).toBe(1)
    const records = repository.appendEvents(scope, [
      delta('Hello', 'event-2'),
      delta(' world', 'event-3'),
    ])

    expect(
      records
        .filter((record) => record.cursor.scope.type === 'thread')
        .map((record) => record.cursor.sequence),
    ).toEqual([2, 3])
    expect(
      database.prepare('SELECT head_sequence, oldest_sequence FROM event_streams').get(),
    ).toEqual({
      head_sequence: 3,
      oldest_sequence: 1,
    })
    expect(
      database
        .prepare(
          `SELECT sequence FROM event_log WHERE event_name != 'session.updated' ORDER BY sequence`,
        )
        .all(),
    ).toEqual([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }])
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

    expect(
      records
        .filter((record) => record.cursor.scope.type === 'thread')
        .map((record) => record.cursor.sequence),
    ).toEqual([2, 3])
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
        .filter((record) => record.cursor.scope.type === 'thread')
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

  it('files a child session under its parent and refuses one from another workspace', async () => {
    const { database } = await createDatabase()
    database.exec(`
      INSERT INTO workspaces (
        workspace_id, name, path, created_at, updated_at
      ) VALUES ('workspace-2', 'Other', '/other', 1, 1);
    `)
    const environmentScope = { type: 'environment', environmentId: scope.environmentId } as const
    const repository = createEventRepository(database, { sessionProviderId: () => 'cursor' })
    const created = (session: {
      sessionId: string
      workspaceId: string
      title: string
      parentSessionId?: string
    }) =>
      ProofEventSchemas['session.created'].parse({
        type: 'event',
        name: 'session.created',
        eventId: `created-${session.sessionId}`,
        timestamp: started().timestamp,
        scope: environmentScope,
        payload: { session },
      })

    repository.appendEvents(environmentScope, [
      created({
        sessionId: 'session-child',
        workspaceId: 'workspace-1',
        title: 'Subagent',
        parentSessionId: 'session-1',
      }),
    ])
    expect(
      database
        .prepare('SELECT parent_session_id, workspace_id FROM sessions WHERE session_id = ?')
        .get('session-child'),
    ).toEqual({ parent_session_id: 'session-1', workspace_id: 'workspace-1' })

    // The composite foreign key is what keeps a child inside its parent's workspace.
    expect(() =>
      repository.appendEvents(environmentScope, [
        created({
          sessionId: 'session-foreign',
          workspaceId: 'workspace-2',
          title: 'Elsewhere',
          parentSessionId: 'session-1',
        }),
      ]),
    ).toThrow()
    expect(
      database
        .prepare('SELECT count(*) AS count FROM sessions WHERE session_id = ?')
        .get('session-foreign'),
    ).toEqual({ count: 0 })
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
    expect(() => repository.appendEvents(otherScope, [request])).toThrow('missing or finished turn')
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

  it.each(['terminal', 'interaction.requested', 'interaction.resolved'] as const)(
    'rolls back a late %s event for a finished turn',
    async (kind) => {
      const { database } = await createDatabase()
      const repository = createEventRepository(database)
      repository.appendEvents(scope, [started(), interactionRequested()])
      repository.finalizeTurn(scope, [completed()])
      const late =
        kind === 'terminal'
          ? ProofEventSchemas['turn.failed'].parse({
              ...completed('late'),
              name: 'turn.failed',
              payload: { turnId: 'turn-1', reason: 'provider_error', message: 'late' },
            })
          : kind === 'interaction.requested'
            ? { ...interactionRequested(), eventId: 'late' }
            : interactionResolved('late')
      const before = projectionSnapshot(database)
      expect(() => repository.appendEvents(scope, [late])).toThrow()
      expect(projectionSnapshot(database)).toEqual(before)
    },
  )

  it('rolls back a second resolution of a settled interaction', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, [started(), interactionRequested(), interactionResolved()])
    const before = projectionSnapshot(database)
    expect(() => repository.appendEvents(scope, [interactionResolved('again')])).toThrow(
      'settled interaction',
    )
    expect(projectionSnapshot(database)).toEqual(before)
  })

  it('rolls back the uncommitted batch and interrupts its open turn after a crash', async () => {
    const { database, directory } = await createDatabase()
    createEventRepository(database, { epoch: 'epoch-1' }).appendEvents(scope, [started()])
    database.close()

    // Node runs the TypeScript sources directly, the same way `pnpm dev` does.
    const modulePath = resolve('src/db/event-repository.ts').replaceAll('\\', '/')
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { createEventRepository } from ${JSON.stringify(`file:///${modulePath}`)};
      const database = new DatabaseSync(${JSON.stringify(join(directory, 'openmanager.sqlite'))});
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON');
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
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
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
    expect(
      recovered
        .prepare(
          `SELECT sequence FROM event_log WHERE event_name != 'session.updated' ORDER BY sequence`,
        )
        .all(),
    ).toEqual([{ sequence: 1 }])
    expect(recovered.prepare('SELECT state FROM turns WHERE turn_id = ?').get('turn-1')).toEqual({
      state: 'interrupted',
    })
    expect(
      recovered.prepare('SELECT status FROM sessions WHERE session_id = ?').get('session-1'),
    ).toEqual({
      // Nobody asked the turn to stop, so the session shows as failed.
      status: 'error',
    })
    expect(recovered.prepare('SELECT role, is_final FROM messages').all()).toEqual([
      { role: 'user', is_final: 1 },
    ])
  })
})

describe('streaming event batching', () => {
  it('routes the terminal batch through finalizeTurn', () => {
    const repository: EventRepository = {
      appendEvents: vi.fn(() => []),
      appendGroups: vi.fn(() => []),
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

describe('durable server event boundary', () => {
  it('hydrates completed history, summaries, and threads from SQLite after restart and retention', async () => {
    const { database, directory } = await createDatabase()
    const publish = vi.fn((record) => {
      expect(
        database
          .prepare('SELECT event_id FROM event_log WHERE event_id = ?')
          .get(record.event.eventId),
      ).toEqual({ event_id: record.event.eventId })
      if (record.event.name === 'turn.completed') {
        expect(database.prepare('SELECT state FROM turns').get()).toEqual({ state: 'completed' })
      }
    })
    const events = createPersistentEventService(database, publish)
    events.append(started())
    events.append(delta('Hello', 'first'))
    events.append(delta(' world', 'second'))
    expect(publish).toHaveBeenCalledTimes(2)
    events.append(completed())
    expect(
      publish.mock.calls
        .filter(([record]) => record.cursor.scope.type === 'thread')
        .map(([record]) => record.cursor.sequence),
    ).toEqual([1, 2, 3])
    events.close()
    createEventRetention(database, { now: () => Date.parse('2027-01-01') }).prune()
    expect(database.prepare('SELECT count(*) AS count FROM event_log').get()).toEqual({ count: 0 })
    database.prepare("UPDATE sessions SET provider_session_id = 'provider-persisted'").run()
    database.close()
    const reopened = openEnvironmentDatabase(directory)
    databases.push(reopened)
    const runtime = {
      ensureSession: vi
        .fn()
        .mockResolvedValue({ sessionId: 'provider-persisted', state: 'loaded' }),
      prompt: vi.fn(),
      cancel: vi.fn(),
    }
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      vi.fn(),
      undefined,
      () => ({ providerId: 'cursor', cwd: '/workspace' }),
      { database: reopened },
    )
    const dispatch = (name: string, payload: Record<string, string>) =>
      service.dispatch({
        type: 'command',
        requestId: 'read',
        name,
        payload,
      })
    expect(dispatch('session.list', {})).toMatchObject({
      payload: {
        sessions: [{ sessionId: 'session-1', status: 'idle', providerId: 'cursor' }],
      },
    })
    expect(dispatch('session.open', { sessionId: 'session-1' })).toMatchObject({
      payload: {
        session: { sessionId: 'session-1' },
        threads: [{ threadId: 'thread-1' }],
      },
    })
    expect(
      dispatch('session.history', { sessionId: 'session-1', threadId: 'thread-1' }),
    ).toMatchObject({
      payload: {
        turns: [{ turnId: 'turn-1', state: 'completed' }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
        ],
        nextCursor: null,
      },
    })
    await service.resolveRuntimeSession('session-1')
    expect(runtime.ensureSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'provider-persisted', threadId: 'thread-1' }),
    )
    // Retention tombstones preserve the cursor even though history no longer needs the log.
    const records = createEventRepository(reopened).appendEvents(scope, [started()])
    expect(records[0]?.cursor.sequence).toBe(1)
    const next = started('next-turn-started')
    next.payload.turn.turnId = 'turn-2'
    next.payload.userMessage.turnId = 'turn-2'
    next.payload.userMessage.messageId = 'user-2'
    const afterRestart = createEventRepository(reopened).appendEvents(scope, [next])
    expect(afterRestart[0]?.cursor).toEqual({ ...publish.mock.calls[0]![0].cursor, sequence: 4 })
  })

  it.each(['running', 'waiting'] as const)(
    'settles a persisted %s turn and preserves its partial content on reopen',
    async (state) => {
      const { database, directory } = await createDatabase()
      const events = createPersistentEventService(database, vi.fn())
      events.append(started())
      events.append(delta('Partial answer', 'partial'))
      if (state === 'waiting') events.append(interactionRequested())
      events.flush()
      database.close()
      const reopened = openEnvironmentDatabase(directory)
      databases.push(reopened)
      expect(reopened.prepare('SELECT state, finished_at FROM turns').get()).toEqual({
        state: 'interrupted',
        finished_at: expect.any(Number),
      })
      expect(reopened.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'error' })
      expect(
        reopened
          .prepare('SELECT content_json FROM message_parts WHERE message_id = ?')
          .get('message-assistant'),
      ).toEqual({ content_json: '{"type":"text","text":"Partial answer"}' })
      expect(
        reopened
          .prepare('SELECT is_final FROM messages WHERE message_id = ?')
          .get('message-assistant'),
      ).toEqual({ is_final: 1 })
      expect(
        reopened
          .prepare("SELECT count(*) AS count FROM interactions WHERE state = 'pending'")
          .get(),
      ).toEqual({ count: 0 })
    },
  )

  it('bounds token flood transactions, log rows, and part writes by count and flushes sparse output by time', async () => {
    vi.useFakeTimers()
    const { database } = await createDatabase()
    database.exec(`
      CREATE TABLE part_writes (n INTEGER NOT NULL);
      INSERT INTO part_writes VALUES (0);
      CREATE TRIGGER count_part_insert AFTER INSERT ON message_parts BEGIN UPDATE part_writes SET n = n + 1; END;
      CREATE TRIGGER count_part_update AFTER UPDATE ON message_parts BEGIN UPDATE part_writes SET n = n + 1; END;
    `)
    const commits = vi.fn()
    const events = createPersistentEventService(database, vi.fn(), {
      maxEvents: 64,
      maxBytes: 1_000_000,
      maxWaitMs: 100,
      beforeCommit: commits,
    })
    events.append(started())
    for (let i = 0; i < 1024; i++) events.append(delta('x', `token-${i}`))
    expect(commits).toHaveBeenCalledTimes(17)
    expect(database.prepare('SELECT n FROM part_writes').get()).toEqual({ n: 17 })
    expect(database.prepare('SELECT count(*) AS count FROM event_log').get()).toEqual({ count: 18 })
    events.append(delta('!', 'sparse'))
    vi.advanceTimersByTime(99)
    expect(commits).toHaveBeenCalledTimes(17)
    vi.advanceTimersByTime(1)
    expect(commits).toHaveBeenCalledTimes(18)
    events.append(completed())
    expect(
      database
        .prepare('SELECT count(*) AS count FROM message_parts WHERE message_id = ?')
        .get('message-assistant'),
    ).toEqual({ count: 1 })
    expect(
      database
        .prepare('SELECT content_json FROM message_parts WHERE message_id = ?')
        .get('message-assistant'),
    ).toEqual({ content_json: JSON.stringify({ type: 'text', text: 'x'.repeat(1024) + '!' }) })
    events.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never publishes failed transactions and rejects transient notices', async () => {
    const { database } = await createDatabase()
    const publish = vi.fn()
    let fail = true
    const events = createPersistentEventService(database, publish, {
      beforeCommit: () => {
        if (fail) throw new Error('commit failed')
      },
    })
    expect(() => events.append(started())).toThrow('commit failed')
    expect(publish).not.toHaveBeenCalled()
    expect(database.prepare('SELECT count(*) AS count FROM turns').get()).toEqual({ count: 0 })
    fail = false
    events.flush()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(() =>
      events.append({ ...started(), name: 'turn.notice' } as unknown as ProofEvent),
    ).toThrow('transient')
    events.close()
  })

  it('commits session and thread creation together and fails the command when the write fails', async () => {
    const { database } = await createDatabase()
    let fail = false
    const commits = vi.fn(() => {
      if (fail) throw new Error('disk full')
    })
    const publish = vi.fn()
    const events = createPersistentEventService(database, publish, {
      beforeCommit: commits,
      sessionProviderId: () => 'cursor',
    })
    const runtime = {
      ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
      prompt: vi.fn(),
      cancel: vi.fn(),
    }
    const service = createThreadService(
      runtime,
      { rejection: () => undefined },
      (event) => events.append(event),
      undefined,
      (workspaceId) =>
        workspaceId === 'workspace-1' ? { providerId: 'opencode', cwd: '/workspace' } : undefined,
      { database, flush: events.flush, appendAtomic: (batch) => events.appendAtomic(batch) },
    )
    service.setEnvironmentId('environment-1')
    const create = (requestId: string) =>
      service.dispatch({
        type: 'command',
        requestId,
        name: 'session.create',
        payload: {
          environmentId: 'environment-1',
          workspaceId: 'workspace-1',
          providerId: 'opencode',
        },
      })

    fail = true
    expect(create('create-1')).toMatchObject({ type: 'error', error: { code: 'unavailable' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.ensureSession).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    // Only the seeded session exists: neither half of the failed creation was kept.
    expect(database.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT count(*) AS count FROM threads').get()).toEqual({ count: 1 })

    fail = false
    commits.mockClear()
    const created = ProofResponseSchemas['session.create'].parse(create('create-2'))
    expect(commits).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls.map(([record]) => record.event.name)).toEqual([
      'session.created',
      'thread.created',
    ])
    expect(
      database
        .prepare('SELECT count(*) AS count FROM threads WHERE session_id = ?')
        .get(created.payload.session.sessionId),
    ).toEqual({ count: 1 })
    await vi.waitFor(() => expect(runtime.ensureSession).toHaveBeenCalledTimes(1))
  })
})

describe('durable turn activity', () => {
  it('keeps reasoning, tool calls and their order with the messages of a turn', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const at = (second: number) => `2026-09-10T10:00:0${second}.000Z`
    const reasoning = (
      eventId: string,
      messageId: string,
      text: string,
      phase: 'delta' | 'stop' = 'delta',
      tokens?: number,
    ) =>
      ProofEventSchemas['message.reasoning'].parse({
        type: 'event',
        name: 'message.reasoning',
        eventId,
        timestamp: at(1),
        scope,
        payload: {
          messageId,
          turnId: 'turn-1',
          phase,
          content: { type: 'text', text },
          ...(tokens === undefined ? {} : { tokens }),
        },
      })
    const tool = (eventId: string, patch: Record<string, unknown>) =>
      ProofEventSchemas['tool.updated'].parse({
        type: 'event',
        name: 'tool.updated',
        eventId,
        timestamp: at(1),
        scope,
        payload: { toolCallId: 'tool-1', turnId: 'turn-1', ...patch },
      })
    const text = (eventId: string, messageId: string, value: string) =>
      ProofEventSchemas['message.delta'].parse({
        ...delta(value, eventId),
        payload: { ...delta(value, eventId).payload, messageId },
      })

    repository.appendEvents(scope, [
      started(),
      reasoning('r1', 'thought-1', 'Plan the', 'delta', 3),
      reasoning('r2', 'thought-1', ' change', 'delta', 7),
      text('t1', 'text-1', 'Looking'),
      text('t2', 'text-1', ' closer'),
      tool('c1', { title: 'Read file', kind: 'read', status: 'in_progress' }),
      tool('c2', { status: 'completed' }),
      reasoning('r3', 'thought-2', 'Check', 'delta'),
      reasoning('r4', 'thought-2', '', 'stop'),
      text('t3', 'text-2', 'Found it'),
      completed(),
    ])

    const page = listSessionHistory(database, { sessionId: 'session-1', threadId: 'thread-1' })!
    expect(page.order.map((ref) => `${ref.kind}:${ref.id}`)).toEqual([
      'message:message-user',
      'reasoning:thought-1',
      'message:text-1',
      'tool:tool-1',
      'reasoning:thought-2',
      'message:text-2',
    ])
    // Text within a run merges; the token estimate keeps its highest reading.
    expect(page.reasoning).toEqual([
      {
        messageId: 'thought-1',
        turnId: 'turn-1',
        phase: 'delta',
        content: [{ type: 'text', text: 'Plan the change' }],
        tokens: 7,
      },
      {
        messageId: 'thought-2',
        turnId: 'turn-1',
        phase: 'stop',
        content: [{ type: 'text', text: 'Check' }],
      },
    ])
    // A later update revises status and forgets nothing the first one said.
    expect(page.tools).toEqual([
      {
        toolCallId: 'tool-1',
        turnId: 'turn-1',
        title: 'Read file',
        kind: 'read',
        status: 'completed',
      },
    ])
    expect(page.messages.map((message) => message.messageId)).toEqual([
      'message-user',
      'text-1',
      'text-2',
    ])
    expect(page.turns).toEqual([
      {
        turnId: 'turn-1',
        threadId: 'thread-1',
        state: 'completed',
        startedAt: at(0),
        finishedAt: at(2),
      },
    ])

    // Pages partition activity by where it happened: the newest page carries
    // what came after its oldest message's predecessor, the older page the rest,
    // so prepending the older page restores the exact interleaving.
    const newest = listSessionHistory(database, {
      sessionId: 'session-1',
      threadId: 'thread-1',
      limit: 1,
    })!
    expect(newest.messages.map((message) => message.messageId)).toEqual(['text-2'])
    expect(newest.order.map((ref) => ref.id)).toEqual(['tool-1', 'thought-2', 'text-2'])
    const older = listSessionHistory(database, {
      sessionId: 'session-1',
      threadId: 'thread-1',
      cursor: newest.nextCursor!,
      limit: 5,
    })!
    expect(older.order.map((ref) => ref.id)).toEqual(['message-user', 'thought-1', 'text-1'])
    expect([...older.order, ...newest.order].map((ref) => ref.id)).toEqual(
      page.order.map((ref) => ref.id),
    )

    // Activity of a turn the thread no longer has goes with it.
    const foreign = createOtherThread(database)
    expect(() =>
      repository.appendEvents(foreign, [{ ...reasoning('r9', 'thought-9', 'x'), scope: foreign }]),
    ).toThrow(/missing turn/)
  })

  it('elides the oldest reasoning text once a page exceeds its budget', async () => {
    const { database } = await createDatabase()
    const repository = createEventRepository(database)
    const big = 'x'.repeat(200 * 1024)
    const thought = (eventId: string, messageId: string) =>
      ProofEventSchemas['message.reasoning'].parse({
        type: 'event',
        name: 'message.reasoning',
        eventId,
        timestamp: '2026-09-10T10:00:01.000Z',
        scope,
        payload: {
          messageId,
          turnId: 'turn-1',
          phase: 'stop',
          content: { type: 'text', text: big },
          tokens: 50_000,
        },
      })
    repository.appendEvents(scope, [
      started(),
      thought('r1', 'thought-1'),
      thought('r2', 'thought-2'),
      thought('r3', 'thought-3'),
      delta('done', 't1'),
      completed(),
    ])
    const page = listSessionHistory(database, { sessionId: 'session-1', threadId: 'thread-1' })!
    // 600 KiB of thinking against a 384 KiB budget: the newest block stays
    // whole, the one before it keeps the tail that still fits behind a note of
    // what was left out, the oldest keeps the note alone. Tokens survive on all.
    expect(page.reasoning.map((block) => block.messageId)).toEqual([
      'thought-1',
      'thought-2',
      'thought-3',
    ])
    expect(page.reasoning[2]?.content).toEqual([{ type: 'text', text: big }])
    const middle = page.reasoning[1]?.content[0]
    const middleText = middle?.type === 'text' ? middle.text : ''
    expect(middleText).toMatch(/^\[\d+ characters of thinking not loaded\]\nx+$/)
    expect(middleText.length).toBeGreaterThan(100 * 1024)
    expect(middleText.length).toBeLessThan(big.length)
    // The oldest block gets whatever the middle one left: the note, perhaps a short tail.
    const oldest = page.reasoning[0]?.content[0]
    const oldestText = oldest?.type === 'text' ? oldest.text : ''
    expect(oldestText).toMatch(/^\[\d+ characters of thinking not loaded\](\nx+)?$/)
    expect(oldestText.length).toBeLessThan(middleText.length)
    expect(page.reasoning.every((block) => block.tokens === 50_000)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024)

    // One block larger than the whole budget keeps its newest text, not a note alone.
    const huge = 'y'.repeat(500 * 1024)
    const other = createOtherThread(database)
    const otherStart = started('other-started')
    repository.appendEvents(other, [
      {
        ...otherStart,
        scope: other,
        payload: {
          turn: { turnId: 'turn-2', threadId: 'thread-2', state: 'running' },
          userMessage: {
            ...otherStart.payload.userMessage,
            messageId: 'other-user',
            threadId: 'thread-2',
            turnId: 'turn-2',
          },
        },
      },
      {
        ...thought('other-r1', 'thought-huge'),
        scope: other,
        payload: {
          ...thought('other-r1', 'thought-huge').payload,
          turnId: 'turn-2',
          content: { type: 'text', text: huge },
        },
      },
      { ...completed('other-completed'), scope: other, payload: { turnId: 'turn-2' } },
    ])
    const otherPage = listSessionHistory(database, {
      sessionId: 'session-2',
      threadId: 'thread-2',
    })!
    const only = otherPage.reasoning[0]?.content[0]
    const onlyText = only?.type === 'text' ? only.text : ''
    expect(onlyText).toMatch(/^\[\d+ characters of thinking not loaded\]\ny+$/)
    expect(onlyText.length).toBeGreaterThan(300 * 1024)
    expect(Buffer.byteLength(JSON.stringify(otherPage))).toBeLessThan(512 * 1024)

    // Text that doubles when encoded (one newline per character) is budgeted
    // as the frame carries it, so the page still fits.
    const dense = 'z\n'.repeat(400 * 1024)
    repository.appendEvents(other, [
      {
        ...thought('other-r2', 'thought-dense'),
        scope: other,
        payload: {
          ...thought('other-r2', 'thought-dense').payload,
          turnId: 'turn-2',
          content: { type: 'text', text: dense },
        },
      },
    ])
    const densePage = listSessionHistory(database, {
      sessionId: 'session-2',
      threadId: 'thread-2',
    })!
    const denseBlock = densePage.reasoning.at(-1)?.content[0]
    const denseText = denseBlock?.type === 'text' ? denseBlock.text : ''
    expect(denseText).toMatch(/characters of thinking not loaded\]\n\n?(z\n)+$/)
    expect(Buffer.byteLength(JSON.stringify(densePage.reasoning))).toBeLessThan(
      REASONING_TEXT_BUDGET_BYTES + 1024,
    )
  })

  it('backfills the activity of turns that happened before the table existed', async () => {
    const { database, directory } = await createDatabase()
    const repository = createEventRepository(database)
    const reasoning = (eventId: string, text: string) =>
      ProofEventSchemas['message.reasoning'].parse({
        type: 'event',
        name: 'message.reasoning',
        eventId,
        timestamp: '2026-09-10T10:00:01.000Z',
        scope,
        payload: {
          messageId: 'thought-1',
          turnId: 'turn-1',
          phase: 'delta',
          content: { type: 'text', text },
        },
      })
    const tool = (eventId: string, status: 'in_progress' | 'completed') =>
      ProofEventSchemas['tool.updated'].parse({
        type: 'event',
        name: 'tool.updated',
        eventId,
        timestamp: '2026-09-10T10:00:01.000Z',
        scope,
        payload: { toolCallId: 'tool-1', turnId: 'turn-1', title: 'Read file', status },
      })
    repository.appendEvents(scope, [
      started(),
      delta('Looking', 't1'),
      tool('c1', 'in_progress'),
      tool('c2', 'completed'),
      reasoning('r1', 'Check'),
      reasoning('r2', ' again'),
      delta(' done', 't2'),
      completed(),
    ])
    // A v10 database: the same event log and dense message ordinals, no activity rows.
    database.exec(`
      DELETE FROM turn_activity;
      UPDATE messages SET ordinal = 0 WHERE message_id = 'message-user';
      UPDATE messages SET ordinal = 1 WHERE message_id = 'message-assistant';
      UPDATE schema_version SET version = 10;
      PRAGMA user_version = 10;
    `)
    database.close()
    databases.splice(databases.indexOf(database), 1)

    const upgraded = openEnvironmentDatabase(directory)
    databases.push(upgraded)
    const page = listSessionHistory(upgraded, { sessionId: 'session-1', threadId: 'thread-1' })!
    // Rows are back, folded as the projector would have; the turn reads as it
    // did before the table existed: thoughts, then tools, then its text.
    expect(page.tools).toEqual([
      { toolCallId: 'tool-1', turnId: 'turn-1', title: 'Read file', status: 'completed' },
    ])
    expect(page.reasoning).toEqual([
      {
        messageId: 'thought-1',
        turnId: 'turn-1',
        phase: 'delta',
        content: [{ type: 'text', text: 'Check again' }],
      },
    ])
    expect(page.order.map((ref) => ref.id)).toEqual([
      'message-user',
      'tool-1',
      'thought-1',
      'message-assistant',
    ])
    expect(page.messages.map((message) => message.messageId)).toEqual([
      'message-user',
      'message-assistant',
    ])
    // Message ordinals are untouched, so a cursor held across the upgrade still
    // pages, and the next live entry takes the integer above the fractions.
    expect(
      upgraded.prepare('SELECT message_id, ordinal FROM messages ORDER BY ordinal').all(),
    ).toEqual([
      { message_id: 'message-user', ordinal: 0 },
      { message_id: 'message-assistant', ordinal: 1 },
    ])
    expect(
      listSessionHistory(upgraded, {
        sessionId: 'session-1',
        threadId: 'thread-1',
        cursor: { ordinal: 1 },
      })!.messages.map((message) => message.messageId),
    ).toEqual(['message-user'])
    expect(upgraded.prepare('SELECT ordinal FROM turn_activity ORDER BY ordinal').all()).toEqual([
      { ordinal: 1 / 3 },
      { ordinal: 2 / 3 },
    ])
    createEventRepository(upgraded).appendEvents(scope, [
      ProofEventSchemas['message.delta'].parse({
        ...delta('later', 'later-delta'),
        payload: { ...delta('later', 'later-delta').payload, messageId: 'later' },
      }),
    ])
    expect(
      upgraded.prepare("SELECT ordinal FROM messages WHERE message_id = 'later'").get(),
    ).toEqual({ ordinal: 2 })
    // Running the backfill again changes nothing.
    upgraded.exec('UPDATE schema_version SET version = 10; PRAGMA user_version = 10;')
    upgraded.close()
    databases.splice(databases.indexOf(upgraded), 1)
    const again = openEnvironmentDatabase(directory)
    databases.push(again)
    expect(
      listSessionHistory(again, { sessionId: 'session-1', threadId: 'thread-1' })!.order,
    ).toEqual([...page.order, { kind: 'message', id: 'later', turnId: 'turn-1' }])
  })
})
