import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@openmanager/protocol'
import { createWebSocketEnvironmentClient, type WebSocketLike } from '../src/websocket'
import { selectActiveThread, selectSessionList } from '../src/state'
import { ENV, SESSION, THREAD, WORKSPACE, delta, permission, turnStarted } from './fixtures'

type Listener = (event: never) => void

/** A scriptable server end of a socket; the client sees a WHATWG-shaped object. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: Array<{ type: string; requestId: string; name: string; payload: unknown }> = []
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
    this.sent.push(JSON.parse(data))
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
  drop(code = 1006, reason = '') {
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }
  last(name: string) {
    return [...this.sent].reverse().find((message) => message.name === name)!
  }
  respond(name: string, payload: unknown) {
    this.receive({ type: 'response', requestId: this.last(name).requestId, payload })
  }
  private dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never)
  }
}

const bootstrap = (capabilities: string[]) => ({
  protocolVersion: PROTOCOL_VERSION,
  environmentId: ENV,
  capabilities,
})

const FULL_CAPABILITIES = [
  'connection.heartbeat',
  'subscription.subscribe',
  'subscription.unsubscribe',
  'environment.get',
  'workspace.list',
  'session.list',
  'session.create',
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

async function connected(capabilities = FULL_CAPABILITIES) {
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
  })
  client.connect()
  const socket = FakeSocket.instances[0]!
  socket.open()
  socket.respond('protocol.handshake', bootstrap(capabilities))
  await flush()
  return { client, socket, timers }
}

describe('websocket environment client', () => {
  it('authenticates through subprotocols and negotiates the handshake', async () => {
    const { client, socket } = await connected()
    expect(socket.protocols).toEqual(['openmanager.v1', `openmanager.auth.${'a'.repeat(64)}`])
    const handshake = socket.sent[0]!
    expect(handshake.name).toBe('protocol.handshake')
    expect(handshake.payload).toEqual({ protocolVersion: PROTOCOL_VERSION, requiredCapabilities: [] })
    expect(client.getState().connection).toMatchObject({ phase: 'connected', hasConnected: true })
    expect(client.supports('sendTurn')).toBe(true)
    expect(client.supports('deleteSession')).toBe(false)
  })

  it('subscribes to the environment scope and hydrates catalog reads after handshake', async () => {
    const { client, socket } = await connected()
    expect(socket.last('subscription.subscribe').payload).toEqual({
      scope: { type: 'environment', environmentId: ENV },
    })
    socket.respond('subscription.subscribe', {
      subscriptionId: 'sub-env',
      scope: { type: 'environment', environmentId: ENV },
    })
    await flush()
    socket.respond('environment.get', { environment: { environmentId: ENV, name: 'Local' } })
    socket.respond('workspace.list', { workspaces: [WORKSPACE] })
    await flush()
    expect(client.getState().environment?.name).toBe('Local')
    expect(client.getState().workspaces[WORKSPACE.workspaceId]).toEqual(WORKSPACE)
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
    socket.respond('session.open', {
      session: SESSION,
      threads: [THREAD],
      messages: [],
      turns: [],
      interactions: [],
    })
    await flush()
    const scopes = socket.sent
      .filter((message) => message.name === 'subscription.subscribe')
      .map((message) => (message.payload as { scope: { type: string } }).scope.type)
    expect(scopes).toEqual(['environment', 'session', 'thread'])
    socket.respond('subscription.subscribe', {
      subscriptionId: 'sub-session',
      scope: { type: 'session', environmentId: ENV, sessionId: SESSION.sessionId },
    })
    await flush()
    socket.respond('subscription.subscribe', {
      subscriptionId: 'sub-thread',
      scope: { ...THREAD, type: 'thread', environmentId: ENV },
    })
    await open
    expect(client.getState().activeThreadId).toBe(THREAD.threadId)
    expect(selectActiveThread(client.getState())?.hydration).toBe('ready')

    const record = (sequence: number, event: unknown) => ({
      type: 'event',
      name: 'subscription.event',
      payload: {
        subscriptionId: 'sub-thread',
        record: { cursor: { scope: { ...THREAD, type: 'thread', environmentId: ENV }, epoch: 'e', sequence }, event },
      },
    })
    socket.receive(record(1, turnStarted()))
    socket.receive(record(2, delta('turn-1', 'assistant-1', 'Hi')))
    socket.receive(record(2, delta('turn-1', 'assistant-1', 'Hi'))) // duplicate delivery
    socket.receive(record(3, delta('turn-1', 'assistant-1', '!')))
    const thread = selectActiveThread(client.getState())!
    expect(thread.messages[1]?.content).toEqual([{ type: 'text', text: 'Hi!' }])
    expect(selectSessionList(client.getState())[0]?.status).toBe('running')
  })

  it('sends a turn and folds the response in before the event arrives', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION, threads: [THREAD], messages: [], turns: [], interactions: [] })
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({ ...THREAD, text: 'go' })
    expect(socket.last('turn.send').payload).toEqual({ ...THREAD, text: 'go' })
    socket.respond('turn.send', turnStarted('turn-9', 'go').payload)
    const result = await sending
    expect(result.turn.turnId).toBe('turn-9')
    expect(selectActiveThread(client.getState())?.turns[0]?.state).toBe('running')
  })

  it('maps protocol errors to typed client errors', async () => {
    const { client, socket } = await connected()
    const pending = client.commands.createSession({ workspaceId: 'missing' })
    socket.receive({
      type: 'error',
      requestId: socket.last('session.create').requestId,
      error: { code: 'not_found', message: 'Workspace not found.' },
    })
    await expect(pending).rejects.toMatchObject({ code: 'not_found', message: 'Workspace not found.' })
  })

  it('removes a pending interaction optimistically after responding', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', {
      session: SESSION,
      threads: [THREAD],
      messages: [],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'waiting' }],
      interactions: [{ threadId: THREAD.threadId, interaction: permission }],
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
    socket.respond('interaction.respond', null)
    await responding
    expect(selectActiveThread(client.getState())?.interactions).toHaveLength(0)
  })

  it('answers heartbeat pings', async () => {
    const { socket } = await connected()
    socket.receive({ type: 'ping', heartbeatId: 'hb-1' })
    expect(socket.sent.at(-1)).toEqual({ type: 'pong', heartbeatId: 'hb-1' })
  })

  it('reconnects with backoff, re-handshakes and re-opens the active session', async () => {
    const { client, socket, timers } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', { session: SESSION, threads: [THREAD], messages: [], turns: [], interactions: [] })
    await flush()
    await flush()
    await opened.catch(() => undefined)

    socket.drop(1006)
    expect(client.getState().connection).toMatchObject({ phase: 'reconnecting', hasConnected: true })
    expect(FakeSocket.instances).toHaveLength(1)
    timers.advance(100)
    expect(FakeSocket.instances).toHaveLength(2)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()
    expect(client.getState().connection.phase).toBe('connected')
    next.respond('subscription.subscribe', {
      subscriptionId: 'sub-env-2',
      scope: { type: 'environment', environmentId: ENV },
    })
    await flush()
    next.respond('environment.get', { environment: { environmentId: ENV, name: 'Local' } })
    next.respond('workspace.list', { workspaces: [] })
    await flush()
    await flush()
    expect(next.last('session.open').payload).toEqual({ sessionId: SESSION.sessionId })
  })

  it('rejects in-flight commands when the connection drops', async () => {
    const { client, socket } = await connected()
    const pending = client.commands.createSession({ workspaceId: WORKSPACE.workspaceId })
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
    expect(client.getState().connection).toMatchObject({ phase: 'closed', failure: { code: 'auth' } })
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
})
