import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../backends/Backend.js'
import { cursor } from '../providers/cursor.js'
import { opencode } from '../providers/opencode.js'
import type { AcpProviderConfig } from '../providers/index.js'
import { AcpProbeRuntimeImpl } from './AcpProbeRuntimeImpl.js'
import { FakeConnectionFactory, type FakeWire } from './test-connection.js'

const CURSOR_INITIALIZE = {
  protocolVersion: 1,
  agentInfo: { name: 'cursor-agent', version: '2026.07.23' },
  agentCapabilities: {
    sessionCapabilities: { list: {} },
    promptCapabilities: { image: true },
  },
  authMethods: [{ id: 'cursor_login', name: 'Cursor' }],
}

function build(wire: FakeWire, config: AcpProviderConfig = cursor) {
  const events: BackendEvent[] = []
  const connections = new FakeConnectionFactory(wire)
  const probe = new AcpProbeRuntimeImpl(
    {
      providerId: config.id,
      cwd: 'C:/workspace',
      threadId: `desktop-bootstrap:${config.id}`,
      workspaceId: 'C:/workspace',
    },
    {
      config,
      host: { log: vi.fn() },
      connections,
      onEvent: (event) => events.push(event),
    },
  )
  return { probe, events, connections }
}

describe('AcpProbeRuntime handshake', () => {
  it('reports the negotiated capabilities and emits the bootstrap lifecycle events', async () => {
    const authenticate = vi.fn(async () => ({}))
    const { probe, events } = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate,
    })

    await expect(probe.probe()).resolves.toMatchObject({
      agentInfo: { name: 'cursor-agent', version: '2026.07.23' },
      authenticated: true,
      sessionListAdvertised: true,
      loadSessionAdvertised: true,
    })
    expect(authenticate).toHaveBeenCalledWith({ methodId: 'cursor_login' })
    expect(events.map((event) => event.event)).toEqual([
      'process_spawned',
      'initialized',
      'authenticated',
    ])
    expect(events.find((event) => event.event === 'initialized')).toMatchObject({
      threadId: 'desktop-bootstrap:cursor',
      data: {
        agentInfo: { name: 'cursor-agent' },
        capabilities: { canListSessions: true },
        promptCapabilities: { image: true },
      },
    })
  })

  it('emits auth_required and rejects when the provider does not tolerate auth failure', async () => {
    const { probe, events } = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate: async () => {
        throw new Error('not signed in')
      },
    })
    await expect(probe.probe()).rejects.toThrow('not signed in')
    expect(events.find((event) => event.event === 'auth_required')).toMatchObject({
      data: { message: 'not signed in', loginHint: 'Sign in to Cursor and retry.' },
    })
  })

  it('tolerates auth failure where the provider config says to', async () => {
    const { probe } = build(
      {
        initialize: async () => ({
          protocolVersion: 1,
          authMethods: [{ id: 'opencode-login', name: 'OpenCode' }],
        }),
        authenticate: async () => {
          throw new Error('no credentials')
        },
      },
      opencode,
    )
    await expect(probe.probe()).resolves.toMatchObject({
      authenticated: false,
      authError: 'no credentials',
    })
  })

  it('fails fast when the CLI dies mid-handshake instead of hanging on the RPC', async () => {
    const { probe, connections } = build({
      // A missing binary on Windows spawns through a shell, so the process
      // exists and exits immediately; `initialize` would never be answered.
      initialize: () => new Promise<never>(() => undefined),
    })
    const probing = probe.probe()
    await Promise.resolve()
    void connections.last.crash(1)
    await expect(probing).rejects.toThrow(/exited during startup \(code 1/)
  })

  it('runs in its own throwaway process and kills it on dispose', async () => {
    const { probe, connections } = build({ initialize: async () => CURSOR_INITIALIZE, authenticate: async () => ({}) })
    await probe.probe()
    expect(connections.connections).toHaveLength(1)
    await probe.dispose()
    expect(connections.last.terminated).toEqual({ reason: 'disposed' })
  })
})

describe('AcpProbeRuntime session listing', () => {
  it('lists, normalizes, deduplicates, and paginates Cursor sessions', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          {
            sessionId: ' session-1 ',
            cwd: ' C:/workspace ',
            title: ' Provider title ',
            updatedAt: ' 2026-07-19T14:32:22.082Z ',
          },
          { sessionId: '', cwd: 'C:/workspace', title: 'Invalid' },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        sessions: [
          { sessionId: 'session-1', cwd: 'C:/workspace', title: 'Duplicate' },
          { sessionId: 'session-2', cwd: 'C:/workspace', title: '  ' },
        ],
      })
    const { probe } = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate: async () => ({}),
      listSessions,
    })

    await expect(probe.listSessions('C:/workspace')).resolves.toEqual([
      {
        sessionId: 'session-1',
        cwd: 'C:/workspace',
        title: 'Provider title',
        updatedAt: '2026-07-19T14:32:22.082Z',
      },
      { sessionId: 'session-2', cwd: 'C:/workspace' },
    ])
    expect(listSessions).toHaveBeenNthCalledWith(1, { cwd: 'C:/workspace' })
    expect(listSessions).toHaveBeenNthCalledWith(2, { cwd: 'C:/workspace', cursor: 'page-2' })
  })

  it('does not call session/list when the agent did not advertise it', async () => {
    const listSessions = vi.fn()
    const { probe } = build({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
      listSessions,
    })

    await expect(probe.listSessions('C:/workspace')).rejects.toThrow(
      'cursor does not advertise ACP session/list support',
    )
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('rejects a repeated pagination cursor instead of looping forever', async () => {
    const { probe } = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate: async () => ({}),
      listSessions: async () => ({ sessions: [], nextCursor: 'same' }),
    })
    await expect(probe.listSessions('C:/workspace')).rejects.toThrow(
      'ACP session/list returned a repeated pagination cursor',
    )
  })
})

describe('AcpProbeRuntime model catalog', () => {
  const CATALOG = {
    models: [
      {
        slug: 'composer-2.5',
        name: 'Composer 2.5',
        description: 'Fast in-house model',
        isDefault: true,
        configOptions: [
          {
            type: 'select',
            id: 'reasoning',
            name: 'Reasoning effort',
            category: 'effort',
            currentValue: 'medium',
            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
          },
          { type: 'boolean', id: 'fast', name: 'Fast mode', currentValue: false },
        ],
      },
      // No effort control at all — a real state, not a gap.
      { slug: 'grok-4.5', name: 'Grok 4.5', configOptions: [] },
      { name: 'nameless row with no id' },
    ],
  }

  it('reads the catalog off the handshake, with per-model capabilities and no session', async () => {
    const newSession = vi.fn()
    const extMethod = vi.fn(async () => CATALOG)
    const { probe } = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate: async () => ({}),
      newSession,
      extMethod,
    })

    await expect(probe.listModels('C:/workspace')).resolves.toEqual({
      currentModelId: 'composer-2.5',
      availableModels: [
        {
          id: 'composer-2.5',
          displayName: 'Composer 2.5',
          description: 'Fast in-house model',
          effortLevels: ['low', 'high'],
          supportsFastMode: true,
        },
        { id: 'grok-4.5', displayName: 'Grok 4.5' },
      ],
    })
    expect(extMethod).toHaveBeenCalledWith('cursor/list_available_models', {})
    // The whole point: no session was opened to answer this.
    expect(newSession).not.toHaveBeenCalled()
  })

  it('falls back to session/new when the CLI is too old to know the method', async () => {
    const extMethod = vi.fn(async () => {
      throw new Error('Method not found')
    })
    const { probe } = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate: async () => ({}),
      extMethod,
      newSession: async () => ({
        sessionId: 'throwaway',
        models: {
          currentModelId: 'composer-2.5',
          availableModels: [{ modelId: 'composer-2.5', name: 'Composer 2.5' }],
        },
      }),
    })

    await expect(probe.listModels('C:/workspace')).resolves.toEqual({
      currentModelId: 'composer-2.5',
      availableModels: [{ id: 'composer-2.5', displayName: 'Composer 2.5' }],
    })
    expect(extMethod).toHaveBeenCalled()
  })

  it('falls back rather than returning an empty catalog the method answered', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'throwaway' }))
    const { probe } = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate: async () => ({}),
      extMethod: async () => ({ models: [] }),
      newSession,
    })

    await expect(probe.listModels('C:/workspace')).resolves.toEqual({})
    expect(newSession).toHaveBeenCalled()
  })

  it('goes straight to session/new for a provider with no catalog method', async () => {
    const extMethod = vi.fn()
    const { probe } = build(
      {
        initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
        extMethod,
        newSession: async () => ({
          sessionId: 'throwaway',
          models: { availableModels: [{ modelId: 'gpt-5.5', name: 'GPT-5.5' }] },
        }),
      },
      opencode,
    )

    await expect(probe.listModels('C:/workspace')).resolves.toEqual({
      availableModels: [{ id: 'gpt-5.5', displayName: 'GPT-5.5' }],
    })
    expect(extMethod).not.toHaveBeenCalled()
  })
})
