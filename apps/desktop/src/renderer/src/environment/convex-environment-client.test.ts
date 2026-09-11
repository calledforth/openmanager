import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ProviderId } from '@agentpack/contract'
import { getFunctionName, type FunctionReference } from 'convex/server'
import { selectActiveThread, selectSessionList } from '@openmanager/environment-client'
import {
  createConvexEnvironmentClient,
  type ConvexGateway,
  type DesktopEventBridge,
} from './convex-environment-client'

// ---------------------------------------------------------------------------
// Fakes: a scriptable Convex deployment and the preload event bridge
// ---------------------------------------------------------------------------

type Handler = (args: Record<string, unknown>) => unknown

class FakeConvex implements ConvexGateway {
  readonly queries = new Map<string, Handler>()
  readonly mutations = new Map<string, Handler>()
  readonly calls: Array<{
    kind: 'query' | 'mutation'
    name: string
    args: Record<string, unknown>
  }> = []
  private readonly watchers = new Map<string, Set<(value: unknown) => void>>()

  on(name: string, handler: Handler) {
    this.queries.set(name, handler)
    return this
  }
  mutate(name: string, handler: Handler) {
    this.mutations.set(name, handler)
    return this
  }
  /** Re-run a query's handler for everyone subscribed to it, as a Convex push would. */
  push(name: string) {
    for (const listener of this.watchers.get(name) ?? []) listener(this.run('query', name, {}))
  }
  pushWith(name: string, value: unknown) {
    for (const listener of this.watchers.get(name) ?? []) listener(value)
  }
  watcherCount(name: string) {
    return this.watchers.get(name)?.size ?? 0
  }

  private run(kind: 'query' | 'mutation', name: string, args: Record<string, unknown>) {
    this.calls.push({ kind, name, args })
    const handler = (kind === 'query' ? this.queries : this.mutations).get(name)
    if (!handler) throw new Error(`No fake for ${kind} ${name}`)
    return handler(args)
  }

  async query<T>(reference: FunctionReference<'query'>, args: Record<string, unknown>) {
    return this.run('query', getFunctionName(reference), args) as T
  }
  async mutation<T>(reference: FunctionReference<'mutation'>, args: Record<string, unknown>) {
    return this.run('mutation', getFunctionName(reference), args) as T
  }
  subscribe<T>(
    reference: FunctionReference<'query'>,
    args: Record<string, unknown>,
    onUpdate: (value: T) => void,
  ) {
    const name = getFunctionName(reference)
    const listeners = this.watchers.get(name) ?? new Set()
    const listener = onUpdate as (value: unknown) => void
    listeners.add(listener)
    this.watchers.set(name, listeners)
    if (this.queries.has(name)) onUpdate(this.run('query', name, args) as T)
    return () => {
      listeners.delete(listener)
    }
  }
}

class FakeBridge implements DesktopEventBridge {
  private acp = new Set<(event: AgentEvent) => void>()
  private stream = new Set<(event: AgentEvent) => void>()
  lastProviderId: ProviderId = 'cursor'
  onAcpEvent(callback: (event: AgentEvent) => void) {
    this.acp.add(callback)
    return () => this.acp.delete(callback)
  }
  onStreamToken(callback: (event: AgentEvent) => void) {
    this.stream.add(callback)
    return () => this.stream.delete(callback)
  }
  getLastProviderId = async () => this.lastProviderId
  /** The main process sends stream-class events on both channels. */
  emit(event: AgentEvent, channels: Array<'acp' | 'stream'> = ['acp', 'stream']) {
    if (channels.includes('acp')) for (const cb of this.acp) cb(event)
    if (channels.includes('stream')) for (const cb of this.stream) cb(event)
  }
  listenerCount() {
    return this.acp.size + this.stream.size
  }
}

let sequence = 0
const agentEvent = (partial: Record<string, unknown>): AgentEvent =>
  ({
    id: `evt-${++sequence}`,
    threadId: 'session-1',
    seq: sequence,
    timestamp: '2026-09-11T00:00:00.000Z',
    providerId: 'opencode',
    workspaceId: 'C:/repo',
    sessionId: 'session-1',
    ...partial,
  }) as AgentEvent

const WORKSPACE = { _id: 'ws1', path: 'C:/repo', name: 'repo' }
const SESSION_ROW = {
  workspacePath: 'C:/repo',
  externalId: 'session-1',
  title: 'First',
  status: 'idle',
  providerId: 'cursor',
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup() {
  const convex = new FakeConvex()
    .on('workspaces:list', () => [WORKSPACE])
    .on('sessions:listForSidebar', () => [SESSION_ROW])
    .on('jobs:getStatus', () => ({ status: 'pending' }))
    .mutate('jobs:submit', () => 'job-1')
  const bridge = new FakeBridge()
  const client = createConvexEnvironmentClient({
    convex,
    bridge,
    clientId: 'client-1',
    environmentId: 'env',
    jobTimeoutMs: 50,
  })
  return { convex, bridge, client }
}

const payloadOf = (convex: FakeConvex, index = -1) => {
  const submits = convex.calls.filter((call) => call.name === 'jobs:submit')
  const call = submits.at(index)!
  return { ...call.args, payload: JSON.parse(call.args.payload as string) }
}

describe('createConvexEnvironmentClient', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports connected with every command advertised, and closes on disconnect', () => {
    const { client, bridge } = setup()
    expect(client.getState().connection.phase).toBe('idle')
    client.connect()
    expect(client.getState().connection).toMatchObject({
      phase: 'connected',
      hasConnected: true,
      capabilities: expect.arrayContaining(['turn.send', 'session.open', 'workspace.add']),
    })
    expect(client.supports('renameSession')).toBe(true)
    expect(bridge.listenerCount()).toBe(2)
    client.disconnect()
    expect(client.getState().connection.phase).toBe('closed')
    expect(bridge.listenerCount()).toBe(0)
  })

  it('mirrors the Convex workspace and session catalog into the store', () => {
    const { client, convex } = setup()
    client.connect()
    const state = client.getState()
    expect(state.workspaceOrder).toEqual(['C:/repo'])
    expect(state.workspaces['C:/repo']).toEqual({ workspaceId: 'C:/repo', name: 'repo' })
    expect(selectSessionList(state, 'C:/repo')).toMatchObject([
      { sessionId: 'session-1', title: 'First', threadIds: ['session-1'] },
    ])
    expect(state.threads['session-1']?.hydration).toBe('idle')
    expect(convex.calls.filter((call) => call.name === 'sessions:listForSidebar')[0]?.args).toEqual(
      {
        workspacePaths: ['C:/repo'],
      },
    )
  })

  it('drops sessions and workspaces the catalog no longer lists, hiding child sessions', () => {
    const { client, convex } = setup()
    client.connect()
    convex.pushWith('sessions:listForSidebar', [
      { ...SESSION_ROW, externalId: 'session-2', title: 'Second' },
      { ...SESSION_ROW, externalId: 'child', parentExternalId: 'session-2' },
    ])
    expect(client.getState().sessionOrder).toEqual(['session-2'])
    convex.pushWith('workspaces:list', [])
    expect(client.getState().workspaceOrder).toEqual([])
    expect(convex.watcherCount('sessions:listForSidebar')).toBe(0)
  })

  it('keeps a session announced over IPC even while the catalog has not caught up', () => {
    const { client, convex, bridge } = setup()
    client.connect()
    bridge.emit(
      agentEvent({ category: 'lifecycle', event: 'session_created', sessionId: 'fresh', data: {} }),
    )
    expect(client.getState().sessions.fresh).toMatchObject({ workspaceId: 'C:/repo', title: null })
    convex.push('sessions:listForSidebar')
    expect(client.getState().sessions.fresh).toBeDefined()
  })

  it('does not let a session_created echo reset a title the catalog already holds', () => {
    const { client, bridge } = setup()
    client.connect()
    bridge.emit(agentEvent({ category: 'lifecycle', event: 'session_created', data: {} }))
    expect(client.getState().sessions['session-1']?.title).toBe('First')
  })

  it('hydrates a session from Convex into turns, messages and pending interactions', async () => {
    const { client, convex } = setup()
    convex
      .on('sessions:getByExternalId', () => ({
        ...SESSION_ROW,
        workspaceId: 'ws1',
        status: 'running',
      }))
      .on('messages:listMetadata', () => [
        { externalId: 'usr-1', role: 'user', sequenceNum: 0, isFinal: true },
        { externalId: 'asst-1', role: 'assistant', sequenceNum: 1, isFinal: true },
        { externalId: 'perm-row', role: 'permission', sequenceNum: 2 },
        { externalId: 'usr-2', role: 'user', sequenceNum: 3, isFinal: true },
      ])
      .on('messages:getContent', ({ externalId }) =>
        externalId === 'usr-1'
          ? {
              externalId,
              role: 'user',
              content: 'hello',
              metadata: {
                parts: [
                  {
                    type: 'image',
                    url: 'https://cdn/img.png',
                    name: 'img.png',
                    mimeType: 'image/png',
                  },
                ],
              },
            }
          : externalId === 'asst-1'
            ? { externalId, role: 'assistant', content: 'hi there', isFinal: true }
            : { externalId, role: 'user', content: 'and again' },
      )
      .on('permissions:getPendingForSession', () => ({
        requestId: 'perm-1',
        toolName: 'bash',
        description: 'run',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        expiresAt: 1_800_000_000_000,
      }))
      .on('questions:getPendingForSession', () => null)
      .on('plans:getPendingForSession', () => ({
        requestId: 'plan-1',
        markdown: '# Plan',
        todos: [{ id: 't', content: 'x', status: 'pending' }],
      }))
    client.connect()

    const opening = client.commands.openSession('session-1')
    expect(client.getState().threads['session-1']?.hydration).toBe('loading')
    await opening

    const state = client.getState()
    expect(state.activeSessionId).toBe('session-1')
    expect(state.activeThreadId).toBe('session-1')
    const thread = selectActiveThread(state)!
    expect(thread.hydration).toBe('ready')
    expect(thread.messages.map((m) => [m.messageId, m.role, m.turnId])).toEqual([
      ['usr-1', 'user', 'asst-1'],
      ['asst-1', 'assistant', 'asst-1'],
      ['usr-2', 'user', 'usr-2'],
    ])
    expect(thread.messages[0]?.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'resource_link', uri: 'https://cdn/img.png', name: 'img.png', mimeType: 'image/png' },
    ])
    expect(thread.turns).toEqual([
      { turnId: 'asst-1', threadId: 'session-1', state: 'completed' },
      { turnId: 'usr-2', threadId: 'session-1', state: 'waiting' },
    ])
    expect(thread.interactions.map((item) => [item.interaction.kind, item.turnId])).toEqual([
      ['permission', 'usr-2'],
      ['plan', 'usr-2'],
    ])
    expect(thread.interactions[0]?.interaction).toMatchObject({
      interactionId: 'perm-1',
      toolCall: { toolCallId: 'perm-1', title: 'bash' },
      expiresAt: '2027-01-15T08:00:00.000Z',
    })
    expect(state.sessions['session-1']?.status).toBe('waiting')
  })

  it('classifies persisted turns by their finish reason', async () => {
    const { client, convex } = setup()
    convex
      .on('sessions:getByExternalId', () => ({ ...SESSION_ROW, status: 'error' }))
      .on('messages:listMetadata', () => [
        { externalId: 'a1', role: 'assistant', sequenceNum: 0, isFinal: true },
        { externalId: 'a2', role: 'assistant', sequenceNum: 1, isFinal: true },
        { externalId: 'a3', role: 'assistant', sequenceNum: 2, isFinal: false },
      ])
      .on('messages:getContent', ({ externalId }) => ({
        externalId,
        role: 'assistant',
        content: 'x',
        isFinal: externalId !== 'a3',
        metadata: {
          runtime: {
            finishReason:
              externalId === 'a1' ? 'error' : externalId === 'a2' ? 'cancelled' : undefined,
          },
        },
      }))
      .on('permissions:getPendingForSession', () => null)
      .on('questions:getPendingForSession', () => null)
      .on('plans:getPendingForSession', () => null)
    client.connect()
    await client.commands.openSession('session-1')
    expect(selectActiveThread(client.getState())!.turns.map((turn) => turn.state)).toEqual([
      'failed',
      'interrupted',
      'interrupted',
    ])
  })

  it('marks the thread failed and rethrows when hydration cannot find the session', async () => {
    const { client, convex } = setup()
    convex
      .on('sessions:getByExternalId', () => null)
      .on('messages:listMetadata', () => [])
      .on('permissions:getPendingForSession', () => null)
      .on('questions:getPendingForSession', () => null)
      .on('plans:getPendingForSession', () => null)
    client.connect()
    await expect(client.commands.openSession('session-1')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(client.getState().threads['session-1']?.hydration).toBe('failed')
    await expect(client.commands.openSession('missing')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('submits a send_message job and resolves once the turn starts over IPC', async () => {
    const { client, convex, bridge } = setup()
    client.connect()
    client.setActiveSession('session-1')

    const sending = client.commands.sendTurn({
      sessionId: 'session-1',
      threadId: 'session-1',
      text: 'do it',
    })
    await flush()
    const submitted = payloadOf(convex)
    expect(submitted).toMatchObject({
      workspacePath: 'C:/repo',
      type: 'send_message',
      clientId: 'client-1',
      sessionExternalId: 'session-1',
      payload: {
        workspacePath: 'C:/repo',
        sessionExternalId: 'session-1',
        content: 'do it',
        attachments: [],
        userMessageId: 'agent_usr_uuid-1',
        providerId: 'cursor',
      },
    })
    expect(convex.watcherCount('jobs:getStatus')).toBe(1)

    bridge.emit(
      agentEvent({
        category: 'lifecycle',
        event: 'prompt_started',
        messageId: 'asst-1',
        data: { prompt: 'do it', userMessageId: 'agent_usr_uuid-1' },
      }),
    )
    const result = await sending
    expect(result.turn).toEqual({ turnId: 'asst-1', threadId: 'session-1', state: 'running' })
    expect(result.userMessage.messageId).toBe('agent_usr_uuid-1')
    expect(convex.watcherCount('jobs:getStatus')).toBe(0)

    const thread = client.getState().threads['session-1']!
    expect(thread.turns).toEqual([{ turnId: 'asst-1', threadId: 'session-1', state: 'running' }])
    expect(client.getState().sessions['session-1']?.status).toBe('running')
  })

  it('applies each streamed event once even though it arrives on both channels', () => {
    const { client, bridge } = setup()
    client.connect()
    bridge.emit(
      agentEvent({
        category: 'lifecycle',
        event: 'prompt_started',
        messageId: 'asst-1',
        data: { prompt: 'q', userMessageId: 'usr-1' },
      }),
    )
    bridge.emit(
      agentEvent({
        category: 'stream',
        event: 'agent_message_chunk',
        messageId: 'asst-1',
        data: { content: { type: 'text', text: 'Hel' } },
      }),
    )
    bridge.emit(
      agentEvent({
        category: 'stream',
        event: 'agent_message_chunk',
        messageId: 'asst-1',
        data: { content: { type: 'text', text: 'lo' } },
      }),
      ['stream'],
    )
    bridge.emit(agentEvent({ category: 'lifecycle', event: 'prompt_completed', data: {} }))
    const thread = client.getState().threads['session-1']!
    expect(thread.messages.find((m) => m.messageId === 'asst-1')?.content).toEqual([
      { type: 'text', text: 'Hello' },
    ])
    expect(thread.turns[0]?.state).toBe('completed')
  })

  it('rejects sendTurn with the worker error when the job fails', async () => {
    const { client, convex } = setup()
    client.connect()
    const sending = client.commands.sendTurn({
      sessionId: 'session-1',
      threadId: 'session-1',
      text: 'x',
    })
    await flush()
    convex.pushWith('jobs:getStatus', { status: 'failed', lastError: 'provider down' })
    await expect(sending).rejects.toMatchObject({ code: 'internal', message: 'provider down' })
  })

  it('times out sendTurn when no turn ever starts', async () => {
    const { client } = setup()
    client.connect()
    await expect(
      client.commands.sendTurn({ sessionId: 'session-1', threadId: 'session-1', text: 'x' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('creates a session through a job and adopts the id the provider announces', async () => {
    const { client, convex, bridge } = setup()
    client.connect()
    const creating = client.commands.createSession({ workspaceId: 'C:/repo', title: 'New' })
    await flush()
    expect(payloadOf(convex)).toMatchObject({
      type: 'create_session',
      payload: { workspacePath: 'C:/repo', providerId: 'cursor', title: 'New' },
    })
    bridge.emit(
      agentEvent({
        category: 'lifecycle',
        event: 'session_created',
        sessionId: 'session-9',
        data: {},
      }),
    )
    const { session, thread } = await creating
    expect(session).toEqual({ sessionId: 'session-9', workspaceId: 'C:/repo', title: 'New' })
    expect(thread).toEqual({ threadId: 'session-9', sessionId: 'session-9' })
    expect(client.getState().threads['session-9']?.hydration).toBe('ready')
    await expect(client.commands.createSession({ workspaceId: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('routes interruptions, deletions and interaction answers to the matching jobs', async () => {
    const { client, convex } = setup()
    client.connect()
    await client.commands.interruptTurn({
      sessionId: 'session-1',
      threadId: 'session-1',
      turnId: 't',
    })
    expect(payloadOf(convex)).toMatchObject({
      type: 'abort',
      payload: { sessionExternalId: 'session-1' },
    })

    await client.commands.respondToInteraction({
      sessionId: 'session-1',
      threadId: 'session-1',
      response: {
        kind: 'permission',
        interactionId: 'perm-1',
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    })
    expect(payloadOf(convex)).toMatchObject({
      type: 'resolve_permission',
      payload: { permissionId: 'perm-1', optionId: 'allow', providerId: 'cursor' },
    })
    await client.commands.respondToInteraction({
      sessionId: 'session-1',
      threadId: 'session-1',
      response: {
        kind: 'permission',
        interactionId: 'perm-2',
        outcome: { outcome: 'cancelled', reason: 'user' },
      },
    })
    expect(payloadOf(convex).payload).toMatchObject({ permissionId: 'perm-2', approved: false })
    await client.commands.respondToInteraction({
      sessionId: 'session-1',
      threadId: 'session-1',
      response: {
        kind: 'question',
        interactionId: 'q-1',
        outcome: { outcome: 'answered', answers: [] },
      },
    })
    expect(payloadOf(convex)).toMatchObject({
      type: 'resolve_question',
      payload: { requestId: 'q-1', outcome: { outcome: 'answered' } },
    })
    await client.commands.respondToInteraction({
      sessionId: 'session-1',
      threadId: 'session-1',
      response: {
        kind: 'plan',
        interactionId: 'plan-1',
        outcome: { outcome: 'rejected', reason: 'no' },
      },
    })
    expect(payloadOf(convex)).toMatchObject({
      type: 'resolve_plan',
      payload: { requestId: 'plan-1' },
    })

    await client.commands.deleteSession('session-1')
    expect(payloadOf(convex)).toMatchObject({
      type: 'delete_session',
      sessionExternalId: 'session-1',
      payload: { sessionExternalId: 'session-1', providerId: 'cursor' },
    })
    expect(client.getState().sessions['session-1']).toBeUndefined()
  })

  it('optimistically clears a pending interaction and returns the turn to running', async () => {
    const { client, bridge } = setup()
    client.connect()
    bridge.emit(
      agentEvent({
        category: 'lifecycle',
        event: 'prompt_started',
        messageId: 'asst-1',
        data: { prompt: 'q', userMessageId: 'usr-1' },
      }),
    )
    bridge.emit(
      agentEvent({
        category: 'permission',
        event: 'permission_request',
        data: {
          requestId: 'perm-1',
          sessionId: 'session-1',
          toolCall: { toolCallId: 'tool-1', title: 'Run' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      }),
    )
    expect(client.getState().threads['session-1']?.turns[0]?.state).toBe('waiting')
    await client.commands.respondToInteraction({
      sessionId: 'session-1',
      threadId: 'session-1',
      response: {
        kind: 'permission',
        interactionId: 'perm-1',
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    })
    const thread = client.getState().threads['session-1']!
    expect(thread.interactions).toEqual([])
    expect(thread.turns[0]?.state).toBe('running')
  })

  it('renames through upsertTitle and refuses to clear a title', async () => {
    const { client, convex } = setup()
    convex.mutate('sessions:upsertTitle', () => undefined)
    client.connect()
    await client.commands.renameSession('session-1', 'Renamed')
    expect(convex.calls.at(-1)).toMatchObject({
      name: 'sessions:upsertTitle',
      args: { workspacePath: 'C:/repo', externalId: 'session-1', title: 'Renamed', source: 'user' },
    })
    expect(client.getState().sessions['session-1']?.title).toBe('Renamed')
    await expect(client.commands.renameSession('session-1', null)).rejects.toMatchObject({
      code: 'validation',
    })
  })

  it('adds and removes workspaces through the Convex mutations', async () => {
    const { client, convex } = setup()
    convex
      .mutate('workspaces:ensureByPath', ({ path }) => ({ _id: 'ws2', path, name: 'other' }))
      .on('workspaces:getByPath', ({ path }) => (path === 'C:/repo' ? WORKSPACE : null))
      .mutate('workspaces:remove', () => undefined)
    client.connect()
    expect(await client.commands.addWorkspace({ name: 'x', path: 'C:/other' })).toEqual({
      workspaceId: 'C:/other',
      name: 'other',
    })
    expect(client.getState().workspaceOrder).toEqual(['C:/repo', 'C:/other'])
    await client.commands.removeWorkspace('C:/repo')
    expect(convex.calls.at(-1)).toMatchObject({ name: 'workspaces:remove', args: { id: 'ws1' } })
    expect(client.getState().workspaceOrder).toEqual(['C:/other'])
    expect(client.getState().sessions['session-1']).toBeUndefined()
  })

  it('rejects commands before connect and after dispose, and drops in-flight waits on dispose', async () => {
    const { client, bridge } = setup()
    await expect(client.commands.listWorkspaces()).rejects.toMatchObject({ code: 'unavailable' })
    client.connect()
    const sending = client.commands.sendTurn({
      sessionId: 'session-1',
      threadId: 'session-1',
      text: 'x',
    })
    await flush()
    client.dispose()
    await expect(sending).rejects.toMatchObject({ code: 'unavailable' })
    expect(bridge.listenerCount()).toBe(0)
    expect(client.getState().connection.phase).toBe('closed')
    await expect(client.commands.getEnvironment()).rejects.toMatchObject({ code: 'unavailable' })
    client.connect()
    expect(bridge.listenerCount()).toBe(0)
  })
})
