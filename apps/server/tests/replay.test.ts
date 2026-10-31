import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EVENT_FORMAT_VERSION,
  ProofEventSchemas,
  ReplayCursorError,
  ReplayResponseSchema,
  type Cursor,
  type DurableEvent,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository, type DurableProofEvent } from '../src/db/event-repository.js'
import { createEventRetention } from '../src/db/event-retention.js'
import {
  answerPayloadJson,
  createReplayReader,
  digitsBetween,
  replayPayloadBytes,
  type ReplayResult,
} from '../src/db/replay.js'
import { raiseReplayFloors, storedEventFormat } from '../src/db/replay-floor.js'
import { findTurnByCommandId } from '../src/db/session-store.js'

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
  capabilities: { git: false },
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

const started = (index: number, at = T0): DurableProofEvent =>
  ProofEventSchemas['turn.started'].parse({
    type: 'event',
    name: 'turn.started',
    eventId: `started-${index}`,
    timestamp: new Date(at).toISOString(),
    scope: threadScope,
    payload: {
      turn: {
        turnId: `turn-${index}`,
        threadId: 'thread-1',
        state: 'running',
        startedAt: new Date(at).toISOString(),
      },
      userMessage: {
        messageId: `user-${index}`,
        threadId: 'thread-1',
        turnId: `turn-${index}`,
        role: 'user',
        content: [{ type: 'text', text: `prompt ${index}` }],
      },
    },
  })

const delta = (index: number, text: string, at = T0): DurableProofEvent =>
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

const completed = (index: number, at = T0): DurableProofEvent =>
  ProofEventSchemas['turn.completed'].parse({
    type: 'event',
    name: 'turn.completed',
    eventId: `completed-${index}`,
    timestamp: new Date(at).toISOString(),
    scope: threadScope,
    payload: { turnId: `turn-${index}` },
  })

const titled = (index: number, at = T0): DurableProofEvent =>
  ProofEventSchemas['session.updated'].parse({
    type: 'event',
    name: 'session.updated',
    eventId: `title-${index}`,
    timestamp: new Date(at).toISOString(),
    scope: environmentScope,
    payload: { sessionId: 'session-1', title: `Title ${index}` },
  })

/** A replay result's records, parsed from the stored JSON it carries. */
const eventsOf = (result: ReplayResult): DurableEvent[] =>
  result.mode === 'replay' ? (JSON.parse(`[${result.eventsJson}]`) as DurableEvent[]) : []

/** The answer a socket would send, parsed as the client parses it. */
const answerOf = (result: ReplayResult) => {
  if (result.mode === 'missing') throw new Error('missing')
  return ReplayResponseSchema.parse(
    JSON.parse(
      `{"type":"response","requestId":"r-1","payload":${answerPayloadJson(result, 'sub-1')}}`,
    ),
  )
}

/**
 * An earlier exchange, as rows only: it makes the thread's snapshot larger
 * than the short replays a test asks for, so the rule picks the replay.
 */
function padThread(database: DatabaseSync) {
  database.exec(`
    INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
    VALUES ('turn-0', 'thread-1', 'workspace-1', 'completed', 1, 1);
    INSERT INTO messages (message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final,
      created_at, updated_at)
    VALUES ('earlier', 'workspace-1', 'thread-1', 'turn-0', 'assistant', 0, 1, 1, 1);
    INSERT INTO message_parts (part_id, message_id, ordinal, part_type, content_json, created_at,
      updated_at)
    VALUES ('earlier-part', 'earlier', 0, 'text', '${JSON.stringify({ type: 'text', text: 'e'.repeat(20_000) })}', 1, 1);
  `)
}

async function seeded(options: { pad?: boolean } = {}) {
  const database = await createDatabase()
  const repository = createEventRepository(database, { epoch: 'epoch-1', now: () => T0 })
  const reader = createReplayReader(database, {
    epoch: 'epoch-fresh',
    environment: () => environment,
    workspaces: () => [workspace],
  })
  if (options.pad) padThread(database)
  const records = [
    ...repository.appendEvents(threadScope, [started(1), delta(1, 'Hel')]),
    ...repository.finalizeTurn(threadScope, [delta(1, 'lo'), completed(1)]),
  ]
  const at = (sequence: number): Cursor => ({ scope: threadScope, epoch: 'epoch-1', sequence })
  return { database, repository, reader, records, at }
}

describe('replay reader', () => {
  it('replays exactly the contiguous tail after a live cursor', async () => {
    const { reader, records, at } = await seeded({ pad: true })
    // The thread events are interleaved with the status broadcasts the
    // repository files on the environment scope; only the thread's own tail
    // is replayed, with the cursors it was committed under.
    const thread = records.filter((record) => record.cursor.scope.type === 'thread')
    expect(thread.map((record) => record.cursor.sequence)).toEqual([1, 2, 3, 4])

    const result = reader.read(threadScope, at(2))
    expect(result).toMatchObject({ mode: 'replay', from: at(2), to: at(4), count: 2 })
    expect(eventsOf(result)).toEqual(thread.slice(2))
    // The answer built from the stored JSON is a valid replay answer.
    expect(answerOf(result).payload).toMatchObject({ mode: 'replay', events: thread.slice(2) })
    // Up to date already: an empty range, not a snapshot.
    const empty = reader.read(threadScope, at(4))
    expect(empty).toMatchObject({ mode: 'replay', from: at(4), to: at(4), count: 0 })
    expect(eventsOf(empty)).toEqual([])
  })

  it('snapshots a still-running turn with its partial assistant text', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1', now: () => T0 })
    const reader = createReplayReader(database, {
      epoch: 'epoch-fresh',
      environment: () => environment,
      workspaces: () => [workspace],
    })
    repository.appendEvents(threadScope, [started(1), delta(1, 'Hel')])

    expect(reader.read(threadScope, null)).toMatchObject({
      mode: 'snapshot',
      reason: 'initial',
      snapshot: {
        cursor: { scope: threadScope, epoch: 'epoch-1', sequence: 2 },
        state: {
          thread: { threadId: 'thread-1', sessionId: 'session-1' },
          turns: [{ turnId: 'turn-1', state: 'running' }],
          messages: [
            { messageId: 'user-1', role: 'user' },
            {
              messageId: 'assistant-1',
              role: 'assistant',
              content: [{ type: 'text', text: 'Hel' }],
            },
          ],
        },
      },
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

  it('snapshots the whole thread, however long', async () => {
    const { repository, reader } = await seeded()
    for (let index = 2; index <= 61; index += 1) {
      repository.appendEvents(threadScope, [started(index), delta(index, `answer-${index}`)])
      repository.finalizeTurn(threadScope, [completed(index)])
    }
    const result = reader.read(threadScope, null)
    if (result.mode !== 'snapshot' || !('thread' in result.snapshot.state))
      throw new Error('Expected thread snapshot')
    const state = result.snapshot.state
    expect(state).not.toHaveProperty('nextCursor')
    const ids = state.messages.map((message) => message.messageId)
    expect(ids).toEqual(
      Array.from({ length: 61 }, (_, i) => [`user-${i + 1}`, `assistant-${i + 1}`]).flat(),
    )
    expect(state.order.map((ref) => ref.id)).toEqual(ids)
    expect(state.turns).toHaveLength(61)
    // The serialized snapshot is what the socket sends, and it parses back.
    expect(answerOf(result).payload).toMatchObject({ mode: 'snapshot', reason: 'initial' })
  })

  it('snapshots when retention has pruned the gap', async () => {
    const { database, repository, reader, at } = await seeded({ pad: true })
    // A second turn, a week later, so the first one falls out of the window.
    const later = T0 + 8 * 24 * 60 * 60 * 1000
    repository.appendEvents(threadScope, [started(2, later)])
    createEventRetention(database, { now: () => later, windowMs: 24 * 60 * 60 * 1000 }).prune()

    // Sequence 4 was pruned but is the boundary's predecessor: still replayable.
    const tail = reader.read(threadScope, at(4))
    expect(tail).toMatchObject({ mode: 'replay' })
    expect(eventsOf(tail)).toMatchObject([{ cursor: at(5), event: { name: 'turn.started' } }])
    expect(reader.read(threadScope, at(2))).toMatchObject({
      mode: 'snapshot',
      reason: 'gap_expired',
      snapshot: {
        cursor: at(5),
        state: { turns: [{ turnId: 'turn-0' }, { turnId: 'turn-1' }, { turnId: 'turn-2' }] },
      },
    })
  })

  it('replays any gap the log holds, however long, while the replay is not larger', async () => {
    const { repository, reader, at } = await seeded({ pad: true })
    for (let index = 2; index <= 400; index += 1) {
      repository.appendEvents(threadScope, [started(index), delta(index, `answer-${index}`)])
      repository.finalizeTurn(threadScope, [completed(index)])
    }
    // Nearly the whole thread since sequence 4: no cap turns it into a snapshot
    // while it is not larger than the snapshot.
    const result = reader.read(threadScope, at(1000))
    if (result.mode !== 'replay') throw new Error(`Expected a replay, got ${result.mode}`)
    expect(result.count).toBe(result.to.sequence - 1000)
    expect(result.count).toBeGreaterThan(150)
  })

  it('snapshots when the replay would be larger than the snapshot (snapshot_smaller)', async () => {
    const { repository, reader, at } = await seeded()
    // Many one-letter deltas into one message: each event costs far more than
    // the letter it adds to the snapshot.
    repository.appendEvents(threadScope, [started(2)])
    for (let index = 0; index < 300; index += 1) {
      repository.appendEvents(threadScope, [
        ProofEventSchemas['message.delta'].parse({ ...delta(2, 'x'), eventId: `letter-${index}` }),
      ])
    }
    const result = reader.read(threadScope, at(4))
    expect(result).toMatchObject({ mode: 'snapshot', reason: 'snapshot_smaller' })
    expect(answerOf(result).payload).toMatchObject({ reason: 'snapshot_smaller' })
  })

  it('sizes a replay exactly as the socket sends it, without building it', async () => {
    const { database, repository, reader, at } = await seeded({ pad: true })
    for (let index = 2; index <= 12; index += 1) {
      repository.appendEvents(threadScope, [started(index), delta(index, `réponse✓${index}`)])
      repository.finalizeTurn(threadScope, [completed(index)])
    }
    for (const from of [1, 3, 9, 30]) {
      const result = reader.read(threadScope, at(from))
      if (result.mode !== 'replay') throw new Error('Expected a replay')
      const { bytes, count } = database
        .prepare(
          `SELECT COALESCE(SUM(octet_length(event_json)), 0) AS bytes, COUNT(*) AS count
           FROM event_log WHERE scope_key = ? AND sequence > ?`,
        )
        .get(JSON.stringify(['thread', 'environment-1', 'session-1', 'thread-1']), from) as {
        bytes: number
        count: number
      }
      expect(count).toBe(result.count)
      const sent = Buffer.byteLength(
        answerPayloadJson(result, '00000000-0000-0000-0000-000000000000'),
      )
      expect(replayPayloadBytes(threadScope, result.from, result.to, bytes, count)).toBe(sent)
    }
    expect(digitsBetween(1, 9)).toBe(9)
    expect(digitsBetween(8, 12)).toBe(2 + 3 * 2)
    expect(digitsBetween(99, 101)).toBe(2 + 3 + 3)
  })

  it('bounds a thread snapshot from below by its stored parts and activity', async () => {
    const { database, reader } = await seeded()
    const result = reader.read(threadScope, null)
    if (result.mode !== 'snapshot') throw new Error('Expected a snapshot')
    const { bytes } = database
      .prepare(
        `SELECT (SELECT COALESCE(SUM(octet_length(p.content_json)), 0) FROM message_parts p
                 JOIN messages m ON m.message_id = p.message_id WHERE m.thread_id = 'thread-1')
              + (SELECT COALESCE(SUM(octet_length(state_json)), 0) FROM turn_activity
                 WHERE thread_id = 'thread-1') AS bytes`,
      )
      .get() as { bytes: number }
    expect(bytes).toBeGreaterThan(0)
    expect(Buffer.byteLength(result.snapshotJson)).toBeGreaterThanOrEqual(bytes)
  })

  it('snapshots the whole environment: every session, preference and provider profile', async () => {
    const { database, reader } = await seeded()
    const composer = JSON.stringify({ configValues: { large: '界'.repeat(7_000) } })
    const insert = database.prepare(`INSERT INTO sessions
      (session_id, workspace_id, provider_id, status, composer_json, created_at, updated_at)
      VALUES (?, 'workspace-1', 'opencode', 'idle', ?, 1000, 1000)`)
    for (let i = 0; i < 130; i++) insert.run(`large-${i}`, composer)
    database.exec(`
      INSERT INTO workspace_composer_preferences
        (workspace_id, provider_id, model_id, revision, updated_at)
      VALUES ('workspace-1', 'opencode', 'model-a', 3, 1);
      INSERT INTO provider_profiles (provider_id, default_model_id, updated_at)
      VALUES ('opencode', 'model-a', 5);
    `)
    const result = reader.read(environmentScope, null)
    if (result.mode !== 'snapshot' || !('sessions' in result.snapshot.state))
      throw new Error('Expected environment snapshot')
    const state = result.snapshot.state
    expect(state.sessions).toHaveLength(131)
    expect(state.preferences).toEqual([
      {
        workspaceId: 'workspace-1',
        providerId: 'opencode',
        preference: { modelId: 'model-a' },
        revision: 3,
      },
    ])
    expect(state.providerProfiles).toMatchObject([
      { providerId: 'opencode', defaultModelId: 'model-a' },
    ])
    // Over 1 MiB, and nothing cut it.
    expect(Buffer.byteLength(result.snapshotJson)).toBeGreaterThan(1024 * 1024)
  })

  it('keeps what providers list off the sidebar: a chat has its own, a workspace shares items', async () => {
    const { database, reader, at } = await seeded({ pad: true })
    const commands = JSON.stringify([{ name: 'review', description: 'Review the diff' }])
    database.exec(`
      INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
        VALUES ('workspace-gone', 'gone', '/gone', 1, 1);
      INSERT INTO composer_listings (workspace_id, provider_id, commands_json, updated_at) VALUES
        ('workspace-1', 'opencode', '${commands}', 1000),
        ('workspace-1', 'cursor', '${commands}', 2000),
        ('workspace-gone', 'cursor', '${commands}', 3000);
      UPDATE threads SET listing_json = '{"availableCommands":${commands}}';
    `)
    const environmentSnapshot = reader.read(environmentScope, null)
    if (
      environmentSnapshot.mode !== 'snapshot' ||
      !('sessions' in environmentSnapshot.snapshot.state)
    )
      throw new Error('Expected environment snapshot')
    // The same command twice over, once on the wire; a workspace this
    // environment does not list is not stated.
    expect(environmentSnapshot.snapshot.state.listings).toEqual({
      commands: [{ name: 'review', description: 'Review the diff' }],
      configOptions: [],
      entries: [
        {
          workspaceId: 'workspace-1',
          providerId: 'cursor',
          commands: [0],
          updatedAt: new Date(2000).toISOString(),
        },
        {
          workspaceId: 'workspace-1',
          providerId: 'opencode',
          commands: [0],
          updatedAt: new Date(1000).toISOString(),
        },
      ],
    })

    const chat = reader.read(threadScope, null)
    if (chat.mode !== 'snapshot' || !('thread' in chat.snapshot.state))
      throw new Error('Expected thread snapshot')
    expect(chat.snapshot.state.listing).toEqual({
      availableCommands: [{ name: 'review', description: 'Review the diff' }],
    })
    expect(at(1).scope).toEqual(threadScope)
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

describe('the replay floor (docs/sync-foundations.md §4.7.7)', () => {
  const setup = async (options: { boot?: boolean } = {}) => {
    const database = await createDatabase()
    padThread(database)
    // A server raises the floors at boot, before it appends anything.
    if (options.boot) raiseReplayFloors(database)
    const repository = createEventRepository(database, { epoch: 'epoch-1' })
    const reader = createReplayReader(database, {
      epoch: 'epoch-1',
      environment: () => environment,
      workspaces: () => [workspace],
    })
    repository.appendEvents(threadScope, [started(1), delta(1, 'Hel')])
    repository.finalizeTurn(threadScope, [delta(1, 'lo'), completed(1)])
    const at = (sequence: number): Cursor => ({ scope: threadScope, epoch: 'epoch-1', sequence })
    return { database, repository, reader, at }
  }

  it('hides every event stored in an older format, once', async () => {
    const { database, repository, reader, at } = await setup()
    // A log written before the format record existed reads as format 1.
    database.exec('DELETE FROM event_format')
    expect(storedEventFormat(database)).toBe(1)
    expect(raiseReplayFloors(database)).toBeGreaterThan(0)
    expect(storedEventFormat(database)).toBe(EVENT_FORMAT_VERSION)
    expect(raiseReplayFloors(database)).toBe(0)

    // At the head: nothing to replay, and nothing is lost.
    expect(reader.read(threadScope, at(4))).toMatchObject({ mode: 'replay', count: 0 })
    // Below it: the stored events are not replayed; a snapshot replaces them.
    expect(reader.read(threadScope, at(1))).toMatchObject({
      mode: 'snapshot',
      reason: 'gap_expired',
    })

    // Events written after the floor replay as usual from the floor on.
    repository.appendEvents(threadScope, [started(2), delta(2, 'Again')])
    const replay = reader.read(threadScope, at(4))
    expect(replay).toMatchObject({ mode: 'replay' })
    expect(eventsOf(replay).map((record) => record.cursor.sequence)).toEqual([5, 6])
    expect(reader.read(threadScope, at(3))).toMatchObject({ mode: 'snapshot' })
  })

  it('leaves a log already in the current format alone', async () => {
    const { database, reader, at } = await setup({ boot: true })
    expect(raiseReplayFloors(database)).toBe(0)
    expect(reader.read(threadScope, at(1))).toMatchObject({ mode: 'replay' })
  })

  it('answers a retried send from the log with when the turn started', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1' })
    const event = started(1, T0 + 5)
    repository.appendEvents(threadScope, [
      { ...event, payload: { ...event.payload, commandId: 'command-1' } } as DurableProofEvent,
    ])
    expect(
      findTurnByCommandId(database, {
        sessionId: 'session-1',
        threadId: 'thread-1',
        commandId: 'command-1',
      })?.turn,
    ).toEqual({
      turnId: 'turn-1',
      threadId: 'thread-1',
      state: 'running',
      startedAt: new Date(T0 + 5).toISOString(),
      commandId: 'command-1',
    })
  })
})
