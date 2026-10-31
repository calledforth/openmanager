import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { reconcileAfterRestart } from '../src/db/boot-reconcile.js'
import { createEventRepository } from '../src/db/event-repository.js'
import {
  findSessionIdByProviderSession,
  getSessionSummary,
  listAllSessionSummaries,
  readThreadState,
  listThreadsForSession,
} from '../src/db/session-store.js'

const directories: string[] = []
const databases: DatabaseSync[] = []

async function createDatabase(): Promise<DatabaseSync> {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-session-store-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  return database
}

function seedWorkspace(database: DatabaseSync) {
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
  `)
}

function seedSession(
  database: DatabaseSync,
  row: {
    sessionId: string
    title: string
    updatedAt: number
    status?: string
    providerId?: string
    parentSessionId?: string
    providerSessionId?: string
  },
) {
  database
    .prepare(
      `INSERT INTO sessions (
         session_id, workspace_id, parent_session_id, provider_id, provider_session_id,
         title, status, created_at, updated_at
       ) VALUES (?, 'workspace-1', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.sessionId,
      row.parentSessionId ?? null,
      row.providerId ?? 'opencode',
      row.providerSessionId ?? null,
      row.title,
      row.status ?? 'idle',
      row.updatedAt,
      row.updatedAt,
    )
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('session summary list', () => {
  it('lists nothing when the environment has no sessions', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    expect(listAllSessionSummaries(database)).toEqual([])
  })

  it('lists every session newest first, as summaries without threads or messages', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    for (const index of [1, 2, 3, 4, 5]) {
      seedSession(database, {
        sessionId: `session-${index}`,
        title: `Session ${index}`,
        updatedAt: index * 1_000,
      })
    }
    const sessions = listAllSessionSummaries(database)
    expect(sessions.map((session) => session.sessionId)).toEqual([
      'session-5',
      'session-4',
      'session-3',
      'session-2',
      'session-1',
    ])
    expect(sessions[0]).toMatchObject({
      title: 'Session 5',
      status: 'idle',
      workspaceId: 'workspace-1',
      providerId: 'opencode',
    })
    expect(sessions[0]).not.toHaveProperty('threads')
    expect(sessions[0]).not.toHaveProperty('messages')
  })

  it('reports a parent session id only for the rows that have one', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    seedSession(database, { sessionId: 'session-parent', title: 'Parent', updatedAt: 2_000 })
    seedSession(database, {
      sessionId: 'session-child',
      title: 'Child',
      updatedAt: 1_000,
      parentSessionId: 'session-parent',
    })

    const sessions = listAllSessionSummaries(database)
    expect(sessions.map((session) => session.parentSessionId)).toEqual([
      undefined,
      'session-parent',
    ])
    expect(sessions[0]).not.toHaveProperty('parentSessionId')
    expect(getSessionSummary(database, 'session-child')).toMatchObject({
      parentSessionId: 'session-parent',
    })
    expect(getSessionSummary(database, 'session-parent')).not.toHaveProperty('parentSessionId')
  })
})

describe('provider session lookup', () => {
  it('finds the host session for a provider thread and misses on a different provider', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    seedSession(database, {
      sessionId: 'session-1',
      title: 'Chat',
      updatedAt: 1_000,
      providerSessionId: 'provider-abc',
    })
    seedSession(database, { sessionId: 'session-unstamped', title: 'New', updatedAt: 2_000 })

    expect(findSessionIdByProviderSession(database, 'opencode', 'provider-abc')).toBe('session-1')
    // A different provider, an unknown thread, and an unstamped row are all misses.
    expect(findSessionIdByProviderSession(database, 'claude', 'provider-abc')).toBeUndefined()
    expect(findSessionIdByProviderSession(database, 'opencode', 'provider-xyz')).toBeUndefined()
    expect(
      findSessionIdByProviderSession(database, 'opencode', 'session-unstamped'),
    ).toBeUndefined()
  })
})

describe('whole thread state', () => {
  it('opens a session as identities only, and reads its whole thread in one go', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    seedSession(database, { sessionId: 'session-1', title: 'Chat', updatedAt: 1_000 })
    database.exec(`
      INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
      VALUES ('thread-1', 'session-1', 'workspace-1', 1, 1);
      INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
      VALUES ('turn-1', 'thread-1', 'workspace-1', 'completed', 1, 1);
    `)
    const insertMessage = database.prepare(
      `INSERT INTO messages (
         message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final,
         created_at, updated_at
       ) VALUES (?, 'workspace-1', 'thread-1', 'turn-1', 'user', ?, 1, ?, ?)`,
    )
    const insertPart = database.prepare(
      `INSERT INTO message_parts (
         part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
       ) VALUES (?, ?, 0, 'text', ?, 1, 1)`,
    )
    for (const ordinal of [0, 1, 2]) {
      insertMessage.run(`message-${ordinal}`, ordinal, ordinal + 1, ordinal + 1)
      insertPart.run(
        `part-${ordinal}`,
        `message-${ordinal}`,
        JSON.stringify({ type: 'text', text: `m${ordinal}` }),
      )
    }
    const insertInteraction = database.prepare(
      `INSERT INTO interactions (
         interaction_id, turn_id, kind, state, request_json, created_at, updated_at
       ) VALUES (?, 'turn-1', 'permission', ?, ?, 1, 1)`,
    )
    for (const [interactionId, state] of [
      ['interaction-pending', 'pending'],
      ['interaction-resolved', 'resolved'],
    ]) {
      insertInteraction.run(
        interactionId,
        state,
        JSON.stringify({
          kind: 'permission',
          interactionId,
          toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
          options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
        }),
      )
    }

    expect(getSessionSummary(database, 'session-1')).toMatchObject({
      sessionId: 'session-1',
      title: 'Chat',
    })
    expect(listThreadsForSession(database, 'session-1')).toEqual([
      { threadId: 'thread-1', sessionId: 'session-1' },
    ])

    const thread = readThreadState(database, { sessionId: 'session-1', threadId: 'thread-1' })
    expect(thread?.messages.map((message) => message.messageId)).toEqual([
      'message-0',
      'message-1',
      'message-2',
    ])
    expect(thread?.order.map((ref) => ref.id)).toEqual(['message-0', 'message-1', 'message-2'])
    expect(thread?.interactions).toEqual([
      {
        turnId: 'turn-1',
        interaction: expect.objectContaining({ interactionId: 'interaction-pending' }),
      },
    ])
    expect(
      readThreadState(database, { sessionId: 'foreign', threadId: 'thread-1' }),
    ).toBeUndefined()
  })
})

describe('durable plans', () => {
  it('keeps pending, accepted, rejected and cancelled plans across reopening the database', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    seedSession(database, { sessionId: 'session-plans', title: 'Plans', updatedAt: 1 })
    database.exec(`
      INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
      VALUES ('thread-plans', 'session-plans', 'workspace-1', 1, 1);
      INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
      VALUES ('turn-plans', 'thread-plans', 'workspace-1', 'waiting', 1, 1);
    `)
    const insert = database.prepare(`INSERT INTO interactions
      (interaction_id, turn_id, kind, state, request_json, response_json, created_at, updated_at)
      VALUES (?, 'turn-plans', 'plan', ?, ?, ?, ?, 1)`)
    const outcomes = [
      undefined,
      { outcome: 'accepted' },
      { outcome: 'rejected', reason: 'needs tests' },
      undefined,
    ]
    for (const [i, state] of ['pending', 'resolved', 'resolved', 'cancelled'].entries()) {
      const interactionId = `plan-${i}`
      insert.run(
        interactionId,
        state,
        JSON.stringify({
          kind: 'plan',
          interactionId,
          markdown: `# Plan ${i}`,
          todos: [],
          continuation: i % 2 ? 'same_turn' : 'follow_up_turn',
        }),
        outcomes[i] ? JSON.stringify({ kind: 'plan', interactionId, outcome: outcomes[i] }) : null,
        i,
      )
    }
    const query = { sessionId: 'session-plans', threadId: 'thread-plans' }
    const thread = readThreadState(database, query)!
    // Only the pending plan is a request; settled plans are history the
    // transcript does not reopen.
    expect(thread.interactions.map((entry) => entry.interaction.interactionId)).toEqual(['plan-0'])
    database.close()
    databases.splice(databases.indexOf(database), 1)
    const reopened = openEnvironmentDatabase(directories.at(-1)!)
    databases.push(reopened)
    reconcileAfterRestart(reopened, createEventRepository(reopened), 'environment-1')
    expect(readThreadState(reopened, query)!.interactions).toEqual([])
    const states = reopened
      .prepare(`SELECT state FROM interactions WHERE turn_id = 'turn-plans' ORDER BY created_at`)
      .all() as Array<{ state: string }>
    expect(states.map((row) => row.state)).toEqual([
      'cancelled',
      'resolved',
      'resolved',
      'cancelled',
    ])
  })
})
