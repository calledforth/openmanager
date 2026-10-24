import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ProofEventSchemas, type DurableEvent, type ProofEvent } from '@openmanager/protocol/node'
import { reconcileAfterRestart } from '../src/db/boot-reconcile.js'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { createEventRepository, type DurableProofEvent } from '../src/db/event-repository.js'

/**
 * The boot reconcile (docs/sync-foundations.md §4.1, §4.2): recovery of the
 * turns the last process left open, then the legacy repair, all as events on
 * the streams a client already follows.
 */
const directories: string[] = []
const databases: DatabaseSync[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const ENV = 'environment-1'
const scopeOf = (thread: number) =>
  ({
    type: 'thread',
    environmentId: ENV,
    sessionId: `session-${thread}`,
    threadId: `thread-${thread}`,
  }) as const

async function createDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'openmanager-boot-reconcile-'))
  directories.push(directory)
  const database = openEnvironmentDatabase(directory)
  databases.push(database)
  database.exec(`
    INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
    VALUES ('workspace-1', 'Workspace', '/workspace', 1, 1);
  `)
  for (const thread of [1, 2]) {
    database.exec(`
      INSERT INTO sessions (session_id, workspace_id, provider_id, status, created_at, updated_at)
      VALUES ('session-${thread}', 'workspace-1', 'cursor', 'idle', 1, 1);
      INSERT INTO threads (thread_id, session_id, workspace_id, created_at, updated_at)
      VALUES ('thread-${thread}', 'session-${thread}', 'workspace-1', 1, 1);
    `)
  }
  return database
}

const event = (thread: number, name: ProofEvent['name'], eventId: string, payload: unknown) =>
  (ProofEventSchemas[name] as { parse(input: unknown): DurableProofEvent }).parse({
    type: 'event',
    name,
    eventId,
    timestamp: '2026-10-21T10:00:00.000Z',
    scope: scopeOf(thread),
    payload,
  })

/** A turn in thread `thread` with an open tool, an open thought and a pending question. */
const openTurn = (thread: number) => {
  const turnId = `turn-${thread}`
  return [
    event(thread, 'turn.started', `started-${thread}`, {
      turn: {
        turnId,
        threadId: `thread-${thread}`,
        state: 'running',
        startedAt: '2026-10-21T10:00:00.000Z',
      },
      userMessage: {
        messageId: `user-${thread}`,
        threadId: `thread-${thread}`,
        turnId,
        role: 'user',
        content: [{ type: 'text', text: 'Go' }],
      },
    }),
    event(thread, 'tool.updated', `tool-${thread}`, {
      toolCallId: `tool-${thread}`,
      turnId,
      status: 'in_progress',
    }),
    event(thread, 'message.reasoning', `thought-${thread}`, {
      messageId: `thought-${thread}`,
      turnId,
      phase: 'delta',
      content: { type: 'text', text: 'Hmm' },
    }),
    event(thread, 'interaction.requested', `ask-${thread}`, {
      turnId,
      turnState: 'waiting',
      interaction: {
        kind: 'question',
        interactionId: `question-${thread}`,
        questions: [{ questionId: 'q', prompt: 'Which?', options: [] }],
      },
    }),
  ]
}

describe('boot reconcile', () => {
  it('logs and skips a thread whose stored child cannot be read, and repairs the others', async () => {
    const database = await createDatabase()
    const before = createEventRepository(database, { epoch: 'epoch-before' })
    for (const thread of [1, 2]) {
      before.appendEvents(scopeOf(thread), openTurn(thread))
      before.finalizeTurn(scopeOf(thread), [
        event(thread, 'turn.completed', `done-${thread}`, { turnId: `turn-${thread}` }),
      ])
    }
    // Rows a server before F3 left behind: open children under ended turns,
    // one of them unreadable ('null' passes the column's json_valid check).
    database.exec(`
      UPDATE turn_activity SET state_json = json_set(state_json, '$.status', 'in_progress')
        WHERE kind = 'tool';
      UPDATE turn_activity SET state_json = json_set(state_json, '$.phase', 'delta')
        WHERE kind = 'reasoning';
      UPDATE turn_activity SET state_json = 'null' WHERE kind = 'tool' AND thread_id = 'thread-1';
    `)
    const repository = createEventRepository(database, { epoch: 'epoch-after' })
    const report = reconcileAfterRestart(database, repository, ENV)
    expect(report.failures).toMatchObject([
      { kind: 'repair', ids: { sessionId: 'session-1', threadId: 'thread-1' } },
    ])
    expect(report).toMatchObject({ threadsRepaired: 1, toolsCancelled: 1, thoughtsClosed: 1 })
    expect(
      database
        .prepare("SELECT kind, state_json FROM turn_activity WHERE thread_id = 'thread-2'")
        .all()
        .map((row) => JSON.parse((row as { state_json: string }).state_json)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'cancelled' }),
        expect.objectContaining({ phase: 'stop' }),
      ]),
    )
  })

  it('ends each open turn with events on its own stream, one transaction per turn', async () => {
    const database = await createDatabase()
    const before = createEventRepository(database, { epoch: 'epoch-before' })
    before.appendEvents(scopeOf(1), openTurn(1))
    before.appendEvents(scopeOf(2), openTurn(2))

    const commits: (readonly DurableEvent[])[] = []
    // A new process: a new epoch, which existing streams must not take.
    const repository = createEventRepository(database, {
      epoch: 'epoch-after',
      beforeCommit: (records) => commits.push(records),
    })
    const report = reconcileAfterRestart(database, repository, ENV, () =>
      Date.parse('2026-10-21T11:00:00.000Z'),
    )
    expect(report).toMatchObject({
      turnsRecovered: 2,
      toolsCancelled: 2,
      thoughtsClosed: 2,
      questionsCancelled: 2,
      threadsRepaired: 0,
      failures: [],
    })
    // One transaction per turn: its closes, its end, and its session's status.
    expect(commits).toHaveLength(2)
    for (const [index, records] of commits.entries()) {
      const thread = index + 1
      const own = records.filter((record) => record.cursor.scope.type === 'thread')
      expect(own.map((record) => record.event.name)).toEqual([
        'tool.updated',
        'message.reasoning',
        'interaction.cancelled',
        'turn.interrupted',
      ])
      // The same epoch, the sequence after what a client already holds.
      expect(own.map((record) => [record.cursor.epoch, record.cursor.sequence])).toEqual([
        ['epoch-before', 5],
        ['epoch-before', 6],
        ['epoch-before', 7],
        ['epoch-before', 8],
      ])
      expect(own.at(-1)!.event).toMatchObject({
        eventId: `recover:turn-${thread}`,
        payload: { turnId: `turn-${thread}`, reason: 'server_restarted' },
      })
    }
    expect(database.prepare('SELECT DISTINCT status FROM sessions').all()).toEqual([
      { status: 'error' },
    ])
    // Nothing is left to do on the next boot.
    expect(reconcileAfterRestart(database, repository, ENV)).toMatchObject({
      turnsRecovered: 0,
      eventsWritten: 0,
    })
  })

  it('logs and skips a turn it cannot end, ends the others, and retries it next boot', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scopeOf(1), openTurn(1))
    repository.appendEvents(scopeOf(2), openTurn(2))
    database.exec(`CREATE TEMP TRIGGER refuse_turn_1 BEFORE UPDATE OF state ON turns
      WHEN old.turn_id = 'turn-1' AND new.state = 'interrupted' BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const report = reconcileAfterRestart(database, repository, ENV)
    expect(report.turnsRecovered).toBe(1)
    expect(report.failures).toEqual([
      {
        kind: 'recovery',
        ids: { sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1' },
        reason: expect.stringContaining('boom'),
      },
    ])
    // Its rows and log are as they were: nothing of the failed turn landed.
    expect(database.prepare("SELECT state FROM turns WHERE turn_id = 'turn-1'").get()).toEqual({
      state: 'waiting',
    })
    expect(
      database
        .prepare("SELECT count(*) AS n FROM event_log WHERE event_id LIKE 'recover:turn-1%'")
        .get(),
    ).toEqual({ n: 0 })
    database.exec('DROP TRIGGER refuse_turn_1')
    expect(reconcileAfterRestart(database, repository, ENV)).toMatchObject({
      turnsRecovered: 1,
      failures: [],
    })
  })

  it('closes the open children of turns that ended long ago, once', async () => {
    const database = await createDatabase()
    const repository = createEventRepository(database)
    repository.appendEvents(scopeOf(1), openTurn(1).slice(0, 3))
    repository.finalizeTurn(scopeOf(1), [
      event(1, 'turn.completed', 'done-1', { turnId: 'turn-1' }),
    ])
    // A turn that ended before servers closed children: its tool and thought still open.
    database.exec(`UPDATE turn_activity SET state_json = json_set(state_json, '$.status', 'in_progress')
      WHERE activity_id = 'tool-1'`)
    database.exec(`UPDATE turn_activity SET state_json = json_set(state_json, '$.phase', 'delta')
      WHERE activity_id = 'thought-1'`)
    const report = reconcileAfterRestart(database, repository, ENV)
    expect(report).toMatchObject({
      turnsRecovered: 0,
      toolsCancelled: 1,
      thoughtsClosed: 1,
      threadsRepaired: 1,
      failures: [],
    })
    expect(
      database
        .prepare("SELECT event_id FROM event_log WHERE event_id LIKE 'repair:%' ORDER BY sequence")
        .all(),
    ).toEqual([{ event_id: 'repair:tool:tool-1' }, { event_id: 'repair:reasoning:thought-1' }])
    expect(
      database.prepare('SELECT kind, state_json FROM turn_activity ORDER BY kind').all(),
    ).toEqual([
      { kind: 'reasoning', state_json: expect.stringContaining('"phase":"stop"') },
      { kind: 'tool', state_json: expect.stringContaining('"status":"cancelled"') },
    ])
    // Idempotent: nothing is open any more.
    expect(reconcileAfterRestart(database, repository, ENV)).toMatchObject({
      threadsRepaired: 0,
      eventsWritten: 0,
    })
  })
})
