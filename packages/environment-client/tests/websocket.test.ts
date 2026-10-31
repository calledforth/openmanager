import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@openmanager/protocol'
import {
  DEFAULT_RECONNECT,
  createWebSocketEnvironmentClient,
  reconnectDelayMs,
  type WebSocketEnvironmentClientOptions,
  type WebSocketLike,
} from '../src/websocket'
import {
  selectActiveThread,
  selectComposerPreference,
  selectSessionComposer,
  selectProviderCatalog,
  selectSessionList,
} from '../src/state'
import type { EnvironmentClient } from '../src/types'
import { createEnvironmentStore } from '../src/store'
import { createInitialState, createThreadState } from '../src/state'
import {
  BARE_PROVIDER,
  ENV,
  PROVIDER,
  SESSION,
  SESSION_SUMMARY,
  THREAD,
  WORKSPACE,
  completed,
  delta,
  environmentScope,
  event,
  permission,
  threadScope,
  turnStarted,
} from './fixtures'

type Listener = (event: never) => void

/** A `session.open` position no held stream compares with: another epoch, so it applies. */
function unplacedRead(payload: unknown) {
  const { sessionId } = (payload as { session: { sessionId: string } }).session
  return {
    environment: { scope: environmentScope, epoch: 'read', sequence: 0 },
    session: {
      scope: { type: 'session', environmentId: ENV, sessionId },
      epoch: 'read',
      sequence: 0,
    },
  }
}

/** A scriptable server end of a socket; the client sees a WHATWG-shaped object. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: Array<{ type: string; requestId: string; name: string; payload: unknown }> = []
  /** Beats and acks (connection control), kept apart from commands. */
  control: Array<{ type: 'beat' } | { type: 'ack'; received: number }> = []
  binaryType = 'blob'
  private listeners = new Map<string, Listener[]>()
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeSocket.instances.push(this)
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string) {
    const message = JSON.parse(data)
    if (message.type === 'beat' || message.type === 'ack') this.control.push(message)
    else this.sent.push(message)
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }
  // --- server side -------------------------------------------------------
  open() {
    this.readyState = 1
    this.dispatch('open', undefined)
  }
  receive(message: unknown) {
    this.dispatch('message', { data: JSON.stringify(message) })
  }
  /** A message as binary fragments of `size` bytes each (flag included). */
  receiveFragments(message: unknown, size: number) {
    const bytes = new TextEncoder().encode(JSON.stringify(message))
    for (let offset = 0; offset < bytes.byteLength; offset += size - 1) {
      const slice = bytes.subarray(offset, offset + size - 1)
      const frame = new Uint8Array(slice.byteLength + 1)
      frame[0] = offset + size - 1 >= bytes.byteLength ? 2 : 1
      frame.set(slice, 1)
      this.dispatch('message', { data: frame.buffer })
    }
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }
  last(name: string) {
    return [...this.sent].reverse().find((message) => message.name === name)!
  }
  respond(name: string, payload: unknown) {
    this.receive({
      type: 'response',
      requestId: this.last(name).requestId,
      payload:
        name === 'session.open' ? { at: unplacedRead(payload), ...(payload as object) } : payload,
    })
  }
  private sequences = new Map<string, number>()
  /**
   * A durable event as the server sends it live: a record of its scope,
   * numbered after the last one this socket published there. For scopes
   * the client subscribed to without a replay, whose first record sets its
   * cursor.
   */
  publish(event: { scope: { type: string; sessionId?: string; threadId?: string } }) {
    const { type, sessionId, threadId } = event.scope
    const key = `${type}:${sessionId ?? ''}:${threadId ?? ''}`
    const sequence = (this.sequences.get(key) ?? 0) + 1
    this.sequences.set(key, sequence)
    this.receive({
      type: 'event',
      name: 'subscription.event',
      payload: {
        subscriptionId: 'live',
        record: { cursor: { scope: event.scope, epoch: 'live', sequence }, event },
      },
    })
  }
  private dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
}

const bootstrap = (capabilities: string[]) => ({
  protocolVersion: PROTOCOL_VERSION,
  instanceId: 'instance-1',
  environmentId: ENV,
  capabilities,
})

const FULL_CAPABILITIES = [
  'connection.heartbeat',
  'subscription.subscribe',
  'subscription.unsubscribe',
  'environment.get',
  'workspace.list',
  'workspace.icon',
  'subscription.replay',
  'session.create',
  'session.create.explicit',
  'session.open',
  'turn.send',
  'turn.interrupt',
  'interaction.respond',
]

function createTimers() {
  const queue: Array<{ fn: () => void; at: number; id: number }> = []
  let now = 0
  let id = 0
  return {
    now: () => now,
    setTimeout: (fn: () => void, delayMs: number) => {
      const entry = { fn, at: now + delayMs, id: ++id }
      queue.push(entry)
      return entry.id
    },
    clearTimeout: (handle: unknown) => {
      const index = queue.findIndex((entry) => entry.id === handle)
      if (index !== -1) queue.splice(index, 1)
    },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const next = queue.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        queue.splice(queue.indexOf(next), 1)
        now = next.at
        next.fn()
      }
      now = target
    },
    pending: () => queue.length,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const EMPTY_HISTORY: {
  messages: unknown[]
  turns: unknown[]
  interactions: Array<{ turnId?: string; interaction: unknown }>
} = { messages: [], turns: [], interactions: [] }

/** The newest `subscription.replay` this socket sent for a scope. */
function lastReplay(socket: FakeSocket, type: string, id?: string) {
  return [...socket.sent].reverse().find((message) => {
    if (message.name !== 'subscription.replay') return false
    const scope = (message.payload as { scope: Record<string, string> }).scope
    return scope.type === type && (!id || scope.threadId === id || scope.sessionId === id)
  })
}

/** Answer a replay of a scope with its whole snapshot. */
function answerSnapshot(
  socket: FakeSocket,
  request: { requestId: string; payload: unknown },
  subscriptionId: string,
  state: unknown,
  // Zero: records a test publishes (numbered from 1) follow the snapshot.
  sequence = 0,
) {
  const scope = (request.payload as { scope: unknown }).scope
  socket.receive({
    type: 'response',
    requestId: request.requestId,
    payload: {
      mode: 'snapshot',
      subscriptionId,
      reason: 'initial',
      // The epoch `FakeSocket.publish` numbers its records in.
      snapshot: { cursor: { scope, epoch: 'live', sequence }, state },
    },
  })
}

/** A thread's whole state, as its snapshot carries it. */
function threadState(thread: typeof THREAD, history: typeof EMPTY_HISTORY) {
  const turns = history.turns as Array<{ turnId: string; state: string }>
  const open = turns.find((turn) => turn.state === 'running' || turn.state === 'waiting')
  const messages = history.messages as Array<{ messageId: string; turnId: string }>
  return {
    thread,
    turns,
    messages,
    reasoning: [],
    tools: [],
    order: messages.map((message) => ({
      kind: 'message',
      id: message.messageId,
      turnId: message.turnId,
    })),
    listing: {},
    interactions: history.interactions.map((item) => ({
      turnId: item.turnId ?? open?.turnId ?? turns.at(-1)?.turnId ?? '',
      interaction: item.interaction,
    })),
  }
}

async function answerOpen(
  socket: FakeSocket,
  session = SESSION_SUMMARY,
  threads = [THREAD],
  history: typeof EMPTY_HISTORY = EMPTY_HISTORY,
) {
  socket.respond('session.open', { session, threads })
  await flush()
  const sessionReplay = lastReplay(socket, 'session', session.sessionId)
  if (sessionReplay) answerSnapshot(socket, sessionReplay, 'sub-session', { session, threads })
  for (const thread of threads) {
    const replay = lastReplay(socket, 'thread', thread.threadId)
    if (replay) answerSnapshot(socket, replay, 'sub-thread', threadState(thread, history))
  }
  await flush()
}

/** The environment's whole snapshot, as the first catch-up after a handshake brings it. */
async function answerCatalog(
  socket: FakeSocket,
  environment = { environmentId: ENV, name: 'Local' },
  state: Record<string, unknown> = {},
) {
  const replay = lastReplay(socket, 'environment')
  if (replay) {
    answerSnapshot(socket, replay, 'sub-env', {
      environment,
      workspaces: [WORKSPACE],
      sessions: [],
      preferences: [],
      providerProfiles: [],
      listings: { commands: [], configOptions: [], entries: [] },
      ...state,
    })
  }
  await flush()
}

async function connected(
  capabilities = FULL_CAPABILITIES,
  extraBootstrap: object = {},
  clientOptions: Partial<WebSocketEnvironmentClientOptions> = {},
) {
  FakeSocket.instances = []
  const timers = createTimers()
  let requests = 0
  const client = createWebSocketEnvironmentClient({
    url: 'ws://127.0.0.1:1/ws',
    credential: 'a'.repeat(64),
    WebSocket: FakeSocket,
    timers,
    now: timers.now,
    requestId: () => `req-${++requests}`,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2 },
    ...clientOptions,
  })
  client.connect()
  const socket = FakeSocket.instances[0]!
  socket.open()
  socket.respond('protocol.handshake', { ...bootstrap(capabilities), ...extraBootstrap })
  await flush()
  return { client, socket, timers }
}

describe('websocket environment client', () => {
  it('retains environment data and opens restored session scopes on a new replay-capable transport', async () => {
    const state = createInitialState()
    state.environment = { environmentId: ENV, name: 'Local' }
    state.sessions = { [SESSION.sessionId]: { ...SESSION_SUMMARY, threadIds: [THREAD.threadId] } }
    state.sessionOrder = [SESSION.sessionId]
    state.threads = { [THREAD.threadId]: createThreadState(THREAD, 'ready') }
    state.activeSessionId = SESSION.sessionId
    state.activeThreadId = THREAD.threadId
    const store = createEnvironmentStore(state)
    const first = createWebSocketEnvironmentClient({
      url: 'ws://localhost/ws',
      environmentId: ENV,
      store,
      WebSocket: FakeSocket,
    })
    first.dispose()
    const { client, socket } = await connected(
      ['subscription.subscribe', 'subscription.replay', 'session.open', 'session.history'],
      {},
      { environmentId: ENV, store },
    )
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(client.getState().threads[THREAD.threadId]!.messages).toBe(
      state.threads[THREAD.threadId]!.messages,
    )
    expect(socket.last('session.open').payload).toEqual({ sessionId: SESSION.sessionId })
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    expect(socket.last('subscription.replay').payload).toMatchObject({
      scope: { type: 'thread', threadId: THREAD.threadId },
      cursor: null,
    })
    client.dispose()
  })

  it('prevents a disposed pending open from changing its replacement selection', async () => {
    const store = createEnvironmentStore()
    const { client } = await connected(['session.open'], {}, { environmentId: ENV, store })
    const pending = client.commands.openSession('old-session').catch(() => undefined)
    client.dispose()
    const replacement = createWebSocketEnvironmentClient({
      url: 'wss://new-route/ws',
      environmentId: ENV,
      store,
      WebSocket: FakeSocket,
    })
    store.update((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        'new-session': { ...SESSION_SUMMARY, sessionId: 'new-session', threadIds: [] },
      },
    }))
    replacement.setActiveSession('new-session')
    await pending
    expect(store.getState().activeSessionId).toBe('new-session')
    expect(store.getState().sessionOpenFailure).toBeNull()
    replacement.dispose()
  })

  it('preserves a valid non-first thread when reopening the active session', async () => {
    const second = { ...THREAD, threadId: 'second-thread' }
    const store = createEnvironmentStore({
      ...createInitialState(),
      environment: { environmentId: ENV, name: 'Local' },
      sessions: {
        [SESSION.sessionId]: { ...SESSION_SUMMARY, threadIds: [THREAD.threadId, second.threadId] },
      },
      threads: {
        [THREAD.threadId]: createThreadState(THREAD),
        [second.threadId]: createThreadState(second),
      },
      activeSessionId: SESSION.sessionId,
      activeThreadId: second.threadId,
    })
    const { client, socket } = await connected(['session.open'], {}, { environmentId: ENV, store })
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD, second] })
    await flush()
    expect(client.getState().activeThreadId).toBe(second.threadId)
    client.dispose()
  })

  it('replaces the sidebar and preferences from the environment snapshot, keeping cached transcripts', async () => {
    const state = createInitialState()
    state.environment = { environmentId: ENV, name: 'Local' }
    state.workspaces = { [WORKSPACE.workspaceId]: WORKSPACE }
    state.workspaceOrder = [WORKSPACE.workspaceId]
    const gone = { ...SESSION_SUMMARY, sessionId: 'session-gone' }
    state.sessions = {
      [SESSION.sessionId]: { ...SESSION_SUMMARY, threadIds: [THREAD.threadId] },
      [gone.sessionId]: { ...gone, threadIds: [] },
    }
    state.sessionOrder = [SESSION.sessionId, gone.sessionId]
    state.threads = { [THREAD.threadId]: createThreadState(THREAD, 'ready') }
    state.composerPreferences = { [WORKSPACE.workspaceId]: { opencode: { modelId: 'old-model' } } }
    const store = createEnvironmentStore(state)
    const { client, socket } = await connected(FULL_CAPABILITIES, {}, { environmentId: ENV, store })
    // The cache holds no cursor: the environment answers with all of it.
    expect(lastReplay(socket, 'environment')?.payload).toEqual({
      scope: { type: 'environment', environmentId: ENV },
      cursor: null,
    })
    await answerCatalog(socket, undefined, {
      sessions: [SESSION_SUMMARY],
      preferences: [
        {
          workspaceId: WORKSPACE.workspaceId,
          providerId: 'opencode',
          preference: { modelId: 'new-model' },
          revision: 2,
        },
      ],
    })
    expect(selectSessionList(client.getState()).map((session) => session.sessionId)).toEqual([
      SESSION.sessionId,
    ])
    expect(client.getState().composerPreferences[WORKSPACE.workspaceId]?.opencode).toEqual({
      modelId: 'new-model',
    })
    expect(client.getState().threads[THREAD.threadId]).toBe(state.threads[THREAD.threadId])
    // No catalog walk.
    expect(socket.sent.some((message) => message.name === 'session.list')).toBe(false)
    client.dispose()
  })

  it('removes a restored session that the environment says was deleted', async () => {
    const state = createInitialState()
    state.sessions = { [SESSION.sessionId]: { ...SESSION_SUMMARY, threadIds: [THREAD.threadId] } }
    state.sessionOrder = [SESSION.sessionId]
    state.activeSessionId = SESSION.sessionId
    const store = createEnvironmentStore(state)
    const { client, socket } = await connected(['session.open'], {}, { environmentId: ENV, store })
    socket.receive({
      type: 'error',
      requestId: socket.last('session.open').requestId,
      error: { code: 'not_found', message: 'Session not found.' },
    })
    await flush()
    expect(client.getState().sessions[SESSION.sessionId]).toBeUndefined()
    expect(client.getState().activeSessionId).toBeNull()
    client.dispose()
  })

  it('rejects a shared store without an identity or with a different identity', () => {
    const store = createEnvironmentStore({
      ...createInitialState(),
      environment: { environmentId: ENV, name: 'Local' },
    })
    expect(() =>
      createWebSocketEnvironmentClient({ url: 'ws://localhost/ws', store, WebSocket: FakeSocket }),
    ).toThrow('requires an environment ID')
    expect(() =>
      createWebSocketEnvironmentClient({
        url: 'ws://localhost/ws',
        environmentId: 'other',
        store,
        WebSocket: FakeSocket,
      }),
    ).toThrow('different environment')
  })

  it('rejects rename on older servers without sending the command', async () => {
    const { client, socket } = await connected()
    await expect(client.commands.renameSession(SESSION.sessionId, 'Name')).rejects.toMatchObject({
      code: 'capability_missing',
    })
    expect(socket.sent.some((message) => message.name === 'session.rename')).toBe(false)
    client.disconnect()
  })

  // Switching is on screen from the click. Until the reply the next session
  // is selected with nothing known about its threads, which reads as loading;
  // clearing the selection instead read as the new-session landing.
  it('selects a listed session as soon as it is opened, before the environment answers', async () => {
    const { client, socket } = await connected()
    const OTHER = { ...SESSION_SUMMARY, sessionId: 'session-2' }
    const OTHER_THREAD = { threadId: 'thread-2', sessionId: OTHER.sessionId }
    await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY, OTHER] })
    await flush()
    const first = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await first
    expect(client.getState().activeThreadId).toBe(THREAD.threadId)

    client.setActiveSession(null)
    const switched = client.commands.openSession(OTHER.sessionId)
    expect(client.getState().activeSessionId).toBe(OTHER.sessionId)
    expect(client.getState().activeThreadId).toBeNull()

    await answerOpen(socket, OTHER, [OTHER_THREAD])
    await switched
    expect(client.getState().activeSessionId).toBe(OTHER.sessionId)
    expect(client.getState().activeThreadId).toBe(OTHER_THREAD.threadId)
    expect(client.getState().threads[OTHER_THREAD.threadId]?.hydration).toBe('ready')

    // Back to a session whose thread is known: it is selected loading, on its thread.
    client.setActiveSession(null)
    const back = client.commands.openSession(SESSION.sessionId)
    expect(client.getState().activeThreadId).toBe(THREAD.threadId)
    expect(client.getState().threads[THREAD.threadId]?.hydration).toBe('loading')
    await answerOpen(socket)
    await back
    expect(client.getState().threads[THREAD.threadId]?.hydration).toBe('ready')
    client.disconnect()
  })

  // Opens that overtake each other must still release the session they left:
  // B is selected the moment it is opened, so C's open sees B, not A, as the
  // previous session, and A has to have gone when B was picked.
  it('releases the session left behind when an open overtakes another', async () => {
    const { client, socket } = await connected()
    const listed = ['session-2', 'session-3'].map((sessionId) => ({
      ...SESSION_SUMMARY,
      sessionId,
    }))
    await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY, ...listed] })
    await flush()
    const first = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await first
    // B's open is overtaken before it is answered.
    void client.commands.openSession('session-2').catch(() => undefined)
    const toC = client.commands.openSession('session-3')
    await answerOpen(socket, listed[1]!, [{ threadId: 'thread-3', sessionId: 'session-3' }])
    await toC
    const released = socket.sent
      .filter((message) => message.name === 'subscription.unsubscribe')
      .map((message) => (message.payload as { subscriptionId: string }).subscriptionId)
    expect(released).toEqual(['sub-session', 'sub-thread'])
    expect(client.getState().activeSessionId).toBe('session-3')
    client.disconnect()
  })

  it('sends rename and delete commands and updates the local session', async () => {
    const { client, socket } = await connected([
      ...FULL_CAPABILITIES,
      'session.rename',
      'session.delete',
    ])
    await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY] })
    await flush()
    const rename = client.commands.renameSession(SESSION.sessionId, 'Renamed')
    expect(socket.last('session.rename').payload).toEqual({
      sessionId: SESSION.sessionId,
      title: 'Renamed',
    })
    socket.respond('session.rename', { session: { ...SESSION, title: 'Renamed' } })
    await rename
    expect(client.getState().sessions[SESSION.sessionId]?.title).toBe('Renamed')
    const remove = client.commands.deleteSession(SESSION.sessionId)
    expect(socket.last('session.delete').payload).toEqual({ sessionId: SESSION.sessionId })
    socket.respond('session.delete', null)
    await remove
    expect(client.getState().sessions[SESSION.sessionId]).toBeUndefined()
    client.disconnect()
  })

  it('settles at once, and neither the echo nor the answer moves it again', async () => {
    const { client, socket } = await connected([...FULL_CAPABILITIES, 'session.settle'])
    await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY] })
    await flush()
    // Settled or not, as shown, through every step.
    const placements: boolean[] = []
    client.subscribe(() =>
      placements.push(Boolean(client.getState().sessions[SESSION.sessionId]?.settledAt)),
    )

    const settling = client.commands.settleSession(SESSION.sessionId, true)
    expect(socket.last('session.settle').payload).toEqual({
      sessionId: SESSION.sessionId,
      settled: true,
    })
    const shown = client.getState().sessions[SESSION.sessionId]?.settledAt
    expect(shown).toEqual(expect.any(String))
    // An overlay entry, not a write to the server's session.
    expect(client.getState().pending.settles[SESSION.sessionId]).toMatchObject({ settled: true })

    // The environment announces the settle before it answers the command.
    socket.receive({
      type: 'event',
      name: 'subscription.event',
      payload: {
        subscriptionId: 'sub-env',
        record: {
          cursor: {
            scope: { type: 'environment', environmentId: ENV },
            epoch: 'live',
            sequence: 1,
          },
          event: event({
            name: 'session.updated',
            scope: environmentScope,
            payload: { sessionId: SESSION.sessionId, settledAt: shown! },
          }),
        },
      },
    })
    socket.respond('session.settle', { settledAt: shown! })
    await settling
    expect(client.getState().sessions[SESSION.sessionId]?.settledAt).toBe(shown)
    expect(client.getState().pending.settles).toEqual({})
    expect(placements.every(Boolean)).toBe(true)
    client.disconnect()
  })

  it('regenerates a title: the event, not the answer, brings it and its source', async () => {
    const { client, socket } = await connected([...FULL_CAPABILITIES, 'session.title.regenerate'])
    await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY] })
    await flush()
    expect(client.supports('regenerateSessionTitle')).toBe(true)
    const regenerate = client.commands.regenerateSessionTitle(SESSION.sessionId)
    expect(socket.last('session.title.regenerate').payload).toEqual({
      sessionId: SESSION.sessionId,
    })
    socket.respond('session.title.regenerate', {
      session: { ...SESSION, title: 'Fix Login Redirect' },
    })
    await regenerate
    expect(client.getState().sessions[SESSION.sessionId]?.title).toBe(SESSION_SUMMARY.title)
    socket.publish(
      event({
        name: 'session.updated',
        scope: environmentScope,
        payload: {
          sessionId: SESSION.sessionId,
          title: 'Fix Login Redirect',
          titleSource: 'generated',
        },
      }),
    )
    expect(client.getState().sessions[SESSION.sessionId]).toMatchObject({
      title: 'Fix Login Redirect',
      titleSource: 'generated',
    })
    client.disconnect()
  })

  it('stops background work by session, naming the tasks when given', async () => {
    const { client, socket } = await connected([...FULL_CAPABILITIES, 'session.background.stop'])
    expect(client.supports('stopBackgroundTasks')).toBe(true)

    const one = client.commands.stopBackgroundTasks({
      sessionId: SESSION.sessionId,
      taskIds: ['task-1'],
    })
    expect(socket.last('session.background.stop').payload).toEqual({
      sessionId: SESSION.sessionId,
      taskIds: ['task-1'],
    })
    socket.respond('session.background.stop', null)
    await one

    const all = client.commands.stopBackgroundTasks({ sessionId: SESSION.sessionId })
    expect(socket.last('session.background.stop').payload).toEqual({
      sessionId: SESSION.sessionId,
    })
    socket.respond('session.background.stop', null)
    await all
    client.disconnect()
  })

  it('rejects regenerating a title on servers that cannot', async () => {
    const { client, socket } = await connected()
    expect(client.supports('regenerateSessionTitle')).toBe(false)
    await expect(client.commands.regenerateSessionTitle(SESSION.sessionId)).rejects.toMatchObject({
      code: 'capability_missing',
    })
    expect(socket.sent.some((message) => message.name === 'session.title.regenerate')).toBe(false)
    client.disconnect()
  })

  it('resolves an overtaken open of the same session only once the chat is ready', async () => {
    const { client, socket } = await connected()
    const first = client.commands.openSession(SESSION.sessionId)
    const firstId = socket.last('session.open').requestId
    const second = client.commands.openSession(SESSION.sessionId)
    let firstSettled = false
    void first.finally(() => {
      firstSettled = true
    })
    // The first's own answer lands: it does not resolve on it any more (§4.7.5).
    socket.receive({
      type: 'response',
      requestId: firstId,
      payload: { session: SESSION_SUMMARY, threads: [THREAD] },
    })
    await flush()
    await flush()
    expect(firstSettled).toBe(false)
    await answerOpen(socket)
    await second
    await first
    expect(selectActiveThread(client.getState())?.hydration).toBe('ready')
  })

  it('follows the newest open of a session through A, B, A; B is superseded', async () => {
    const { client, socket } = await connected()
    const firstA = client.commands.openSession(SESSION.sessionId)
    const firstId = socket.last('session.open').requestId
    const b = client.commands.openSession('session-2')
    const bId = socket.last('session.open').requestId
    const supersededB = expect(b).rejects.toMatchObject({ code: 'superseded' })
    const thirdA = client.commands.openSession(SESSION.sessionId)
    // The environment answers every open, oldest first.
    for (const [requestId, sessionId] of [
      [firstId, SESSION.sessionId],
      [bId, 'session-2'],
    ] as const) {
      socket.receive({
        type: 'response',
        requestId,
        payload: {
          session: { ...SESSION_SUMMARY, sessionId },
          threads: [{ ...THREAD, sessionId, threadId: `${sessionId}-thread` }],
        },
      })
    }
    await flush()
    await answerOpen(socket)
    await thirdA
    await firstA
    await supersededB
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
  })

  it('rejects an open with the failure of a thread that could not load', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    socket.receive({
      type: 'error',
      requestId: lastReplay(socket, 'thread')!.requestId,
      error: { code: 'internal', message: 'History is unreadable.' },
    })
    await expect(opened).rejects.toMatchObject({ message: 'History is unreadable.' })
    expect(selectActiveThread(client.getState())?.hydration).toBe('failed')
  })

  it('rejects an open with the transport error when the connection drops during it', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    // The history read is out; the socket drops before it is answered.
    socket.drop(1006, 'gone')
    await expect(opened).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('does not show a stale open failure after navigating away', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    // Overtaken by the new selection: nothing for the caller to report.
    const rejected = expect(opened).rejects.toMatchObject({ code: 'superseded' })
    client.setActiveSession(null)
    socket.receive({
      type: 'error',
      requestId: socket.last('session.open').requestId,
      error: { code: 'not_found', message: 'Folder unavailable' },
    })
    await rejected
    expect(client.getState().sessionOpenFailure).toBeFalsy()
    expect(client.getState().activeSessionId).toBeNull()
  })

  it('retains an open failure before threads load and clears it after a successful retry', async () => {
    const { client, socket } = await connected()
    await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY] })
    await flush()
    const opened = client.commands.openSession(SESSION.sessionId)
    const rejected = expect(opened).rejects.toThrow('Folder unavailable')
    socket.receive({
      type: 'error',
      requestId: socket.last('session.open').requestId,
      error: {
        code: 'workspace_unavailable',
        message: 'Folder unavailable',
        details: { workspaceId: SESSION.workspaceId, availability: 'inaccessible' },
      },
    })
    await rejected
    // The code and cause travel with the failure so the pane can offer the
    // recovery actions for that cause instead of a generic "could not open".
    expect(client.getState().sessionOpenFailure).toEqual({
      sessionId: SESSION.sessionId,
      message: 'Folder unavailable',
      code: 'workspace_unavailable',
      availability: 'inaccessible',
    })
    expect(selectSessionList(client.getState())).toHaveLength(1)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    const retry = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await retry
    expect(client.getState().sessionOpenFailure).toBeNull()
    expect(selectActiveThread(client.getState())?.hydration).toBe('ready')
  })

  describe('opening a session with no connection', () => {
    function cachedStore(hydration: 'ready' | 'loading' | 'idle', messages: unknown[]) {
      const state = createInitialState()
      state.environment = { environmentId: ENV, name: 'Local' }
      state.sessions = { [SESSION.sessionId]: { ...SESSION_SUMMARY, threadIds: [THREAD.threadId] } }
      state.sessionOrder = [SESSION.sessionId]
      state.threads = {
        [THREAD.threadId]: {
          ...createThreadState(THREAD, hydration),
          messages: messages as never,
        },
      }
      return createEnvironmentStore(state)
    }
    const offlineClient = (hydration: 'ready' | 'loading' | 'idle', messages: unknown[] = []) => {
      FakeSocket.instances = []
      return createWebSocketEnvironmentClient({
        url: 'ws://127.0.0.1:1/ws',
        WebSocket: FakeSocket,
        environmentId: ENV,
        store: cachedStore(hydration, messages),
      })
    }

    // An open cut off by a drop leaves its threads loading; a chat is no less
    // readable for that.
    it.each(['ready', 'loading', 'idle'] as const)('keeps a chat read as %s readable, with no failure on top', async (hydration) => {
      const client = offlineClient(hydration, [{ messageId: 'cached' }])
      await expect(client.commands.openSession(SESSION.sessionId)).rejects.toMatchObject({
        code: 'unavailable',
      })
      expect(client.getState().sessionOpenFailure).toBeNull()
      expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
      expect(selectActiveThread(client.getState())?.hydration).toBe('ready')
      expect(FakeSocket.instances).toHaveLength(0)
    })

    it.each(['ready', 'idle'] as const)('still says so when a %s thread has nothing to read', async (hydration) => {
      const client = offlineClient(hydration)
      await expect(client.commands.openSession(SESSION.sessionId)).rejects.toMatchObject({
        code: 'unavailable',
      })
      expect(client.getState().sessionOpenFailure).toMatchObject({
        sessionId: SESSION.sessionId,
        code: 'unavailable',
      })
    })
  })

  it('authenticates through subprotocols and negotiates the handshake', async () => {
    const { client, socket } = await connected()
    expect(socket.protocols).toEqual(['openmanager.v1', `openmanager.auth.${'a'.repeat(64)}`])
    const handshake = socket.sent[0]!
    expect(handshake.name).toBe('protocol.handshake')
    expect(handshake.payload).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      requiredCapabilities: [],
    })
    expect(client.getState().connection).toMatchObject({ phase: 'connected', hasConnected: true })
    expect(client.supports('sendTurn')).toBe(true)
    expect(client.supports('deleteSession')).toBe(false)
  })

  it('catches the environment scope up after the handshake: the whole environment, once', async () => {
    const { client, socket } = await connected()
    expect(lastReplay(socket, 'environment')?.payload).toEqual({
      scope: { type: 'environment', environmentId: ENV },
      cursor: null,
    })
    expect(socket.sent.some((message) => message.name === 'subscription.subscribe')).toBe(false)
    await answerCatalog(socket)
    expect(client.getState().environment?.name).toBe('Local')
    expect(client.getState().workspaces[WORKSPACE.workspaceId]).toEqual(WORKSPACE)
  })

  it('names the environment from the handshake label when it cannot answer environment.get', async () => {
    const { client, socket } = await connected(
      FULL_CAPABILITIES.filter((name) => name !== 'environment.get'),
      { label: '  devbox  ' },
    )
    expect(client.getState().environment).toEqual({ environmentId: ENV, name: 'devbox' })
    expect(socket.sent.some((message) => message.name === 'environment.get')).toBe(false)
  })

  it('seeds providers and their health from the handshake', async () => {
    const { client, socket } = await connected(FULL_CAPABILITIES, { providers: [BARE_PROVIDER] })
    expect(selectProviderCatalog(client.getState())).toEqual([BARE_PROVIDER])
    expect(socket.sent.some((message) => message.name === 'provider.catalog.get')).toBe(false)
  })

  it('keeps a read profile when a reconnect handshake lists the provider again', async () => {
    const { client, socket, timers } = await connected(
      [...FULL_CAPABILITIES, 'provider.catalog.get'],
      { providers: [BARE_PROVIDER] },
    )
    socket.respond('provider.catalog.get', { providers: [PROVIDER] })
    await flush()
    socket.drop()
    timers.advance(1000)
    const next = FakeSocket.instances.at(-1)!
    next.open()
    const unhealthy = { ...BARE_PROVIDER.health, summary: 'error', auth: 'unauthenticated' }
    next.respond('protocol.handshake', {
      ...bootstrap(FULL_CAPABILITIES),
      providers: [{ ...BARE_PROVIDER, health: unhealthy }],
    })
    await flush()
    expect(client.getState().providers.opencode).toEqual({ ...PROVIDER, health: unhealthy })
  })

  it('folds provider_health_changed into the listed provider and ignores strangers', async () => {
    const { client, socket } = await connected(FULL_CAPABILITIES, { providers: [BARE_PROVIDER] })
    const health = { ...BARE_PROVIDER.health, summary: 'error', install: 'missing' }
    socket.receive({
      type: 'event',
      name: 'provider_health_changed',
      payload: { providerId: 'opencode', health },
    })
    socket.receive({
      type: 'event',
      name: 'provider_health_changed',
      payload: { providerId: 'cursor', health },
    })
    expect(client.getState().providers.opencode?.health).toEqual(health)
    expect(client.getState().providerOrder).toEqual(['opencode'])
    // An unchanged reading must not wake subscribers.
    const before = client.getState()
    socket.receive({
      type: 'event',
      name: 'provider_health_changed',
      payload: { providerId: 'opencode', health },
    })
    expect(client.getState()).toBe(before)
  })

  it('manages the device list and hears it change', async () => {
    const clientCommands = [
      'client.list',
      'client.rename',
      'client.revoke',
      'client.revoke_others',
      'client.owner.rotate',
    ]
    const { client, socket } = await connected([...FULL_CAPABILITIES, ...clientCommands])
    const owner = {
      clientId: 'client-owner',
      label: 'Desk',
      kind: 'owner',
      capabilities: ['read', 'operate', 'agent', 'terminal', 'admin'],
      createdAt: '2026-10-01T10:00:00.000Z',
      lastSeenAt: '2026-10-02T10:00:00.000Z',
      expiresAt: '2026-11-01T10:00:00.000Z',
      connected: true,
    }
    const phone = {
      ...owner,
      clientId: 'client-phone',
      label: 'Phone',
      kind: 'paired',
      capabilities: ['read'],
      connected: false,
    }
    const heard: unknown[] = []
    const stop = client.onAuthorizedClientsChanged!((list) => heard.push(list))

    const listed = client.commands.listAuthorizedClients()
    socket.respond('client.list', {
      clients: [owner, phone],
      currentClientId: 'client-owner',
      omitted: 0,
    })
    await expect(listed).resolves.toEqual({
      clients: [owner, phone],
      currentClientId: 'client-owner',
      omitted: 0,
    })

    const renamed = client.commands.renameAuthorizedClient('client-phone', 'Pixel')
    expect(socket.last('client.rename').payload).toEqual({
      clientId: 'client-phone',
      label: 'Pixel',
    })
    socket.respond('client.rename', { client: { ...phone, label: 'Pixel' } })
    await expect(renamed).resolves.toMatchObject({ label: 'Pixel' })

    const revoked = client.commands.revokeAuthorizedClient('client-phone')
    socket.respond('client.revoke', { clientId: 'client-phone' })
    await expect(revoked).resolves.toBeUndefined()

    const others = client.commands.revokeOtherAuthorizedClients()
    socket.respond('client.revoke_others', { revokedClientIds: ['a', 'b'] })
    await expect(others).resolves.toEqual(['a', 'b'])

    const rotated = client.commands.rotateOwnerCredential()
    const credential = `omc1.${'z'.repeat(43)}`
    socket.respond('client.owner.rotate', { client: owner, credential })
    await expect(rotated).resolves.toEqual({ client: owner, credential })

    socket.receive({
      type: 'event',
      name: 'client.list.changed',
      payload: { clients: [owner], currentClientId: 'client-owner', omitted: 0 },
    })
    expect(heard).toEqual([{ clients: [owner], currentClientId: 'client-owner', omitted: 0 }])
    stop()
    socket.receive({
      type: 'event',
      name: 'client.list.changed',
      payload: { clients: [], currentClientId: 'client-owner', omitted: 0 },
    })
    expect(heard).toHaveLength(1)
  })

  it('creates, lists, withdraws and redeems pairing links', async () => {
    const pairingCommands = ['pairing.create', 'pairing.list', 'pairing.revoke', 'pairing.redeem']
    const { client, socket } = await connected([...FULL_CAPABILITIES, ...pairingCommands])
    const link = {
      linkId: 'link-1',
      label: null,
      capabilities: ['read', 'operate'],
      createdByClientId: 'client-owner',
      createdAt: '2026-10-01T10:00:00.000Z',
      expiresAt: '2026-10-01T10:05:00.000Z',
      status: 'waiting',
      usedByClientId: null,
      usedAt: null,
    }

    const created = client.commands.createPairingLink({ capabilities: ['read', 'operate'] })
    expect(socket.last('pairing.create').payload).toEqual({ capabilities: ['read', 'operate'] })
    socket.respond('pairing.create', { link, token: 'ABCDEFGHJKMN' })
    await expect(created).resolves.toEqual({ link, token: 'ABCDEFGHJKMN' })

    const listed = client.commands.listPairingLinks()
    socket.respond('pairing.list', { links: [link] })
    await expect(listed).resolves.toEqual([link])

    const withdrawn = client.commands.revokePairingLink('link-1')
    expect(socket.last('pairing.revoke').payload).toEqual({ linkId: 'link-1' })
    socket.respond('pairing.revoke', { linkId: 'link-1' })
    await expect(withdrawn).resolves.toBeUndefined()

    const redeemed = client.commands.redeemPairingLink({ token: 'ABCDEFGHJKMN' })
    expect(socket.last('pairing.redeem').payload).toEqual({ token: 'ABCDEFGHJKMN' })
    const answer = {
      clientId: 'client-phone',
      clientLabel: 'Phone',
      grant: ['read', 'operate'],
      grantChanged: true,
    }
    socket.respond('pairing.redeem', answer)
    await expect(redeemed).resolves.toEqual(answer)
  })

  it('stops for good when its credential is revoked instead of redialing', async () => {
    const { client, socket, timers } = await connected()
    socket.drop(4401, 'revoked')
    expect(client.getState().connection).toMatchObject({
      phase: 'closed',
      failure: { code: 'auth' },
      retriesExhausted: true,
    })
    timers.advance(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('stops for good when the environment does not know its credential', async () => {
    // A browser cannot read a refused upgrade, so the environment closes an
    // accepted one with the revocation code and its own reason.
    const { client, socket, timers } = await connected()
    socket.drop(4401, 'unauthorized')
    expect(client.getState().connection).toMatchObject({
      phase: 'closed',
      failure: { code: 'auth', message: 'Token not recognized.' },
      retriesExhausted: true,
    })
    timers.advance(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('says the environment shut down, then redials as for any drop', async () => {
    const { client, socket, timers } = await connected()
    socket.drop(1001, 'server_shutdown')
    expect(client.getState().connection).toMatchObject({
      phase: 'reconnecting',
      failure: { code: 'unavailable', serverStopped: true },
      retriesExhausted: false,
    })
    timers.advance(60_000)
    expect(FakeSocket.instances.length).toBeGreaterThan(1)

    // Any other close says nothing about why.
    const other = await connected()
    other.socket.drop(1001, 'going away')
    expect(other.client.getState().connection.failure).not.toHaveProperty('serverStopped')
  })

  it('probes a provider only when the environment advertises it', async () => {
    const older = await connected(FULL_CAPABILITIES, { providers: [BARE_PROVIDER] })
    expect(older.client.supports('probeProvider')).toBe(false)
    const sent = older.socket.sent.length
    await expect(
      older.client.commands.probeProvider({ providerId: 'opencode', workspaceId: 'ws-1' }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
    expect(older.socket.sent.length).toBe(sent)

    const { client, socket } = await connected(
      [...FULL_CAPABILITIES, 'provider.catalog.get', 'provider.probe'],
      { providers: [BARE_PROVIDER] },
    )
    socket.respond('provider.catalog.get', { providers: [PROVIDER] })
    await flush()
    const probe = client.commands.probeProvider({ providerId: 'opencode', workspaceId: 'ws-1' })
    expect(socket.last('provider.probe').payload).toEqual({
      providerId: 'opencode',
      workspaceId: 'ws-1',
    })
    const health = { ...BARE_PROVIDER.health, summary: 'error', auth: 'unauthenticated' }
    socket.respond('provider.probe', { provider: { ...BARE_PROVIDER, health } })
    await expect(probe).resolves.toEqual({ ...BARE_PROVIDER, health })
    // The probe answer carries no profile; the one already read stays.
    expect(client.getState().providers.opencode).toEqual({ ...PROVIDER, health })
  })

  it('refuses commands the environment does not advertise before sending anything', async () => {
    const { client, socket } = await connected(['session.create'])
    const before = socket.sent.length
    await expect(client.commands.deleteSession('x')).rejects.toMatchObject({
      code: 'capability_missing',
    })
    expect(socket.sent.length).toBe(before)
  })

  it('opens a session, hydrates it, subscribes to its scopes and applies live events', async () => {
    const { client, socket } = await connected()
    const open = client.commands.openSession(SESSION.sessionId)
    expect(socket.last('session.open').payload).toEqual({ sessionId: SESSION.sessionId })
    await answerOpen(socket)
    await flush()
    const scopes = socket.sent
      .filter((message) => message.name === 'subscription.replay')
      .map((message) => (message.payload as { scope: { type: string } }).scope.type)
    expect(scopes).toEqual(['environment', 'session', 'thread'])
    await open
    expect(client.getState().activeThreadId).toBe(THREAD.threadId)
    expect(selectActiveThread(client.getState())?.hydration).toBe('ready')

    const record = (sequence: number, event: unknown) => ({
      type: 'event',
      name: 'subscription.event',
      payload: {
        subscriptionId: 'sub-thread',
        record: {
          cursor: {
            scope: { ...THREAD, type: 'thread', environmentId: ENV },
            epoch: 'live',
            sequence,
          },
          event,
        },
      },
    })
    socket.receive(record(1, turnStarted()))
    socket.receive(record(2, delta('turn-1', 'assistant-1', 'Hi')))
    socket.receive(record(2, delta('turn-1', 'assistant-1', 'Hi'))) // duplicate delivery
    socket.receive(record(3, delta('turn-1', 'assistant-1', '!')))
    const thread = selectActiveThread(client.getState())!
    expect(thread.messages[1]?.content).toEqual([{ type: 'text', text: 'Hi!' }])
    expect(selectSessionList(client.getState())[0]?.status).toBe('idle')
  })

  it('sends a turn; the answer changes nothing, and its event brings the turn', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({ ...THREAD, text: 'go', commandId: 'cmd-1' })
    expect(socket.last('turn.send').payload).toEqual({
      ...THREAD,
      text: 'go',
      commandId: 'cmd-1',
    })
    const before = client.getState().threads
    socket.respond('turn.send', turnStarted('turn-9', 'go', 'cmd-1').payload)
    const result = await sending
    expect(result.turn.turnId).toBe('turn-9')
    // A mutation answer is an acknowledgement (§4.7.10): the echo waits for the event.
    expect(client.getState().threads).toBe(before)
    socket.publish(turnStarted('turn-9', 'go', 'cmd-1'))
    expect(selectActiveThread(client.getState())?.turns[0]?.state).toBe('running')
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
  })

  it('echoes the message before the environment answers and mints a command id', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({ ...THREAD, text: 'go' })
    const sent = socket.last('turn.send').payload as { commandId: string }
    expect(sent.commandId).toEqual(expect.any(String))
    expect(selectActiveThread(client.getState())?.outbox).toEqual([
      { commandId: sent.commandId, text: 'go', status: 'pending' },
    ])
    socket.respond('turn.send', turnStarted('turn-9', 'go', sent.commandId).payload)
    await sending
    expect(selectActiveThread(client.getState())?.outbox).toHaveLength(1)
    socket.publish(turnStarted('turn-9', 'go', sent.commandId))
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
  })

  it('changes nothing for a retried send the environment answers from its log', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    socket.publish(turnStarted('turn-9', 'go', 'cmd-1'))
    socket.publish(
      event({
        name: 'turn.completed',
        scope: { type: 'thread', environmentId: ENV, ...THREAD },
        payload: { turnId: 'turn-9' },
      }),
    )
    const before = client.getState().threads
    // The cached answer describes the turn as it started; it must not rewind it.
    const retry = client.commands.sendTurn({ ...THREAD, text: 'go', commandId: 'cmd-1' })
    socket.respond('turn.send', turnStarted('turn-9', 'go', 'cmd-1').payload)
    await retry
    expect(selectActiveThread(client.getState())?.turns[0]?.state).toBe('completed')
    expect(client.getState().threads[THREAD.threadId]?.turns).toBe(before[THREAD.threadId]?.turns)
  })

  it('keeps one row when the event arrives before the response, and after it', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({ ...THREAD, text: 'go', commandId: 'cmd-1' })
    socket.publish(turnStarted('turn-9', 'go', 'cmd-1'))
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
    socket.respond('turn.send', turnStarted('turn-9', 'go', 'cmd-1').payload)
    await sending
    socket.publish(turnStarted('turn-9', 'go', 'cmd-1'))
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
    expect(selectActiveThread(client.getState())?.turns).toHaveLength(1)
  })

  it('marks a rejected send failed and reuses its row on retry', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({ ...THREAD, text: 'go', commandId: 'cmd-1' })
    const rejected = expect(sending).rejects.toThrow('Provider is down')
    socket.receive({
      type: 'error',
      requestId: socket.last('turn.send').requestId,
      error: { code: 'unavailable', message: 'Provider is down' },
    })
    await rejected
    expect(selectActiveThread(client.getState())?.outbox).toEqual([
      { commandId: 'cmd-1', text: 'go', status: 'failed', error: 'Provider is down' },
    ])

    const retry = client.commands.sendTurn({ ...THREAD, text: 'go', commandId: 'cmd-1' })
    expect(selectActiveThread(client.getState())?.outbox).toEqual([
      { commandId: 'cmd-1', text: 'go', status: 'pending' },
    ])
    socket.respond('turn.send', turnStarted('turn-9', 'go', 'cmd-1').payload)
    await retry
    socket.publish(turnStarted('turn-9', 'go', 'cmd-1'))
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
  })

  it('names uploaded artifacts on the send and keeps them for a retry', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({
      ...THREAD,
      text: 'look',
      artifactIds: ['artifact-1'],
      commandId: 'cmd-1',
    })
    expect(socket.last('turn.send').payload).toEqual({
      ...THREAD,
      text: 'look',
      artifactIds: ['artifact-1'],
      commandId: 'cmd-1',
    })
    const rejected = expect(sending).rejects.toMatchObject({ code: 'unavailable' })
    socket.receive({
      type: 'error',
      requestId: socket.last('turn.send').requestId,
      error: { code: 'unavailable', message: 'Provider is offline.' },
    })
    await rejected
    expect(selectActiveThread(client.getState())?.outbox).toEqual([
      {
        commandId: 'cmd-1',
        text: 'look',
        artifactIds: ['artifact-1'],
        status: 'failed',
        error: 'Provider is offline.',
      },
    ])
  })

  it('reads artifact bytes from the HTTP route beside the socket, with the credential', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const { client } = await connected(FULL_CAPABILITIES, {}, {
      // A tunnel may put a path prefix in front of the environment.
      url: 'wss://tunnel.example/env-1/ws',
      credential: 'secret',
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
        })
        return new Response(new Blob(['png-bytes'], { type: 'image/png' }))
      },
    })
    const blob = await client.fetchArtifact!({ sessionId: 'session 1', artifactId: 'artifact-1' })
    expect(await blob.text()).toBe('png-bytes')
    expect(requests).toEqual([
      {
        url: 'https://tunnel.example/env-1/artifacts/session%201/artifact-1',
        authorization: 'Bearer secret',
      },
    ])
    client.dispose()
  })

  it('maps a refused artifact read to a typed error', async () => {
    const answer = async (status: number, body: unknown) => {
      const { client } = await connected(FULL_CAPABILITIES, {}, {
        fetch: async () => new Response(JSON.stringify(body), { status }),
      })
      return client.fetchArtifact!({ sessionId: 's', artifactId: 'a' })
    }

    await expect(
      answer(401, { error: { code: 'auth', message: 'A valid client credential is required.' } }),
    ).rejects.toMatchObject({ code: 'auth', message: 'A valid client credential is required.' })
    await expect(answer(404, {})).rejects.toMatchObject({ code: 'not_found' })
    await expect(answer(429, null)).rejects.toMatchObject({ code: 'unavailable' })
    const { client } = await connected(FULL_CAPABILITIES, {}, {
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await expect(
      client.fetchArtifact!({ sessionId: 's', artifactId: 'a' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reads no artifact, so sends no token, without a handshake holding', async () => {
    const fetchBytes = vi.fn(async () => new Response('bytes'))
    const { client, socket } = await connected(FULL_CAPABILITIES, {}, { fetch: fetchBytes })
    await client.fetchArtifact!({ sessionId: 's', artifactId: 'a' })
    expect(fetchBytes).toHaveBeenCalledTimes(1)

    // The address may lead somewhere else now, and only a handshake would say.
    socket.close(1006)
    await flush()

    await expect(
      client.fetchArtifact!({ sessionId: 's', artifactId: 'a' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(fetchBytes).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('uploads an artifact with a ticket and a PUT of the bytes beside the socket', async () => {
    const requests: Array<{
      url: string
      method: string | undefined
      authorization: string | null
      contentType: string | null
      body: string
    }> = []
    const { client, socket } = await connected(
      [...FULL_CAPABILITIES, 'upload.ticket.create'],
      {},
      {
        url: 'wss://tunnel.example/env-1/ws',
        fetch: async (input, init) => {
          requests.push({
            url: String(input),
            method: init?.method,
            authorization: new Headers(init?.headers).get('authorization'),
            contentType: new Headers(init?.headers).get('content-type'),
            body: await new Response(init?.body as Blob).text(),
          })
          return new Response(
            JSON.stringify({
              artifactId: 'artifact-1',
              sessionId: 'session-1',
              workspaceId: 'workspace-1',
              name: 'shot.png',
              mimeType: 'image/png',
              sizeBytes: 9,
            }),
            { status: 201 },
          )
        },
      },
    )
    const pending = client.uploadArtifact!({
      sessionId: 'session-1',
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: new Blob(['png-bytes'], { type: 'image/png' }),
    })
    expect(socket.last('upload.ticket.create').payload).toEqual({
      sessionId: 'session-1',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 9,
    })
    // No bytes move before the environment has issued the ticket.
    expect(requests).toEqual([])
    socket.respond('upload.ticket.create', {
      ticket: 'ticket-1',
      uploadPath: '/uploads/ticket-1',
      expiresAt: new Date(60_000).toISOString(),
      maxBytes: 9,
    })
    await expect(pending).resolves.toEqual({
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 9,
    })
    expect(requests).toEqual([
      {
        url: 'https://tunnel.example/env-1/uploads/ticket-1',
        method: 'PUT',
        authorization: `Bearer ${'a'.repeat(64)}`,
        contentType: 'image/png',
        body: 'png-bytes',
      },
    ])
    client.dispose()
  })

  it('asks for a workspace ticket for a draft, which has no session yet', async () => {
    const held = {
      artifactId: 'artifact-1',
      workspaceId: 'workspace-1',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 9,
    }
    const { client, socket } = await connected(
      [...FULL_CAPABILITIES, 'upload.ticket.create'],
      {},
      { fetch: async () => new Response(JSON.stringify(held), { status: 201 }) },
    )
    const pending = client.uploadArtifact!({
      workspaceId: 'workspace-1',
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: new Blob(['png-bytes'], { type: 'image/png' }),
    })
    expect(socket.last('upload.ticket.create').payload).toEqual({
      workspaceId: 'workspace-1',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 9,
    })
    socket.respond('upload.ticket.create', {
      ticket: 'ticket-1',
      uploadPath: '/uploads/ticket-1',
      expiresAt: new Date(60_000).toISOString(),
      maxBytes: 9,
    })
    await expect(pending).resolves.toEqual(held)
    client.dispose()
  })

  it('refuses an upload before the ticket when the environment does not advertise it', async () => {
    let fetched = 0
    const { client } = await connected(
      FULL_CAPABILITIES,
      {},
      {
        fetch: async () => {
          fetched += 1
          return new Response(null, { status: 500 })
        },
      },
    )
    await expect(
      client.uploadArtifact!({
        sessionId: 'session-1',
        name: 'shot.png',
        mimeType: 'image/png',
        bytes: new Blob(['x']),
      }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
    expect(fetched).toBe(0)
    client.dispose()
  })

  it('maps a refused upload to a typed error', async () => {
    const upload = async (status: number, body: unknown) => {
      const { client, socket } = await connected(
        [...FULL_CAPABILITIES, 'upload.ticket.create'],
        {},
        {
          fetch: async () => new Response(JSON.stringify(body), { status }),
        },
      )
      const pending = client.uploadArtifact!({
        sessionId: 'session-1',
        name: 'shot.png',
        mimeType: 'image/png',
        bytes: new Blob(['x']),
      })
      socket.respond('upload.ticket.create', {
        ticket: 't',
        uploadPath: '/uploads/t',
        expiresAt: new Date(60_000).toISOString(),
        maxBytes: 1,
      })
      try {
        await pending
      } finally {
        client.dispose()
      }
    }
    await expect(
      upload(413, {
        error: { code: 'validation', message: 'The upload is larger than the ticket allows.' },
      }),
    ).rejects.toMatchObject({
      code: 'validation',
      message: 'The upload is larger than the ticket allows.',
    })
    await expect(upload(410, {})).rejects.toMatchObject({ code: 'not_found' })
    await expect(upload(401, null)).rejects.toMatchObject({ code: 'auth' })
    await expect(upload(201, { artifactId: 'a' })).rejects.toMatchObject({ code: 'validation' })
  })

  it('resolves a workspace icon by ID without touching the store', async () => {
    const { client, socket } = await connected()
    const before = client.getState()
    const pending = client.commands.resolveWorkspaceIcon(WORKSPACE.workspaceId)
    expect(socket.last('workspace.icon').payload).toEqual({ workspaceId: WORKSPACE.workspaceId })
    socket.respond('workspace.icon', { iconDataUrl: 'data:image/png;base64,iVBORw0KGgo=' })
    await expect(pending).resolves.toBe('data:image/png;base64,iVBORw0KGgo=')
    const none = client.commands.resolveWorkspaceIcon(WORKSPACE.workspaceId)
    socket.respond('workspace.icon', { iconDataUrl: null })
    await expect(none).resolves.toBeNull()
    expect(client.getState()).toBe(before)
  })

  it('maps protocol errors to typed client errors', async () => {
    const { client, socket } = await connected()
    const pending = client.commands.createSession({
      environmentId: ENV,
      providerId: 'opencode',
      workspaceId: 'missing',
    })
    socket.receive({
      type: 'error',
      requestId: socket.last('session.create').requestId,
      error: { code: 'not_found', message: 'Workspace not found.' },
    })
    await expect(pending).rejects.toMatchObject({
      code: 'not_found',
      message: 'Workspace not found.',
    })
  })

  it('sends plan build intent', async () => {
    const { client, socket } = await connected([...FULL_CAPABILITIES, 'plan.build'])
    const response = {
      kind: 'plan' as const,
      interactionId: 'plan-1',
      outcome: { outcome: 'accepted' as const },
    }
    const build = { text: 'Implement the plan', modeId: 'agent' }
    const pending = client.commands.respondToInteraction({ ...THREAD, response, build })
    expect(socket.last('interaction.respond').payload).toMatchObject({
      response,
      build,
      commandId: expect.any(String),
    })
    socket.respond('interaction.respond', null)
    await pending
  })

  it('refuses plan builds on an older environment instead of silently only accepting', async () => {
    const { client, socket } = await connected()
    await expect(
      client.commands.respondToInteraction({
        ...THREAD,
        response: { kind: 'plan', interactionId: 'plan-1', outcome: { outcome: 'accepted' } },
        build: { text: 'Implement the plan', modeId: 'agent' },
      }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
    expect(socket.last('interaction.respond')).toBeUndefined()
  })

  it('removes a pending interaction optimistically after responding', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket, SESSION_SUMMARY, [THREAD], {
      messages: [],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'waiting' }],
      interactions: [{ interaction: permission }],
    })
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const responding = client.commands.respondToInteraction({
      ...THREAD,
      response: {
        kind: 'permission',
        interactionId: permission.interactionId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    })
    // Every answer carries an id so the environment can tell a retry from a rival.
    expect(socket.last('interaction.respond').payload).toMatchObject({
      commandId: expect.any(String),
    })
    socket.respond('interaction.respond', null)
    await responding
    expect(selectActiveThread(client.getState())?.interactions).toHaveLength(0)
  })

  it('drops a pending interaction another client answered first, and still reports losing', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket, SESSION_SUMMARY, [THREAD], {
      messages: [],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'waiting' }],
      interactions: [{ interaction: permission }],
    })
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const responding = client.commands.respondToInteraction({
      ...THREAD,
      response: {
        kind: 'permission',
        interactionId: permission.interactionId,
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    })
    const rejected = expect(responding).rejects.toMatchObject({ code: 'conflict' })
    socket.receive({
      type: 'error',
      requestId: socket.last('interaction.respond').requestId,
      error: { code: 'conflict', message: 'Interaction was already resolved.' },
    })
    await rejected
    expect(selectActiveThread(client.getState())?.interactions).toHaveLength(0)
  })

  it('retries the same answer under the id it first went out with', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket, SESSION_SUMMARY, [THREAD], {
      messages: [],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'waiting' }],
      interactions: [{ interaction: permission }],
    })
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const respond = (optionId: string) =>
      client.commands.respondToInteraction({
        ...THREAD,
        response: {
          kind: 'permission',
          interactionId: permission.interactionId,
          outcome: { outcome: 'selected', optionId },
        },
      })
    const fail = async (pending: Promise<void>) => {
      const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' })
      socket.receive({
        type: 'error',
        requestId: socket.last('interaction.respond').requestId,
        error: { code: 'unavailable', message: 'Acknowledgement lost' },
      })
      await rejected
      return (socket.last('interaction.respond').payload as { commandId: string }).commandId
    }
    const first = await fail(respond('allow'))
    // The environment may have accepted it, so the repeat must not look like a rival.
    expect(await fail(respond('allow'))).toBe(first)
    // A different answer is a different command.
    expect(await fail(respond('deny'))).not.toBe(first)
  })

  it('releases a subscription whose catch-up arrives after the scope was dropped', async () => {
    const { client, socket } = await connected()
    void client.commands.openSession(SESSION.sessionId).catch(() => undefined)
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    const threadReplay = lastReplay(socket, 'thread', THREAD.threadId)!
    expect(threadReplay.payload).toMatchObject({ scope: { type: 'thread' } })

    // Leave the session before the server answers the thread's catch-up.
    const second = {
      sessionId: 'session-2',
      workspaceId: WORKSPACE.workspaceId,
      title: null,
      status: 'idle' as const,
      providerId: 'opencode',
      updatedAt: '2026-09-10T00:00:00.000Z',
    }
    const switched = client.commands.openSession(second.sessionId)
    await answerOpen(socket, second, [])
    await switched
    expect(socket.sent.some((message) => message.name === 'subscription.unsubscribe')).toBe(false)

    answerSnapshot(socket, threadReplay, 'sub-thread-1', threadState(THREAD, EMPTY_HISTORY))
    expect(socket.last('subscription.unsubscribe').payload).toEqual({
      subscriptionId: 'sub-thread-1',
    })
  })

  it('sends one catch-up per scope while it holds the scope', async () => {
    const { client, socket } = await connected()
    const first = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await first
    const again = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await again
    const threadSubscribes = socket.sent.filter(
      (message) =>
        message.name === 'subscription.replay' &&
        (message.payload as { scope: { type: string } }).scope.type === 'thread',
    )
    expect(threadSubscribes).toHaveLength(1)
  })

  it('does not let a resync interrupted by a drop queue a second session.open', async () => {
    // connected() leaves the initial catalog reads unanswered, so the first
    // resync is still awaiting them when the socket drops.
    const { client, socket, timers } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await opened

    socket.drop(1006)
    await flush()
    await flush()
    timers.advance(100)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()
    await answerCatalog(next, { environmentId: ENV, name: 'Local' })
    await flush()
    await flush()
    // The held scopes catch up from their cursors; the same process needs no
    // second open of the chat.
    expect(next.sent.filter((message) => message.name === 'session.open')).toHaveLength(0)
    expect(lastReplay(next, 'thread', THREAD.threadId)).toBeDefined()
  })

  it('asks for binary frames as ArrayBuffer', async () => {
    const { socket } = await connected()
    expect(socket.binaryType).toBe('arraybuffer')
  })

  it('beats when it has sent nothing for 10 s, and takes a keepalive as a sign of life', async () => {
    const { client, socket, timers } = await connected()
    socket.control.length = 0
    for (let step = 0; step < 4; step++) {
      timers.advance(10_000)
      socket.receive({ type: 'keepalive' })
    }
    expect(socket.control.filter((message) => message.type === 'beat').length).toBeGreaterThan(2)
    expect(client.getState().connection.phase).toBe('connected')
  })

  it('reconnects after 45 s without any frame, and any frame resets that', async () => {
    const { client, socket, timers } = await connected()
    timers.advance(40_000)
    socket.receive({ type: 'keepalive' })
    timers.advance(40_000)
    expect(client.getState().connection.phase).toBe('connected')
    timers.advance(5_000)
    expect(client.getState().connection.phase).toBe('reconnecting')
    expect(socket.readyState).toBe(3)
  })

  it('reassembles a fragmented message, and acknowledges the bytes it received', async () => {
    const { client, socket, timers } = await connected()
    const environment = { environmentId: ENV, name: 'Fragmented '.repeat(500) }
    socket.control.length = 0
    const request = lastReplay(socket, 'environment')!
    socket.receiveFragments(
      {
        type: 'response',
        requestId: request.requestId,
        payload: {
          mode: 'snapshot',
          subscriptionId: 'sub-env',
          reason: 'initial',
          snapshot: {
            cursor: { scope: environmentScope, epoch: 'live', sequence: 0 },
            state: {
              environment,
              workspaces: [WORKSPACE],
              sessions: [],
              preferences: [],
              providerProfiles: [],
              listings: { commands: [], configOptions: [], entries: [] },
            },
          },
        },
      },
      512,
    )
    await flush()
    expect(client.getState().environment?.name).toBe(environment.name)
    // Every 32 KiB, or 250 ms after the last frame.
    timers.advance(250)
    const acks = socket.control.filter((message) => message.type === 'ack')
    expect(acks.length).toBeGreaterThan(0)
    const last = acks.at(-1) as { received: number }
    expect(last.received).toBeGreaterThan(
      new TextEncoder().encode(JSON.stringify({ environment })).byteLength,
    )
  })

  it('reconnects with backoff, re-handshakes and catches the open chat up', async () => {
    const { client, socket, timers } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)

    socket.drop(1006)
    expect(client.getState().connection).toMatchObject({
      phase: 'reconnecting',
      hasConnected: true,
    })
    expect(FakeSocket.instances).toHaveLength(1)
    timers.advance(100)
    expect(FakeSocket.instances).toHaveLength(2)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()
    expect(client.getState().connection.phase).toBe('connected')
    await answerCatalog(next, { environmentId: ENV, name: 'Local' })
    await flush()
    await flush()
    // The same process: the held scopes catch up from their cursors.
    expect(lastReplay(next, 'thread', THREAD.threadId)?.payload).toMatchObject({
      cursor: { sequence: 0 },
    })
  })

  it('rejects in-flight commands when the connection drops', async () => {
    const { client, socket } = await connected()
    const pending = client.commands.createSession({
      environmentId: ENV,
      providerId: 'opencode',
      workspaceId: WORKSPACE.workspaceId,
    })
    socket.drop(1006, 'gone')
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('stops retrying after a terminal handshake failure', async () => {
    FakeSocket.instances = []
    const timers = createTimers()
    const client = createWebSocketEnvironmentClient({
      url: 'ws://127.0.0.1:1/ws',
      credential: 'a'.repeat(64),
      WebSocket: FakeSocket,
      timers,
      now: timers.now,
    })
    client.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.receive({
      type: 'error',
      requestId: socket.last('protocol.handshake').requestId,
      error: {
        code: 'protocol_incompatible',
        message: 'Upgrade required.',
        details: { clientProtocolVersion: PROTOCOL_VERSION, serverProtocolVersion: 99 },
      },
    })
    await flush()
    expect(client.getState().connection).toMatchObject({
      phase: 'closed',
      failure: { code: 'protocol_incompatible' },
      retriesExhausted: true,
    })
    timers.advance(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('refuses a handshake from a different environment', async () => {
    FakeSocket.instances = []
    const client = createWebSocketEnvironmentClient({
      url: 'ws://127.0.0.1:1/ws',
      credential: 'a'.repeat(64),
      environmentId: 'expected',
      WebSocket: FakeSocket,
    })
    client.connect()
    const socket = FakeSocket.instances[0]!
    socket.open()
    socket.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()
    expect(client.getState().connection).toMatchObject({
      phase: 'closed',
      failure: { code: 'auth' },
    })
  })

  it('disconnect and dispose close cleanly without scheduling reconnects', async () => {
    const { client, socket, timers } = await connected()
    client.disconnect()
    expect(socket.readyState).toBe(3)
    expect(client.getState().connection).toMatchObject({ phase: 'closed', failure: null })
    expect(timers.pending()).toBe(0)
    client.dispose()
    await expect(client.commands.listWorkspaces()).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reconnects when connect() is called while a manual disconnect is still closing', async () => {
    FakeSocket.instances = []
    const timers = createTimers()
    let requests = 0
    const client = createWebSocketEnvironmentClient({
      url: 'ws://127.0.0.1:1/ws',
      WebSocket: FakeSocket,
      timers,
      now: timers.now,
      requestId: () => `req-${++requests}`,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000, multiplier: 2 },
    })
    client.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()

    // A socket whose close event has not fired yet (browser sockets close asynchronously).
    const closeHandlers: Array<() => void> = []
    const original = first.close.bind(first)
    first.close = () => {
      closeHandlers.push(() => original(1000, 'client_disconnect'))
    }
    client.disconnect()
    client.connect()
    for (const handler of closeHandlers) handler()

    expect(client.getState().connection.phase).toBe('reconnecting')
    timers.advance(100)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('spreads reconnect attempts with jittered exponential backoff', async () => {
    FakeSocket.instances = []
    const timers = createTimers()
    const rolls = [0.5, 0.25, 1]
    let roll = 0
    const client = createWebSocketEnvironmentClient({
      url: 'ws://127.0.0.1:1/ws',
      WebSocket: FakeSocket,
      timers,
      now: timers.now,
      random: () => rolls[roll++]!,
      reconnect: { initialDelayMs: 100, maxDelayMs: 400, multiplier: 2 },
    })
    client.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()

    // window 100 x 0.5
    first.drop(1006)
    expect(client.getState().connection).toMatchObject({
      phase: 'reconnecting',
      attempt: 1,
      retriesExhausted: false,
    })
    timers.advance(49)
    expect(FakeSocket.instances).toHaveLength(1)
    timers.advance(1)
    expect(FakeSocket.instances).toHaveLength(2)

    // window 200 x 0.25
    FakeSocket.instances[1]!.drop(1006)
    expect(client.getState().connection.attempt).toBe(2)
    timers.advance(49)
    expect(FakeSocket.instances).toHaveLength(2)
    timers.advance(1)
    expect(FakeSocket.instances).toHaveLength(3)

    // window capped at 400 x 1
    FakeSocket.instances[2]!.drop(1006)
    expect(client.getState().connection.attempt).toBe(3)
    timers.advance(399)
    expect(FakeSocket.instances).toHaveLength(3)
    timers.advance(1)
    expect(FakeSocket.instances).toHaveLength(4)

    // A handshake clears the schedule, so the next drop starts at the first window.
    const fourth = FakeSocket.instances[3]!
    fourth.open()
    fourth.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()
    expect(client.getState().connection).toMatchObject({ attempt: 0, retriesExhausted: false })
  })

  it('stops retrying once maxAttempts is exhausted, and connect() starts over', async () => {
    FakeSocket.instances = []
    const timers = createTimers()
    const client = createWebSocketEnvironmentClient({
      url: 'ws://127.0.0.1:1/ws',
      WebSocket: FakeSocket,
      timers,
      now: timers.now,
      random: () => 0.5,
      reconnect: { initialDelayMs: 100, maxDelayMs: 100, multiplier: 1, maxAttempts: 1 },
    })
    client.connect()
    const first = FakeSocket.instances[0]!
    first.open()
    first.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()

    first.drop(1006, 'gone')
    timers.advance(100)
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.instances[1]!.drop(1006, 'gone')
    expect(client.getState().connection).toMatchObject({
      phase: 'closed',
      hasConnected: true,
      retriesExhausted: true,
      failure: { code: 'unavailable' },
    })
    timers.advance(60_000)
    expect(FakeSocket.instances).toHaveLength(2)

    client.connect()
    expect(FakeSocket.instances).toHaveLength(3)
    expect(client.getState().connection).toMatchObject({ attempt: 0, retriesExhausted: false })
  })

  it('releases the previous session scopes when the active session is cleared', async () => {
    const { client, socket, timers } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await opened

    // Opening a draft clears the active session; its scopes must go with it.
    client.setActiveSession(null)
    expect(
      socket.sent
        .filter((message) => message.name === 'subscription.unsubscribe')
        .map((message) => message.payload),
    ).toEqual([{ subscriptionId: 'sub-session' }, { subscriptionId: 'sub-thread' }])

    socket.drop(1006)
    await flush()
    timers.advance(100)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()
    expect(
      next.sent
        .filter((message) => message.name === 'subscription.replay')
        .map((message) => (message.payload as { scope: { type: string } }).scope.type),
    ).toEqual(['environment'])
  })
})

describe('cursor replay on reconnect', () => {
  const REPLAY_CAPABILITIES = FULL_CAPABILITIES
  const cursor = (sequence: number, epoch = 'e') => ({
    scope: { ...THREAD, type: 'thread' as const, environmentId: ENV },
    epoch,
    sequence,
  })
  const record = (sequence: number, event: unknown) => ({ cursor: cursor(sequence), event })
  const live = (sequence: number, event: unknown) => ({
    type: 'event',
    name: 'subscription.event',
    payload: { subscriptionId: 'sub-thread', record: record(sequence, event) },
  })
  const names = (target: FakeSocket) =>
    target.sent
      .filter(
        (message) =>
          message.name.startsWith('subscription.') && message.name !== 'subscription.unsubscribe',
      )
      .map(
        (message) =>
          `${message.name.slice('subscription.'.length)}:${(message.payload as { scope: { type: string } }).scope.type}`,
      )

  /** Open a session, stream two events into its thread, then drop the socket. */
  async function dropped(instanceId = 'instance-1') {
    const { client, socket, timers } = await connected(REPLAY_CAPABILITIES)
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    socket.respond('subscription.replay', {
      mode: 'snapshot',
      subscriptionId: 'sub-thread',
      reason: 'initial',
      snapshot: {
        cursor: cursor(1),
        state: {
          thread: THREAD,
          turns: [],
          messages: [],
          reasoning: [],
          tools: [],
          order: [],
          interactions: [],
          listing: {},
        },
      },
    })
    await opened
    // A first thread open uses the atomic snapshot/live boundary.
    expect(names(socket)).toEqual(['replay:environment', 'replay:session', 'replay:thread'])
    socket.receive(live(2, turnStarted()))
    socket.receive(live(3, delta('turn-1', 'assistant-1', 'Hi')))
    socket.drop(1006)
    await flush()
    timers.advance(100)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', { ...bootstrap(REPLAY_CAPABILITIES), instanceId })
    await flush()
    return { client, next }
  }

  it('reopens the active chat when the server it reconnects to is a new process', async () => {
    const { client, next } = await dropped('instance-2')
    next.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(3),
      to: cursor(3),
      events: [],
    })
    await answerCatalog(next)
    await flush()
    await flush()
    // Its scopes are still held, but the restarted server has not loaded the
    // chat: the resync opens it, so its provider starts before the user types.
    expect(next.sent.filter((message) => message.name === 'session.open')).toHaveLength(1)
    client.dispose()
  })

  it('replaces a thread from a snapshot when a record names a turn it does not hold', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { client, next } = await dropped()
    next.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(3),
      to: cursor(3),
      events: [],
    })
    await flush()
    // A protocol error: the client asks for the whole thread again instead
    // of inventing the turn (docs/sync-foundations.md §3.5).
    next.receive(
      live(4, {
        ...completed(),
        payload: { turnId: 'turn-unknown' },
      }),
    )
    await flush()
    expect(selectActiveThread(client.getState())?.turns.map((turn) => turn.turnId)).toEqual([
      'turn-1',
    ])
    expect(
      next.sent
        .filter((message) => message.name === 'subscription.unsubscribe')
        .map((message) => message.payload),
    ).toContainEqual({ subscriptionId: 'sub-thread-2' })
    expect(next.last('subscription.replay').payload).toEqual({
      scope: cursor(3).scope,
      cursor: null,
    })
    // Said once for the scope, however often it happens.
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    client.dispose()
  })

  it('buffers live records until recovery has applied the missing prefix', async () => {
    const { client, next } = await dropped()
    next.receive(live(5, delta('turn-1', 'assistant-1', ' there')))
    next.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(3),
      to: cursor(4),
      events: [record(4, delta('turn-1', 'assistant-1', '!'))],
    })
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi! there' },
    ])
    await answerCatalog(next)
    await flush()
    expect(
      next.sent.some(
        (message) => message.name === 'session.open' || message.name === 'session.history',
      ),
    ).toBe(false)
    client.dispose()
  })

  /** A thread opened by an initial snapshot at sequence 1, subscribed as `sub-thread`. */
  async function opened() {
    const { client, socket, timers } = await connected(REPLAY_CAPABILITIES)
    const open = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    socket.respond('subscription.replay', {
      mode: 'snapshot',
      subscriptionId: 'sub-thread',
      reason: 'initial',
      snapshot: {
        cursor: cursor(1),
        state: {
          thread: THREAD,
          turns: [],
          messages: [],
          reasoning: [],
          tools: [],
          order: [],
          interactions: [],
          listing: {},
        },
      },
    })
    await open
    return { client, socket, timers }
  }

  it('holds a lagging scope until its catch-up, then places what it held', async () => {
    const { client, socket } = await opened()
    socket.receive(live(2, turnStarted()))
    socket.receive({
      type: 'event',
      name: 'subscription.lagging',
      payload: { subscriptionId: 'sub-thread', cursor: cursor(2) },
    })
    // Arrives after the catch-up was built: held, then placed after it.
    socket.receive(live(5, delta('turn-1', 'assistant-1', '!')))
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
    socket.receive({
      type: 'event',
      name: 'subscription.catchup',
      payload: {
        mode: 'replay',
        subscriptionId: 'sub-thread',
        from: cursor(2),
        to: cursor(4),
        events: [
          record(3, delta('turn-1', 'assistant-1', 'Hi')),
          record(4, delta('turn-1', 'assistant-1', ' there')),
        ],
      },
    })
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi there!' },
    ])
    // No replay of its own was needed.
    expect(
      socket.sent.filter(
        (message) =>
          message.name === 'subscription.replay' &&
          (message.payload as { scope: { type: string } }).scope.type === 'thread',
      ),
    ).toHaveLength(1)
    client.dispose()
  })

  it('catches up by itself when a catch-up does not start at its cursor', async () => {
    const { client, socket } = await opened()
    socket.receive({
      type: 'event',
      name: 'subscription.lagging',
      payload: { subscriptionId: 'sub-thread', cursor: cursor(1) },
    })
    socket.receive({
      type: 'event',
      name: 'subscription.catchup',
      payload: {
        mode: 'replay',
        subscriptionId: 'sub-thread',
        from: cursor(7),
        to: cursor(7),
        events: [],
      },
    })
    const replays = socket.sent.filter(
      (message) =>
        message.name === 'subscription.replay' &&
        (message.payload as { scope: { type: string } }).scope.type === 'thread',
    )
    expect(replays).toHaveLength(2)
    expect(replays[1]!.payload).toEqual({ scope: cursor(1).scope, cursor: cursor(1) })
    expect(socket.last('subscription.unsubscribe').payload).toEqual({
      subscriptionId: 'sub-thread',
    })
    client.dispose()
  })

  it('ignores lagging frames for a subscription it no longer holds', async () => {
    const { client, socket } = await opened()
    socket.receive({
      type: 'event',
      name: 'subscription.lagging',
      payload: { subscriptionId: 'someone-else', cursor: cursor(1) },
    })
    socket.receive(live(2, turnStarted()))
    expect(selectActiveThread(client.getState())?.turns).toHaveLength(1)
    client.dispose()
  })

  it('hydrates from a cursor-bearing first page and ignores a duplicate at its boundary', async () => {
    const { client, socket } = await connected(REPLAY_CAPABILITIES)
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    expect(socket.last('subscription.replay').payload).toEqual({
      scope: cursor(0).scope,
      cursor: null,
    })
    const start = turnStarted()
    socket.respond('subscription.replay', {
      mode: 'snapshot',
      subscriptionId: 'sub-thread',
      reason: 'initial',
      snapshot: {
        cursor: cursor(3),
        state: {
          thread: THREAD,
          turns: [start.payload.turn],
          messages: [
            start.payload.userMessage,
            {
              messageId: 'assistant-1',
              threadId: THREAD.threadId,
              turnId: 'turn-1',
              role: 'assistant',
              content: [{ type: 'text', text: 'Hi' }],
            },
          ],
          reasoning: [],
          tools: [],
          order: [],
          interactions: [],
          listing: {},
        },
      },
    })
    socket.receive(live(3, delta('turn-1', 'assistant-1', 'Hi')))
    socket.receive(live(4, delta('turn-1', 'assistant-1', '!')))
    await opened
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi!' },
    ])
    expect(socket.sent.some((message) => message.name === 'session.history')).toBe(false)
    client.dispose()
  })

  it('resumes a held cursor through subscription.replay and folds the missed tail in once', async () => {
    const { client, next } = await dropped()
    // Only the thread has a cursor; the other scopes never produced an event.
    expect(names(next)).toEqual(['replay:environment', 'replay:session', 'replay:thread'])
    const replay = next.last('subscription.replay')
    expect(replay.payload).toEqual({ scope: cursor(3).scope, cursor: cursor(3) })

    next.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(3),
      to: cursor(5),
      events: [record(4, delta('turn-1', 'assistant-1', '!')), record(5, completed())],
    })
    const thread = selectActiveThread(client.getState())!
    expect(thread.messages[1]?.content).toEqual([{ type: 'text', text: 'Hi!' }])
    expect(thread.turns[0]?.state).toBe('completed')

    // The tail moved the cursor: repeats cannot change the settled turn. (A
    // finished turn gets nothing but closes from the environment, and the
    // client applies what it receives: protocol v17, I2.)
    next.receive(live(5, completed()))
    next.receive(live(4, delta('turn-1', 'assistant-1', '!')))
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi!' },
    ])
    next.receive(live(6, turnStarted('turn-2')))
    expect(selectActiveThread(client.getState())?.turns.at(-1)?.turnId).toBe('turn-2')
    // The recovered subscription is the one released when the session goes.
    client.setActiveSession(null)
    expect(
      next.sent
        .filter((message) => message.name === 'subscription.unsubscribe')
        .map((message) => message.payload),
    ).toEqual([{ subscriptionId: 'sub-thread-2' }])
    // No catalog walk follows: the environment catches up like any scope.
    expect(next.sent.some((message) => message.name === 'session.list')).toBe(false)
  })

  it('replaces the scope from a snapshot when the gap can no longer be replayed', async () => {
    const { client, next } = await dropped()
    next.respond('subscription.replay', {
      mode: 'snapshot',
      subscriptionId: 'sub-thread-2',
      reason: 'gap_expired',
      snapshot: {
        cursor: cursor(9),
        state: {
          thread: THREAD,
          turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
          messages: [
            {
              messageId: 'turn-1-user',
              threadId: THREAD.threadId,
              turnId: 'turn-1',
              role: 'user',
              content: [{ type: 'text', text: 'hello' }],
            },
            {
              messageId: 'assistant-1',
              threadId: THREAD.threadId,
              turnId: 'turn-1',
              role: 'assistant',
              content: [{ type: 'text', text: 'Hi, the whole answer' }],
            },
          ],
          reasoning: [],
          tools: [],
          order: [],
          interactions: [],
          listing: {},
        },
      },
    })
    const thread = selectActiveThread(client.getState())!
    expect(thread.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'Hi, the whole answer' },
    ])
    expect(thread.turns).toEqual([
      { turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' },
    ])
    // The snapshot's cursor is where live delivery resumes.
    next.receive(live(9, delta('turn-1', 'assistant-1', 'stale')))
    next.receive(live(10, turnStarted('turn-2')))
    expect(selectActiveThread(client.getState())?.turns.at(-1)?.turnId).toBe('turn-2')
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi, the whole answer' },
    ])
  })

  it('keeps the transcript failed when replay fails instead of silently skipping the gap', async () => {
    const { client, next } = await dropped()
    next.receive({
      type: 'error',
      requestId: next.last('subscription.replay').requestId,
      error: { code: 'unavailable', message: 'Replay is not available.' },
    })
    await flush()
    expect(names(next)).toEqual(['replay:environment', 'replay:session', 'replay:thread'])
    expect(selectActiveThread(client.getState())?.hydration).toBe('failed')
  })

  it('lets go of a scope the environment no longer has', async () => {
    const { next } = await dropped()
    const replay = next.last('subscription.replay')
    next.receive({
      type: 'error',
      requestId: replay.requestId,
      error: { code: 'not_found', message: 'The scope no longer exists.' },
    })
    expect(names(next)).toEqual(['replay:environment', 'replay:session', 'replay:thread'])
  })

  it('refuses a replay answer that does not match what it asked for', async () => {
    const { client, next } = await dropped()
    // The answer starts somewhere else: not applied, and the scope is
    // subscribed plainly instead.
    next.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(1),
      to: cursor(2),
      events: [record(2, delta('turn-1', 'assistant-1', 'wrong'))],
    })
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi' },
    ])
    expect(names(next).at(-1)).toBe('replay:thread')
    expect(selectActiveThread(client.getState())?.hydration).toBe('failed')
    // The subscription that answer granted is released, not left to pile up.
    expect(next.last('subscription.unsubscribe').payload).toEqual({
      subscriptionId: 'sub-thread-2',
    })
  })
})

describe('one ordered queue on the client (§5.2)', () => {
  const REPLAY_CAPABILITIES = FULL_CAPABILITIES
  const cursor = (sequence: number, epoch = 'e') => ({ scope: threadScope, epoch, sequence })
  const live = (sequence: number, event: unknown, epoch = 'e') => ({
    type: 'event',
    name: 'subscription.event',
    payload: { subscriptionId: 'sub-thread', record: { cursor: cursor(sequence, epoch), event } },
  })
  const notice = (after: number, message: string, epoch = 'e') => ({
    type: 'event',
    name: 'subscription.transient',
    payload: {
      subscriptionId: 'sub-thread',
      after: cursor(after, epoch),
      event: event({
        name: 'turn.notice',
        scope: threadScope,
        payload: { turnId: 'turn-1', message },
      }),
    },
  })
  const snapshotAt = (sequence: number, turns: unknown[] = [], epoch = 'e') => ({
    mode: 'snapshot',
    subscriptionId: 'sub-thread',
    reason: 'initial',
    snapshot: {
      cursor: cursor(sequence, epoch),
      state: {
        thread: THREAD,
        turns,
        messages: [],
        reasoning: [],
        tools: [],
        order: [],
        interactions: [],
        listing: {},
      },
    },
  })
  const RUNNING = {
    turnId: 'turn-1',
    threadId: THREAD.threadId,
    state: 'running',
    startedAt: '2026-09-10T00:00:00.000Z',
  }
  const notices = (client: EnvironmentClient) =>
    client.getState().threads[THREAD.threadId]?.notices.map((item) => item.message)
  const text = (client: EnvironmentClient) =>
    client
      .getState()
      .threads[THREAD.threadId]?.messages.filter((message) => message.role === 'assistant')
      .map((message) =>
        message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
      )
  const replays = (socket: FakeSocket) =>
    socket.sent.filter(
      (message) =>
        message.name === 'subscription.replay' &&
        (message.payload as { scope: { type: string } }).scope.type === 'thread',
    )

  /** Open the session; its thread's first catch-up is sent and not yet answered. */
  async function opening() {
    const { client, socket } = await connected(REPLAY_CAPABILITIES)
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION_SUMMARY, threads: [THREAD] })
    await flush()
    expect(replays(socket)).toHaveLength(1)
    return { client, socket, opened }
  }

  /** The same, with the catch-up answered at sequence 1: a running turn-1. */
  async function caughtUp() {
    const { client, socket, opened } = await opening()
    socket.respond('subscription.replay', snapshotAt(1, [RUNNING]))
    await opened
    return { client, socket }
  }

  it('holds every frame during a catch-up and places it against the answer', async () => {
    const { client, socket, opened } = await opening()
    // Sent before the answer: a record the snapshot already holds, the next
    // one, a notice placed after it, and a notice older than the snapshot.
    socket.receive(live(1, turnStarted()))
    socket.receive(notice(0, 'too old'))
    socket.receive(live(2, delta('turn-1', 'a-1', 'Hi')))
    socket.receive(notice(2, 'after the text'))
    expect(notices(client) ?? []).toEqual([])
    socket.respond('subscription.replay', snapshotAt(1, [RUNNING]))
    await opened
    expect(text(client)).toEqual(['Hi'])
    expect(notices(client)).toEqual(['after the text'])
    expect(replays(socket)).toHaveLength(1)
    client.dispose()
  })

  it('applies a notice at the cursor and drops one behind it', async () => {
    const { client, socket } = await caughtUp()
    socket.receive(notice(1, 'now'))
    socket.receive(live(2, delta('turn-1', 'a-1', 'Hi')))
    socket.receive(notice(1, 'before the text'))
    expect(notices(client)).toEqual(['now'])
    expect(replays(socket)).toHaveLength(1)
    client.dispose()
  })

  it('catches up from its cursor when a record is missing, then applies what it held', async () => {
    const { client, socket } = await caughtUp()
    socket.receive(live(3, delta('turn-1', 'a-1', ' there')))
    expect(text(client)).toEqual([])
    // The live subscription is released and the gap read from the cursor.
    expect(socket.last('subscription.unsubscribe').payload).toEqual({
      subscriptionId: 'sub-thread',
    })
    expect(replays(socket).at(-1)!.payload).toEqual({ scope: threadScope, cursor: cursor(1) })
    socket.receive(notice(3, 'held behind the catch-up'))
    socket.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(1),
      to: cursor(3),
      events: [
        { cursor: cursor(2), event: delta('turn-1', 'a-1', 'Hi') },
        { cursor: cursor(3), event: delta('turn-1', 'a-1', ' there') },
      ],
    })
    await flush()
    expect(text(client)).toEqual(['Hi there'])
    expect(notices(client)).toEqual(['held behind the catch-up'])
    client.dispose()
  })

  it('loses a final record, then sees only a notice: it catches up and applies the notice (§5.5)', async () => {
    const { client, socket } = await caughtUp()
    // Record 2 never arrives; the notice that followed it does.
    socket.receive(notice(2, 'Retrying'))
    expect(notices(client)).toEqual([])
    expect(replays(socket).at(-1)!.payload).toEqual({ scope: threadScope, cursor: cursor(1) })
    socket.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(1),
      to: cursor(2),
      events: [{ cursor: cursor(2), event: delta('turn-1', 'a-1', 'Hi') }],
    })
    await flush()
    expect(text(client)).toEqual(['Hi'])
    expect(notices(client)).toEqual(['Retrying'])
    client.dispose()
  })

  it('drops the notice that asked for a catch-up the answer cannot place it after', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { client, socket } = await caughtUp()
    socket.receive(notice(5, 'from nowhere'))
    socket.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(1),
      to: cursor(1),
      events: [],
    })
    await flush()
    // No second catch-up: the server said something its log cannot back.
    expect(replays(socket)).toHaveLength(2)
    expect(notices(client)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    client.dispose()
  })

  it('catches up when a frame comes from another epoch, and keeps only the answer’s', async () => {
    const { client, socket } = await caughtUp()
    socket.receive(live(1, turnStarted(), 'f'))
    expect(replays(socket).at(-1)!.payload).toEqual({ scope: threadScope, cursor: cursor(1) })
    socket.receive(notice(1, 'old epoch', 'e'))
    socket.receive(notice(1, 'new epoch', 'f'))
    socket.respond('subscription.replay', {
      ...snapshotAt(1, [RUNNING], 'f'),
      reason: 'stream_reset',
    })
    await flush()
    expect(notices(client)).toEqual(['new epoch'])
    expect(replays(socket)).toHaveLength(2)
    client.dispose()
  })

  it('ignores a notice for a thread it does not hold, and a bare event', async () => {
    const { client, socket } = await caughtUp()
    const other = { ...threadScope, threadId: 'thread-other' }
    socket.receive({
      type: 'event',
      name: 'subscription.transient',
      payload: {
        subscriptionId: 'sub-other',
        after: { scope: other, epoch: 'e', sequence: 0 },
        event: event({ name: 'turn.notice', scope: other, payload: { turnId: 't', message: 'x' } }),
      },
    })
    // Nothing durable or transient arrives outside a subscription any more.
    socket.receive(
      event({
        name: 'turn.notice',
        scope: threadScope,
        payload: { turnId: 'turn-1', message: 'y' },
      }),
    )
    expect(notices(client)).toEqual([])
    expect(client.getState().threads['thread-other']).toBeUndefined()
    client.dispose()
  })
})

describe('reconnectDelayMs', () => {
  const policy = { initialDelayMs: 500, maxDelayMs: 15_000, multiplier: 2, jitter: 1 }

  it('keeps full jitter inside a doubling window that stops at the cap', () => {
    expect(reconnectDelayMs(policy, 0, () => 0)).toBe(0)
    expect(reconnectDelayMs(policy, 0, () => 0.5)).toBe(250)
    expect(reconnectDelayMs(policy, 3, () => 0.5)).toBe(2000)
    expect(reconnectDelayMs(policy, 20, () => 1)).toBe(policy.maxDelayMs)
  })

  it('honours a partial or disabled jitter fraction', () => {
    expect(reconnectDelayMs({ ...policy, jitter: 0.5 }, 0, () => 0)).toBe(250)
    expect(reconnectDelayMs({ ...policy, jitter: 0.5 }, 0, () => 1)).toBe(500)
    expect(reconnectDelayMs({ ...policy, jitter: 0 }, 2, () => 0)).toBe(2000)
    expect(reconnectDelayMs({ ...policy, jitter: undefined }, 2, () => 0)).toBe(2000)
  })

  it('defaults to full jitter that never overshoots the window', () => {
    expect(DEFAULT_RECONNECT.jitter).toBe(1)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const window = Math.min(
        DEFAULT_RECONNECT.initialDelayMs * DEFAULT_RECONNECT.multiplier ** attempt,
        DEFAULT_RECONNECT.maxDelayMs,
      )
      const delay = reconnectDelayMs(DEFAULT_RECONNECT, attempt, Math.random)
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(window)
    }
  })
})

it('refuses explicit creation on older environments without sending a lossy command', async () => {
  const { client, socket } = await connected(['session.create'])
  const before = socket.sent.length
  await expect(
    client.commands.createSession({
      environmentId: ENV,
      workspaceId: WORKSPACE.workspaceId,
      providerId: 'opencode',
      firstMessage: 'hello',
    }),
  ).rejects.toMatchObject({ code: 'capability_missing' })
  expect(socket.sent).toHaveLength(before)
})

it('folds the first turn from creation without a second turn.send round trip', async () => {
  const { client, socket } = await connected()
  const input = {
    environmentId: ENV,
    workspaceId: WORKSPACE.workspaceId,
    providerId: 'opencode',
    firstMessage: 'hello',
  }
  const pending = client.commands.createSession(input)
  expect(socket.last('session.create').payload).toEqual(input)
  const firstTurn = {
    turn: { turnId: 'first', threadId: THREAD.threadId, state: 'running' },
    userMessage: {
      messageId: 'user-first',
      threadId: THREAD.threadId,
      turnId: 'first',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    },
  }
  const announcedAt = '2026-09-12T00:00:00.000Z'
  socket.respond('session.create', { session: SESSION, thread: THREAD, firstTurn, announcedAt })
  expect(await pending).toMatchObject({ firstTurn })
  expect(client.getState().threads[THREAD.threadId]?.messages).toEqual([firstTurn.userMessage])
  // Listed as the environment lists it, from the answer alone: working on its
  // first message, with the time it was announced.
  expect(client.getState().sessions[SESSION.sessionId]).toMatchObject({
    status: 'running',
    updatedAt: announcedAt,
  })
  expect(socket.sent.some((message) => message.name === 'turn.send')).toBe(false)
  // Shown from the answer as an overlay entry, never written as server state,
  // and selectable before the server lists it.
  expect(client.getState().pending.creates[SESSION.sessionId]).toBeDefined()
  client.setActiveSession(SESSION.sessionId)
  expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
})

it('hides a session while it is deleted and shows it again when the delete fails', async () => {
  const { client, socket } = await connected([...FULL_CAPABILITIES, 'session.delete'])
  await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY] })
  await flush()
  const deleting = client.commands.deleteSession(SESSION.sessionId)
  expect(client.getState().sessions[SESSION.sessionId]).toBeUndefined()
  socket.receive({
    type: 'error',
    requestId: socket.last('session.delete').requestId,
    error: { code: 'unavailable', message: 'The session change could not be saved. Try again.' },
  })
  await expect(deleting).rejects.toMatchObject({ code: 'unavailable' })
  expect(client.getState().sessions[SESSION.sessionId]).toBeDefined()
  expect(client.getState().pending.removals).toEqual({})
})

describe('composer commands', () => {
  const COMPOSER_CAPABILITIES = [
    'provider.catalog.get',
    'composer.preferences.set',
    'composer.model.set',
    'composer.mode.set',
    'composer.config_option.set',
  ]
  const TARGET = { workspaceId: WORKSPACE.workspaceId, providerId: PROVIDER.id }
  const preferenceOf = (client: EnvironmentClient) =>
    selectComposerPreference(client.getState(), TARGET.workspaceId, TARGET.providerId)

  /** Connected, with the session and its provider already listed. */
  async function composing() {
    const context = await connected([...FULL_CAPABILITIES, ...COMPOSER_CAPABILITIES])
    await answerCatalog(context.socket, undefined, { sessions: [SESSION_SUMMARY] })
    await flush()
    return context
  }

  it('rejects every composer command on an older environment without sending it', async () => {
    const { client, socket } = await connected()
    const sessionId = SESSION.sessionId
    const attempts = [
      client.commands.getProviderCatalog(),
      client.commands.setComposerPreference({ ...TARGET, preference: { modelId: 'opus' } }),
      client.commands.setSessionModel({ sessionId, modelId: 'opus' }),
      client.commands.setSessionMode({ sessionId, modeId: 'plan' }),
      client.commands.setSessionConfigOption({ sessionId, configId: 'effort', value: 'high' }),
    ]
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({ code: 'capability_missing' })
    }
    expect(socket.sent.some((message) => COMPOSER_CAPABILITIES.includes(message.name))).toBe(false)
    expect(client.supports('getProviderCatalog')).toBe(false)
    client.disconnect()
  })

  it('gates each composer command on its own capability', async () => {
    const { client, socket } = await connected([...FULL_CAPABILITIES, 'composer.model.set'])
    expect(client.supports('setSessionModel')).toBe(true)
    expect(client.supports('setComposerPreference')).toBe(false)
    await expect(
      client.commands.setComposerPreference({ ...TARGET, preference: {} }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
    expect(socket.sent.some((message) => message.name === 'composer.preferences.set')).toBe(false)
    client.disconnect()
  })

  it('reads the provider catalog into state after the handshake and on demand', async () => {
    const { client, socket } = await composing()
    expect(socket.last('provider.catalog.get').payload).toBeNull()
    socket.respond('provider.catalog.get', { providers: [PROVIDER] })
    await flush()
    expect(selectProviderCatalog(client.getState())).toEqual([PROVIDER])

    const refreshed = client.commands.getProviderCatalog()
    socket.respond('provider.catalog.get', { providers: [BARE_PROVIDER] })
    expect(await refreshed).toEqual([BARE_PROVIDER])
    expect(selectProviderCatalog(client.getState())).toEqual([BARE_PROVIDER])
    client.disconnect()
  })

  it('holds preferences from the environment snapshot and writes them with strict payloads', async () => {
    const context = await connected([...FULL_CAPABILITIES, ...COMPOSER_CAPABILITIES])
    const { client, socket } = context
    await answerCatalog(socket, undefined, {
      sessions: [SESSION_SUMMARY],
      preferences: [{ ...TARGET, preference: { modelId: 'sonnet' }, revision: 1 }],
    })
    expect(preferenceOf(client)).toEqual({ modelId: 'sonnet' })

    const written = client.commands.setComposerPreference({
      ...TARGET,
      preference: { modeId: 'plan' },
    })
    expect(socket.last('composer.preferences.set').payload).toEqual({
      ...TARGET,
      preference: { modeId: 'plan' },
    })
    // Shown at once, over the server's preference (pending.preferences).
    expect(preferenceOf(client)).toEqual({ modelId: 'sonnet', modeId: 'plan' })
    socket.respond('composer.preferences.set', {
      preference: { modelId: 'sonnet', modeId: 'plan' },
      revision: 2,
    })
    expect(await written).toEqual({ modelId: 'sonnet', modeId: 'plan' })
    expect(preferenceOf(client)).toEqual({ modelId: 'sonnet', modeId: 'plan' })
    client.disconnect()
  })

  it('files a session setter answer under the session workspace and provider', async () => {
    const { client, socket } = await composing()
    const sessionId = SESSION.sessionId

    const model = client.commands.setSessionModel({ sessionId, modelId: 'opus' })
    expect(socket.last('composer.model.set').payload).toEqual({ sessionId, modelId: 'opus' })
    socket.respond('composer.model.set', { preference: { modelId: 'opus' }, revision: 1 })
    await model

    const mode = client.commands.setSessionMode({ sessionId, modeId: 'plan' })
    expect(socket.last('composer.mode.set').payload).toEqual({ sessionId, modeId: 'plan' })
    socket.respond('composer.mode.set', {
      preference: { modelId: 'opus', modeId: 'plan' },
      revision: 2,
    })
    await mode

    const option = client.commands.setSessionConfigOption({
      sessionId,
      configId: 'fast',
      value: true,
    })
    expect(socket.last('composer.config_option.set').payload).toEqual({
      sessionId,
      configId: 'fast',
      value: true,
    })
    const preference = { modelId: 'opus', modeId: 'plan', configValues: { fast: true } }
    socket.respond('composer.config_option.set', { preference, revision: 3 })
    expect(await option).toEqual(preference)
    expect(preferenceOf(client)).toEqual(preference)
    client.disconnect()
  })

  it('returns a setter answer without storing it when the session provider is unknown', async () => {
    const { client, socket } = await connected([...FULL_CAPABILITIES, ...COMPOSER_CAPABILITIES])
    const pending = client.commands.setSessionModel({ sessionId: 'unlisted', modelId: 'opus' })
    socket.respond('composer.model.set', { preference: { modelId: 'opus' }, revision: 1 })
    expect(await pending).toEqual({ modelId: 'opus' })
    expect(client.getState().composerPreferences).toEqual({})
    client.disconnect()
  })

  it('keeps the newest write by revision when answers arrive out of order', async () => {
    const { client, socket } = await composing()
    const sessionId = SESSION.sessionId
    const first = client.commands.setSessionModel({ sessionId, modelId: 'sonnet' })
    const firstId = socket.last('composer.model.set').requestId
    const second = client.commands.setSessionModel({ sessionId, modelId: 'opus' })
    socket.respond('composer.model.set', { preference: { modelId: 'opus' }, revision: 2 })
    await second
    socket.receive({
      type: 'response',
      requestId: firstId,
      payload: { preference: { modelId: 'sonnet' }, revision: 1 },
    })
    expect(await first).toEqual({ modelId: 'sonnet' })
    expect(preferenceOf(client)).toEqual({ modelId: 'opus' })
    client.disconnect()
  })

  it('files a setter answer under a provider learned while it was in flight', async () => {
    const { client, socket } = await connected([...FULL_CAPABILITIES, ...COMPOSER_CAPABILITIES])
    const pending = client.commands.setSessionModel({
      sessionId: SESSION.sessionId,
      modelId: 'opus',
    })
    await answerCatalog(socket, undefined, { sessions: [SESSION_SUMMARY] })
    await flush()
    socket.respond('composer.model.set', { preference: { modelId: 'opus' }, revision: 1 })
    await pending
    expect(preferenceOf(client)).toEqual({ modelId: 'opus' })
    client.disconnect()
  })

  it('follows a session selection pushed by the environment', async () => {
    const { client, socket } = await composing()
    socket.publish(
      event({
        name: 'session.composer.updated',
        scope: { type: 'environment', environmentId: ENV },
        payload: { sessionId: SESSION.sessionId, composer: { modelId: 'opus', modeId: 'plan' } },
      }),
    )
    expect(selectSessionComposer(client.getState(), SESSION.sessionId)).toEqual({
      modelId: 'opus',
      modeId: 'plan',
    })
    client.disconnect()
  })

  it('does not bring back a preference whose session or workspace went away in flight', async () => {
    const { client, socket } = await composing()
    const setter = client.commands.setSessionModel({
      sessionId: SESSION.sessionId,
      modelId: 'opus',
    })
    const write = client.commands.setComposerPreference({
      ...TARGET,
      preference: { modeId: 'plan' },
    })
    // As the environment announces a removal: its session first, then itself.
    socket.publish(
      event({
        name: 'session.deleted',
        scope: { type: 'environment', environmentId: ENV },
        payload: { sessionId: SESSION.sessionId },
      }),
    )
    socket.publish(
      event({
        name: 'workspace.removed',
        scope: { type: 'environment', environmentId: ENV },
        payload: { workspaceId: WORKSPACE.workspaceId },
      }),
    )
    socket.respond('composer.model.set', { preference: { modelId: 'opus' }, revision: 1 })
    socket.respond('composer.preferences.set', { preference: { modeId: 'plan' }, revision: 1 })
    expect(await setter).toEqual({ modelId: 'opus' })
    expect(await write).toEqual({ modeId: 'plan' })
    expect(client.getState().composerPreferences).toEqual({})
    client.disconnect()
  })

  it('leaves state alone when the environment rejects or answers invalidly', async () => {
    const { client, socket } = await composing()
    const sessionId = SESSION.sessionId
    const rejected = client.commands.setSessionMode({ sessionId, modeId: 'plan' })
    socket.receive({
      type: 'error',
      requestId: socket.last('composer.mode.set').requestId,
      error: { code: 'not_found', message: 'Session not found.' },
    })
    await expect(rejected).rejects.toMatchObject({ code: 'not_found' })

    const invalid = client.commands.setComposerPreference({ ...TARGET, preference: {} })
    socket.respond('composer.preferences.set', { preference: { modelId: 7 }, revision: 1 })
    await expect(invalid).rejects.toMatchObject({ code: 'validation' })
    expect(client.getState().composerPreferences).toEqual({})
    client.disconnect()
  })
})
