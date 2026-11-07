import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime } from '@agentpack/runtime/node'
import {
  ProofResponseSchemas,
  type CommandEnvelope,
  type EventEnvelope,
} from '@openmanager/protocol/node'
import { reconcileAfterRestart } from '../src/db/boot-reconcile.js'
import { runMigrations } from '../src/db/migrate.js'
import { MIGRATIONS } from '../src/db/migrations.js'
import { readThreadState } from '../src/db/session-store.js'
import { createPersistentEventService } from '../src/event-service.js'
import { createThreadService, type WorkspaceRuntimeResolver } from '../src/thread-service.js'

const registered: WorkspaceRuntimeResolver = (workspaceId) =>
  workspaceId === '/workspace/project'
    ? { providerId: 'claude', cwd: '/workspace/project' }
    : undefined

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

type RuntimeEvent = Parameters<ReturnType<typeof createThreadService>['onRuntimeEvent']>[0]
type PromptArgs = { prompt: { text: string }; userMessageId: string; desiredConfig?: unknown }

/** A Claude chat on a real (in-memory) database, its provider driven by hand. */
function boot(database: DatabaseSync, published: EventEnvelope[]) {
  const events = createPersistentEventService(
    database,
    (record) => published.push(record.event),
    {},
  )
  const runtime = {
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'provider-session', state: 'created' }),
    // Left open: the provider's own events end each turn below.
    prompt: vi
      .fn<(args: PromptArgs) => Promise<void>>()
      .mockReturnValue(new Promise(() => undefined)),
    cancel: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
  }
  const settings = { current: { modelId: 'claude-sonnet-5' } as Record<string, unknown> }
  const service = createThreadService(
    runtime as unknown as Pick<AgentRuntime, 'ensureSession' | 'prompt' | 'cancel'>,
    { rejection: () => undefined },
    (event) => events.append(event),
    undefined,
    registered,
    {
      database,
      flush: events.flush,
      appendAtomic: (batch, options) => events.appendAtomic(batch, options),
      queuedSettings: () => settings.current,
    },
  )
  service.setEnvironmentId('environment-1')
  return { events, runtime, service, settings }
}

async function setup() {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true })
  runMigrations(database, MIGRATIONS)
  database.exec(
    "INSERT INTO workspaces (workspace_id, name, path, created_at, updated_at) VALUES ('/workspace/project', 'Project', '/workspace/project', 1, 1)",
  )
  const published: EventEnvelope[] = []
  const booted = boot(database, published)
  closers.push(() => {
    booted.events.close()
    database.close()
  })
  const { service, runtime } = booted
  const dispatch = (name: string, payload: CommandEnvelope['payload']) =>
    service.dispatch({
      type: 'command',
      requestId: `r-${name.replaceAll('.', '-')}`,
      name,
      payload,
    }) as {
      type: string
      payload?: unknown
      error?: { code: string; message: string }
    }
  const created = ProofResponseSchemas['session.create'].parse(
    dispatch('session.create', {
      environmentId: 'environment-1',
      workspaceId: '/workspace/project',
      providerId: 'claude',
    }),
  ).payload
  const thread = created.thread
  await service.resolveRuntimeSession(created.session.sessionId)

  let seq = 0
  // Provider events follow the real clock the service stamps its own turns
  // with, so turns the provider starts sort after the ones sent before them.
  const clock = Date.now()
  const emit = (
    event: Pick<RuntimeEvent, 'category' | 'event'> & { data: unknown },
    messageId?: string,
  ) =>
    service.onRuntimeEvent({
      providerId: 'claude',
      threadId: thread.threadId,
      workspaceId: '/workspace/project',
      sessionId: 'provider-session',
      id: `event-${++seq}`,
      seq,
      timestamp: new Date(clock + seq * 1000).toISOString(),
      ...(messageId ? { messageId } : {}),
      ...event,
    } as RuntimeEvent)

  /** The provider picks up the `n`th prompt the service handed it. */
  const started = async (n: number) => {
    await vi.waitFor(() => expect(runtime.prompt.mock.calls.length).toBeGreaterThan(n))
    const args = runtime.prompt.mock.calls[n]![0]
    emit(
      {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: args.prompt.text, userMessageId: args.userMessageId },
      },
      `assistant-${n}`,
    )
    return args
  }
  const text = (messageId: string, value: string) =>
    emit(
      {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: value } },
      },
      messageId,
    )
  const completed = async (messageId: string) => {
    emit({ category: 'lifecycle', event: 'prompt_completed', data: {} }, messageId)
    // The queue follows the turn's end a microtask later.
    await Promise.resolve()
    await Promise.resolve()
  }
  const send = (text: string, commandId = `send-${text.replaceAll(' ', '-')}`) =>
    ProofResponseSchemas['turn.send'].parse(dispatch('turn.send', { ...thread, text, commandId }))
      .payload
  const state = () => {
    booted.events.flush()
    return readThreadState(database, { sessionId: thread.sessionId, threadId: thread.threadId })!
  }
  const queue = () => state().queue
  const queueEvents = () => published.filter((event) => event.name === 'thread.queue.updated')
  return {
    database,
    published,
    ...booted,
    dispatch,
    thread,
    emit,
    started,
    text,
    completed,
    send,
    state,
    queue,
    queueEvents,
  }
}

describe('a chat queue', () => {
  it('holds a message while a turn runs and runs it, with its settings, when the turn completes', async () => {
    const chat = await setup()
    const first = chat.send('Build it')
    await chat.started(0)

    chat.settings.current = { modelId: 'claude-opus-5', configValues: { effort: 'high' } }
    const added = chat.dispatch('queue.add', {
      ...chat.thread,
      text: 'Then test it',
      commandId: 'q-1',
    })
    expect(added).toMatchObject({ type: 'response', payload: { queueItemId: 'q-1' } })
    expect(chat.queue()).toMatchObject({
      items: [{ queueItemId: 'q-1', text: 'Then test it', delivery: 'queued' }],
      pausedBy: null,
    })
    expect(chat.queue().items[0]!.settings).toEqual({
      modelId: 'claude-opus-5',
      configValues: { effort: 'high' },
    })
    // A later change of model does not move what the message was sent with.
    chat.settings.current = { modelId: 'claude-haiku-5' }
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(1)

    chat.text('assistant-0', 'Built.')
    await chat.completed('assistant-0')
    const next = await chat.started(1)
    expect(next.prompt.text).toBe('Then test it')
    expect(next.desiredConfig).toEqual({ modelId: 'claude-opus-5', values: { effort: 'high' } })
    expect(chat.queue()).toEqual({ items: [], pausedBy: null })
    const turns = chat.state().turns
    expect(turns.map((turn) => turn.commandId)).toEqual([first.commandId, 'q-1'])
    // Every client hears each change: added, then gone with the turn that ran it.
    expect(
      chat.queueEvents().map((event) => (event.payload as { items: unknown[] }).items.length),
    ).toEqual([1, 0])
  })

  it('drains in order, one message per completed turn', async () => {
    const chat = await setup()
    chat.send('One')
    await chat.started(0)
    chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' })
    chat.dispatch('queue.add', { ...chat.thread, text: 'Three', commandId: 'q-3' })
    await chat.completed('assistant-0')
    expect((await chat.started(1)).prompt.text).toBe('Two')
    expect(chat.queue().items.map((item) => item.queueItemId)).toEqual(['q-3'])
    await chat.completed('assistant-1')
    expect((await chat.started(2)).prompt.text).toBe('Three')
    expect(chat.queue().items).toEqual([])
  })

  it('answers a retried add once, and runs a message added to an idle chat at once', async () => {
    const chat = await setup()
    chat.send('One')
    await chat.started(0)
    chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' })
    expect(
      chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' }),
    ).toMatchObject({
      type: 'response',
    })
    expect(chat.queue().items).toHaveLength(1)
    await chat.completed('assistant-0')
    await chat.started(1)
    await chat.completed('assistant-1')
    // Ran already: a late retry neither queues it again nor runs it twice.
    chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' })
    expect(chat.queue().items).toEqual([])
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(2)

    chat.dispatch('queue.add', { ...chat.thread, text: 'Now', commandId: 'q-now' })
    expect((await chat.started(2)).prompt.text).toBe('Now')
  })

  it('runs the next message when the turn is stopped', async () => {
    const chat = await setup()
    const sent = chat.send('One')
    await chat.started(0)
    chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' })
    chat.dispatch('queue.add', { ...chat.thread, text: 'Three', commandId: 'q-3' })
    chat.dispatch('turn.interrupt', { ...chat.thread, turnId: sent.turn.turnId })
    expect((await chat.started(1)).prompt.text).toBe('Two')
    expect(chat.queue()).toMatchObject({ items: [{ queueItemId: 'q-3' }], pausedBy: null })
    expect(chat.state().turns.map((turn) => turn.state)).toEqual(['interrupted', 'running'])
  })

  it('pauses when a turn fails', async () => {
    const chat = await setup()
    chat.send('One')
    await chat.started(0)
    chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' })
    chat.emit(
      { category: 'error', event: 'runtime_error', data: { kind: 'provider', message: 'boom' } },
      'assistant-0',
    )
    await vi.waitFor(() => expect(chat.queue().pausedBy).toBe('failure'))
    await Promise.resolve()
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(1)

    expect(chat.dispatch('queue.resume', chat.thread)).toMatchObject({ type: 'response' })
    expect((await chat.started(1)).prompt.text).toBe('Two')
    expect(chat.queue()).toEqual({ items: [], pausedBy: null })
  })

  it('removes a waiting message, and refuses one already sent', async () => {
    const chat = await setup()
    chat.send('One')
    await chat.started(0)
    chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' })
    expect(chat.dispatch('queue.remove', { ...chat.thread, queueItemId: 'q-2' })).toMatchObject({
      type: 'response',
    })
    expect(chat.queue().items).toEqual([])
    expect(chat.dispatch('queue.remove', { ...chat.thread, queueItemId: 'q-2' })).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
    await chat.completed('assistant-0')
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(1)
  })

  it('survives a restart paused, with what the provider held given back', async () => {
    const chat = await setup()
    const sent = chat.send('One')
    await chat.started(0)
    chat.dispatch('queue.add', { ...chat.thread, text: 'Two', commandId: 'q-2' })
    chat.dispatch('turn.steer', {
      ...chat.thread,
      turnId: sent.turn.turnId,
      text: 'And three',
      commandId: 'q-3',
    })
    expect(chat.queue().items.map((item) => item.delivery)).toEqual(['queued', 'steering'])

    // The next process on the same rows.
    const rebooted = boot(chat.database, chat.published)
    closers.unshift(() => rebooted.events.close())
    rebooted.service.setEnvironmentId('environment-1')
    // As the server boots: the cut-off turn is closed first.
    reconcileAfterRestart(chat.database, rebooted.events.repository, 'environment-1')
    expect(rebooted.service.pauseQueuesAfterRestart()).toBe(1)
    rebooted.events.flush()
    const queue = readThreadState(chat.database, chat.thread)!.queue
    expect(queue.pausedBy).toBe('restart')
    // The steer comes back ahead of the message that was only queued.
    expect(queue.items.map((item) => [item.queueItemId, item.delivery])).toEqual([
      ['q-3', 'queued'],
      ['q-2', 'queued'],
    ])
    // Nothing ran by itself; a resume runs the first.
    expect(rebooted.runtime.prompt).not.toHaveBeenCalled()
    rebooted.service.dispatch({
      type: 'command',
      requestId: 'r-resume',
      name: 'queue.resume',
      payload: chat.thread,
    })
    await vi.waitFor(() => expect(rebooted.runtime.prompt).toHaveBeenCalledTimes(1))
    expect(rebooted.runtime.prompt.mock.calls[0]![0].prompt.text).toBe('And three')
  })
})

describe('steering', () => {
  it('hands a message to the running turn and records it there when the provider takes it', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    chat.text('assistant-0', 'Working on it.')
    const steered = chat.dispatch('turn.steer', {
      ...chat.thread,
      turnId: sent.turn.turnId,
      text: 'Skip the docs',
      commandId: 's-1',
    })
    expect(steered).toMatchObject({ payload: { queueItemId: 's-1', outcome: 'steering' } })
    expect(chat.queue().items).toMatchObject([{ queueItemId: 's-1', delivery: 'steering' }])
    await vi.waitFor(() => expect(chat.runtime.steer).toHaveBeenCalledTimes(1))
    expect(chat.runtime.steer.mock.calls[0]![0]).toMatchObject({
      steerId: 's-1',
      prompt: { text: 'Skip the docs' },
    })
    // It cannot be taken out while the provider has it.
    expect(chat.dispatch('queue.remove', { ...chat.thread, queueItemId: 's-1' })).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })

    chat.emit(
      { category: 'lifecycle', event: 'steer_delivered', data: { steerId: 's-1' } },
      'assistant-0',
    )
    chat.text('assistant-0', 'Skipping the docs.')
    await chat.completed('assistant-0')

    const state = chat.state()
    expect(state.queue.items).toEqual([])
    expect(state.turns).toHaveLength(1)
    const users = state.messages.filter((message) => message.role === 'user')
    expect(users.map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'Build it' }],
      [{ type: 'text', text: 'Skip the docs' }],
    ])
    expect(users.every((message) => message.turnId === sent.turn.turnId)).toBe(true)
    // In order: the prompt, what the agent said, the steer, what it said next.
    const roles = state.order
      .filter((ref) => ref.kind === 'message')
      .map((ref) => state.messages.find((message) => message.messageId === ref.id)!.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    // A retried send of the turn still names its prompt, not the steer.
    expect(
      ProofResponseSchemas['turn.send'].parse(
        chat.dispatch('turn.send', {
          ...chat.thread,
          text: 'Build it',
          commandId: sent.commandId!,
        }),
      ).payload.userMessage.content,
    ).toEqual([{ type: 'text', text: 'Build it' }])
  })

  it('queues instead when the turn named is not the running one', async () => {
    const chat = await setup()
    chat.send('Build it')
    await chat.started(0)
    const answer = chat.dispatch('turn.steer', {
      ...chat.thread,
      turnId: 'turn-long-gone',
      text: 'Late',
      commandId: 's-1',
    })
    expect(answer).toMatchObject({ payload: { outcome: 'queued' } })
    expect(chat.runtime.steer).not.toHaveBeenCalled()
    expect(chat.queue().items).toMatchObject([{ queueItemId: 's-1', delivery: 'queued' }])
  })

  it('runs a steer the provider gave back as the next turn', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    chat.dispatch('turn.steer', {
      ...chat.thread,
      turnId: sent.turn.turnId,
      text: 'Also lint',
      commandId: 's-1',
    })
    await chat.completed('assistant-0')
    // The provider still holds it: nothing runs until it says what became of it.
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(1)
    chat.emit({ category: 'lifecycle', event: 'steer_withdrawn', data: { steerId: 's-1' } })
    expect((await chat.started(1)).prompt.text).toBe('Also lint')
    expect(chat.queue().items).toEqual([])
  })

  it('records the turn the provider began for a steer that missed its turn', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    chat.dispatch('turn.steer', {
      ...chat.thread,
      turnId: sent.turn.turnId,
      text: 'Say LATE',
      commandId: 's-1',
    })
    await chat.completed('assistant-0')
    chat.emit(
      { category: 'lifecycle', event: 'steer_turn_started', data: { steerId: 's-1' } },
      'assistant-late',
    )
    chat.text('assistant-late', 'LATE')
    await chat.completed('assistant-late')

    const state = chat.state()
    expect(state.queue.items).toEqual([])
    expect(state.turns.map((turn) => [turn.commandId, turn.state])).toEqual([
      [sent.commandId, 'completed'],
      ['s-1', 'completed'],
    ])
    const late = state.messages.filter((message) => message.turnId === state.turns[1]!.turnId)
    expect(late.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(1)
  })

  it('keeps a steer the provider holds out of reach after Stop, until the provider says', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    chat.dispatch('turn.steer', {
      ...chat.thread,
      turnId: sent.turn.turnId,
      text: 'Also lint',
      commandId: 's-1',
    })
    chat.dispatch('queue.add', { ...chat.thread, text: 'Then docs', commandId: 'q-2' })
    chat.dispatch('turn.interrupt', { ...chat.thread, turnId: sent.turn.turnId })
    await vi.waitFor(() => expect(chat.state().turns[0]?.state).toBe('interrupted'))
    await Promise.resolve()
    // No guess: it stays the provider's, so neither the stop's drain nor a
    // resume can send it twice, and the message queued behind it waits.
    expect(chat.queue()).toMatchObject({
      items: [
        { queueItemId: 's-1', delivery: 'steering' },
        { queueItemId: 'q-2', delivery: 'queued' },
      ],
      pausedBy: null,
    })
    chat.dispatch('queue.resume', chat.thread)
    await Promise.resolve()
    expect(chat.runtime.prompt).toHaveBeenCalledTimes(1)
    // Nor can a send start a turn the provider's next one could be credited with.
    expect(
      chat.dispatch('turn.send', { ...chat.thread, text: 'Other', commandId: 'other' }),
    ).toMatchObject({
      type: 'error',
      error: { code: 'conflict' },
    })
    chat.emit({ category: 'lifecycle', event: 'steer_withdrawn', data: { steerId: 's-1' } })
    expect((await chat.started(1)).prompt.text).toBe('Also lint')
    expect(chat.queue()).toMatchObject({ items: [{ queueItemId: 'q-2' }], pausedBy: null })
  })

  it('runs steers given back ahead of messages that were only queued, in order', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    chat.dispatch('queue.add', { ...chat.thread, text: 'Then docs', commandId: 'q-1' })
    for (const [commandId, text] of [
      ['s-1', 'Also lint'],
      ['s-2', 'And test'],
    ]) {
      chat.dispatch('turn.steer', { ...chat.thread, turnId: sent.turn.turnId, text, commandId })
    }
    chat.dispatch('turn.interrupt', { ...chat.thread, turnId: sent.turn.turnId })
    await vi.waitFor(() => expect(chat.state().turns[0]?.state).toBe('interrupted'))
    chat.emit({ category: 'lifecycle', event: 'steer_withdrawn', data: { steerId: 's-1' } })
    chat.emit({ category: 'lifecycle', event: 'steer_withdrawn', data: { steerId: 's-2' } })
    expect((await chat.started(1)).prompt.text).toBe('Also lint')
    expect(chat.queue().items.map((item) => item.queueItemId)).toEqual(['s-2', 'q-1'])
  })

  it('answers a retried steer it already delivered, without sending it again', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    const steer = {
      ...chat.thread,
      turnId: sent.turn.turnId,
      text: 'Skip the docs',
      commandId: 's-1',
    }
    chat.dispatch('turn.steer', steer)
    await vi.waitFor(() => expect(chat.runtime.steer).toHaveBeenCalledTimes(1))
    chat.emit(
      { category: 'lifecycle', event: 'steer_delivered', data: { steerId: 's-1' } },
      'assistant-0',
    )
    expect(chat.dispatch('turn.steer', steer)).toMatchObject({ type: 'response' })
    expect(
      chat.dispatch('queue.add', { ...chat.thread, text: 'Skip the docs', commandId: 's-1' }),
    ).toMatchObject({
      type: 'response',
    })
    expect(chat.queue().items).toEqual([])
    expect(chat.runtime.steer).toHaveBeenCalledTimes(1)
  })

  it('queues a steer aimed at a turn the provider began by itself', async () => {
    const chat = await setup()
    chat.emit({ category: 'lifecycle', event: 'background_turn_started', data: {} }, 'background-1')
    const turnId = chat.state().turns[0]!.turnId
    expect(
      chat.dispatch('turn.steer', { ...chat.thread, turnId, text: 'Hi', commandId: 's-1' }),
    ).toMatchObject({ payload: { outcome: 'queued' } })
    expect(chat.runtime.steer).not.toHaveBeenCalled()
  })

  it('puts a steer back in line when the provider cannot take it', async () => {
    const chat = await setup()
    const sent = chat.send('Build it')
    await chat.started(0)
    chat.runtime.steer.mockRejectedValueOnce(new Error('no turn to steer'))
    chat.dispatch('turn.steer', {
      ...chat.thread,
      turnId: sent.turn.turnId,
      text: 'Also lint',
      commandId: 's-1',
    })
    await vi.waitFor(() => expect(chat.queue().items).toMatchObject([{ delivery: 'queued' }]))
    await chat.completed('assistant-0')
    expect((await chat.started(1)).prompt.text).toBe('Also lint')
  })
})
