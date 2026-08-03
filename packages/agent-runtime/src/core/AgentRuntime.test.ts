import type { AgentEvent, PromptInput, SessionConfigOption } from '@agentpack/contract'
import { describe, expect, it, vi } from 'vitest'
import { claude } from '../providers/claude.js'
import { cursor } from '../providers/cursor.js'
import { opencode } from '../providers/opencode.js'
import type { ProviderConfig } from '../providers/index.js'
import type { AcpConnectionSpec } from '../session/AcpConnection.js'
import { FakeClaudeSdk } from '../session/claude/test-sdk.js'
import { FakeConnectionFactory, type FakeWire } from '../session/test-connection.js'
import { AgentRuntime } from './AgentRuntime.js'

const configs = { cursor, opencode, claude }
const ROUTE = {
  providerId: 'cursor' as const,
  workspaceId: 'C:/workspace',
  cwd: 'C:/workspace',
}
const PROMPT: PromptInput = { text: 'hi', blocks: [{ type: 'text', text: 'hi' }] }

function stringProperty(value: unknown, property: string): string {
  if (value === null || typeof value !== 'object') {
    throw new Error('Expected ' + property + ' on an object')
  }
  const propertyValue = Reflect.get(value, property)
  if (typeof propertyValue !== 'string') {
    throw new Error('Expected ' + property + ' to be a string')
  }
  return propertyValue
}

function build(wire: FakeWire | ((spec: AcpConnectionSpec) => FakeWire)) {
  const events: AgentEvent[] = []
  const connections = new FakeConnectionFactory(wire)
  const runtime = new AgentRuntime(
    { emitEvent: (event) => events.push(event), log: vi.fn() },
    configs,
    { connections },
  )
  return { runtime, events, connections }
}

/** One `session/new` per process, ids handed out in spawn order. */
function sequentialSessions() {
  let counter = 0
  return (): FakeWire => {
    const sessionId = `session-${++counter}`
    return { newSession: async () => ({ sessionId }) }
  }
}

describe('AgentRuntime session routing', () => {
  it('gives every thread its own process', async () => {
    const { runtime, connections } = build(sequentialSessions())
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-2' })
    expect(connections.connections).toHaveLength(2)
  })

  it('rebinds a newly created session to its stable thread without a second process', async () => {
    const loadSession = vi.fn()
    const { runtime, connections, events } = build({
      newSession: async () => ({ sessionId: 'session-1' }),
      loadSession,
    })

    await expect(
      runtime.ensureSession({ ...ROUTE, threadId: 'provisional-thread' }),
    ).resolves.toMatchObject({ sessionId: 'session-1', state: 'created' })
    await expect(
      runtime.ensureSession({ ...ROUTE, threadId: 'session-1', sessionId: 'session-1' }),
    ).resolves.toMatchObject({ sessionId: 'session-1', state: 'reused' })

    expect(connections.connections).toHaveLength(1)
    expect(loadSession).not.toHaveBeenCalled()

    await connections.last.sessionUpdate({
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'routed' } },
    })
    expect(events.at(-1)).toMatchObject({
      threadId: 'session-1',
      sessionId: 'session-1',
      event: 'agent_message_chunk',
    })
  })

  it('drops provisional provider and sequence bookkeeping when a created session is rebound', async () => {
    let session = 0
    const { runtime, events } = build(() => ({
      newSession: async () => ({ sessionId: 'session-' + ++session }),
    }))

    await runtime.ensureSession({ ...ROUTE, threadId: 'provisional-thread' })
    await runtime.ensureSession({
      ...ROUTE,
      threadId: 'session-1',
      sessionId: 'session-1',
    })
    const eventCount = events.length

    // The provisional id is dead after the rebind. Reusing that string for a
    // new thread must not inherit either its old provider binding or sequence.
    await expect(
      runtime.ensureSession({
        ...ROUTE,
        providerId: 'opencode',
        threadId: 'provisional-thread',
      }),
    ).resolves.toMatchObject({ sessionId: 'session-2' })
    expect(
      events.slice(eventCount).filter((event) => event.threadId === 'provisional-thread')[0],
    ).toMatchObject({ providerId: 'opencode', seq: 1 })
  })

  it('runs two threads on one provider concurrently', async () => {
    const started: string[] = []
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let counter = 0
    const { runtime } = build(() => {
      const sessionId = `session-${++counter}`
      return {
        newSession: async () => ({ sessionId }),
        prompt: async (params: unknown) => {
          const id = (params as { sessionId: string }).sessionId
          started.push(id)
          if (id === 'session-1') await blocked
          return { stopReason: 'end_turn' }
        },
      }
    })

    const first = runtime.prompt({ ...ROUTE, threadId: 'thread-1', prompt: PROMPT })
    // The second thread must not queue behind the first: `promptTail` used to
    // serialise every Cursor prompt in the whole app.
    await runtime.prompt({ ...ROUTE, threadId: 'thread-2', prompt: PROMPT })
    expect(started).toEqual(['session-1', 'session-2'])
    release?.()
    await first
  })

  it('stamps events with a per-thread sequence and the active assistant message id', async () => {
    const { runtime, events } = build({
      newSession: async () => ({ sessionId: 'session-1' }),
      prompt: async () => ({ stopReason: 'end_turn' }),
    })
    await runtime.prompt({ ...ROUTE, threadId: 'thread-1', prompt: PROMPT })
    const forThread = events.filter((event) => event.threadId === 'thread-1')
    expect(forThread.map((event) => event.seq)).toEqual(forThread.map((_event, index) => index + 1))
    const started = forThread.find((event) => event.event === 'prompt_started')
    const completed = forThread.find((event) => event.event === 'prompt_completed')
    expect(started?.messageId).toBeDefined()
    expect(completed?.messageId).toBe(started?.messageId)
  })

  it('refuses to move a thread to another provider', async () => {
    const { runtime } = build(sequentialSessions())
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await expect(
      runtime.ensureSession({ ...ROUTE, providerId: 'opencode', threadId: 'thread-1' }),
    ).rejects.toThrow('already bound to provider cursor')
  })

  it('reports capability gaps without spawning anything', async () => {
    const { runtime, connections, events } = build(sequentialSessions())
    await expect(
      runtime.listSessions({ ...ROUTE, providerId: 'opencode', threadId: 'session-metadata' }),
    ).rejects.toThrow(/list sessions/)
    expect(connections.connections).toHaveLength(0)
    expect(events.find((event) => event.event === 'capability_missing')).toBeDefined()
  })

  it('routes a question response to the thread that raised it', async () => {
    const { runtime, connections, events } = build(sequentialSessions())
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-2' })

    // No sessionId on the wire; the second process owns the second session.
    const pending = connections.connections[1].extMethod('cursor/ask_question', {
      toolCallId: 'tool-1',
      title: 'Pick',
      questions: [{ id: 'q1', prompt: 'Pick', options: [{ id: 'o1', label: 'One' }] }],
    })
    const request = events.find((event) => event.event === 'question_request')
    expect(request).toMatchObject({ threadId: 'thread-2', sessionId: 'session-2' })

    runtime.respondQuestion({
      providerId: 'cursor',
      requestId: (request?.data as { requestId: string }).requestId,
      outcome: { outcome: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['o1'] }] },
    })
    await expect(pending).resolves.toMatchObject({ outcome: { outcome: 'answered' } })
  })

  it('settles pending work as runtime_disposed on app shutdown', async () => {
    const { runtime, connections, events } = build({
      newSession: async () => ({ sessionId: 'session-1' }),
    })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    const pending = connections.last.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Write', kind: 'edit' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    })

    runtime.dispose()

    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events.find((event) => event.event === 'permission_resolved')).toMatchObject({
      threadId: 'thread-1',
      data: { outcome: { outcome: 'cancelled', reason: 'runtime_disposed' } },
    })
  })
})

describe('AgentRuntime desired config', () => {
  /** Cursor's shape: a `category: 'model'` select, refreshed by the
   * `set_config_option` response. */
  function modelWire() {
    let currentValue = 'composer-2.5'
    const options = (): SessionConfigOption[] => [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue,
        options: [
          { value: 'claude-opus-5', name: 'Opus 5' },
          { value: 'composer-2.5', name: 'Composer 2.5' },
        ],
      },
      { type: 'boolean', id: 'fast', name: 'Fast', currentValue: false },
    ]
    const setSessionConfigOption = vi.fn(async (params: unknown) => {
      const args = params as { configId: string; value: string }
      if (args.configId === 'model') currentValue = args.value
      return { configOptions: options() }
    })
    return {
      wire: {
        newSession: async () => ({ sessionId: 'session-1', configOptions: options() }),
        setSessionConfigOption,
        prompt: async () => ({ stopReason: 'end_turn' }),
      } satisfies FakeWire,
      setSessionConfigOption,
    }
  }

  it('enforces the desired selection once and then costs nothing per message', async () => {
    const { wire, setSessionConfigOption } = modelWire()
    const { runtime, connections } = build(wire)
    const args = {
      ...ROUTE,
      threadId: 'thread-1',
      desiredConfig: { modelId: 'claude-opus-5' },
    }

    await runtime.ensureSession(args)
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1)

    // The reused runtime never sees the spec again, so `ensureSession` has to
    // reconcile on every message — which the cache makes free.
    await runtime.ensureSession(args)
    await runtime.prompt({ ...args, prompt: PROMPT })
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1)
    expect(connections.connections).toHaveLength(1)
  })

  it('applies a changed selection on the next message', async () => {
    const { wire, setSessionConfigOption } = modelWire()
    const { runtime } = build(wire)
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })

    await runtime.ensureSession({
      ...ROUTE,
      threadId: 'thread-1',
      desiredConfig: { modelId: 'claude-opus-5' },
    })

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-1',
      configId: 'model',
      value: 'claude-opus-5',
    })
  })

  it('dispatches queued prompts on their own desired config', async () => {
    let currentModel = 'composer-2.5'
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const dispatchedModels: string[] = []
    let promptCount = 0
    const configOptions = (): SessionConfigOption[] => [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: currentModel,
        options: [
          { value: 'claude-opus-5', name: 'Opus 5' },
          { value: 'composer-2.5', name: 'Composer 2.5' },
        ],
      },
    ]
    const { runtime } = build({
      newSession: async () => ({ sessionId: 'session-1', configOptions: configOptions() }),
      setSessionConfigOption: async (params) => {
        currentModel = stringProperty(params, 'value')
        return { configOptions: configOptions() }
      },
      prompt: async () => {
        dispatchedModels.push(currentModel)
        promptCount += 1
        if (promptCount === 1) await firstBlocked
        return { stopReason: 'end_turn' }
      },
    })
    const route = { ...ROUTE, threadId: 'thread-1' }

    const first = runtime.prompt({
      ...route,
      desiredConfig: { modelId: 'composer-2.5' },
      prompt: PROMPT,
    })
    await vi.waitFor(() => expect(dispatchedModels).toEqual(['composer-2.5']))

    // Both turns sit behind the first one. Applying their config before the
    // queue would leave the process on Composer and make the Opus turn wrong.
    const second = runtime.prompt({
      ...route,
      desiredConfig: { modelId: 'claude-opus-5' },
      prompt: PROMPT,
    })
    const third = runtime.prompt({
      ...route,
      desiredConfig: { modelId: 'composer-2.5' },
      prompt: PROMPT,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    releaseFirst?.()
    await Promise.all([first, second, third])

    expect(dispatchedModels).toEqual(['composer-2.5', 'claude-opus-5', 'composer-2.5'])
  })

  it('drops what the provider cannot do at all', async () => {
    const { wire, setSessionConfigOption } = modelWire()
    const events: AgentEvent[] = []
    const runtime = new AgentRuntime(
      { emitEvent: (event) => events.push(event), log: vi.fn() },
      {
        cursor: { ...cursor, capabilities: { ...cursor.capabilities, canSetModel: false } },
        opencode,
        claude,
      },
      { connections: new FakeConnectionFactory(wire) },
    )

    await runtime.ensureSession({
      ...ROUTE,
      threadId: 'thread-1',
      desiredConfig: { modelId: 'claude-opus-5' },
    })

    expect(setSessionConfigOption).not.toHaveBeenCalled()
  })
})

describe('AgentRuntime provider probes', () => {
  it('probes in a throwaway process and disposes it', async () => {
    const { runtime, connections, events } = build({
      initialize: async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'cursor-agent' },
        authMethods: [],
      }),
    })
    await expect(
      runtime.probeProvider({ ...ROUTE, threadId: 'desktop-bootstrap:cursor' }),
    ).resolves.toMatchObject({ result: { authenticated: true } })
    expect(connections.last.terminated).toEqual({ reason: 'disposed' })
    expect(events.find((event) => event.event === 'initialized')).toMatchObject({
      threadId: 'desktop-bootstrap:cursor',
      providerId: 'cursor',
    })
  })

  it('answers session/list on the handshake process instead of spawning a second CLI', async () => {
    const { runtime, connections } = build({
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      }),
      listSessions: async () => ({
        sessions: [{ sessionId: 'session-1', cwd: 'C:/workspace', title: 'Bootstrapped' }],
      }),
    })

    const bootstrap = await runtime.probeProvider({
      ...ROUTE,
      threadId: 'desktop-bootstrap:cursor',
    })

    expect(bootstrap.sessions).toEqual([
      { sessionId: 'session-1', cwd: 'C:/workspace', title: 'Bootstrapped' },
    ])
    // The whole point: handshake and listing share one throwaway process.
    expect(connections.connections).toHaveLength(1)
    expect(connections.last.terminated).toEqual({ reason: 'disposed' })
  })

  it('reports no session list, rather than failing, when the agent does not advertise one', async () => {
    const { runtime, connections } = build({
      initialize: async () => ({ protocolVersion: 1, authMethods: [] }),
    })

    const bootstrap = await runtime.probeProvider({
      ...ROUTE,
      threadId: 'desktop-bootstrap:cursor',
    })

    expect(bootstrap.result.authenticated).toBe(true)
    expect(bootstrap.sessions).toBeUndefined()
    expect(connections.connections).toHaveLength(1)
  })

  it('still bootstraps when session/list fails on the probe', async () => {
    const { runtime } = build({
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      }),
      listSessions: async () => {
        throw new Error('listing blew up')
      },
    })

    const bootstrap = await runtime.probeProvider({
      ...ROUTE,
      threadId: 'desktop-bootstrap:cursor',
    })

    expect(bootstrap.result.authenticated).toBe(true)
    expect(bootstrap.sessions).toBeUndefined()
  })

  it('lists sessions silently, so the post-prompt refresh does not replay the handshake', async () => {
    const { runtime, connections, events } = build({
      initialize: async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      }),
      listSessions: async () => ({ sessions: [{ sessionId: 'session-1', cwd: 'C:/workspace' }] }),
    })
    await expect(
      runtime.listSessions({ ...ROUTE, threadId: 'session-metadata:cursor' }),
    ).resolves.toEqual([{ sessionId: 'session-1', cwd: 'C:/workspace' }])
    expect(connections.last.terminated).toEqual({ reason: 'disposed' })
    expect(events).toHaveLength(0)
  })
})

describe('AgentRuntime session listing reuse', () => {
  const LISTING_INITIALIZE = {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { list: {} } },
    authMethods: [],
  }

  it('borrows the live runtime instead of spawning a CLI per title refresh', async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [{ sessionId: 'session-1', cwd: 'C:/workspace', title: 'Live' }],
    }))
    const { runtime, connections } = build({
      initialize: async () => LISTING_INITIALIZE,
      newSession: async () => ({ sessionId: 'session-1' }),
      listSessions,
    })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    expect(connections.connections).toHaveLength(1)

    // What `refreshSessionTitles` does after every `prompt_completed`.
    await expect(
      runtime.listSessions({ ...ROUTE, threadId: 'session-metadata:cursor' }),
    ).resolves.toEqual([{ sessionId: 'session-1', cwd: 'C:/workspace', title: 'Live' }])

    // No second process, and the live one was never terminated.
    expect(connections.connections).toHaveLength(1)
    expect(connections.last.terminated).toBeUndefined()
    expect(listSessions).toHaveBeenCalledWith({ cwd: 'C:/workspace' })
  })

  it('does not reset a borrowed runtime idle clock during session listing', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const connections = new FakeConnectionFactory({
        initialize: async () => LISTING_INITIALIZE,
        newSession: async () => ({ sessionId: 'session-1' }),
        listSessions: async () => ({ sessions: [] }),
      })
      const runtime = new AgentRuntime({ emitEvent: vi.fn(), log: vi.fn() }, configs, {
        connections,
        reaper: { idleMs: 50, schedule: () => ({ cancel: vi.fn() }) },
      })
      await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })

      vi.setSystemTime(100)
      await runtime.listSessions({ ...ROUTE, threadId: 'session-metadata:cursor' })

      await expect(runtime.reaper.sweep()).resolves.toEqual(['thread-1'])
      expect(connections.last.terminated).toEqual({ reason: 'reaped' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not borrow a runtime pointed at another directory', async () => {
    const { runtime, connections } = build({
      initialize: async () => LISTING_INITIALIZE,
      newSession: async () => ({ sessionId: 'session-1' }),
      listSessions: async () => ({ sessions: [] }),
    })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await runtime.listSessions({
      providerId: 'cursor',
      threadId: 'session-metadata:cursor',
      workspaceId: 'C:/other',
      cwd: 'C:/other',
    })
    expect(connections.connections).toHaveLength(2)
    expect(connections.last.terminated).toEqual({ reason: 'disposed' })
  })

  it('falls back to a throwaway process when the agent never advertised session/list', async () => {
    // The live session's process claims no list support, so borrowing it is
    // not an option; the probe's does.
    let spawns = 0
    const { runtime, connections } = build(() => {
      const first = ++spawns === 1
      return {
        initialize: async () =>
          first ? { protocolVersion: 1, authMethods: [] } : LISTING_INITIALIZE,
        newSession: async () => ({ sessionId: 'session-1' }),
        listSessions: async () => ({ sessions: [] }),
      }
    })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await runtime.listSessions({ ...ROUTE, threadId: 'session-metadata:cursor' })
    expect(connections.connections).toHaveLength(2)
  })
})

describe('AgentRuntime provider health', () => {
  it('does not mark a provider dead because one of its sessions exited', async () => {
    let counter = 0
    const { runtime, connections } = build(() => ({
      newSession: async () => ({ sessionId: `session-${++counter}` }),
    }))
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-2' })
    expect(runtime.health.health('cursor').runtime).toMatchObject({
      state: 'running',
      liveProcesses: 2,
    })

    await connections.connections[0]?.crash(1)

    await vi.waitFor(() => {
      const health = runtime.health.health('cursor')
      expect(health.runtime.state).toBe('degraded')
      expect(health.runtime.liveProcesses).toBe(1)
      expect(health.runtime.lastUnexpectedExit).toMatchObject({ threadId: 'thread-1' })
    })
  })

  it('reports the last process dying as a provider failure', async () => {
    const { runtime, connections } = build({ newSession: async () => ({ sessionId: 'session-1' }) })
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await connections.last.crash(1)
    await vi.waitFor(() => expect(runtime.health.health('cursor').runtime.state).toBe('failed'))
  })

  it('adopts the bootstrap probe rather than spawning a second CLI for health', async () => {
    const { runtime } = build({
      initialize: async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'cursor-agent', version: '2026.07.23' },
        authMethods: [],
      }),
    })
    await runtime.probeProvider({ ...ROUTE, threadId: 'desktop-bootstrap:cursor' })
    const health = runtime.health.health('cursor')
    expect(health.install).toMatchObject({ state: 'installed', version: '2026.07.23' })
    expect(health.auth.state).toBe('authenticated')
    expect(health.lastProbe?.outcome).toBe('ok')
  })

  /** Replays `apps/desktop/src/main/index.ts`'s launch order. The regression
   * this locks down: constructing the host started the health loop, whose boot
   * sweep registered a cursor probe *before* the bootstrap could, and
   * `beginProbe` has no reciprocal guard — so every launch spawned two
   * `cursor-agent` processes for one handshake. The fix is ordering, and it
   * depends on `probeProvider` registering its adoption synchronously, which is
   * exactly what this asserts by not awaiting it before `health.start()`. */
  it('spawns one CLI per provider at launch, not two for the bootstrapped one', async () => {
    const { runtime, connections } = build({
      initialize: async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'cursor-agent', version: '2026.07.23' },
        agentCapabilities: { sessionCapabilities: { list: {} } },
        authMethods: [],
      }),
      listSessions: async () => ({ sessions: [] }),
    })

    // --- AgentHost constructor: probe cwd is known, health loop is NOT started
    runtime.setDefaultProbeCwd('C:/workspace')
    // --- index.ts: bootstrap first, deliberately un-awaited...
    const bootstrap = runtime.probeProvider({
      ...ROUTE,
      threadId: 'desktop-bootstrap:cursor',
    })
    // --- ...then the health loop, which must adopt it rather than duplicate it
    runtime.health.start()

    await bootstrap
    // Let the monitor's one-slot probe queue drain.
    await vi.waitFor(() => expect(runtime.health.health('opencode').lastProbe?.outcome).toBe('ok'))

    const spawned = connections.connections.map((connection) => connection.spec.providerId)
    expect(spawned.filter((providerId) => providerId === 'cursor')).toHaveLength(1)
    // The provider nobody bootstrapped still gets its badge populated.
    expect(spawned.filter((providerId) => providerId === 'opencode')).toHaveLength(1)
    expect(runtime.health.health('cursor').lastProbe?.outcome).toBe('ok')

    runtime.dispose()
  })
})

describe('AgentRuntime lazy respawn and resume', () => {
  /** A Cursor-shaped process: one model option, read back from every write.
   * `sessions` records which session id each spawned process opened and how. */
  function resumableWire(options: { loadFails?: boolean } = {}) {
    const opened: Array<{ how: 'new' | 'load'; sessionId: string }> = []
    const writes: Array<{ configId: string; value: string | boolean }> = []
    let counter = 0
    const wire = (): FakeWire => {
      // Each process reports the model Cursor left on disk, not the one the
      // user chose — the stale-global-state case a respawn has to correct.
      let currentValue = 'composer-2.5'
      const configOptions = (): SessionConfigOption[] => [
        {
          type: 'select',
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue,
          options: [
            { value: 'claude-opus-5', name: 'Opus 5' },
            { value: 'composer-2.5', name: 'Composer 2.5' },
          ],
        },
      ]
      return {
        newSession: async () => {
          const sessionId = `session-${++counter}`
          opened.push({ how: 'new', sessionId })
          return { sessionId, configOptions: configOptions() }
        },
        loadSession: async (params: unknown) => {
          const sessionId = (params as { sessionId: string }).sessionId
          if (options.loadFails) throw new Error(`Session not found: ${sessionId}`)
          opened.push({ how: 'load', sessionId })
          return { configOptions: configOptions() }
        },
        setSessionConfigOption: async (params: unknown) => {
          const args = params as { configId: string; value: string }
          writes.push({ configId: args.configId, value: args.value })
          if (args.configId === 'model') currentValue = args.value
          return { configOptions: configOptions() }
        },
        prompt: async () => ({ stopReason: 'end_turn' }),
      }
    }
    return { wire, opened, writes }
  }

  function reapable(wire: (spec: AcpConnectionSpec) => FakeWire) {
    const events: AgentEvent[] = []
    const connections = new FakeConnectionFactory(wire)
    const runtime = new AgentRuntime(
      { emitEvent: (event) => events.push(event), log: vi.fn() },
      configs,
      // Everything idle is reapable, and the sweep is driven by hand.
      { connections, reaper: { idleMs: 0, schedule: () => ({ cancel: vi.fn() }) } },
    )
    return { runtime, events, connections }
  }

  it('respawns a reaped thread and reapplies the desired config on the new process', async () => {
    const { wire, opened, writes } = resumableWire()
    const { runtime, connections } = reapable(wire)
    const args = { ...ROUTE, threadId: 'thread-1', desiredConfig: { modelId: 'claude-opus-5' } }

    await runtime.ensureSession(args)
    expect(opened).toEqual([{ how: 'new', sessionId: 'session-1' }])
    expect(writes).toEqual([{ configId: 'model', value: 'claude-opus-5' }])

    await expect(runtime.reaper.sweep()).resolves.toEqual(['thread-1'])
    expect(connections.connections[0]?.terminated).toEqual({ reason: 'reaped' })

    // A model change on a thread whose process is gone used to throw. It now
    // respawns, resumes the same ACP session, and reconciles the remembered
    // selection against the *new* process's own read-back — without which the
    // turn would run on the `composer-2.5` Cursor restored from disk.
    await runtime.setModel({
      ...ROUTE,
      threadId: 'thread-1',
      sessionId: 'session-1',
      modelId: 'claude-opus-5',
    })

    expect(connections.connections).toHaveLength(2)
    expect(opened).toEqual([
      { how: 'new', sessionId: 'session-1' },
      { how: 'load', sessionId: 'session-1' },
    ])
    expect(writes).toEqual([
      { configId: 'model', value: 'claude-opus-5' },
      { configId: 'model', value: 'claude-opus-5' },
    ])
  })

  it('falls back to session/new when the reaped session was never prompted', async () => {
    // `session/load` answers "Session not found" for a session that was
    // created but never prompted, so resume cannot assume load works.
    const { wire, opened } = resumableWire({ loadFails: true })
    const { runtime } = reapable(wire)
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await runtime.reaper.sweep()

    await expect(
      runtime.setConfigOption({
        ...ROUTE,
        threadId: 'thread-1',
        sessionId: 'session-1',
        configId: 'model',
        value: 'claude-opus-5',
      }),
    ).resolves.toBeUndefined()

    expect(opened).toEqual([
      { how: 'new', sessionId: 'session-1' },
      { how: 'new', sessionId: 'session-2' },
    ])
  })

  it('never reaps a thread with a turn in flight, however long it runs', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => (release = resolve))
    const { runtime, connections } = reapable(() => ({
      newSession: async () => ({ sessionId: 'session-1' }),
      prompt: async () => {
        await blocked
        return { stopReason: 'end_turn' }
      },
    }))

    const turn = runtime.prompt({ ...ROUTE, threadId: 'thread-1', prompt: PROMPT })
    await vi.waitFor(() => expect(connections.connections).toHaveLength(1))

    await expect(runtime.reaper.sweep()).resolves.toEqual([])
    expect(connections.last.terminated).toBeUndefined()

    release?.()
    await turn
    // Once the turn is over the same runtime becomes reapable.
    await expect(runtime.reaper.sweep()).resolves.toEqual(['thread-1'])
  })

  it('does not spawn a process just to cancel a thread that has none', async () => {
    const { runtime, connections } = reapable(() => ({
      newSession: async () => ({ sessionId: 'session-1' }),
    }))
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    await runtime.reaper.sweep()

    await expect(
      runtime.cancel({ ...ROUTE, threadId: 'thread-1', sessionId: 'session-1' }),
    ).resolves.toBeUndefined()
    expect(connections.connections).toHaveLength(1)
  })

  it('waits for every child, including one mid-turn, before shutdown resolves', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => (release = resolve))
    let counter = 0
    const { runtime, connections } = reapable(() => ({
      newSession: async () => ({ sessionId: `session-${++counter}` }),
      prompt: async () => {
        await blocked
        return { stopReason: 'end_turn' }
      },
    }))
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    let turnSettled = false
    const turn = runtime.prompt({ ...ROUTE, threadId: 'thread-2', prompt: PROMPT }).then(
      () => (turnSettled = true),
      () => (turnSettled = true),
    )
    await vi.waitFor(() => expect(connections.connections).toHaveLength(2))

    await runtime.shutdown()

    // A quit is a quit: the mid-turn runtime is terminated too, and shutdown
    // does not sit waiting for a turn that could run for minutes.
    expect(turnSettled).toBe(false)
    expect(connections.connections.map((child) => child.terminated)).toEqual([
      { reason: 'disposed' },
      { reason: 'disposed' },
    ])
    release?.()
    await turn
  })
})

describe('AgentRuntime provider dispatch', () => {
  /** The dispatch keys on `ProviderConfig.kind` and never on the id, so a
   * claude-kind config wearing an ACP provider's id is the sharpest available
   * test: if the runtime ever looked at the id it would take the wrong arm. */
  const claudeKindUnderAcpId: ProviderConfig = { ...claude, id: 'cursor' }

  function buildWith(config: ProviderConfig) {
    const connections = new FakeConnectionFactory({
      newSession: async () => ({ sessionId: 'session-1' }),
    })
    const runtime = new AgentRuntime(
      { emitEvent: () => undefined, log: vi.fn() },
      { cursor: config, opencode, claude },
      { connections },
    )
    return { runtime, connections }
  }

  it('drives an acp-kind provider over the ACP transport', async () => {
    const { runtime, connections } = buildWith(cursor)
    await runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })
    // The spawned command is the proof: it comes from `AcpProviderConfig.
    // command`, which only the ACP implementation reads.
    expect(connections.last.spec.command).toBe(cursor.command.bin)
  })

  /** A path that cannot exist, so the Claude arm fails at binary resolution
   * before it can reach for the SDK. That failure is the signal: the ACP arm
   * would have spawned `cursor.command.bin` and never looked at
   * `CLAUDE_CODE_BIN` at all. */
  function withMissingClaudeBinary(): void {
    vi.stubEnv('CLAUDE_CODE_BIN', 'C:/nowhere/claude-does-not-exist.exe')
  }

  it('drives a claude-kind provider through the SDK arm, not the ACP transport', async () => {
    withMissingClaudeBinary()
    const { runtime, connections } = buildWith(claudeKindUnderAcpId)
    await expect(runtime.ensureSession({ ...ROUTE, threadId: 'thread-1' })).rejects.toThrow(
      /CLAUDE_CODE_BIN/,
    )
    // Nothing was spawned: falling through to ACP would have started the
    // wrong CLI rather than failing.
    expect(connections.connections).toHaveLength(0)
    vi.unstubAllEnvs()
  })

  it('probes a claude-kind provider through the SDK arm, not the ACP transport', async () => {
    withMissingClaudeBinary()
    const { runtime, connections } = buildWith(claudeKindUnderAcpId)
    await expect(
      runtime.probeProvider({ ...ROUTE, threadId: 'desktop-bootstrap:cursor' }),
    ).rejects.toThrow(/CLAUDE_CODE_BIN/)
    expect(connections.connections).toHaveLength(0)
    vi.unstubAllEnvs()
  })
})

/** The turn-lifetime half of `isRecoverableError`.
 *
 * `forward` stamps every event with the thread's active assistant message id
 * and releases it on the terminal ones. It used to release on ANY `rpc_error`,
 * so a Claude Code `api_retry` — the CLI saying "that request failed, I am
 * retrying" — ended the turn as far as every consumer was concerned. The
 * retry then succeeded and every event it produced arrived with no
 * `messageId`, which both the Convex projector and the live renderer drop: the
 * answer was truncated on screen and in persisted history. */
describe('AgentRuntime recoverable errors', () => {
  const CLAUDE_ROUTE = {
    providerId: 'claude' as const,
    workspaceId: 'C:/workspace',
    cwd: 'C:/workspace',
  }

  function buildClaude() {
    // The resolver stats a real file and the runtime must not care which; the
    // test's own node binary exercises real resolution without requiring
    // Claude Code to be installed.
    vi.stubEnv('CLAUDE_CODE_BIN', process.execPath)
    const events: AgentEvent[] = []
    const claudeSdk = new FakeClaudeSdk()
    const runtime = new AgentRuntime(
      { emitEvent: (event) => events.push(event), log: vi.fn() },
      configs,
      { claudeSdk },
    )
    return { runtime, events, claudeSdk }
  }

  it('keeps the assistant message id alive across an api_retry', async () => {
    const { runtime, events, claudeSdk } = buildClaude()
    const session = await runtime.ensureSession({ ...CLAUDE_ROUTE, threadId: 'thread-1' })
    const query = claudeSdk.last
    const turn = runtime.prompt({ ...CLAUDE_ROUTE, threadId: 'thread-1', prompt: PROMPT })
    await vi.waitFor(() => expect(query.prompts).toHaveLength(1))

    query.emitText('partial ')
    query.emitSystem('api_retry', session.sessionId, {
      error: 'Overloaded',
      attempt: 1,
      max_retries: 3,
    })
    // What the retry then produces. Before the fix this text carried no
    // messageId at all and was dropped by every consumer downstream.
    query.emitText('and the rest')
    query.emitResult({ sessionId: session.sessionId })
    await turn

    const started = events.find((event) => event.event === 'prompt_started')
    const retry = events.find((event) => event.event === 'rpc_error')
    expect(retry?.data).toMatchObject({ recoverable: true })
    const chunks = events.filter((event) => event.event === 'agent_message_chunk')
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) expect(chunk.messageId).toBe(started?.messageId)
    expect(events.find((event) => event.event === 'prompt_completed')?.messageId).toBe(
      started?.messageId,
    )
    vi.unstubAllEnvs()
  })

  /** The other half, over ACP: an `rpc_error` that says nothing about
   * recoverability is still terminal, so the guard cannot be a blanket
   * exemption for the whole event. Cursor and OpenCode both reach this path. */
  it('still releases the message id for an ordinary rpc_error', async () => {
    const events: AgentEvent[] = []
    const connections = new FakeConnectionFactory({
      newSession: async () => ({ sessionId: 'session-1' }),
      prompt: async () => {
        await connections.last.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'something_this_build_has_never_heard_of' },
        })
        await connections.last.sessionUpdate({
          sessionId: 'session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
        })
        return { stopReason: 'end_turn' }
      },
    })
    const runtime = new AgentRuntime(
      { emitEvent: (event) => events.push(event), log: vi.fn() },
      configs,
      { connections },
    )
    await runtime.prompt({ ...ROUTE, threadId: 'thread-1', prompt: PROMPT })
    const failure = events.find((event) => event.event === 'rpc_error')
    expect(failure?.data).not.toMatchObject({ recoverable: true })
    expect(events.find((event) => event.event === 'agent_message_chunk')?.messageId).toBeUndefined()
  })
})
