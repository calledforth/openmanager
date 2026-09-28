import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../backends/Backend.js'
import { cursor } from '../providers/cursor.js'
import { opencode } from '../providers/opencode.js'
import type { AcpProviderConfig } from '../providers/index.js'
import { AcpProbeRuntimeImpl } from './AcpProbeRuntimeImpl.js'
import type { RuntimeTimeouts } from './constants.js'
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

function build(
  wire: FakeWire,
  config: AcpProviderConfig = cursor,
  timeouts?: Partial<RuntimeTimeouts>,
) {
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
      ...(timeouts ? { timeouts } : {}),
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

  it('answers every prompt capability after a handshake, reading omitted ones as false', async () => {
    // ACP defines each omitted prompt capability as `false`. An agent that
    // sends none has answered "text only"; the composer must not wait on it.
    const silent = build({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    })
    await expect(silent.probe.probe()).resolves.toMatchObject({
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    })
    expect(silent.events.find((event) => event.event === 'initialized')).toMatchObject({
      data: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    })
    const partial = build({
      initialize: async () => CURSOR_INITIALIZE,
      authenticate: async () => ({}),
    })
    await expect(partial.probe.probe()).resolves.toMatchObject({
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    })
    // Only a literal boolean grants a capability; a truthy string does not.
    const malformed = build({
      initialize: async () => ({
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: { promptCapabilities: { image: 'yes', audio: 1 } },
      }),
    })
    await expect(malformed.probe.probe()).resolves.toMatchObject({
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
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

describe('AcpProbeRuntime model catalog', () => {
  const HANDSHAKE = {
    initialize: async () => CURSOR_INITIALIZE,
    authenticate: async () => ({}),
  }
  const LISTING = {
    models: [
      { value: 'composer-2.5', name: 'Composer 2.5' },
      {
        value: 'gpt-5.4',
        name: 'GPT-5.4',
        configOptions: [{ id: 'reasoning', type: 'select', currentValue: 'medium', options: [] }],
      },
    ],
  }
  const CATALOG = {
    availableModels: [
      { id: 'composer-2.5', displayName: 'Composer 2.5' },
      // Its one setting lists no values, so it cannot be offered.
      { id: 'gpt-5.4', displayName: 'GPT-5.4', configOptions: [] },
    ],
  }
  const MODES = {
    currentModeId: 'agent',
    availableModes: [
      { id: 'agent', name: 'Agent', description: 'Full agent capabilities with tool access' },
      { id: 'plan', name: 'Plan' },
      { id: 'ask', name: 'Ask' },
    ],
  }
  const withoutModes = { ...cursor, models: { catalog: { ...cursor.models!.catalog!, modesFromSession: false } } } as AcpProviderConfig

  it("reads Cursor's catalog from its own listing, without opening a session", async () => {
    const request = vi.fn(async () => LISTING)
    const newSession = vi.fn()
    const { probe } = build({ ...HANDSHAKE, request, newSession }, withoutModes)

    await expect(probe.listModels('C:/workspace')).resolves.toEqual(CATALOG)
    expect(request).toHaveBeenCalledWith('cursor/list_available_models', {})
    expect(newSession).not.toHaveBeenCalled()
  })

  it("reads Cursor's modes from one unprompted session, since no listing has them", async () => {
    const request = vi.fn(async () => LISTING)
    const newSession = vi.fn(async () => ({ sessionId: 'probe-session', modes: MODES }))
    const { probe } = build({ ...HANDSHAKE, request, newSession })

    const listing = await probe.listModels('C:/workspace')
    expect(listing).toMatchObject(CATALOG)
    expect(listing.modes?.currentModeId).toBe('agent')
    expect(listing.modes?.availableModes?.map((mode) => mode.id)).toEqual(['agent', 'plan', 'ask'])
    expect(newSession).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps the catalog when the session for the modes cannot open', async () => {
    const request = vi.fn(async () => LISTING)
    const newSession = vi.fn(async () => {
      throw new Error('session/new failed')
    })
    const { probe } = build({ ...HANDSHAKE, request, newSession })

    await expect(probe.listModels('C:/workspace')).resolves.toEqual(CATALOG)
  })

  it('opens a session only when the listing will not answer without one', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to initialize ACP services'))
      .mockResolvedValueOnce(LISTING)
    const newSession = vi.fn(async () => ({ sessionId: 'probe-session', configOptions: [] }))
    const { probe } = build({ ...HANDSHAKE, request, newSession })

    await expect(probe.listModels('C:/workspace')).resolves.toEqual(CATALOG)
    expect(newSession).toHaveBeenCalledWith({ cwd: 'C:/workspace', mcpServers: [] })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("falls back to the session's own model control on a CLI without the listing", async () => {
    const request = vi.fn(async () => {
      throw new Error('"Method not found": cursor/list_available_models')
    })
    const newSession = vi.fn(async () => ({
      sessionId: 'probe-session',
      configOptions: [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'composer-2.5',
          options: [{ value: 'composer-2.5', name: 'Composer 2.5' }],
        },
      ],
    }))
    const { probe } = build({ ...HANDSHAKE, request, newSession })

    await expect(probe.listModels('C:/workspace')).resolves.toEqual({
      currentModelId: 'composer-2.5',
      availableModels: [{ id: 'composer-2.5', displayName: 'Composer 2.5' }],
    })
  })

  it('never opens a session for a provider that would keep it', async () => {
    const list = vi.fn(async () => CATALOG)
    const newSession = vi.fn()
    const { probe, connections } = build(
      { ...HANDSHAKE, newSession },
      { ...opencode, models: { catalog: { via: 'cli', list } } },
    )

    await expect(probe.listModels('C:/workspace')).resolves.toEqual(CATALOG)
    // Asked where a session would be opened: a provider can be configured
    // per folder.
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'opencode', cwd: 'C:/workspace' }),
    )
    expect(newSession).not.toHaveBeenCalled()
    // The CLI answers on its own; no ACP process is spawned to ask it.
    expect(connections.connections).toHaveLength(0)
  })

  it('takes the CLI it was reading from down with it', async () => {
    let exited = false
    const list = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          // The read rejects only once its process has exited.
          signal?.addEventListener('abort', () =>
            setTimeout(() => {
              exited = true
              reject(new Error('The operation was aborted'))
            }, 5),
          )
        }),
    )
    const { probe } = build(HANDSHAKE, { ...opencode, models: { catalog: { via: 'cli', list } } })
    const reading = probe.listModels('C:/workspace')
    reading.catch(() => undefined)

    await probe.dispose()
    expect(exited).toBe(true)
    await expect(reading).rejects.toThrow('aborted')
    // And it starts nothing once it is gone.
    await expect(probe.listModels('C:/workspace')).rejects.toThrow()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('does not ask a provider that names no way of being asked', async () => {
    const request = vi.fn()
    const newSession = vi.fn()
    const { models: _models, ...silent } = cursor
    const { probe, connections } = build({ ...HANDSHAKE, request, newSession }, silent)

    await expect(probe.listModels('C:/workspace')).resolves.toEqual({})
    expect(request).not.toHaveBeenCalled()
    expect(newSession).not.toHaveBeenCalled()
    expect(connections.connections).toHaveLength(0)
  })

  it('reports a listing refused for want of a login as an auth failure', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('Authentication required'), { code: -32002 })
    })
    const newSession = vi.fn()
    const { probe, events } = build({ ...HANDSHAKE, request, newSession })

    await expect(probe.listModels('C:/workspace')).rejects.toThrow('Authentication required')
    expect(newSession).not.toHaveBeenCalled()
    expect(events.some((event) => event.event === 'auth_required')).toBe(true)
  })

  it('gives up on a listing the agent never answers', async () => {
    const { probe } = build(
      { ...HANDSHAKE, request: () => new Promise<never>(() => undefined) },
      {
        ...cursor,
        models: {
          catalog: {
            via: 'extension',
            method: 'cursor/list_available_models',
            read: () => ({}),
            sessionFallback: false,
          },
        },
      },
      { controlRequestMs: 10 },
    )
    await expect(probe.listModels('C:/workspace')).rejects.toThrow(/cursor\/list_available_models/)
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
