import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProofEventSchemas,
  ReplayCursorError,
  type Cursor,
  type ProofEvent,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository } from '../src/db/event-repository.js'
import { createEventRetention } from '../src/db/event-retention.js'
import { createReplayReader } from '../src/db/replay.js'

const directories: string[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const T0 = Date.parse('2026-09-01T00:00:00.000Z')
const environmentScope = { type: 'environment', environmentId: 'environment-1' } as const
const sessionScope = { ...environmentScope, type: 'session', sessionId: 'session-1' } as const
const threadScope = { ...sessionScope, type: 'thread', threadId: 'thread-1' } as const
const environment = { environmentId: 'environment-1', name: 'Local' }
const workspace = {
  workspaceId: 'workspace-1',
  name: 'Workspace',
  path: '/workspace',
  lastUsedAt: null,
  lastActivityAt: null,
  exists: true,
  availability: 'available' as const,
  capabilities: { git: false, providers: [] },
}

async function createDatabase(): Promise<DatabaseSync> {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-replay-test-'))
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

const started = (index: number, at = T0): ProofEvent =>
  ProofEventSchemas['turn.started'].parse({
    type: 'event',
    name: 'turn.started',
    eventId: `started-${index}`,
    timestamp: new Date(at).toISOString(),
    scope: threadScope,
    payload: {
      turn: { turnId: `turn-${index}`, threadId: 'thread-1', state: 'running' },
      userMessage: {
        messageId: `user-${index}`,
        threadId: 'thread-1',
        turnId: `turn-${index}`,
        role: 'user',
        content: [{ type: 'text', text: `prompt ${index}` }],
      },
    },
  })

const delta = (index: number, text: string, at = T0): ProofEvent =>
  ProofEventSchemas['message.delta'].parse({
    type: 'event',
    name: 'message.delta',
    eventId: `delta-${index}-${text}`,
    timestamp: new Date(at).toISOString(),
    scope: threadScope,
    payload: {
      messageId: `assistant-${index}`,
      turnId: `turn-${index}`,
      role: 'assistant',
      content: { type: 'text', text },
    },
  })

const completed = (index: number, at = T0): ProofEvent =>
  ProofEventSchemas['turn.completed'].parse({
    type: 'event',
    name: 'turn.completed',
    eventId: `completed-${index}`,
    timestamp: new Date(at).toISOString(),
    scope: threadScope,
    payload: { turnId: `turn-${index}` },
  })

const titled = (index: number, at = T0): ProofEvent =>
  ProofEventSchemas['session.updated'].parse({
    type: 'event',
    name: 'session.updated',
    eventId: `title-${index}`,
    timestamp: new Date(at).toISOString(),
    scope: environmentScope,
    payload: { sessionId: 'session-1', title: `Title ${index}` },
  })

async function seeded(options: { limits?: { maxEvents?: number; maxBytes?: number } } = {}) {
  const database = await createDatabase()
  const repository = createEventRepository(database, { epoch: 'epoch-1', now: () => T0 })
  const reader = createReplayReader(database, {
    epoch: 'epoch-fresh',
    environment: () => environment,
    workspaces: () => [workspace],
    limits: options.limits,
  })
  const records = [
    ...repository.appendEvents(threadScope, [started(1), delta(1, 'Hel')]),
    ...repository.finalizeTurn(threadScope, [delta(1, 'lo'), completed(1)]),
  ]
  const at = (sequence: number): Cursor => ({ scope: threadScope, epoch: 'epoch-1', sequence })
  return { database, repository, reader, records, at }
}

describe('replay reader', () => {
  it('replays exactly the contiguous tail after a live cursor', async () => {
    const { reader, records, at } = await seeded()
    // The thread events are interleaved with the status broadcasts the
    // repository files on the environment scope; only the thread's own tail
    // is replayed, with the cursors it was committed under.
    const thread = records.filter((record) => record.cursor.scope.type === 'thread')
    expect(thread.map((record) => record.cursor.sequence)).toEqual([1, 2, 3, 4])

    const result = reader.read(threadScope, at(2))
    expect(result).toEqual({
      mode: 'replay',
      from: at(2),
      to: at(4),
      events: thread.slice(2),
    })
    // Up to date already: an empty range, not a snapshot.
    expect(reader.read(threadScope, at(4))).toEqual({
      mode: 'replay',
      from: at(4),
      to: at(4),
      events: [],
    })
  })

  it('answers a first subscription and a foreign epoch with a snapshot of the thread', async () => {
    const { reader, at } = await seeded()
    const initial = reader.read(threadScope, null)
    expect(initial).toMatchObject({
      mode: 'snapshot',
      reason: 'initial',
      snapshot: {
        cursor: at(4),
        state: {
          thread: { threadId: 'thread-1', sessionId: 'session-1' },
          turns: [{ turnId: 'turn-1', state: 'completed' }],
          messages: [
            { messageId: 'user-1', role: 'user' },
            {
              messageId: 'assistant-1',
              role: 'assistant',
              content: [{ type: 'text', text: 'Hello' }],
            },
          ],
          reasoning: [],
          tools: [],
          interactions: [],
        },
      },
    })
    expect(reader.read(threadScope, { ...at(2), epoch: 'epoch-from-another-life' })).toMatchObject({
      mode: 'snapshot',
      reason: 'stream_reset',
      snapshot: { cursor: at(4) },
    })
    expect(reader.read(threadScope, at(9))).toMatchObject({
      mode: 'snapshot',
      reason: 'cursor_ahead',
    })
  })

  it('snapshots when retention has pruned the gap', async () => {
    const { database, repository, reader, at } = await seeded()
    // A second turn, a week later, so the first one falls out of the window.
    const later = T0 + 8 * 24 * 60 * 60 * 1000
    repository.appendEvents(threadScope, [started(2, later)])
    createEventRetention(database, { now: () => later, windowMs: 24 * 60 * 60 * 1000 }).prune()

    // Sequence 4 was pruned but is the boundary's predecessor: still replayable.
    expect(reader.read(threadScope, at(4))).toMatchObject({
      mode: 'replay',
      events: [{ cursor: at(5), event: { name: 'turn.started' } }],
    })
    expect(reader.read(threadScope, at(2))).toMatchObject({
      mode: 'snapshot',
      reason: 'gap_expired',
      snapshot: { cursor: at(5), state: { turns: [{ turnId: 'turn-1' }, { turnId: 'turn-2' }] } },
    })
  })

  it('snapshots instead of carrying a tail over the event or byte budget', async () => {
    const byCount = await seeded({ limits: { maxEvents: 1 } })
    expect(byCount.reader.read(threadScope, byCount.at(1))).toMatchObject({
      mode: 'snapshot',
      reason: 'gap_expired',
    })
    expect(byCount.reader.read(threadScope, byCount.at(3))).toMatchObject({ mode: 'replay' })

    const byBytes = await seeded({ limits: { maxBytes: 200 } })
    expect(byBytes.reader.read(threadScope, byBytes.at(1))).toMatchObject({
      mode: 'snapshot',
      reason: 'gap_expired',
    })
  })

  it('snapshots environment and session scopes from the catalog', async () => {
    const { repository, reader } = await seeded()
    repository.appendEvents(environmentScope, [titled(1)])
    const environmentHead = reader.read(environmentScope, null)
    expect(environmentHead).toMatchObject({
      mode: 'snapshot',
      reason: 'initial',
      snapshot: {
        cursor: { scope: environmentScope, epoch: 'epoch-1' },
        state: {
          environment,
          workspaces: [workspace],
          sessions: [{ sessionId: 'session-1', title: 'Title 1', status: 'idle' }],
        },
      },
    })
    expect(reader.read(sessionScope, null)).toMatchObject({
      mode: 'snapshot',
      reason: 'initial',
      // No session-scoped event yet: the stream sits at zero of the fresh epoch.
      snapshot: {
        cursor: { scope: sessionScope, epoch: 'epoch-fresh', sequence: 0 },
        state: {
          session: { sessionId: 'session-1', workspaceId: 'workspace-1', title: 'Title 1' },
          threads: [{ threadId: 'thread-1', sessionId: 'session-1' }],
        },
      },
    })
  })

  it('reports a scope whose session or thread is gone, and refuses a cursor from another scope', async () => {
    const { database, reader, at } = await seeded()
    expect(reader.read({ ...threadScope, threadId: 'thread-9' }, null)).toEqual({ mode: 'missing' })
    expect(reader.read({ ...sessionScope, sessionId: 'session-9' }, null)).toEqual({
      mode: 'missing',
    })
    database.exec(`DELETE FROM sessions WHERE session_id = 'session-1'`)
    expect(reader.read(threadScope, at(2))).toEqual({ mode: 'missing' })
    expect(() =>
      reader.read(sessionScope, { scope: threadScope, epoch: 'epoch-1', sequence: 1 }),
    ).toThrow(ReplayCursorError)
  })
})
