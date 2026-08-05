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
