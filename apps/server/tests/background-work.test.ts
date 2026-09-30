import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofResponseSchemas,
  type CommandEnvelope,
  type EventEnvelope,
} from '@openmanager/protocol/node'
import { openEnvironmentDatabase } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { getSessionSummary, listSessionHistory } from '../src/db/session-store.js'
import { createPersistentEventService } from '../src/event-service.js'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'

const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === '/workspace/project'
    ? { providerId: 'claude', cwd: '/workspace/project' }
    : undefined

const closers: (() => void)[] = []
const directories: string[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) close()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

type RuntimeEvent = Parameters<ReturnType<typeof createThreadService>['onRuntimeEvent']>[0]

/**
 * A session on a provider that runs work in the background, with a turn the
 * user sent already open. The provider is driven by hand, in the order Claude
 * Code emits (live-verified on 2.1.285).
 */
async function setup(durable = true, onPersistenceError?: (error: unknown) => void) {
  const database = durable
    ? new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
    : undefined
  const published: EventEnvelope[] = []
  /** Set to make the next event write report a failure. */
  const failure = { next: false }
  let events: ReturnType<typeof createPersistentEventService> | undefined
  if (database) {
    runMigrations(database, MIGRATIONS)
    database.exec(
      "INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at) VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1)",
    )
    events = createPersistentEventService(database, (record) => published.push(record.event), {
      sessionProviderId: () => 'claude',
    })
    closers.push(() => {
      events!.close()
      database.close()
    })
  }
  const runtime = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
    // Left open: the provider's own events end each turn below.
    prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
    cancel: vi.fn().mockResolvedValue(undefined),
    stopBackgroundTasks: vi.fn().mockResolvedValue(undefined),
    closeThread: vi.fn().mockResolvedValue(undefined),
  }
  const service = createThreadService(
    runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
    { rejection: () => undefined },
    events
      ? (event) => {
          const record = events!.append(event)
          // The write is queued and then reported as failed, as a busy disk
          // does it: the batch commits with the next append.
          if (failure.next) {
            failure.next = false
            throw new Error('disk busy')
          }
          return record
        }
      : (event) => published.push(event),
    undefined,
    registered,
    database
      ? {
          database,
          flush: events!.flush,
          appendAtomic: events!.appendAtomic,
          ...(onPersistenceError ? { onPersistenceError } : {}),
        }
      : {},
  )
  service.setEnvironmentId('environment-1')
  const dispatch = (name: string, payload: CommandEnvelope['payload']) =>
    service.dispatch({ type: 'command', requestId: name.replaceAll('.', '-'), name, payload })
  const created = ProofResponseSchemas['session.create'].parse(
    dispatch('session.create', {
      environmentId: 'environment-1',
      workspaceId: '/workspace/project',
      providerId: 'claude',
    }),
  ).payload
  const { sessionId } = created.session
  await service.resolveRuntimeSession(sessionId)

  let seq = 0
  const emit = (
    event: Pick<RuntimeEvent, 'category' | 'event'> & { data: unknown },
    messageId?: string,
  ) =>
    service.onRuntimeEvent({
      providerId: 'claude',
      threadId: created.thread.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      id: `event-${++seq}`,
      seq,
      timestamp: new Date(Date.UTC(2026, 8, 30, 10, 0, seq)).toISOString(),
      ...(messageId ? { messageId } : {}),
      ...event,
    } as RuntimeEvent)
  const roster = (...taskIds: string[]) =>
    emit({
      category: 'session',
      event: 'background_tasks_update',
      data: {
        tasks: taskIds.map((taskId) => ({ taskId, kind: 'shell', description: `Run ${taskId}` })),
      },
    })
  const text = (messageId: string, value: string) =>
    emit(
      {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: value } },
      },
      messageId,
    )
  const completed = (messageId: string) =>
    emit({ category: 'lifecycle', event: 'prompt_completed', data: {} }, messageId)

  /** The user's turn: the agent starts `taskIds` in the background and ends. */
  const userTurn = (...taskIds: string[]) => {
    const sent = ProofResponseSchemas['turn.send'].parse(
      dispatch('turn.send', { ...created.thread, text: 'Build it' }),
    ).payload
    return Promise.resolve().then(async () => {
      await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalled())
      emit(
        {
          category: 'lifecycle',
          event: 'prompt_started',
          data: { prompt: 'Build it', userMessageId: sent.userMessage.messageId },
        },
        'assistant-1',
      )
      if (taskIds.length) roster(...taskIds)
      text('assistant-1', 'Started.')
      completed('assistant-1')
      return sent
    })
  }
  const summary = () => {
    events?.flush()
    return database
      ? getSessionSummary(database, sessionId)!
      : ProofResponseSchemas['session.open'].parse(dispatch('session.open', { sessionId })).payload
          .session
  }
  const statuses = () =>
    published.flatMap((event) =>
      event.name === 'session.updated' &&
      (event.payload as { status?: string }).status !== undefined
        ? [(event.payload as { status: string }).status]
        : [],
    )
  return {
    database,
    events,
    runtime,
    service,
    dispatch,
    created,
    sessionId,
    emit,
    roster,
    text,
    completed,
    userTurn,
    summary,
    statuses,
    published,
    failure,
  }
}

describe('background work', () => {
  it('keeps a session running after its turn while a background task is live', async () => {
    const h = await setup()
    await h.userTurn('provider-task')

    const session = h.summary()
    expect(session.status).toBe('running')
    // The turn ended, but nothing is finished yet.
    expect(session.doneAt).toBeNull()
    expect(session.backgroundTasks).toEqual([
      { taskId: expect.any(String), kind: 'shell', description: 'Run provider-task' },
    ])
    // The provider's own id never crosses the wire.
    expect(session.backgroundTasks![0]!.taskId).not.toBe('provider-task')
    // Sidebar subscribers saw it start working and nothing since.
    expect(h.statuses()).toEqual(['running'])
  })

  it('files the turn the provider starts by itself, then rests the session as done', async () => {
    const h = await setup()
    const sent = await h.userTurn('provider-task')

    // The task settles and the agent wakes to report. No command asked for it.
    h.emit({ category: 'lifecycle', event: 'background_turn_started', data: {} }, 'assistant-2')
    h.roster()
    expect(h.summary().status).toBe('running')
    h.text('assistant-2', 'The build passed.')
    h.completed('assistant-2')

    const session = h.summary()
    expect(session.status).toBe('idle')
    expect(session.doneAt).toEqual(expect.any(String))
    expect(session.backgroundTasks).toBeUndefined()
    // One continuous stretch of work as far as the sidebar is concerned.
    expect(h.statuses()).toEqual(['running', 'idle'])

    const history = listSessionHistory(h.database!, { ...h.created.thread })!
    expect(history.turns).toHaveLength(2)
    expect(history.turns.map((turn) => turn.state)).toEqual(['completed', 'completed'])
    const backgroundTurn = history.turns.find((turn) => turn.turnId !== sent.turn.turnId)!
    // History says which turn nobody sent; the user's own carries no origin.
    expect(backgroundTurn.origin).toBe('background')
    expect(history.turns.find((turn) => turn.turnId === sent.turn.turnId)).not.toHaveProperty(
      'origin',
    )
    const backgroundTurnId = backgroundTurn.turnId
    // The turn nobody prompted has an answer and no user message.
    expect(
      history.messages
        .filter((message) => message.turnId === backgroundTurnId)
        .map((message) => [message.role, message.content]),
    ).toEqual([['assistant', [{ type: 'text', text: 'The build passed.' }]]])
    const startedEvents = h.published.filter((event) => event.name === 'turn.started')
    expect(startedEvents).toHaveLength(2)
    expect((startedEvents[1]!.payload as { userMessage?: unknown }).userMessage).toBeUndefined()
  })

  it('rests an idle session when the last background task ends with no turn following', async () => {
    const h = await setup()
    await h.userTurn('provider-task')

    h.roster()

    const session = h.summary()
    expect(session.status).toBe('idle')
    // Nothing was reported, so there is nothing new to read.
    expect(session.doneAt).toBeNull()
    expect(session.backgroundTasks).toBeUndefined()
  })

  it('leaves a turn the user sent in charge when the provider speaks up during it', async () => {
    const h = await setup()
    const sent = ProofResponseSchemas['turn.send'].parse(
      h.dispatch('turn.send', { ...h.created.thread, text: 'Build it' }),
    ).payload

    h.emit({ category: 'lifecycle', event: 'background_turn_started', data: {} }, 'assistant-0')
    h.events!.flush()

    const history = listSessionHistory(h.database!, { ...h.created.thread })!
    expect(history.turns.map((turn) => turn.turnId)).toEqual([sent.turn.turnId])
  })

  it('refuses a send while a background turn is running, and lets it be interrupted', async () => {
    const h = await setup()
    await h.userTurn('provider-task')
    h.emit({ category: 'lifecycle', event: 'background_turn_started', data: {} }, 'assistant-2')
    h.events!.flush()

    expect(h.dispatch('turn.send', { ...h.created.thread, text: 'And this' })).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })

    const turnOf = (state: string) =>
      listSessionHistory(h.database!, { ...h.created.thread })!.turns.find(
        (turn) => turn.state === state,
      )
    const turnId = turnOf('running')!.turnId
    expect(h.dispatch('turn.interrupt', { ...h.created.thread, turnId })).toMatchObject({
      type: 'response',
      payload: { turnId },
    })
    await vi.waitFor(() => expect(h.runtime.cancel).toHaveBeenCalled())
    await vi.waitFor(() => {
      h.events!.flush()
      expect(turnOf('interrupted')?.turnId).toBe(turnId)
    })
    // Interrupting the turn does not stop the task; the session is still working.
    expect(h.summary().status).toBe('running')
  })

  it('stops the tasks a client names, by the provider id behind each host id', async () => {
    const h = await setup()
    await h.userTurn('provider-a', 'provider-b')
    const [first] = h.summary().backgroundTasks!

    await h.dispatch('session.background.stop', {
      sessionId: h.sessionId,
      taskIds: [first!.taskId],
    })
    expect(h.runtime.stopBackgroundTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: h.created.thread.threadId, taskIds: ['provider-a'] }),
    )

    // Stopping everything names nothing: the provider may be running more
    // than the roster this host is allowed to list.
    expect(await h.dispatch('session.background.stop', { sessionId: h.sessionId })).toMatchObject({
      type: 'response',
      payload: null,
    })
    const everything = h.runtime.stopBackgroundTasks.mock.lastCall![0]
    expect(everything).toMatchObject({ threadId: h.created.thread.threadId })
    expect(everything).not.toHaveProperty('taskIds')
  })

  it('treats a task that already ended, or an unknown session, as nothing to stop', async () => {
    const h = await setup()
    await h.userTurn('provider-a')

    expect(
      h.dispatch('session.background.stop', { sessionId: h.sessionId, taskIds: ['long-gone'] }),
    ).toMatchObject({ type: 'response', payload: null })
    expect(h.runtime.stopBackgroundTasks).not.toHaveBeenCalled()
    expect(h.dispatch('session.background.stop', { sessionId: 'no-such-session' })).toMatchObject({
      type: 'error',
      error: { code: 'not_found' },
    })
  })

  it('reports a stop the provider refused', async () => {
    const h = await setup()
    await h.userTurn('provider-a')
    h.runtime.stopBackgroundTasks.mockRejectedValueOnce(new Error('control request timed out'))

    expect(await h.dispatch('session.background.stop', { sessionId: h.sessionId })).toMatchObject({
      type: 'error',
      error: { code: 'unavailable' },
    })
  })

  it('keeps the same host id for a task across roster updates', async () => {
    const h = await setup()
    await h.userTurn('provider-a')
    const before = h.summary().backgroundTasks![0]!.taskId

    h.roster('provider-a', 'provider-b')

    const tasks = h.summary().backgroundTasks!
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.taskId).toBe(before)
  })

  it('ends the background work of a session that is deleted', async () => {
    const h = await setup()
    await h.userTurn('provider-a')

    expect(h.dispatch('session.delete', { sessionId: h.sessionId })).toMatchObject({
      type: 'response',
    })
    // Nothing can reach the session to stop it now, and a process with
    // background work is never stopped for being idle.
    expect(h.runtime.closeThread).toHaveBeenCalledWith({
      providerId: 'claude',
      threadId: h.created.thread.threadId,
    })
  })

  it('leaves the process of a deleted session with no background work alone', async () => {
    const h = await setup()
    await h.userTurn()

    h.dispatch('session.delete', { sessionId: h.sessionId })

    expect(h.runtime.closeThread).not.toHaveBeenCalled()
  })

  it('keeps a roster whose write had to be retried, so its tasks can still be stopped', async () => {
    const failures: unknown[] = []
    const h = await setup(true, (error) => failures.push(error))
    await h.userTurn()

    h.failure.next = true
    h.roster('provider-a')
    expect(failures).toHaveLength(1)

    const tasks = h.summary().backgroundTasks!
    expect(tasks).toHaveLength(1)
    expect(h.summary().status).toBe('running')
    await h.dispatch('session.background.stop', {
      sessionId: h.sessionId,
      taskIds: [tasks[0]!.taskId],
    })
    expect(h.runtime.stopBackgroundTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskIds: ['provider-a'] }),
    )
  })

  it('mirrors the same lifecycle without a database', async () => {
    const h = await setup(false)
    await h.userTurn('provider-task')
    expect(h.summary()).toMatchObject({ status: 'running', doneAt: null })
    expect(h.summary().backgroundTasks).toHaveLength(1)

    h.emit({ category: 'lifecycle', event: 'background_turn_started', data: {} }, 'assistant-2')
    h.roster()
    h.text('assistant-2', 'The build passed.')
    h.completed('assistant-2')

    expect(h.summary()).toMatchObject({ status: 'idle', doneAt: expect.any(String) })
    expect(h.summary().backgroundTasks).toBeUndefined()
  })
})

describe('background work across a restart', () => {
  /** A database the previous process left behind, with work it was running. */
  async function reopened(status: string) {
    const directory = await mkdtemp(join(tmpdir(), 'openmanager-background-test-'))
    directories.push(directory)
    const first = openEnvironmentDatabase(directory)
    first.exec(`
      INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at)
        VALUES ('workspace-1', 'Project', '/workspace/project', 1, 1);
      INSERT INTO sessions (
        session_id, workspace_id, provider_id, title, status, background_tasks_json,
        created_at, updated_at
      ) VALUES (
        'session-1', 'workspace-1', 'claude', 'Build', '${status}',
        '[{"taskId":"task-1","kind":"shell","description":"Run the build"}]', 1, 1
      );
    `)
    first.close()

    const database = openEnvironmentDatabase(directory)
    const published: EventEnvelope[] = []
    const events = createPersistentEventService(
      database,
      (record) => published.push(record.event),
      { sessionProviderId: () => 'claude' },
    )
    closers.push(() => {
      events.close()
      database.close()
    })
    const service = createThreadService(
      { ensureSession: vi.fn(), prompt: vi.fn(), cancel: vi.fn() } as unknown as Pick<
        AgentRuntime,
        'ensureSession' | 'prompt' | 'cancel'
      >,
      { rejection: () => undefined },
      events.append,
      undefined,
      registered,
      { database, flush: events.flush, appendAtomic: events.appendAtomic },
    )
    service.setEnvironmentId('environment-1')
    return { database, events, published, service }
  }

  it('forgets tasks that died with the server, in a way a reconnecting client replays', async () => {
    const h = await reopened('running')
    // Opening the database alone says nothing: a client with a saved cursor
    // would replay no change and go on showing the dead task.
    expect(getSessionSummary(h.database, 'session-1')!.backgroundTasks).toHaveLength(1)

    expect(h.service.forgetStaleBackgroundWork()).toBe(1)
    h.events.flush()

    const session = getSessionSummary(h.database, 'session-1')!
    expect(session.status).toBe('idle')
    expect(session.backgroundTasks).toBeUndefined()
    expect(h.published.map((event) => [event.name, event.payload])).toEqual([
      ['session.updated', { sessionId: 'session-1', backgroundTasks: [], status: 'idle' }],
    ])
    // Nothing left to say the second time.
    expect(h.service.forgetStaleBackgroundWork()).toBe(0)
  })

  it('leaves a session the restart already marked failed as failed', async () => {
    const h = await reopened('error')

    h.service.forgetStaleBackgroundWork()
    h.events.flush()

    const session = getSessionSummary(h.database, 'session-1')!
    expect(session.status).toBe('error')
    expect(session.backgroundTasks).toBeUndefined()
  })
})
