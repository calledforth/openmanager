import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProofEventSchemas, type ProofEvent } from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventProjector } from '../src/db/event-projection.js'
import { createEventRepository, type DurableProofEvent } from '../src/db/event-repository.js'
import { listSessionHistory } from '../src/db/session-store.js'

/**
 * The end of a turn closes every child it left open, with its own event,
 * before the terminal and in its transaction (docs/sync-foundations.md §4.3, I3).
 */
const directories: string[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const scope = {
  type: 'thread',
  environmentId: 'environment-1',
  sessionId: 'session-1',
  threadId: 'thread-1',
} as const
const T = (second: number) => `2026-10-21T10:00:0${second}.000Z`

async function createDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-closure-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
    VALUES ('session-1', 'workspace-1', 'cursor', 'idle', 1, 1);
    INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
    VALUES ('thread-1', 'session-1', 'workspace-1', 1, 1);
  `)
  return database
}

const event = (name: ProofEvent['name'], eventId: string, payload: unknown, at = T(1)) =>
  (ProofEventSchemas[name] as { parse(input: unknown): DurableProofEvent }).parse({
    type: 'event',
    name,
    eventId,
    timestamp: at,
    scope,
    payload,
  })

/** A turn with an open tool, a finished tool, an open thought and two open requests. */
function openTurn() {
  return [
    event(
      'turn.started',
      'started',
      {
        turn: { turnId: 'turn-1', threadId: 'thread-1', state: 'running', startedAt: T(0) },
        userMessage: {
          messageId: 'user-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          role: 'user',
          content: [{ type: 'text', text: 'Go' }],
        },
      },
      T(0),
    ),
    event('tool.updated', 'tool-open', {
      toolCallId: 'tool-1',
      turnId: 'turn-1',
      status: 'in_progress',
    }),
    event('tool.updated', 'tool-done', {
      toolCallId: 'tool-2',
      turnId: 'turn-1',
      status: 'completed',
    }),
    event('message.reasoning', 'thought', {
      messageId: 'thought-1',
      turnId: 'turn-1',
      phase: 'delta',
      content: { type: 'text', text: 'Hmm' },
    }),
    event('interaction.requested', 'ask-1', {
      turnId: 'turn-1',
      turnState: 'waiting',
      interaction: {
        kind: 'question',
        interactionId: 'question-1',
        questions: [{ questionId: 'q', prompt: 'Which?', options: [] }],
      },
    }),
    event('interaction.requested', 'ask-2', {
      turnId: 'turn-1',
      turnState: 'waiting',
      interaction: {
        kind: 'permission',
        interactionId: 'permission-1',
        toolCall: { toolCallId: 'tool-1', title: 'Write' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    }),
  ]
}

describe('turn closure', () => {
  it('closes each open child with its own event before the terminal, in one transaction', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, openTurn())
    const terminal = event('turn.interrupted', 'stop', { turnId: 'turn-1', reason: 'user' }, T(2))
    const records = repository.finalizeTurn(scope, [terminal])

    const thread = records.filter((record) => record.cursor.scope.type === 'thread')
    expect(thread.map((record) => record.event.eventId)).toEqual([
      'stop:close:tool:tool-1',
      'stop:close:reasoning:thought-1',
      // Requests close oldest first; these two were raised together.
      'stop:close:interaction:permission-1',
      'stop:close:interaction:question-1',
      'stop',
    ])
    expect(thread.map((record) => record.event.payload)).toEqual([
      { toolCallId: 'tool-1', turnId: 'turn-1', status: 'cancelled' },
      { messageId: 'thought-1', turnId: 'turn-1', phase: 'stop' },
      {
        turnId: 'turn-1',
        turnState: 'waiting',
        response: {
          kind: 'permission',
          interactionId: 'permission-1',
          outcome: { outcome: 'cancelled', reason: 'turn_ended' },
        },
      },
      {
        turnId: 'turn-1',
        turnState: 'running',
        response: {
          kind: 'question',
          interactionId: 'question-1',
          outcome: { outcome: 'cancelled', reason: 'turn_ended' },
        },
      },
      { turnId: 'turn-1', reason: 'user' },
    ])
    // Cursors run on, one per event, and the status of the session is said once.
    expect(thread.map((record) => record.cursor.sequence)).toEqual([7, 8, 9, 10, 11])
    const status = records.filter((record) => record.cursor.scope.type === 'environment')
    expect(status.map((record) => record.event.payload)).toEqual([
      expect.objectContaining({ sessionId: 'session-1', status: 'idle' }),
    ])

    const page = listSessionHistory(database, { sessionId: 'session-1', threadId: 'thread-1' })!
    expect(page.tools.map((tool) => [tool.toolCallId, tool.status])).toEqual([
      ['tool-1', 'cancelled'],
      ['tool-2', 'completed'],
    ])
    expect(page.reasoning.map((thought) => thought.phase)).toEqual(['stop'])
    expect(page.interactions).toEqual([])
    expect(
      database.prepare('SELECT state FROM interactions ORDER BY interaction_id').all(),
    ).toEqual([{ state: 'cancelled' }, { state: 'cancelled' }])
  })

  it('a restart cancels what it cut off as server_restarted, and fails the session', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, openTurn())
    const records = repository.finalizeTurn(scope, [
      event('turn.interrupted', 'recover', { turnId: 'turn-1', reason: 'server_restarted' }, T(3)),
    ])
    const reasons = records
      .map((record) => record.event)
      .filter((item) => item.name === 'interaction.cancelled')
      .map(
        (item) =>
          (item.payload as { response: { outcome: { reason?: string } } }).response.outcome.reason,
      )
    expect(reasons).toEqual(['server_restarted', 'server_restarted'])
    expect(database.prepare('SELECT status FROM sessions').get()).toEqual({ status: 'error' })
    expect(database.prepare('SELECT interrupted_by FROM turns').get()).toEqual({
      interrupted_by: 'server_restarted',
    })
  })

  it('re-publishes the closes with their cursors when a written turn end is retried', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, openTurn())
    const terminal = event('turn.completed', 'done', { turnId: 'turn-1' }, T(2))
    const first = repository.finalizeTurn(scope, [terminal])
    const again = repository.finalizeTurn(scope, [terminal])
    expect(again).toEqual(first)
    // The turn, its five closes plus the terminal, and two status records.
    expect(database.prepare('SELECT count(*) AS n FROM event_log').get()).toEqual({
      n: openTurn().length + 5 + 2,
    })
  })

  it('closes nothing a batch already closed before its terminal', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, openTurn().slice(0, 4))
    const records = repository.finalizeTurn(scope, [
      event('tool.updated', 'tool-finish', {
        toolCallId: 'tool-1',
        turnId: 'turn-1',
        status: 'completed',
      }),
      event('message.reasoning', 'thought-stop', {
        messageId: 'thought-1',
        turnId: 'turn-1',
        phase: 'stop',
      }),
      event('turn.completed', 'done', { turnId: 'turn-1' }, T(2)),
    ])
    expect(
      records
        .filter((record) => record.cursor.scope.type === 'thread')
        .map((record) => record.event.eventId),
    ).toEqual(['tool-finish', 'thought-stop', 'done'])
  })

  it('refuses a terminal that would leave a child open (I3)', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scope, openTurn().slice(0, 2))
    // The projector alone, as a writer that skipped the closure would call it.
    const project = createEventProjector(database, { sessionProviderId: () => 'cursor' })
    expect(() => project(event('turn.completed', 'bare', { turnId: 'turn-1' }, T(2)))).toThrow(
      /cannot end with open children: tool tool-1/,
    )
  })
})
