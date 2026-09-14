import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openEnvironmentDatabase } from '../src/db/database.js'
import {
  getSessionSummary,
  listSessionHistory,
  listSessionSummaries,
  listThreadsForSession,
  pageSessionSummaries,
  pageThreadMessages,
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
  },
) {
  database
    .prepare(
      `INSERT INTO sessions (
         session_id, workspace_id, provider_id, title, status, created_at, updated_at
       ) VALUES (?, 'workspace-1', ?, ?, ?, ?, ?)`,
    )
    .run(
      row.sessionId,
      row.providerId ?? 'opencode',
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
  it('returns an empty page when the environment has no sessions', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    expect(listSessionSummaries(database)).toEqual({ sessions: [], nextCursor: null })
    expect(listSessionSummaries(database, { workspaceId: 'workspace-1' })).toEqual({
      sessions: [],
      nextCursor: null,
    })
  })

  it('returns one page of summaries without threads or messages', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    seedSession(database, { sessionId: 'session-new', title: 'New', updatedAt: 2_000 })
    seedSession(database, { sessionId: 'session-old', title: 'Old', updatedAt: 1_000 })

    const page = listSessionSummaries(database, { limit: 50 })
    expect(page.nextCursor).toBeNull()
    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      'session-new',
      'session-old',
    ])
    expect(page.sessions[0]).toMatchObject({
      title: 'New',
      status: 'idle',
      workspaceId: 'workspace-1',
      providerId: 'opencode',
    })
    expect(page.sessions[0]).not.toHaveProperty('threads')
    expect(page.sessions[0]).not.toHaveProperty('messages')
  })

  it('pages newest-first with a keyset cursor', async () => {
    const database = await createDatabase()
    seedWorkspace(database)
    for (const index of [1, 2, 3, 4, 5]) {
      seedSession(database, {
        sessionId: `session-${index}`,
        title: `Session ${index}`,
        updatedAt: index * 1_000,
      })
    }

    const first = listSessionSummaries(database, { limit: 2 })
    expect(first.sessions.map((session) => session.sessionId)).toEqual(['session-5', 'session-4'])
    expect(first.nextCursor).toEqual({
      updatedAt: first.sessions[1]!.updatedAt,
      sessionId: 'session-4',
    })

    const second = listSessionSummaries(database, { cursor: first.nextCursor!, limit: 2 })
    expect(second.sessions.map((session) => session.sessionId)).toEqual(['session-3', 'session-2'])
    expect(second.nextCursor?.sessionId).toBe('session-2')

    const last = listSessionSummaries(database, { cursor: second.nextCursor!, limit: 2 })
    expect(last.sessions.map((session) => session.sessionId)).toEqual(['session-1'])
    expect(last.nextCursor).toBeNull()
  })
})

describe('session history pages', () => {
  it('opens a session as identities only, then pages history separately', async () => {
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
      insertPart.run(`part-${ordinal}`, `message-${ordinal}`, JSON.stringify({ type: 'text', text: `m${ordinal}` }))
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

    const newest = listSessionHistory(database, {
      sessionId: 'session-1',
      threadId: 'thread-1',
      limit: 2,
    })
    expect(newest?.messages.map((message) => message.messageId)).toEqual([
      'message-1',
      'message-2',
    ])
    expect(newest?.nextCursor).toEqual({ ordinal: 1 })
    expect(newest?.interactions).toEqual([
      {
        threadId: 'thread-1',
        interaction: expect.objectContaining({ interactionId: 'interaction-pending' }),
      },
    ])

    const older = listSessionHistory(database, {
      sessionId: 'session-1',
      threadId: 'thread-1',
      cursor: newest!.nextCursor!,
      limit: 2,
    })
    expect(older?.messages.map((message) => message.messageId)).toEqual(['message-0'])
    expect(older?.nextCursor).toBeNull()
  })
})

describe('in-memory pagination helpers', () => {
  const summaries = [1, 2, 3].map((index) => ({
    sessionId: `session-${index}`,
    workspaceId: 'workspace-1',
    title: `S${index}`,
    status: 'idle' as const,
    providerId: 'opencode',
    updatedAt: new Date(index * 1_000).toISOString(),
  }))

  it('covers empty, one-page and multi-page in-memory lists', () => {
    expect(pageSessionSummaries([], { limit: 2 })).toEqual({ sessions: [], nextCursor: null })
    expect(pageSessionSummaries(summaries, { limit: 10 }).nextCursor).toBeNull()
    const first = pageSessionSummaries(summaries, { limit: 2 })
    expect(first.sessions.map((session) => session.sessionId)).toEqual(['session-3', 'session-2'])
    const rest = pageSessionSummaries(summaries, { cursor: first.nextCursor!, limit: 2 })
    expect(rest.sessions.map((session) => session.sessionId)).toEqual(['session-1'])
    expect(rest.nextCursor).toBeNull()
  })

  it('pages an in-memory transcript backwards', () => {
    const messages = [0, 1, 2, 3].map((ordinal) => ({
      messageId: `m-${ordinal}`,
      threadId: 'thread-1',
      turnId: 'turn-1',
      role: 'user' as const,
      content: [{ type: 'text' as const, text: String(ordinal) }],
    }))
    const newest = pageThreadMessages(messages, { limit: 2 })
    expect(newest.messages.map((message) => message.messageId)).toEqual(['m-2', 'm-3'])
    expect(newest.nextCursor).toEqual({ ordinal: 2 })
    const older = pageThreadMessages(messages, { cursor: newest.nextCursor!, limit: 2 })
    expect(older.messages.map((message) => message.messageId)).toEqual(['m-0', 'm-1'])
    expect(older.nextCursor).toBeNull()
  })
})
