import type { SessionConfigOption } from '@agentpack/contract'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../backends/Backend.js'
import { ExtensionBroker } from '../core/ExtensionBroker.js'
import { PermissionBroker } from '../core/PermissionBroker.js'
import { cursor } from '../providers/cursor.js'
import { opencode } from '../providers/opencode.js'
import type { AcpProviderConfig } from '../providers/index.js'
import type { AcpConnectionSpec } from './AcpConnection.js'
import type { SessionRuntimeSpec } from './SessionRuntime.js'
import { AcpSessionRuntimeImpl } from './AcpSessionRuntimeImpl.js'
import type { RuntimeTimeouts } from './constants.js'
import {
  extMethod,
  FakeConnectionFactory,
  notify,
  type FakeAcpConnection,
  type FakeWire,
} from './test-connection.js'

const SPEC = {
  threadId: 'thread-1',
  workspaceId: 'workspace-1',
  cwd: 'C:/workspace',
} satisfies Omit<SessionRuntimeSpec, 'providerId'>

/** Mirrors how `AgentRuntime` wires the two app-wide brokers, so settlement
 * events land in the same stream the runtime's own events do. */
function build(
  wire: FakeWire | ((spec: AcpConnectionSpec) => FakeWire),
  config: AcpProviderConfig = opencode,
  spec: Partial<SessionRuntimeSpec> = {},
  timeouts?: Partial<RuntimeTimeouts>,
) {
  const events: BackendEvent[] = []
  const permissions = new PermissionBroker((settlement) =>
    events.push({
      threadId: settlement.threadId,
      workspaceId: settlement.workspaceId,
      sessionId: settlement.sessionId,
      category: 'permission',
      event: 'permission_resolved',
      data: { requestId: settlement.requestId, outcome: settlement.outcome },
    } as BackendEvent),
  )
  const extensions = new ExtensionBroker((settlement) =>
    events.push({
      threadId: settlement.threadId,
      workspaceId: settlement.workspaceId,
      sessionId: settlement.sessionId,
      category: 'extension',
      event: 'extension_resolved',
      data: {
        requestId: settlement.requestId,
        method: settlement.method,
        outcome: settlement.outcome,
      },
    } as BackendEvent),
  )
  const connections = new FakeConnectionFactory(wire)
  const runtime = new AcpSessionRuntimeImpl(
    { ...SPEC, providerId: config.id, ...spec },
    {
      config,
      host: { log: vi.fn(), onSessionTitle: vi.fn() },
      permissions,
      extensions,
      connections,
      ...(timeouts ? { timeouts } : {}),
    },
  )
  runtime.events((event) => events.push(event))
  return { runtime, events, connections, permissions, extensions }
}

async function started(
  wire: FakeWire | ((spec: AcpConnectionSpec) => FakeWire) = {},
  config: AcpProviderConfig = opencode,
  spec: Partial<SessionRuntimeSpec> = {},
) {
  const harness = build(
    { newSession: async () => ({ sessionId: 'session-1' }), ...wire },
    config,
    spec,
  )
  const result = await harness.runtime.start()
  return { ...harness, result, child: harness.connections.last as FakeAcpConnection }
}

const requestIdOf = (event: BackendEvent | undefined): string =>
  (event?.data as { requestId: string }).requestId

describe('AcpSessionRuntime permission round-trip', () => {
  async function setupWithPermission() {
    const harness = await started()
    const responsePromise = harness.child.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Write file', kind: 'edit' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    })
    const requestId = requestIdOf(
      harness.events.find((event) => event.event === 'permission_request'),
    )
    return { ...harness, responsePromise, requestId }
  }

  it('emits permission_resolved when the request is answered', async () => {
    const { runtime, events, responsePromise, requestId } = await setupWithPermission()
    expect(runtime.respondPermission(requestId, { outcome: 'selected', optionId: 'allow' })).toBe(
      true,
    )
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    expect(events.find((event) => event.event === 'permission_resolved')).toMatchObject({
      threadId: 'thread-1',
      sessionId: 'session-1',
      data: { requestId, outcome: { outcome: 'selected', optionId: 'allow' } },
    })
  })

  it('settles pending permissions as session_closed when the process goes away', async () => {
    const { runtime, events, responsePromise, requestId } = await setupWithPermission()
    await runtime.stop({ reason: 'disposed' })
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events.find((event) => event.event === 'permission_resolved')).toMatchObject({
      data: { requestId, outcome: { outcome: 'cancelled', reason: 'session_closed' } },
    })
  })

  it("declines permission requests carrying somebody else's session id", async () => {
    const { child, events } = await started()
    await expect(child.requestPermission({ sessionId: 'session-9', options: [] })).resolves.toEqual(
      { outcome: { outcome: 'cancelled' } },
    )
    expect(events.find((event) => event.event === 'permission_request')).toBeUndefined()
  })
})

describe('AcpSessionRuntime deferred extension requests', () => {
  const deferredConfig: AcpProviderConfig = {
    ...opencode,
    extensions: {
      deferred: ['test/ask'],
      requests: {
        'test/ask': () => ({ outcome: { outcome: 'skipped', reason: 'fallback' } }),
      },
    },
  }

  async function setupWithRequest(config = deferredConfig) {
    const harness = await started({}, config)
    const responsePromise = harness.child.extMethod('test/ask', {
      sessionId: 'session-1',
      title: 'Pick one',
      questions: [],
    })
    const requestId = requestIdOf(
      harness.events.find((event) => event.event === 'extension_request'),
    )
    return { ...harness, responsePromise, requestId }
  }

  it('holds the request open until respondExtension supplies the answer', async () => {
    const { runtime, events, responsePromise, requestId } = await setupWithRequest()
    const response = { outcome: { outcome: 'answered', answers: ['A'] } }
    expect(runtime.respondExtension(requestId, response)).toBe(true)
    await expect(responsePromise).resolves.toEqual(response)
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      threadId: 'thread-1',
      sessionId: 'session-1',
      data: { requestId, method: 'test/ask', outcome: { outcome: 'responded', response } },
    })
  })

  it('falls back to the registered handler when the process goes away', async () => {
    const { runtime, events, responsePromise, requestId } = await setupWithRequest()
    await runtime.stop({ reason: 'disposed' })
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'fallback' },
    })
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      data: { requestId, outcome: { outcome: 'cancelled', reason: 'session_closed' } },
    })
    expect(runtime.respondExtension(requestId, {})).toBe(false)
  })

  it('answers non-deferred methods immediately and reports the response', async () => {
    const { child, events } = await started({}, deferredConfig)
    await expect(child.extMethod('test/other', { sessionId: 'session-1' })).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      data: {
        method: 'test/other',
        outcome: { outcome: 'responded', response: { outcome: { outcome: 'cancelled' } } },
      },
    })
  })
})

describe('AcpSessionRuntime structured questions (cursor/ask_question)', () => {
  // Real wire shape: no sessionId anywhere in params. One process owns one
  // session, so this correlates unambiguously.
  const askParams = {
    toolCallId: 'tool-1',
    title: 'Favorite color',
    questions: [
      {
        id: 'q1',
        prompt: 'Pick a color',
        options: [
          { id: 'o1', label: 'Red' },
          { id: 'o2', label: 'Blue' },
        ],
        allowMultiple: false,
      },
    ],
  }

  async function setupWithQuestion() {
    const harness = await started({}, cursor)
    const responsePromise = harness.child.extMethod('cursor/ask_question', askParams)
    const request = harness.events.find((event) => event.event === 'question_request')
    return { ...harness, responsePromise, request, requestId: requestIdOf(request) }
  }

  it('emits question_request for the sole session and answers with smuggled text', async () => {
    const { runtime, responsePromise, requestId, request } = await setupWithQuestion()
    expect(request).toMatchObject({
      sessionId: 'session-1',
      data: {
        sessionId: 'session-1',
        title: 'Favorite color',
        questions: [
          {
            questionId: 'q1',
            prompt: 'Pick a color',
            options: [
              { optionId: 'o1', label: 'Red' },
              { optionId: 'o2', label: 'Blue' },
            ],
            allowMultiple: false,
          },
        ],
      },
    })
    expect(
      runtime.respondQuestion(requestId, {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['o2'], text: 'turquoise, actually' }],
      }),
    ).toBe(true)
    await expect(responsePromise).resolves.toEqual({
      outcome: {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['o2', 'turquoise, actually'] }],
      },
    })
  })

  it('maps a cancelled outcome to the skipped wire response', async () => {
    const { runtime, responsePromise, requestId } = await setupWithQuestion()
    expect(runtime.respondQuestion(requestId, { outcome: 'cancelled', reason: 'user' })).toBe(true)
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'User skipped questions' },
    })
  })

  it('registers a question before emitting it to synchronous listeners', async () => {
    const { runtime, child } = await started({}, cursor)
    let accepted = false
    runtime.events((event) => {
      if (event.event !== 'question_request') return
      accepted = runtime.respondQuestion((event.data as { requestId: string }).requestId, {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['o2'] }],
      })
    })
    await expect(child.extMethod('cursor/ask_question', askParams)).resolves.toMatchObject({
      outcome: { outcome: 'answered' },
    })
    expect(accepted).toBe(true)
  })

  it('answers with the static fallback until the session exists', async () => {
    let early: Promise<Record<string, unknown>> | undefined
    const harness = build(
      (spec: AcpConnectionSpec): FakeWire => ({
        newSession: async () => {
          // The client handlers are live from the first byte, but there is
          // nothing to correlate a sessionless request against until
          // session/new has answered.
          early = extMethod(spec.client, 'cursor/ask_question', askParams)
          await early
          return { sessionId: 'session-1' }
        },
      }),
      cursor,
    )
    await harness.runtime.start()
    await expect(early).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'User skipped questions' },
    })
    expect(harness.events.find((event) => event.event === 'question_request')).toBeUndefined()
  })
})

describe('AcpSessionRuntime plan review (cursor/create_plan)', () => {
  // Real wire shape: no sessionId anywhere.
  const planParams = {
    toolCallId: 'tool-1',
    name: 'Implementation Plan',
    overview: 'Overview',
    plan: '# Plan\n\n- step',
    todos: [{ id: 't1', content: 'Step 1', status: 'pending' }],
  }

  async function setupWithPlan() {
    const harness = await started({}, cursor)
    const responsePromise = harness.child.extMethod('cursor/create_plan', planParams)
    const request = harness.events.find((event) => event.event === 'plan_review_request')
    return { ...harness, responsePromise, request, requestId: requestIdOf(request) }
  }

  it('emits plan_review_request for the sole session and accepts', async () => {
    const { runtime, responsePromise, requestId, request } = await setupWithPlan()
    expect(request).toMatchObject({
      sessionId: 'session-1',
      data: {
        sessionId: 'session-1',
        name: 'Implementation Plan',
        overview: 'Overview',
        markdown: '# Plan\n\n- step',
        todos: [{ id: 't1', content: 'Step 1', status: 'pending' }],
      },
    })
    expect(runtime.respondPlan(requestId, { outcome: 'accepted' })).toBe(true)
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'accepted' } })
  })

  it('maps a rejected outcome to the wire response with its reason', async () => {
    const { runtime, responsePromise, requestId } = await setupWithPlan()
    expect(runtime.respondPlan(requestId, { outcome: 'rejected', reason: 'needs tests' })).toBe(
      true,
    )
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'rejected', reason: 'needs tests' },
    })
  })

  it('falls back to cancelled when the process goes away mid-review', async () => {
    const { runtime, responsePromise } = await setupWithPlan()
    await runtime.stop({ reason: 'disposed' })
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('AcpSessionRuntime plan snapshots (cursor/update_todos)', () => {
  it('acks immediately and emits plan_update, dropping cancelled todos', async () => {
    const { child, events } = await started({}, cursor)
    await expect(
      child.extMethod('cursor/update_todos', {
        toolCallId: 't',
        todos: [
          { id: '1', content: 'A', status: 'in_progress' },
          { id: '2', content: 'B', status: 'cancelled' },
        ],
        merge: false,
      }),
    ).resolves.toEqual({})
    expect(events.find((event) => event.event === 'plan_update')).toMatchObject({
      sessionId: 'session-1',
      data: { entries: [{ content: 'A', priority: 'medium', status: 'in_progress' }] },
    })
  })

  it('merges incoming todos by id on merge:true', async () => {
    const { child, events } = await started({}, cursor)
    await child.extMethod('cursor/update_todos', {
      toolCallId: 't',
      todos: [
        { id: '1', content: 'A', status: 'in_progress' },
        { id: '2', content: 'B', status: 'cancelled' },
      ],
      merge: false,
    })
    await child.extMethod('cursor/update_todos', {
      toolCallId: 't',
      todos: [
        { id: '1', content: 'A', status: 'completed' },
        { id: '3', content: 'C', status: 'pending' },
      ],
      merge: true,
    })
    expect(events.filter((event) => event.event === 'plan_update').at(-1)).toMatchObject({
      data: {
        entries: [
          { content: 'A', priority: 'medium', status: 'completed' },
          { content: 'C', priority: 'medium', status: 'pending' },
        ],
      },
    })
  })
})

describe('AcpSessionRuntime lifecycle', () => {
  it('negotiates Cursor session listing from initialize capabilities', async () => {
    const { events } = await started(
      {
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: {} } },
          authMethods: [],
        }),
      },
      cursor,
    )
    expect(events.find((event) => event.event === 'initialized')).toMatchObject({
      threadId: 'thread-1',
      data: { capabilities: { canListSessions: true } },
    })
  })

  it('advertises form elicitation support during initialization', async () => {
    const initialize = vi.fn(async () => ({ protocolVersion: 1, authMethods: [] }))
    await started({ initialize })
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({ elicitation: { form: {} } }),
      }),
    )
  })

  it('spawns in the spec cwd and emits process_spawned for its own thread', async () => {
    const { connections, events } = await started()
    expect(connections.last.spec.cwd).toBe('C:/workspace')
    expect(events.find((event) => event.event === 'process_spawned')).toMatchObject({
      threadId: 'thread-1',
      data: { cwd: 'C:/workspace', processId: 4242 },
    })
  })

  it('routes replayed updates while session/load is in flight', async () => {
    const harness = build(
      (spec: AcpConnectionSpec): FakeWire => ({
        loadSession: async () => {
          await notify(spec.client, {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'replayed' },
              _meta: { cursor: 'cursor-2' },
            },
          })
          return { sessionId: 'session-1' }
        },
      }),
      opencode,
      { sessionId: 'session-1', resumeCursor: 'cursor-1' },
    )

    await expect(harness.runtime.start()).resolves.toMatchObject({
      state: 'loaded',
      resumeCursor: 'cursor-2',
    })
    expect(harness.events.map((event) => event.event)).toEqual([
      'process_spawned',
      'initialized',
      'agent_message_chunk',
      'session_loaded',
    ])
  })

  it('falls back to session/new when the stored session cannot be loaded', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'session-2' }))
    const harness = build(
      {
        loadSession: async () => {
          throw new Error('Session not found')
        },
        newSession,
      },
      opencode,
      { sessionId: 'session-1' },
    )
    await expect(harness.runtime.start()).resolves.toMatchObject({
      sessionId: 'session-2',
      state: 'created',
    })
    expect(newSession).toHaveBeenCalledTimes(1)
  })

  it('fails a timed-out load without creating a second session', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'session-2' }))
    const harness = build(
      {
        loadSession: () => new Promise(() => undefined),
        newSession,
      },
      opencode,
      { sessionId: 'session-1' },
      { loadSessionMs: 30 },
    )

    await expect(harness.runtime.start()).rejects.toThrow(
      'opencode did not answer session/load within 30ms',
    )
    expect(newSession).not.toHaveBeenCalled()
    expect(harness.connections.last.terminated).toEqual({ reason: 'start_failed' })
  })

  it('reports a second start as reused without creating a second session', async () => {
    const newSession = vi.fn(async () => ({ sessionId: 'session-1' }))
    const { runtime } = await started({ newSession })
    await expect(runtime.start()).resolves.toMatchObject({
      sessionId: 'session-1',
      state: 'reused',
    })
    expect(newSession).toHaveBeenCalledTimes(1)
  })

  it('tells its own thread when the child dies unexpectedly', async () => {
    const { runtime, child, events } = await started()
    await child.crash(9)
    const exit = await runtime.exited
    expect(exit).toMatchObject({ expected: false, exitCode: 9 })
    expect(exit.reason).toBeUndefined()
    expect(runtime.phase).toBe('exited')
    expect(events.find((event) => event.event === 'process_exited')).toMatchObject({
      threadId: 'thread-1',
      sessionId: 'session-1',
      data: { exitCode: 9, expected: false },
    })
  })

  it('reports a requested stop as expected and carries the reason', async () => {
    const { runtime, events } = await started()
    const exit = await runtime.stop({ reason: 'reaped' })
    expect(exit).toMatchObject({ expected: true, reason: 'reaped' })
    expect(events.find((event) => event.event === 'process_exited')).toMatchObject({
      data: { expected: true },
    })
  })

  it('fails the start instead of hanging when the child dies mid-handshake', async () => {
    const harness = build((spec: AcpConnectionSpec): FakeWire => ({
      initialize: async () => {
        // Kill the child while the handshake RPC is outstanding: nothing will
        // ever answer it.
        const connection = harness.connections.connections.find(
          (candidate) => candidate.spec === spec,
        )
        void connection?.crash(127)
        return new Promise(() => undefined)
      },
    }))
    await expect(harness.runtime.start()).rejects.toThrow('exited during startup')
    expect(harness.runtime.exit).toMatchObject({ expected: false, exitCode: 127 })
  })

  it('emits runtime_error and never starts when the CLI cannot be spawned', async () => {
    const harness = build({})
    harness.connections.failWith = new Error('spawn agent ENOENT')
    await expect(harness.runtime.start()).rejects.toThrow('spawn agent ENOENT')
    expect(harness.events.find((event) => event.event === 'runtime_error')).toMatchObject({
      threadId: 'thread-1',
      data: { kind: 'process', message: 'spawn agent ENOENT' },
    })
    // Nothing spawned, so there is no process death to report.
    expect(harness.events.find((event) => event.event === 'process_exited')).toBeUndefined()
  })
})

describe('AcpSessionRuntime model and config', () => {
  it('uses advertised config option ids for model and mode selection', async () => {
    let configOptions: SessionConfigOption[] = [
      {
        id: 'active-model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'provider/model-a',
        options: [
          { value: 'provider/model-a', name: 'Model A' },
          { value: 'provider/model-b', name: 'Model B' },
        ],
      },
      {
        id: 'workflow',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [
          { value: 'build', name: 'Build' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ]
    const setSessionConfigOption = vi.fn(async (params: unknown) => {
      const args = params as { configId: string; value: string }
      configOptions = configOptions.map((option) =>
        option.id === args.configId ? { ...option, currentValue: args.value } : option,
      ) as SessionConfigOption[]
      return { configOptions }
    })
    const request = vi.fn(async () => ({}))
    const setSessionMode = vi.fn(async () => ({}))
    const { runtime, events } = await started({
      newSession: async () => ({ sessionId: 'session-1', configOptions }),
      setSessionConfigOption,
      request,
      setSessionMode,
    })

    await runtime.setModel('provider/model-b')
    await runtime.setMode('plan')

    expect(setSessionConfigOption).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      configId: 'active-model',
      value: 'provider/model-b',
    })
    expect(setSessionConfigOption).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      configId: 'workflow',
      value: 'plan',
    })
    expect(request).not.toHaveBeenCalled()
    expect(setSessionMode).not.toHaveBeenCalled()
    expect(events.findLast((event) => event.event === 'current_model_update')?.data).toMatchObject({
      currentModelId: 'provider/model-b',
    })
    expect(events.findLast((event) => event.event === 'current_mode_update')?.data).toMatchObject({
      currentModeId: 'plan',
    })
  })

  it('falls back to legacy model and mode methods without config options', async () => {
    const request = vi.fn(async () => ({}))
    const setSessionMode = vi.fn(async () => ({}))
    const { runtime } = await started({ request, setSessionMode })

    await runtime.setModel('legacy-model')
    await runtime.setMode('legacy-mode')

    expect(request).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'session-1',
      modelId: 'legacy-model',
    })
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modeId: 'legacy-mode',
    })
  })

  it('mirrors config_option_update notifications into applied state', async () => {
    const { runtime, child } = await started()
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'effort',
            name: 'Effort',
            type: 'select',
            currentValue: 'high',
            options: [{ value: 'high', name: 'High' }],
          },
        ],
      },
    })
    expect(runtime.applied?.source).toBe('config_option_update')
    expect(runtime.applied?.options.get('effort')?.currentValue).toBe('high')
  })
})

describe('AcpSessionRuntime applied-config cache', () => {
  /** Cursor's shape, from live responses: the model is a `category: 'model'`
   * select, the advertised option set is model-dependent (`composer-2.5`
   * exposes model/fast where `claude-opus-5` also exposes effort), sending an
   * option the current model lacks fails with "Unknown model config option",
   * and `set_config_option` answers with the full refreshed array. */
  function cursorWire(initial: { model?: string; effort?: string; fast?: boolean } = {}) {
    const state = {
      model: initial.model ?? 'claude-opus-5',
      effort: initial.effort ?? 'low',
      fast: initial.fast ?? false,
    }
    const failures = new Map<string, Error>()
    const options = (): SessionConfigOption[] => [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: state.model,
        options: [
          { value: 'claude-opus-5', name: 'Opus 5' },
          { value: 'composer-2.5', name: 'Composer 2.5' },
        ],
      },
      { type: 'boolean', id: 'fast', name: 'Fast', currentValue: state.fast },
      ...(state.model === 'claude-opus-5'
        ? [
            {
              type: 'select' as const,
              id: 'effort',
              name: 'Effort',
              currentValue: state.effort,
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' },
              ],
            },
          ]
        : []),
    ]
    const setSessionConfigOption = vi.fn(async (params: unknown) => {
      const { configId, value } = params as { configId: string; value: string | boolean }
      const failure = failures.get(configId)
      if (failure) {
        failures.delete(configId)
        throw failure
      }
      if (!options().some((option) => option.id === configId))
        throw new Error(`Unknown model config option: ${configId}`)
      if (configId === 'model') state.model = String(value)
      if (configId === 'effort') state.effort = String(value)
      if (configId === 'fast') state.fast = value === true || value === 'true'
      return { configOptions: options() }
    })
    const wire: FakeWire = {
      newSession: async () => ({ sessionId: 'session-1', configOptions: options() }),
      setSessionConfigOption,
    }
    return {
      wire,
      setSessionConfigOption,
      state,
      failNext: (id: string, error: Error) => failures.set(id, error),
    }
  }

  const writes = (mock: ReturnType<typeof vi.fn>): Array<{ configId: string; value: unknown }> =>
    mock.mock.calls.map(([params]) => {
      const { configId, value } = params as { configId: string; value: unknown }
      return { configId, value }
    })

  it('sends nothing when the session already reports the desired selection', async () => {
    const { wire, setSessionConfigOption } = cursorWire()
    const { runtime } = await started(wire, cursor)

    await runtime.applyDesiredConfig({
      modelId: 'claude-opus-5',
      values: { effort: 'low', fast: false },
    })

    // The steady state of every warm message: 0 RPCs, where the old preamble
    // spent 11.5s re-sending values the agent already held.
    expect(setSessionConfigOption).not.toHaveBeenCalled()
  })

  it('writes only the option whose current value differs', async () => {
    const { wire, setSessionConfigOption } = cursorWire()
    const { runtime } = await started(wire, cursor)

    await runtime.applyDesiredConfig({
      modelId: 'claude-opus-5',
      values: { effort: 'high', fast: false },
    })

    expect(writes(setSessionConfigOption)).toEqual([{ configId: 'effort', value: 'high' }])
    expect(runtime.applied?.options.get('effort')?.currentValue).toBe('high')
  })

  it('applies the model first and re-plans, never sending an option the new model dropped', async () => {
    const { wire, setSessionConfigOption } = cursorWire()
    const { runtime } = await started(wire, cursor)

    await runtime.applyDesiredConfig({
      modelId: 'composer-2.5',
      values: { effort: 'high', fast: true },
    })

    // `effort` is legal for claude-opus-5 and gone for composer-2.5. Planning
    // against the pre-change list would have burned ~1.4s failing with
    // "Unknown model config option".
    expect(writes(setSessionConfigOption)).toEqual([
      { configId: 'model', value: 'composer-2.5' },
      { configId: 'fast', value: true },
    ])
    expect(runtime.applied?.options.has('effort')).toBe(false)
  })

  it('reports the applied model so the composer is corrected', async () => {
    const { wire } = cursorWire({ model: 'composer-2.5' })
    const { events } = await started(wire, cursor, {
      desiredConfig: { modelId: 'claude-opus-5' },
    })

    // Cursor's model state is process-global and restored from disk, so a
    // brand-new process can report a model left behind by an exited one.
    expect(events.findLast((event) => event.event === 'current_model_update')?.data).toMatchObject({
      currentModelId: 'claude-opus-5',
    })
  })

  it('corrects stale on-disk state at start and then costs nothing per message', async () => {
    const { wire, setSessionConfigOption } = cursorWire({ model: 'composer-2.5' })
    const desiredConfig = { modelId: 'claude-opus-5', values: { effort: 'high' } }
    const { runtime } = await started(wire, cursor, { desiredConfig })

    expect(writes(setSessionConfigOption)).toEqual([
      { configId: 'model', value: 'claude-opus-5' },
      // effort only exists once the model change has landed, so it is planned
      // against the refreshed list.
      { configId: 'effort', value: 'high' },
    ])

    setSessionConfigOption.mockClear()
    await runtime.applyDesiredConfig(desiredConfig)
    expect(setSessionConfigOption).not.toHaveBeenCalled()
  })

  it('never records a value whose write failed, so the next attempt retries', async () => {
    const { wire, setSessionConfigOption, failNext } = cursorWire()
    const { runtime } = await started(wire, cursor)
    failNext('effort', new Error('agent is busy'))

    await expect(runtime.applyDesiredConfig({ values: { effort: 'high' } })).rejects.toThrow(
      'agent is busy',
    )
    expect(runtime.applied?.options.get('effort')?.currentValue).toBe('low')

    setSessionConfigOption.mockClear()
    await runtime.applyDesiredConfig({ values: { effort: 'high' } })
    expect(writes(setSessionConfigOption)).toEqual([{ configId: 'effort', value: 'high' }])
  })

  it('re-applies after the agent reports a model change of its own', async () => {
    const { wire, setSessionConfigOption } = cursorWire()
    const { runtime, child } = await started(wire, cursor)
    // Without this the cache would still hold claude-opus-5 and skip the write,
    // leaving the prompt to run on whatever the agent switched to.
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: { sessionUpdate: 'current_model_update', currentModelId: 'composer-2.5' },
    })

    expect(runtime.applied?.options.get('model')?.currentValue).toBe('composer-2.5')
    await runtime.applyDesiredConfig({ modelId: 'claude-opus-5' })
    expect(writes(setSessionConfigOption)).toEqual([{ configId: 'model', value: 'claude-opus-5' }])
  })

  it('rejects an explicit value the agent does not advertise without a round trip', async () => {
    const { wire, setSessionConfigOption } = cursorWire()
    const { runtime } = await started(wire, cursor)

    await expect(runtime.setConfigOption('effort', 'xhigh')).rejects.toThrow(
      'does not advertise value xhigh',
    )
    await expect(runtime.setConfigOption('thinking', true)).rejects.toThrow(
      'does not expose config option thinking',
    )
    expect(setSessionConfigOption).not.toHaveBeenCalled()
  })

  it('confirms an explicit no-op write with the cached options instead of an RPC', async () => {
    const { wire, setSessionConfigOption } = cursorWire()
    const { runtime, events } = await started(wire, cursor)

    await runtime.setConfigOption('effort', 'low')

    expect(setSessionConfigOption).not.toHaveBeenCalled()
    expect(events.findLast((event) => event.event === 'config_option_update')).toMatchObject({
      sessionId: 'session-1',
    })
  })

  it('prunes a remembered value the current model dropped instead of attempting it', async () => {
    const { wire, setSessionConfigOption } = cursorWire({ model: 'composer-2.5' })
    const { runtime } = await started(wire, cursor)

    await runtime.applyDesiredConfig({ values: { effort: 'high', fast: true } })

    expect(writes(setSessionConfigOption)).toEqual([{ configId: 'fast', value: true }])
  })

  it('applies blindly while the agent has advertised no config options', async () => {
    const setSessionConfigOption = vi.fn(async () => ({ configOptions: [] }))
    const request = vi.fn(async () => ({}))
    const { runtime } = await started({ setSessionConfigOption, request }, cursor)

    // Nothing has been read back, so nothing can be proved satisfied and
    // nothing can be pruned. Correctness beats latency: send it.
    await runtime.applyDesiredConfig({ modelId: 'some-model', values: { fast: true } })
    await runtime.applyDesiredConfig({ modelId: 'some-model', values: { fast: true } })

    expect(request).toHaveBeenCalledTimes(2)
    expect(setSessionConfigOption).toHaveBeenCalledTimes(2)
  })

  it('re-sends session/set_model every time for an agent with no model option', async () => {
    const request = vi.fn(async () => ({}))
    const { runtime } = await started({ request }, opencode)

    await runtime.applyDesiredConfig({ modelId: 'anthropic/claude-opus-5' })
    await runtime.applyDesiredConfig({ modelId: 'anthropic/claude-opus-5' })

    // `session/set_model` answers `{}`, so there is no wire-sourced value to
    // cache and a skip would rest on nothing but our own memory of asking.
    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenLastCalledWith('session/set_model', {
      sessionId: 'session-1',
      modelId: 'anthropic/claude-opus-5',
    })
  })
})

describe('AcpSessionRuntime prompt', () => {
  it('forwards text and image blocks in one ACP prompt without dropping attachment metadata', async () => {
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' }))
    const { runtime, events } = await started({ prompt })

    await runtime.prompt({
      prompt: {
        text: 'Describe this',
        blocks: [
          { type: 'text', text: 'Describe this' },
          { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
        ],
        attachments: [{ id: 'attachment-1', name: 'icon.png', mimeType: 'image/png', size: 5 }],
      },
      userMessageId: 'user-1',
    })

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      ],
    })
    expect(events.find((event) => event.event === 'prompt_started')?.data).toMatchObject({
      prompt: 'Describe this',
      attachments: [{ id: 'attachment-1', name: 'icon.png' }],
    })
  })
})

describe('AcpSessionRuntime ACP form elicitation', () => {
  it('routes standard ACP form elicitation through the canonical question broker', async () => {
    const { runtime, events, child } = await started()

    const pending = child.elicit({
      sessionId: 'session-1',
      mode: 'form',
      message: 'Choose and configure',
      requestedSchema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            title: 'Strategy',
            oneOf: [
              { const: 'safe', title: 'Safe' },
              { const: 'fast', title: 'Fast' },
            ],
          },
          retries: { type: 'integer', title: 'Retries', minimum: 0 },
        },
        required: ['strategy', 'retries'],
      },
    })
    const request = events.find((event) => event.event === 'question_request')
    expect(request).toMatchObject({
      category: 'session',
      sessionId: 'session-1',
      data: {
        title: 'Choose and configure',
        questions: [
          {
            questionId: 'strategy',
            options: [
              { optionId: 'safe', label: 'Safe' },
              { optionId: 'fast', label: 'Fast' },
            ],
          },
          { questionId: 'retries', options: [] },
        ],
      },
    })

    const requestId = requestIdOf(request)
    expect(
      runtime.respondQuestion(requestId, {
        outcome: 'answered',
        answers: [
          { questionId: 'strategy', selectedOptionIds: ['fast'] },
          { questionId: 'retries', text: '3' },
        ],
      }),
    ).toBe(true)
    await expect(pending).resolves.toEqual({
      action: 'accept',
      content: { strategy: 'fast', retries: 3 },
    })
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      data: { requestId, method: 'elicitation/create', outcome: { outcome: 'responded' } },
    })
    expect(runtime.respondQuestion(requestId, { outcome: 'cancelled' })).toBe(false)
  })

  it('cancels pending ACP form elicitation with the prompt turn', async () => {
    const cancel = vi.fn(async () => undefined)
    const { runtime, events, child } = await started({ cancel })
    const pending = child.elicit({
      sessionId: 'session-1',
      mode: 'form',
      message: 'Name it',
      requestedSchema: {
        type: 'object',
        properties: { name: { type: 'string', title: 'Name' } },
        required: ['name'],
      },
    })

    await runtime.cancel()

    await expect(pending).resolves.toEqual({ action: 'cancel' })
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      data: {
        method: 'elicitation/create',
        outcome: { outcome: 'cancelled', reason: 'tool_cancelled' },
      },
    })
  })
})

describe('AcpSessionRuntime subtask normalization', () => {
  const subtaskEvents = (events: BackendEvent[]) =>
    events.filter((event) => event.event === 'subtask_update').map((event) => event.data)
  const toolEvents = (events: BackendEvent[]) =>
    events.filter((event) => event.event === 'tool_call' || event.event === 'tool_call_update')

  it('normalizes the OpenCode task lifecycle and suppresses raw tool events', async () => {
    const { child, events } = await started({}, opencode)
    // Live wire shapes, OpenCode 1.17.15.
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'task',
        kind: 'think',
        status: 'pending',
        rawInput: {},
      },
    })
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        title: 'Summarize folder structure',
        status: 'in_progress',
        rawInput: {
          description: 'Summarize folder structure',
          subagent_type: 'explore',
          prompt: 'Explore the current working directory.',
        },
      },
    })
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        status: 'completed',
        rawOutput: {
          output:
            '<task id="ses_child" state="completed">\n<task_result>\nA tidy summary.\n</task_result>\n</task>',
          metadata: {
            parentSessionId: 'session-1',
            sessionId: 'ses_child',
            model: { modelID: 'gpt-5.5', providerID: 'openai' },
            truncated: false,
          },
        },
      },
    })
    expect(toolEvents(events)).toHaveLength(0)
    expect(subtaskEvents(events)).toEqual([
      { taskId: 'call_1', status: 'pending', statusSource: 'task_event' },
      {
        taskId: 'call_1',
        status: 'running',
        statusSource: 'task_event',
        title: 'Summarize folder structure',
        description: 'Summarize folder structure',
        prompt: 'Explore the current working directory.',
        subagentType: 'explore',
      },
      {
        taskId: 'call_1',
        status: 'completed',
        statusSource: 'task_event',
        modelId: 'openai/gpt-5.5',
        childSessionId: 'ses_child',
        resultText: 'A tidy summary.',
      },
    ])
  })

  it('passes non-task OpenCode tool calls through untouched', async () => {
    const { child, events } = await started({}, opencode)
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_2',
        title: 'read',
        kind: 'read',
        status: 'pending',
        rawInput: { filePath: 'a.txt' },
      },
    })
    expect(subtaskEvents(events)).toHaveLength(0)
    expect(toolEvents(events)).toHaveLength(1)
  })

  it('normalizes the Cursor Task tool and keeps claimed ids suppressed', async () => {
    const { child, events } = await started({}, cursor)
    // Fast-path wire shape: generic title, rawInput only carries _toolName.
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool_1',
        title: 'Task: Subagent task',
        kind: 'other',
        status: 'pending',
        rawInput: { _toolName: 'task' },
      },
    })
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool_1', status: 'in_progress' },
    })
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool_1',
        status: 'completed',
        rawOutput: { durationMs: 28086, isBackground: false },
      },
    })
    expect(toolEvents(events)).toHaveLength(0)
    expect(subtaskEvents(events)).toEqual([
      { taskId: 'tool_1', status: 'pending', statusSource: 'task_event', title: 'Subagent task' },
      { taskId: 'tool_1', status: 'running', statusSource: 'task_event' },
      { taskId: 'tool_1', status: 'completed', statusSource: 'task_event', durationMs: 28086 },
    ])
  })

  it('acks cursor/task immediately and emits enrichment for the sole session', async () => {
    const { child, events } = await started({}, cursor)
    // Real payload shape (no sessionId; nested tagged-enum subagentType).
    await expect(
      child.extMethod('cursor/task', {
        toolCallId: 'tool_1',
        description: 'Explore folder structure summary',
        prompt: 'Explore the workspace directory.',
        subagentType: { custom: { unspecified: {} } },
        model: 'composer-2.5-fast',
        agentId: '2dbea804-4e9e-4e4f-8c47-234a4077187b',
        durationMs: 28086,
      }),
    ).resolves.toEqual({})
    expect(events.find((event) => event.event === 'extension_request')).toBeUndefined()
    expect(subtaskEvents(events)).toEqual([
      {
        taskId: 'tool_1',
        description: 'Explore folder structure summary',
        prompt: 'Explore the workspace directory.',
        modelId: 'composer-2.5-fast',
        durationMs: 28086,
        subagentType: 'unspecified',
      },
    ])
  })

  it('routes sessionless extension notifications through the sole session', async () => {
    const { child, events } = await started({}, cursor)
    await child.extNotification('cursor/task', {
      toolCallId: 'tool_9',
      description: 'Background task',
      subagentType: 'explore',
    })
    expect(subtaskEvents(events)).toEqual([
      { taskId: 'tool_9', description: 'Background task', subagentType: 'explore' },
    ])
    expect(events.find((event) => event.event === 'extension_notification')).toBeUndefined()
  })

  it('maps OpenCode aborted task output to interrupted with provider detail', async () => {
    const { child, events } = await started({}, opencode)
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_cancelled',
        title: 'task',
        kind: 'think',
        status: 'pending',
        rawInput: {},
      },
    })
    await child.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_cancelled',
        status: 'failed',
        rawOutput: { error: 'Tool execution aborted', metadata: { interrupted: true } },
      },
    })

    expect(subtaskEvents(events).at(-1)).toEqual({
      taskId: 'call_cancelled',
      status: 'interrupted',
      statusSource: 'task_event',
      statusReason: 'Tool execution aborted',
    })
  })
})

describe('AcpSessionRuntime RPC timeouts', () => {
  /** Small enough that a real timer is fine, big enough not to be flaky. */
  const TIGHT: Partial<RuntimeTimeouts> = {
    initializeMs: 30,
    authenticateMs: 30,
    newSessionMs: 30,
    loadSessionMs: 30,
    controlRequestMs: 30,
  }

  it('fails a handshake the agent accepted and never answered', async () => {
    const harness = build({ initialize: () => new Promise(() => undefined) }, opencode, {}, TIGHT)
    // `AcpBackend` had no budget here at all: an agent that takes the request
    // and goes quiet hung its caller forever, with the child still alive so
    // the exit race never fires either.
    await expect(harness.runtime.start()).rejects.toThrow(
      'opencode did not answer initialize within 30ms',
    )
    // The half-built process is torn down rather than left resident.
    expect(harness.connections.last.terminated).toEqual({ reason: 'start_failed' })
    expect(harness.runtime.phase).toBe('exited')
  })

  it('bounds a config write, because a prompt queues behind it', async () => {
    const harness = build(
      {
        newSession: async () => ({ sessionId: 'session-1' }),
        setSessionConfigOption: () => new Promise(() => undefined),
      },
      opencode,
      {},
      TIGHT,
    )
    await harness.runtime.start()
    await expect(harness.runtime.setConfigOption('effort', 'high')).rejects.toThrow(
      'did not answer session/set_config_option within 30ms',
    )
    // A write that never answered proves nothing, so nothing is cached and the
    // next attempt retries rather than skipping.
    expect(harness.runtime.applied?.options.get('effort')).toBeUndefined()
    expect(harness.events.find((event) => event.event === 'rpc_error')).toBeDefined()
    // The process survives: one unanswered config write is not a dead CLI.
    expect(harness.runtime.phase).toBe('ready')
  })

  it('never applies a handshake budget to a prompt', async () => {
    const harness = build(
      {
        newSession: async () => ({ sessionId: 'session-1' }),
        // Longer than every configured budget, several times over. A turn that
        // runs for minutes is normal and must not be cut off.
        prompt: () =>
          new Promise((resolve) => setTimeout(() => resolve({ stopReason: 'end_turn' }), 150)),
      },
      opencode,
      {},
      TIGHT,
    )
    await harness.runtime.start()
    await expect(
      harness.runtime.prompt({ prompt: { text: 'hi', blocks: [{ type: 'text', text: 'hi' }] } }),
    ).resolves.toBeUndefined()
    expect(harness.events.find((event) => event.event === 'prompt_completed')).toBeDefined()
  })
})
