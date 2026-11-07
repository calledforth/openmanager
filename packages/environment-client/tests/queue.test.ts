import { describe, expect, it } from 'vitest'
import { EMPTY_THREAD_QUEUE, type ProofEvent, type ThreadQueue } from '@openmanager/protocol'
import { createMockEnvironmentClient } from '../src/mock'
import { cacheState } from '../src/cache-state'
import {
  applyEvent,
  applySnapshot,
  createInitialState,
  resendablePrompt,
  selectThreadQueue,
  selectTurnPrompt,
} from '../src/state'
import { PROVIDER, SESSION, THREAD, WORKSPACE, event, threadScope } from './fixtures'

const queued = (queueItemId: string, text: string): ThreadQueue['items'][number] => ({
  queueItemId,
  text,
  settings: {},
  delivery: 'queued',
  createdAt: '2026-11-07T10:00:00.000Z',
})

const queueEvent = (queue: ThreadQueue) =>
  event<Extract<ProofEvent, { name: 'thread.queue.updated' }>>({
    name: 'thread.queue.updated',
    scope: threadScope,
    payload: queue,
  })

describe('thread queue state', () => {
  it('replaces the queue with each update and keeps it when nothing changed', () => {
    const first: ThreadQueue = { items: [queued('q1', 'next')], pausedBy: null }
    const once = applyEvent(createInitialState(), queueEvent(first))
    expect(selectThreadQueue(once, THREAD.threadId)).toEqual(first)

    // The same queue again hands readers the object they hold.
    const twice = applyEvent(once, queueEvent({ items: [queued('q1', 'next')], pausedBy: null }))
    expect(twice).toBe(once)

    const paused = applyEvent(twice, queueEvent({ items: [], pausedBy: 'stop' }))
    expect(selectThreadQueue(paused, THREAD.threadId)).toEqual({ items: [], pausedBy: 'stop' })
  })

  it('takes the queue from the thread snapshot, and keeps it through a reload', () => {
    const queue: ThreadQueue = { items: [queued('q1', 'later')], pausedBy: 'restart' }
    const state = applySnapshot(createInitialState(), {
      cursor: { scope: threadScope, epoch: 'epoch-1', sequence: 3 },
      state: {
        thread: THREAD,
        turns: [],
        messages: [],
        reasoning: [],
        tools: [],
        notices: [],
        order: [],
        interactions: [],
        listing: {},
        queue,
      },
    })
    expect(selectThreadQueue(state, THREAD.threadId)).toEqual(queue)
    expect(selectThreadQueue(cacheState(state), THREAD.threadId)).toEqual(queue)
  })

  it('reads as empty for a chat not held, or cached before chats had a queue', () => {
    const state = createInitialState()
    expect(selectThreadQueue(state, 'missing')).toBe(EMPTY_THREAD_QUEUE)
    const held = applyEvent(state, queueEvent({ items: [], pausedBy: null }))
    const older: Partial<(typeof held.threads)[string]> = { ...held.threads[THREAD.threadId]! }
    delete older.queue
    const cached = {
      ...held,
      threads: { [THREAD.threadId]: older as (typeof held.threads)[string] },
    }
    expect(selectThreadQueue(cached, THREAD.threadId)).toBe(EMPTY_THREAD_QUEUE)
  })

  it("names a turn's prompt by order, not a message steered in after it", () => {
    const prompt = {
      messageId: 'm-prompt',
      threadId: THREAD.threadId,
      turnId: 't1',
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'first' }],
    }
    const steered = {
      ...prompt,
      messageId: 'm-steer',
      content: [{ type: 'text' as const, text: 'also' }],
    }
    const order = [
      { kind: 'message' as const, id: 'm-prompt', turnId: 't1' },
      { kind: 'message' as const, id: 'a1', turnId: 't1' },
      { kind: 'message' as const, id: 'm-steer', turnId: 't1' },
    ]
    // Held in either order, the prompt is the one the order places first.
    expect(selectTurnPrompt([steered, prompt], 't1', order)).toBe(prompt)
    expect(resendablePrompt([steered, prompt], 't1', order)).toEqual({
      text: 'first',
      artifactIds: [],
    })
    expect(selectTurnPrompt([prompt, steered], 't1')).toBe(prompt)
  })
})

describe('mock queue', () => {
  const seed = {
    workspaces: [WORKSPACE],
    providers: [
      { ...PROVIDER, id: 'claude', capabilities: { ...PROVIDER.capabilities, canSteer: true } },
      PROVIDER,
    ],
    sessions: [{ session: SESSION, threads: [THREAD], providerId: 'claude' }],
    activeSessionId: SESSION.sessionId,
  }

  const runningTurn = async (client: ReturnType<typeof createMockEnvironmentClient>) => {
    const { turn } = await client.commands.sendTurn({ ...THREAD, text: 'first' })
    return turn.turnId
  }

  it('holds a message while a turn runs and runs it when the turn completes', async () => {
    const client = createMockEnvironmentClient({ seed, respond: null })
    const turnId = await runningTurn(client)

    const answer = await client.commands.queueMessage({
      ...THREAD,
      text: 'then this',
      commandId: 'q1',
    })
    expect(answer).toEqual({ queueItemId: 'q1' })
    const thread = () => client.getState().threads[THREAD.threadId]!
    expect(thread().queue.items.map((item) => [item.queueItemId, item.delivery])).toEqual([
      ['q1', 'queued'],
    ])
    // Not a send: nothing is echoed, and the transcript has only the first turn.
    expect(thread().outbox).toEqual([])
    expect(thread().turns).toHaveLength(1)

    // A retry finds the same message.
    await client.commands.queueMessage({ ...THREAD, text: 'then this', commandId: 'q1' })
    expect(thread().queue.items).toHaveLength(1)

    client.completeTurn({ ...THREAD, turnId })
    expect(thread().queue).toEqual({ items: [], pausedBy: null })
    const next = thread().turns.at(-1)!
    expect(next).toMatchObject({ state: 'running', commandId: 'q1' })
    const prompt = thread().messages.find((message) => message.turnId === next.turnId)
    expect(prompt).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'then this' }] })
    // No echo stood for it, so none is settled by it.
    expect(thread().confirmedEchoes?.[prompt!.messageId]).toBeUndefined()
  })

  it('starts the turn at once in a chat with nothing running or waiting', async () => {
    const client = createMockEnvironmentClient({ seed, respond: null })
    await client.commands.queueMessage({ ...THREAD, text: 'go', commandId: 'q1' })
    const thread = client.getState().threads[THREAD.threadId]!
    expect(thread.queue.items).toEqual([])
    expect(thread.turns).toEqual([expect.objectContaining({ state: 'running', commandId: 'q1' })])
  })

  it('pauses on a stop or a failure, and drains again only when resumed', async () => {
    const client = createMockEnvironmentClient({ seed, respond: null })
    const turnId = await runningTurn(client)
    await client.commands.queueMessage({ ...THREAD, text: 'a', commandId: 'q1' })
    await client.commands.queueMessage({ ...THREAD, text: 'b', commandId: 'q2' })

    await client.commands.interruptTurn({ ...THREAD, turnId })
    const thread = () => client.getState().threads[THREAD.threadId]!
    expect(thread().queue.pausedBy).toBe('stop')
    expect(thread().queue.items).toHaveLength(2)
    expect(thread().turns).toHaveLength(1)

    await client.commands.removeQueuedMessage({ ...THREAD, queueItemId: 'q2' })
    expect(thread().queue.items.map((item) => item.queueItemId)).toEqual(['q1'])

    await client.commands.resumeQueue(THREAD)
    expect(thread().queue).toEqual({ items: [], pausedBy: null })
    const resumed = thread().turns.at(-1)!
    expect(resumed).toMatchObject({ state: 'running', commandId: 'q1' })

    await client.commands.queueMessage({ ...THREAD, text: 'c', commandId: 'q3' })
    client.failTurn({ ...THREAD, turnId: resumed.turnId }, 'provider_error', 'Boom')
    expect(thread().queue.pausedBy).toBe('failure')

    // A message already sent can no longer be taken out.
    await expect(
      client.commands.removeQueuedMessage({ ...THREAD, queueItemId: 'q1' }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('steers into the running turn: a user message of that turn, in its place', async () => {
    const client = createMockEnvironmentClient({ seed, respond: null, holdSteering: true })
    const turnId = await runningTurn(client)
    client.streamAssistantText({ ...THREAD, turnId }, 'Working on it.', 'a1')

    const answer = await client.commands.steerTurn({
      ...THREAD,
      turnId,
      text: 'use the other file',
      commandId: 's1',
    })
    expect(answer).toEqual({ queueItemId: 's1', outcome: 'steering' })
    const thread = () => client.getState().threads[THREAD.threadId]!
    expect(thread().queue.items).toEqual([
      expect.objectContaining({ queueItemId: 's1', delivery: 'steering' }),
    ])
    // With the provider already: it cannot be taken out.
    await expect(
      client.commands.removeQueuedMessage({ ...THREAD, queueItemId: 's1' }),
    ).rejects.toMatchObject({ code: 'conflict' })

    client.deliverSteering(THREAD)
    expect(thread().queue.items).toEqual([])
    const steered = thread().messages.filter(
      (message) => message.turnId === turnId && message.role === 'user',
    )
    expect(steered.map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'use the other file' }],
    ])
    expect(thread().order.map((ref) => ref.id)).toEqual([
      steered[0]!.messageId,
      'a1',
      steered[1]!.messageId,
    ])
    expect(thread().turns).toHaveLength(1)
  })

  it('queues a steer the provider cannot take, or one whose turn ended first', async () => {
    const opencode = createMockEnvironmentClient({
      seed: {
        ...seed,
        sessions: [{ session: SESSION, threads: [THREAD], providerId: 'opencode' }],
      },
      respond: null,
    })
    const turnId = await runningTurn(opencode)
    expect(
      await opencode.commands.steerTurn({ ...THREAD, turnId, text: 'x', commandId: 's1' }),
    ).toEqual({ queueItemId: 's1', outcome: 'queued' })

    const claude = createMockEnvironmentClient({ seed, respond: null, holdSteering: true })
    const running = await runningTurn(claude)
    await claude.commands.steerTurn({ ...THREAD, turnId: running, text: 'y', commandId: 's2' })
    claude.interruptTurn({ ...THREAD, turnId: running })
    // Given back: it waits for its own turn, and the stop holds the queue.
    expect(claude.getState().threads[THREAD.threadId]!.queue).toEqual({
      items: [expect.objectContaining({ queueItemId: 's2', delivery: 'queued' })],
      pausedBy: 'stop',
    })
  })

  it('refuses the queue commands where the environment does not offer them', async () => {
    const client = createMockEnvironmentClient({
      seed,
      capabilities: ['sendTurn', 'interruptTurn', 'openSession'],
    })
    expect(client.supports('queueMessage')).toBe(false)
    await expect(client.commands.queueMessage({ ...THREAD, text: 'x' })).rejects.toMatchObject({
      code: 'capability_missing',
    })
  })
})
