import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decideReplay, ProofEventSchemas, type SubscriptionScope } from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository } from '../src/db/event-repository.js'
import {
  DEFAULT_EVENT_RETENTION_WINDOW_MS,
  DEFAULT_MAX_EVENTS_PER_SCOPE,
  createEventRetention,
} from '../src/db/event-retention.js'
import { EVENTS_AFTER_CURSOR_SQL, STREAM_BOUNDS_SQL } from '../src/db/queries.js'

const directories: string[] = []
const databases: DatabaseSync[] = []

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-09-01T00:00:00.000Z')

const environmentScope = { type: 'environment', environmentId: 'environment-1' } as const
const sessionScope = {
  type: 'session',
  environmentId: 'environment-1',
  sessionId: 'session-1',
} as const

async function createDatabase(): Promise<DatabaseSync> {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-retention-test-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
    INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
    VALUES ('session-1', 'workspace-1', 'cursor', 'idle', 1, 1);
  `)
  return database
}

/**
 * A durable event numbered `index` in its scope, stamped at `at`. Environment
 * scope uses a title update; session scope creates thread `thread-<index>`.
 */
function durable(scope: SubscriptionScope, index: number, at: number) {
  const base = {
    type: 'event',
    eventId: `${scope.type}-event-${index}`,
    timestamp: new Date(at).toISOString(),
    scope,
  }
  if (scope.type === 'environment') {
    return ProofEventSchemas['session.updated'].parse({
      ...base,
      name: 'session.updated',
      payload: { sessionId: 'session-1', title: `Title ${index}` },
    })
  }
  if (scope.type === 'session') {
    return ProofEventSchemas['thread.created'].parse({
      ...base,
      name: 'thread.created',
      payload: { thread: { threadId: `thread-${index}`, sessionId: scope.sessionId } },
    })
  }
  throw new Error('Thread-scoped seeding is not needed by these tests')
}

function seed(
  database: DatabaseSync,
  scope: SubscriptionScope,
  count: number,
  startAt: number,
  stepMs: number,
  firstIndex = 1,
) {
  const repository = createEventRepository(database, { epoch: 'epoch-1', now: () => startAt })
  for (let offset = 0; offset < count; offset += 1) {
    repository.appendEvents(scope, [
      durable(scope, firstIndex + offset, startAt + offset * stepMs),
    ])
  }
  return repository
}

function bounds(database: DatabaseSync, scope: SubscriptionScope) {
  return database.prepare(STREAM_BOUNDS_SQL).get(scopeKey(scope)) as {
    epoch: string
    head_sequence: number
    oldest_sequence: number | null
  }
}

function sequences(database: DatabaseSync, scope: SubscriptionScope, after = 0): number[] {
  return database
    .prepare(EVENTS_AFTER_CURSOR_SQL)
    .all(scopeKey(scope), after, 1000)
    .map((row) => (row as { sequence: number }).sequence)
}

function scopeKey(scope: SubscriptionScope): string {
  switch (scope.type) {
    case 'environment':
      return JSON.stringify([scope.type, scope.environmentId])
    case 'session':
      return JSON.stringify([scope.type, scope.environmentId, scope.sessionId])
    case 'thread':
      return JSON.stringify([scope.type, scope.environmentId, scope.sessionId, scope.threadId])
  }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('event retention', () => {
  it('defaults to a seven-day window and a ten-thousand event cap per scope', async () => {
    const retention = createEventRetention(await createDatabase())
    expect(retention.policy).toEqual({
      windowMs: DEFAULT_EVENT_RETENTION_WINDOW_MS,
      maxEventsPerScope: DEFAULT_MAX_EVENTS_PER_SCOPE,
    })
    expect(DEFAULT_EVENT_RETENTION_WINDOW_MS).toBe(7 * DAY)
    expect(DEFAULT_MAX_EVENTS_PER_SCOPE).toBe(10_000)
  })

  it('prunes events older than the window and moves the retention boundary', async () => {
    const database = await createDatabase()
    seed(database, sessionScope, 6, T0, DAY)
    const retention = createEventRetention(database, {
      windowMs: 2 * DAY,
      now: () => T0 + 5 * DAY + HOUR,
    })

    const report = retention.prune()

    // Events 1..4 are older than now - 2d; events 5 and 6 remain.
    expect(report).toEqual({
      at: T0 + 5 * DAY + HOUR,
      deleted: 4,
      streams: [{ scopeKey: scopeKey(sessionScope), oldestSequence: 5 }],
    })
    expect(sequences(database, sessionScope)).toEqual([5, 6])
    expect(bounds(database, sessionScope)).toEqual({
      epoch: 'epoch-1',
      head_sequence: 6,
      oldest_sequence: 5,
    })
  })

  it('never prunes an in-window event that sorts below an expired one', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database, { epoch: 'epoch-1', now: () => T0 })
    // Sequence 1 is young, 2 is old, 3 is young, 4 is old, 5 is young.
    const stamps = [T0 + 10 * DAY, T0, T0 + 10 * DAY, T0, T0 + 10 * DAY]
    stamps.forEach((at, index) => {
      repository.appendEvents(sessionScope, [durable(sessionScope, index + 1, at)])
    })
    const retention = createEventRetention(database, {
      windowMs: 2 * DAY,
      now: () => T0 + 10 * DAY + HOUR,
    })

    // Sequence 1 is still inside the window, so nothing below it can go.
    expect(retention.prune()).toEqual({ at: T0 + 10 * DAY + HOUR, deleted: 0, streams: [] })
    expect(sequences(database, sessionScope)).toEqual([1, 2, 3, 4, 5])

    // Once sequence 1 is gone, the boundary stops at the next in-window row (3).
    database.prepare('DELETE FROM event_log WHERE scope_key = ? AND sequence = 1').run(
      scopeKey(sessionScope),
    )
    database
      .prepare('UPDATE event_streams SET oldest_sequence = 2 WHERE scope_key = ?')
      .run(scopeKey(sessionScope))
    expect(retention.prune()).toEqual({
      at: T0 + 10 * DAY + HOUR,
      deleted: 1,
      streams: [{ scopeKey: scopeKey(sessionScope), oldestSequence: 3 }],
    })
    expect(sequences(database, sessionScope)).toEqual([3, 4, 5])
  })

  it('caps each scope at the newest N events regardless of age', async () => {
    const database = await createDatabase()
    seed(database, sessionScope, 10, T0, 1)
    seed(database, environmentScope, 3, T0, 1)
    const retention = createEventRetention(database, {
      windowMs: 365 * DAY,
      maxEventsPerScope: 4,
      now: () => T0 + HOUR,
    })

    const report = retention.prune()

    expect(report.deleted).toBe(6)
    expect(report.streams).toEqual([{ scopeKey: scopeKey(sessionScope), oldestSequence: 7 }])
    expect(sequences(database, sessionScope)).toEqual([7, 8, 9, 10])
    expect(sequences(database, environmentScope)).toEqual([1, 2, 3])
    expect(bounds(database, environmentScope).oldest_sequence).toBe(1)
  })

  it('leaves a stream with nothing retained and lets appends continue the sequence', async () => {
    const database = await createDatabase()
    const repository = seed(database, sessionScope, 3, T0, 1)
    const clock = { now: T0 + 30 * DAY }
    const retention = createEventRetention(database, { windowMs: 7 * DAY, now: () => clock.now })

    expect(retention.prune()).toEqual({
      at: clock.now,
      deleted: 3,
      streams: [{ scopeKey: scopeKey(sessionScope), oldestSequence: null }],
    })
    expect(bounds(database, sessionScope)).toEqual({
      epoch: 'epoch-1',
      head_sequence: 3,
      oldest_sequence: null,
    })
    // A second pass finds nothing to do and does not touch the stream.
    expect(retention.prune().streams).toEqual([])

    const [record] = repository.appendEvents(sessionScope, [durable(sessionScope, 4, clock.now)])
    expect(record?.cursor.sequence).toBe(4)
    expect(bounds(database, sessionScope)).toEqual({
      epoch: 'epoch-1',
      head_sequence: 4,
      oldest_sequence: 4,
    })
  })

  it('forces snapshot fallback only for cursors that fell behind the retained range', async () => {
    const database = await createDatabase()
    seed(database, sessionScope, 6, T0, DAY)
    createEventRetention(database, { windowMs: 2 * DAY, now: () => T0 + 5 * DAY + HOUR }).prune()

    const stream = bounds(database, sessionScope)
    const head = { scope: sessionScope, epoch: stream.epoch, sequence: stream.head_sequence }
    const decide = (sequence: number) =>
      decideReplay(
        sessionScope,
        { scope: sessionScope, epoch: 'epoch-1', sequence },
        head,
        stream.oldest_sequence,
      )

    expect(decide(3)).toEqual({ mode: 'snapshot', reason: 'gap_expired' })
    expect(decide(4)).toEqual({ mode: 'replay' })
    expect(sequences(database, sessionScope, 4)).toEqual([5, 6])
    expect(decide(6)).toEqual({ mode: 'replay' })
  })

  it('does not delete projected history rows or domain records', async () => {
    const database = await createDatabase()
    seed(database, sessionScope, 3, T0, 1)
    seed(database, environmentScope, 2, T0, 1)
    database.exec(`
      INSERT INTO turns (turn_id, thread_id, workspace_id, state, started_at, updated_at)
      VALUES ('turn-1', 'thread-1', 'workspace-1', 'completed', 1, 1);
      INSERT INTO messages (
        message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final, created_at, updated_at
      ) VALUES ('message-1', 'workspace-1', 'thread-1', 'turn-1', 'assistant', 0, 1, 1, 1);
      INSERT INTO message_parts (
        part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
      ) VALUES ('part-1', 'message-1', 0, 'text', '{"type":"text","text":"kept"}', 1, 1);
    `)

    createEventRetention(database, { windowMs: 0, now: () => T0 + DAY }).prune()

    expect(sequences(database, sessionScope)).toEqual([])
    expect(sequences(database, environmentScope)).toEqual([])
    const counts = Object.fromEntries(
      ['sessions', 'threads', 'turns', 'messages', 'message_parts'].map((table) => [
        table,
        (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
          .count,
      ]),
    )
    expect(counts).toEqual({ sessions: 1, threads: 3, turns: 1, messages: 1, message_parts: 1 })
    expect(database.prepare('SELECT title FROM sessions').get()).toEqual({ title: 'Title 2' })
  })

  it('rolls back the whole pass when a step fails', async () => {
    const database = await createDatabase()
    seed(database, sessionScope, 3, T0, 1)
    const retention = createEventRetention(database, { windowMs: 0, now: () => T0 + DAY })
    database.exec(`
      CREATE TRIGGER block_oldest BEFORE UPDATE OF oldest_sequence ON event_streams
      BEGIN SELECT RAISE(ABORT, 'blocked'); END
    `)

    expect(() => retention.prune()).toThrow(/blocked/)
    expect(sequences(database, sessionScope)).toEqual([1, 2, 3])
    expect(bounds(database, sessionScope).oldest_sequence).toBe(1)
    expect(() => database.exec('BEGIN IMMEDIATE; ROLLBACK')).not.toThrow()
  })

  it('runs on a schedule until stopped and reports failures without throwing', async () => {
    vi.useFakeTimers()
    const database = await createDatabase()
    seed(database, sessionScope, 3, T0, 1)
    const onError = vi.fn()
    const retention = createEventRetention(database, { windowMs: 0, now: () => T0 + DAY })

    const stop = retention.schedule({ intervalMs: 1000, onError })
    expect(sequences(database, sessionScope)).toEqual([1, 2, 3])
    vi.advanceTimersByTime(1000)
    expect(sequences(database, sessionScope)).toEqual([])
    expect(onError).not.toHaveBeenCalled()

    seed(database, sessionScope, 1, T0, 1, 4)
    database.exec(`
      CREATE TRIGGER block_delete BEFORE DELETE ON event_log
      BEGIN SELECT RAISE(ABORT, 'blocked'); END
    `)
    vi.advanceTimersByTime(1000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String((onError.mock.calls[0] as unknown[])[0])).toMatch(/blocked/)

    stop()
    database.exec('DROP TRIGGER block_delete')
    vi.advanceTimersByTime(5000)
    expect(sequences(database, sessionScope)).toEqual([4])
  })

  it('rejects invalid policies and intervals', async () => {
    const database = await createDatabase()
    expect(() => createEventRetention(database, { windowMs: -1 })).toThrow(/retention window/)
    expect(() => createEventRetention(database, { maxEventsPerScope: 1.5 })).toThrow(
      /retention cap/,
    )
    expect(() => createEventRetention(database).schedule({ intervalMs: 0 })).toThrow(
      /prune interval/,
    )
  })
})
