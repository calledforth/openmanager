import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@openmanager/protocol'
import {
  DEFAULT_RECONNECT,
  createWebSocketEnvironmentClient,
  reconnectDelayMs,
  type WebSocketLike,
} from '../src/websocket'
import { selectActiveThread, selectSessionList } from '../src/state'
import {
  ENV,
  SESSION,
  SESSION_SUMMARY,
  THREAD,
  WORKSPACE,
  completed,
  delta,
  permission,
  turnStarted,
} from './fixtures'

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
  'workspace.icon',
  'session.list',
  'session.create',
  'session.create.explicit',
  'session.open',
  'session.history',
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
  interactions: unknown[]
  nextCursor: { ordinal: number } | null
} = { messages: [], turns: [], interactions: [], nextCursor: null }

async function answerOpen(
  socket: FakeSocket,
  session = SESSION_SUMMARY,
  threads = [THREAD],
  history: typeof EMPTY_HISTORY = EMPTY_HISTORY,
) {
  socket.respond('session.open', { session, threads })
  await flush()
  if (threads.length > 0) socket.respond('session.history', history)
}

async function answerCatalog(
  socket: FakeSocket,
  environment = { environmentId: ENV, name: 'Local' },
) {
  socket.respond('environment.get', { environment })
  socket.respond('workspace.list', { workspaces: [WORKSPACE] })
  socket.respond('session.list', { sessions: [], nextCursor: null })
}

async function connected(capabilities = FULL_CAPABILITIES, extraBootstrap: object = {}) {
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
  socket.respond('protocol.handshake', { ...bootstrap(capabilities), ...extraBootstrap })
  await flush()
  return { client, socket, timers }
}

describe('websocket environment client', () => {
  it('rejects rename on older servers without sending the command', async () => {
    const { client, socket } = await connected()
    await expect(client.commands.renameSession(SESSION.sessionId, 'Name')).rejects.toMatchObject({
      code: 'capability_missing',
    })
    expect(socket.sent.some((message) => message.name === 'session.rename')).toBe(false)
    client.disconnect()
  })

  it('keeps the persisted status while opening and hydrating an empty transcript', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    socket.respond('session.open', {
      session: { ...SESSION_SUMMARY, status: 'error' },
      threads: [THREAD],
    })
    await flush()
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('error')
    socket.respond('session.history', EMPTY_HISTORY)
    await opened
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('error')
    client.disconnect()
  })

  it('sends rename and delete commands and updates the local session', async () => {
    const { client, socket } = await connected([
      ...FULL_CAPABILITIES,
      'session.rename',
      'session.delete',
    ])
    socket.respond('session.list', { sessions: [SESSION_SUMMARY], nextCursor: null })
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

  it('does not show a stale open failure after navigating away', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    const rejected = expect(opened).rejects.toThrow('Folder unavailable')
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
    socket.respond('session.list', { sessions: [SESSION_SUMMARY], nextCursor: null })
    await flush()
    const opened = client.commands.openSession(SESSION.sessionId)
    const rejected = expect(opened).rejects.toThrow('Folder unavailable')
    socket.receive({
      type: 'error',
      requestId: socket.last('session.open').requestId,
      error: { code: 'workspace_unavailable', message: 'Folder unavailable' },
    })
    await rejected
    // The code travels with the failure so the pane can offer the recovery
    // actions instead of a generic "could not open" message.
    expect(client.getState().sessionOpenFailure).toEqual({
      sessionId: SESSION.sessionId,
      message: 'Folder unavailable',
      code: 'workspace_unavailable',
    })
    expect(selectSessionList(client.getState())).toHaveLength(1)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    const retry = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await retry
    expect(client.getState().sessionOpenFailure).toBeNull()
    expect(selectActiveThread(client.getState())?.hydration).toBe('ready')
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
    await answerCatalog(socket)
    await flush()
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
        record: {
          cursor: {
            scope: { ...THREAD, type: 'thread', environmentId: ENV },
            epoch: 'e',
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

  it('lists session summaries with a cursor and hydrates history after open', async () => {
    const { client, socket } = await connected()
    const listing = client.commands.listSessions({ limit: 1 })
    expect(socket.last('session.list').payload).toEqual({ limit: 1 })
    socket.respond('session.list', {
      sessions: [SESSION_SUMMARY],
      nextCursor: { updatedAt: SESSION_SUMMARY.updatedAt, sessionId: SESSION.sessionId },
    })
    const page = await listing
    expect(page.sessions).toHaveLength(1)
    expect(page.sessions[0]).toMatchObject({
      sessionId: SESSION.sessionId,
      status: 'idle',
      providerId: 'opencode',
    })
    expect(page.nextCursor?.sessionId).toBe(SESSION.sessionId)
    expect(client.getState().sessions[SESSION.sessionId]?.threadIds).toEqual([])

    const older = {
      sessionId: 'session-0',
      workspaceId: SESSION.workspaceId,
      title: 'Older',
      status: 'idle' as const,
      providerId: 'opencode',
      updatedAt: '2026-09-09T00:00:00.000Z',
    }
    const rest = client.commands.listSessions({ cursor: page.nextCursor!, limit: 1 })
    socket.respond('session.list', { sessions: [older], nextCursor: null })
    const second = await rest
    expect(second.sessions.map((session) => session.sessionId)).toEqual(['session-0'])
    expect(second.nextCursor).toBeNull()
    expect(
      selectSessionList(client.getState())
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual([SESSION.sessionId, 'session-0'].sort())

    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket, SESSION_SUMMARY, [THREAD], {
      messages: [
        {
          messageId: 'message-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
      interactions: [],
      nextCursor: null,
    })
    await opened
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
    expect(selectActiveThread(client.getState())?.hydration).toBe('ready')
  })

  it('sends a turn and folds the response in before the event arrives', async () => {
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
    socket.respond('turn.send', turnStarted('turn-9', 'go', 'cmd-1').payload)
    const result = await sending
    expect(result.turn.turnId).toBe('turn-9')
    expect(selectActiveThread(client.getState())?.turns[0]?.state).toBe('running')
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
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
  })

  it('confirms the echo from an environment that does not return the command id', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({ ...THREAD, text: 'go', commandId: 'cmd-1' })
    socket.respond('turn.send', turnStarted('turn-9', 'go').payload)
    await sending
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
  })

  it('keeps one row when the event arrives before the response, and after it', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await flush()
    await opened.catch(() => undefined)
    const sending = client.commands.sendTurn({ ...THREAD, text: 'go', commandId: 'cmd-1' })
    socket.receive(turnStarted('turn-9', 'go', 'cmd-1'))
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
    socket.respond('turn.send', turnStarted('turn-9', 'go', 'cmd-1').payload)
    await sending
    socket.receive(turnStarted('turn-9', 'go', 'cmd-1'))
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
    expect(selectActiveThread(client.getState())?.outbox).toEqual([])
    expect(selectActiveThread(client.getState())?.messages).toHaveLength(1)
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

  it('removes a pending interaction optimistically after responding', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket, SESSION_SUMMARY, [THREAD], {
      messages: [],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'waiting' }],
      interactions: [{ threadId: THREAD.threadId, interaction: permission }],
      nextCursor: null,
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
      interactions: [{ threadId: THREAD.threadId, interaction: permission }],
      nextCursor: null,
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

  it('releases a subscription that was dropped before its acknowledgement arrived', async () => {
    const { client, socket } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await opened
    const subscribeRequest = socket.last('subscription.subscribe')
    expect(subscribeRequest.payload).toMatchObject({ scope: { type: 'thread' } })

    // Leave the session before the server acknowledges the thread subscription.
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

    socket.receive({
      type: 'response',
      requestId: subscribeRequest.requestId,
      payload: {
        subscriptionId: 'sub-thread-1',
        scope: (subscribeRequest.payload as { scope: unknown }).scope,
      },
    })
    expect(socket.last('subscription.unsubscribe').payload).toEqual({
      subscriptionId: 'sub-thread-1',
    })
  })

  it('sends one subscribe per scope while an earlier subscribe is unacknowledged', async () => {
    const { client, socket } = await connected()
    const first = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await first
    const again = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await again
    const threadSubscribes = socket.sent.filter(
      (message) =>
        message.name === 'subscription.subscribe' &&
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
    expect(next.sent.filter((message) => message.name === 'session.open')).toHaveLength(1)
  })

  it('answers heartbeat pings', async () => {
    const { socket } = await connected()
    socket.receive({ type: 'ping', heartbeatId: 'hb-1' })
    expect(socket.sent.at(-1)).toEqual({ type: 'pong', heartbeatId: 'hb-1' })
  })

  it('reconnects with backoff, re-handshakes and re-opens the active session', async () => {
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
    next.respond('subscription.subscribe', {
      subscriptionId: 'sub-env-2',
      scope: { type: 'environment', environmentId: ENV },
    })
    await flush()
    await answerCatalog(next, { environmentId: ENV, name: 'Local' })
    await flush()
    await flush()
    expect(next.last('session.open').payload).toEqual({ sessionId: SESSION.sessionId })
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

  it('resumes every subscription after a drop and keeps events flowing', async () => {
    const { client, socket, timers } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await flush()
    await opened.catch(() => undefined)

    const scopes = (target: FakeSocket) =>
      target.sent
        .filter((message) => message.name === 'subscription.subscribe')
        .map((message) => (message.payload as { scope: { type: string } }).scope.type)
    expect(scopes(socket)).toEqual(['environment', 'session', 'thread'])

    const record = (sequence: number, event: unknown) => ({
      type: 'event',
      name: 'subscription.event',
      payload: {
        subscriptionId: 'sub-thread',
        record: {
          cursor: {
            scope: { ...THREAD, type: 'thread', environmentId: ENV },
            epoch: 'e',
            sequence,
          },
          event,
        },
      },
    })
    socket.receive(record(2, turnStarted()))
    socket.receive(record(3, delta('turn-1', 'assistant-1', 'Hi')))

    socket.drop(1006)
    await flush()
    timers.advance(100)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()

    // Re-subscribed from the handshake alone: no catalog read, no session.open
    // and no user action have happened yet.
    expect(scopes(next)).toEqual(['environment', 'session', 'thread'])

    // The cursor survived the drop, so a replayed record is still ignored and a
    // newer one still lands in the store.
    next.receive(record(3, delta('turn-1', 'assistant-1', 'Hi')))
    next.receive(record(4, delta('turn-1', 'assistant-1', '!')))
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi!' },
    ])
  })

  it('releases the previous session scopes when the active session is cleared', async () => {
    const { client, socket, timers } = await connected()
    const opened = client.commands.openSession(SESSION.sessionId)
    await answerOpen(socket)
    await opened

    const subscribes = socket.sent.filter((message) => message.name === 'subscription.subscribe')
    expect(
      subscribes.map((message) => (message.payload as { scope: { type: string } }).scope.type),
    ).toEqual(['environment', 'session', 'thread'])
    for (const [index, request] of subscribes.entries()) {
      socket.receive({
        type: 'response',
        requestId: request.requestId,
        payload: {
          subscriptionId: `sub-${index}`,
          scope: (request.payload as { scope: unknown }).scope,
        },
      })
    }

    // Opening a draft clears the active session; its scopes must go with it.
    client.setActiveSession(null)
    expect(
      socket.sent
        .filter((message) => message.name === 'subscription.unsubscribe')
        .map((message) => message.payload),
    ).toEqual([{ subscriptionId: 'sub-1' }, { subscriptionId: 'sub-2' }])

    socket.drop(1006)
    await flush()
    timers.advance(100)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', bootstrap(FULL_CAPABILITIES))
    await flush()
    expect(
      next.sent
        .filter((message) => message.name === 'subscription.subscribe')
        .map((message) => (message.payload as { scope: { type: string } }).scope.type),
    ).toEqual(['environment'])
  })
})

describe('cursor replay on reconnect', () => {
  const REPLAY_CAPABILITIES = [...FULL_CAPABILITIES, 'subscription.replay']
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
  async function dropped() {
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
          interactions: [],
          nextCursor: null,
        },
      },
    })
    await opened
    // A first thread open uses the atomic snapshot/live boundary.
    expect(names(socket)).toEqual(['subscribe:environment', 'subscribe:session', 'replay:thread'])
    socket.receive(live(2, turnStarted()))
    socket.receive(live(3, delta('turn-1', 'assistant-1', 'Hi')))
    socket.drop(1006)
    await flush()
    timers.advance(100)
    const next = FakeSocket.instances[1]!
    next.open()
    next.respond('protocol.handshake', bootstrap(REPLAY_CAPABILITIES))
    await flush()
    return { client, next }
  }

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
          interactions: [],
          nextCursor: { ordinal: 12 },
        },
      },
    })
    socket.receive(live(3, delta('turn-1', 'assistant-1', 'Hi')))
    socket.receive(live(4, delta('turn-1', 'assistant-1', '!')))
    await opened
    expect(selectActiveThread(client.getState())?.historyCursor).toEqual({ ordinal: 12 })
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi!' },
    ])
    expect(socket.sent.some((message) => message.name === 'session.history')).toBe(false)
    client.dispose()
  })

  it('does not let an older page roll back live turn state or replace streamed text', async () => {
    const { client, next } = await dropped()
    next.respond('subscription.replay', {
      mode: 'replay',
      subscriptionId: 'sub-thread-2',
      from: cursor(3),
      to: cursor(3),
      events: [],
    })
    const page = client.commands.loadSessionHistory({ ...THREAD, cursor: { ordinal: 12 } })
    next.receive(live(4, delta('turn-1', 'assistant-1', '!')))
    next.receive(live(5, completed()))
    next.respond('session.history', {
      messages: [
        {
          messageId: 'assistant-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'stale' }],
        },
      ],
      turns: [turnStarted().payload.turn],
      interactions: [],
      nextCursor: null,
    })
    await page
    expect(selectActiveThread(client.getState())?.turns[0]?.state).toBe('completed')
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi!' },
    ])
    client.dispose()
  })

  it('resumes a held cursor through subscription.replay and folds the missed tail in once', async () => {
    const { client, next } = await dropped()
    // Only the thread has a cursor; the other scopes never produced an event.
    expect(names(next)).toEqual(['subscribe:environment', 'subscribe:session', 'replay:thread'])
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

    // The tail moved the cursor: repeats and late parts cannot change the settled turn.
    next.receive(live(5, completed()))
    next.receive(live(4, delta('turn-1', 'assistant-1', '!')))
    next.receive(live(6, delta('turn-1', 'assistant-1', ' there')))
    expect(selectActiveThread(client.getState())?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Hi!' },
    ])
    next.receive(live(7, turnStarted('turn-2')))
    expect(selectActiveThread(client.getState())?.turns.at(-1)?.turnId).toBe('turn-2')
    // The recovered subscription is the one released when the session goes.
    client.setActiveSession(null)
    expect(
      next.sent
        .filter((message) => message.name === 'subscription.unsubscribe')
        .map((message) => message.payload),
    ).toEqual([{ subscriptionId: 'sub-thread-2' }])
    // The catalog reads and the re-open still follow, as before.
    expect(next.last('session.list')).toBeDefined()
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
          interactions: [],
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
    next.receive(live(10, delta('turn-1', 'assistant-1', '.')))
    next.receive(live(11, turnStarted('turn-2')))
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
    expect(names(next)).toEqual(['subscribe:environment', 'subscribe:session', 'replay:thread'])
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
    expect(names(next)).toEqual(['subscribe:environment', 'subscribe:session', 'replay:thread'])
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
  socket.respond('session.create', { session: SESSION, thread: THREAD, firstTurn })
  expect(await pending).toMatchObject({ firstTurn })
  expect(client.getState().threads[THREAD.threadId]?.messages).toEqual([firstTurn.userMessage])
  expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('idle')
  expect(socket.sent.some((message) => message.name === 'turn.send')).toBe(false)
})
