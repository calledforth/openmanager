import type { SessionConfigOption } from '@agentpack/contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../Backend.js'
import { cursor } from '../../providers/cursor.js'
import { opencode } from '../../providers/opencode.js'
import { AcpBackend } from './AcpBackend.js'

type BackendInternals = {
  connection: unknown
  process: { exitCode: null }
  initialized: boolean
  authenticated: boolean
  handshake(route: { threadId: string; workspaceId?: string }): Promise<void>
  elicitationRequest(
    params: import('@agentclientprotocol/sdk').CreateElicitationRequest,
  ): Promise<import('@agentclientprotocol/sdk').CreateElicitationResponse>
  sessionUpdate(params: { sessionId: string; update: Record<string, unknown> }): Promise<void>
  activePromptSessionId?: string
}

const route = {
  providerId: 'opencode' as const,
  threadId: 'thread-1',
  workspaceId: 'workspace-1',
  cwd: 'C:/workspace',
}

function setup(connection: Record<string, unknown>, config = opencode) {
  const events: BackendEvent[] = []
  const backend = new AcpBackend(config, {
    log: vi.fn(),
    onSessionTitle: vi.fn(),
  })
  const internals = backend as unknown as BackendInternals
  internals.connection = connection
  internals.process = { exitCode: null }
  internals.initialized = true
  internals.authenticated = true
  backend.events((event) => events.push(event))
  return { backend, events, internals }
}

describe('AcpBackend permission round-trip', () => {
  type PermissionInternals = {
    permissionRequest(params: Record<string, unknown>): Promise<unknown>
  }

  async function setupWithSession() {
    const connection = {
      async newSession() {
        return { sessionId: 'session-1' }
      },
    }
    const result = setup(connection)
    await result.backend.ensureSession({ ...route })
    const responsePromise = (result.backend as unknown as PermissionInternals).permissionRequest({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Write file', kind: 'edit' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    })
    const request = result.events.find((event) => event.event === 'permission_request')
    const requestId = (request?.data as { requestId: string }).requestId
    return { ...result, responsePromise, requestId }
  }

  it('emits permission_resolved when the request is answered', async () => {
    const { backend, events, responsePromise, requestId } = await setupWithSession()
    expect(backend.respondPermission(requestId, { outcome: 'selected', optionId: 'allow' })).toBe(
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

  it('emits permission_resolved when dispose cancels pending requests', async () => {
    const { backend, events, internals, responsePromise, requestId } = await setupWithSession()
    ;(internals as unknown as { process: { exitCode: number | null; kill: () => void } }).process =
      { exitCode: null, kill: vi.fn() }
    backend.dispose()
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events.find((event) => event.event === 'permission_resolved')).toMatchObject({
      data: { requestId, outcome: { outcome: 'cancelled', reason: 'runtime_disposed' } },
    })
  })
})

describe('AcpBackend deferred extension requests', () => {
  type ExtensionInternals = {
    extensionRequest(method: string, params: unknown): Promise<Record<string, unknown>>
  }

  const deferredConfig = {
    ...opencode,
    extensions: {
      deferred: ['test/ask'],
      requests: {
        'test/ask': () => ({ outcome: { outcome: 'skipped', reason: 'fallback' } }),
      },
    },
  }

  async function setupWithSession(config = deferredConfig) {
    const connection = {
      async newSession() {
        return { sessionId: 'session-1' }
      },
    }
    const result = setup(connection, config)
    await result.backend.ensureSession({ ...route })
    const responsePromise = (result.backend as unknown as ExtensionInternals).extensionRequest(
      'test/ask',
      { sessionId: 'session-1', title: 'Pick one', questions: [] },
    )
    const request = result.events.find((event) => event.event === 'extension_request')
    const requestId = (request?.data as { requestId: string }).requestId
    return { ...result, responsePromise, requestId }
  }

  it('holds the request open until respondExtension supplies the answer', async () => {
    const { backend, events, responsePromise, requestId } = await setupWithSession()
    const response = { outcome: { outcome: 'answered', answers: ['A'] } }
    expect(backend.respondExtension(requestId, response)).toBe(true)
    await expect(responsePromise).resolves.toEqual(response)
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      threadId: 'thread-1',
      sessionId: 'session-1',
      data: { requestId, method: 'test/ask', outcome: { outcome: 'responded', response } },
    })
  })

  it('falls back to the registered handler when dispose cancels the wait', async () => {
    const { backend, events, internals, responsePromise, requestId } = await setupWithSession()
    ;(internals as unknown as { process: { exitCode: number | null; kill: () => void } }).process =
      { exitCode: null, kill: vi.fn() }
    backend.dispose()
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'fallback' },
    })
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      data: { requestId, outcome: { outcome: 'cancelled', reason: 'runtime_disposed' } },
    })
    expect(backend.respondExtension(requestId, {})).toBe(false)
  })

  it('answers non-deferred methods immediately and reports the response', async () => {
    const connection = {
      async newSession() {
        return { sessionId: 'session-1' }
      },
    }
    const { backend, events } = setup(connection, deferredConfig)
    await backend.ensureSession({ ...route })
    const response = await (backend as unknown as ExtensionInternals).extensionRequest(
      'test/other',
      { sessionId: 'session-1' },
    )
    expect(response).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(events.find((event) => event.event === 'extension_resolved')).toMatchObject({
      data: {
        method: 'test/other',
        outcome: { outcome: 'responded', response: { outcome: { outcome: 'cancelled' } } },
      },
    })
  })
})

describe('AcpBackend structured questions (cursor/ask_question)', () => {
  type ExtensionInternals = {
    extensionRequest(method: string, params: unknown): Promise<Record<string, unknown>>
  }

  // Real wire shape: no sessionId anywhere in params (exercises the
  // sole-active-session fallback).
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
    const connection = {
      async newSession() {
        return { sessionId: 'session-1' }
      },
    }
    const result = setup(connection, cursor)
    await result.backend.ensureSession({ ...route })
    const responsePromise = (result.backend as unknown as ExtensionInternals).extensionRequest(
      'cursor/ask_question',
      askParams,
    )
    const request = result.events.find((event) => event.event === 'question_request')
    const requestId = (request?.data as { requestId: string } | undefined)?.requestId
    return { ...result, responsePromise, requestId, request }
  }

  it('emits question_request via the sole-session fallback and answers with smuggled text', async () => {
    const { backend, responsePromise, requestId, request } = await setupWithQuestion()
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
      backend.respondQuestion(requestId!, {
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
    const { backend, responsePromise, requestId } = await setupWithQuestion()
    expect(backend.respondQuestion(requestId!, { outcome: 'cancelled', reason: 'user' })).toBe(true)
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'skipped', reason: 'User skipped questions' },
    })
  })

  it('answers immediately with the static fallback when multiple sessions are active', async () => {
    let sessionCounter = 0
    const connection = {
      async newSession() {
        sessionCounter += 1
        return { sessionId: `session-${sessionCounter}` }
      },
    }
    const { backend, events } = setup(connection, cursor)
    await backend.ensureSession({ ...route })
    await backend.ensureSession({ ...route, threadId: 'thread-2' })
    const response = await (backend as unknown as ExtensionInternals).extensionRequest(
      'cursor/ask_question',
      askParams,
    )
    expect(response).toEqual({ outcome: { outcome: 'skipped', reason: 'User skipped questions' } })
    expect(events.find((event) => event.event === 'question_request')).toBeUndefined()
  })

  it('correlates sessionless questions to the active prompt with multiple sessions', async () => {
    let sessionCounter = 0
    const connection = {
      async newSession() {
        sessionCounter += 1
        return { sessionId: `session-${sessionCounter}` }
      },
    }
    const { backend, events, internals } = setup(connection, cursor)
    await backend.ensureSession({ ...route })
    await backend.ensureSession({ ...route, threadId: 'thread-2' })
    internals.activePromptSessionId = 'session-2'
    const responsePromise = (backend as unknown as ExtensionInternals).extensionRequest(
      'cursor/ask_question',
      askParams,
    )
    const request = events.find((event) => event.event === 'question_request')
    expect(request).toMatchObject({ threadId: 'thread-2', sessionId: 'session-2' })
    const requestId = (request?.data as { requestId: string }).requestId
    backend.respondQuestion(requestId, {
      outcome: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: ['o1'] }],
    })
    await expect(responsePromise).resolves.toMatchObject({
      outcome: { outcome: 'answered' },
    })
  })

  it('registers a question before emitting it to synchronous listeners', async () => {
    const connection = {
      async newSession() {
        return { sessionId: 'session-1' }
      },
    }
    const { backend } = setup(connection, cursor)
    await backend.ensureSession({ ...route })
    let accepted = false
    backend.events((event) => {
      if (event.event !== 'question_request') return
      const requestId = (event.data as { requestId: string }).requestId
      accepted = backend.respondQuestion(requestId, {
        outcome: 'answered',
        answers: [{ questionId: 'q1', selectedOptionIds: ['o2'] }],
      })
    })
    await expect(
      (backend as unknown as ExtensionInternals).extensionRequest(
        'cursor/ask_question',
        askParams,
      ),
    ).resolves.toMatchObject({ outcome: { outcome: 'answered' } })
    expect(accepted).toBe(true)
  })
})

describe('AcpBackend plan review (cursor/create_plan)', () => {
  type ExtensionInternals = {
    extensionRequest(method: string, params: unknown): Promise<Record<string, unknown>>
  }

  // Real wire shape: no sessionId anywhere (exercises the sole-session fallback).
  const planParams = {
    toolCallId: 'tool-1',
    name: 'Implementation Plan',
    overview: 'Overview',
    plan: '# Plan\n\n- step',
    todos: [{ id: 't1', content: 'Step 1', status: 'pending' }],
  }

  async function setupWithPlan() {
    const connection = {
      async newSession() {
        return { sessionId: 'session-1' }
      },
    }
    const result = setup(connection, cursor)
    await result.backend.ensureSession({ ...route })
    const responsePromise = (result.backend as unknown as ExtensionInternals).extensionRequest(
      'cursor/create_plan',
      planParams,
    )
    const request = result.events.find((event) => event.event === 'plan_review_request')
    const requestId = (request?.data as { requestId: string } | undefined)?.requestId
    return { ...result, responsePromise, requestId, request }
  }

  it('emits plan_review_request via the sole-session fallback and accepts', async () => {
    const { backend, responsePromise, requestId, request } = await setupWithPlan()
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
    expect(backend.respondPlan(requestId!, { outcome: 'accepted' })).toBe(true)
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'accepted' } })
  })

  it('maps a rejected outcome to the wire response with its reason', async () => {
    const { backend, responsePromise, requestId } = await setupWithPlan()
    expect(backend.respondPlan(requestId!, { outcome: 'rejected', reason: 'needs tests' })).toBe(
      true,
    )
    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'rejected', reason: 'needs tests' },
    })
  })

  it('falls back to cancelled when dispose cancels the review', async () => {
    const { backend, internals, responsePromise } = await setupWithPlan()
    ;(internals as unknown as { process: { exitCode: number | null; kill: () => void } }).process =
      { exitCode: null, kill: vi.fn() }
    backend.dispose()
    await expect(responsePromise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('AcpBackend plan snapshots (cursor/update_todos)', () => {
  type ExtensionInternals = {
    extensionRequest(method: string, params: unknown): Promise<Record<string, unknown>>
  }

  async function setupWithSession() {
    const connection = {
      async newSession() {
        return { sessionId: 'session-1' }
      },
    }
    const result = setup(connection, cursor)
    await result.backend.ensureSession({ ...route })
    return result
  }

  it('acks immediately and emits plan_update, dropping cancelled todos', async () => {
    const { backend, events } = await setupWithSession()
    const response = await (backend as unknown as ExtensionInternals).extensionRequest(
      'cursor/update_todos',
      {
        toolCallId: 't',
        todos: [
          { id: '1', content: 'A', status: 'in_progress' },
          { id: '2', content: 'B', status: 'cancelled' },
        ],
        merge: false,
      },
    )
    expect(response).toEqual({})
    const update = events.find((event) => event.event === 'plan_update')
    expect(update).toMatchObject({
      sessionId: 'session-1',
      data: { entries: [{ content: 'A', priority: 'medium', status: 'in_progress' }] },
    })
  })

  it('merges incoming todos by id on merge:true', async () => {
    const { backend, events } = await setupWithSession()
    const internals = backend as unknown as ExtensionInternals
    await internals.extensionRequest('cursor/update_todos', {
      toolCallId: 't',
      todos: [
        { id: '1', content: 'A', status: 'in_progress' },
        { id: '2', content: 'B', status: 'cancelled' },
      ],
      merge: false,
    })
    await internals.extensionRequest('cursor/update_todos', {
      toolCallId: 't',
      todos: [
        { id: '1', content: 'A', status: 'completed' },
        { id: '3', content: 'C', status: 'pending' },
      ],
      merge: true,
    })
    const updates = events.filter((event) => event.event === 'plan_update')
    expect(updates.at(-1)).toMatchObject({
      data: {
        entries: [
          { content: 'A', priority: 'medium', status: 'completed' },
          { content: 'C', priority: 'medium', status: 'pending' },
        ],
      },
    })
  })
})

describe('AcpBackend session compatibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('routes replayed updates while session/load is in flight', async () => {
    let internals: BackendInternals
    const connection = {
      async loadSession() {
        await internals.sessionUpdate({
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'replayed' },
            _meta: { cursor: 'cursor-2' },
          },
        })
        return { sessionId: 'session-1' }
      },
    }
    const setupResult = setup(connection)
    internals = setupResult.internals

    const result = await setupResult.backend.ensureSession({
      ...route,
      sessionId: 'session-1',
      resumeCursor: 'cursor-1',
    })

    expect(result).toMatchObject({ state: 'loaded', resumeCursor: 'cursor-2' })
    expect(setupResult.events.map((event) => event.event)).toEqual([
      'agent_message_chunk',
      'session_loaded',
    ])
  })

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
    const setSessionConfigOption = vi.fn(async (args: { configId: string; value: string }) => {
      configOptions = configOptions.map((option) =>
        option.id === args.configId ? { ...option, currentValue: args.value } : option,
      ) as SessionConfigOption[]
      return { configOptions }
    })
    const unstableSetSessionModel = vi.fn()
    const setSessionMode = vi.fn()
    const { backend, events } = setup({
      newSession: async () => ({ sessionId: 'session-1', configOptions }),
      setSessionConfigOption,
      unstable_setSessionModel: unstableSetSessionModel,
      setSessionMode,
    })
    await backend.ensureSession(route)

    await backend.setModel({ ...route, sessionId: 'session-1', modelId: 'provider/model-b' })
    await backend.setMode({ ...route, sessionId: 'session-1', modeId: 'plan' })

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
    expect(unstableSetSessionModel).not.toHaveBeenCalled()
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
    const { backend } = setup({
      newSession: async () => ({ sessionId: 'session-1' }),
      request,
      setSessionMode,
    })
    await backend.ensureSession(route)

    await backend.setModel({ ...route, sessionId: 'session-1', modelId: 'legacy-model' })
    await backend.setMode({ ...route, sessionId: 'session-1', modeId: 'legacy-mode' })

    expect(request).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'session-1',
      modelId: 'legacy-model',
    })
    expect(setSessionMode).toHaveBeenCalledWith({
      sessionId: 'session-1',
      modeId: 'legacy-mode',
    })
  })

  it('forwards text and image blocks in one ACP prompt without dropping attachment metadata', async () => {
    const prompt = vi.fn(async () => ({ stopReason: 'end_turn' }))
    const { backend, events } = setup({
      newSession: async () => ({ sessionId: 'session-1' }),
      prompt,
    })
    await backend.ensureSession(route)

    await backend.prompt({
      ...route,
      sessionId: 'session-1',
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

  it('advertises form elicitation support during initialization', async () => {
    const initialize = vi.fn(async () => ({ protocolVersion: 1, authMethods: [] }))
    const { internals } = setup({ initialize })

    await internals.handshake(route)

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({
          elicitation: { form: {} },
        }),
      }),
    )
  })

  it('routes standard ACP form elicitation through the canonical question broker', async () => {
    const { backend, events, internals } = setup({
      newSession: async () => ({ sessionId: 'session-1' }),
    })
    await backend.ensureSession(route)

    const pending = internals.elicitationRequest({
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
          retries: {
            type: 'integer',
            title: 'Retries',
            minimum: 0,
          },
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

    const requestId = (request?.data as { requestId: string }).requestId
    expect(
      backend.respondQuestion(requestId, {
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
      data: {
        requestId,
        method: 'elicitation/create',
        outcome: { outcome: 'responded' },
      },
    })
    expect(backend.respondQuestion(requestId, { outcome: 'cancelled' })).toBe(false)
  })

  it('cancels pending ACP form elicitation with the prompt turn', async () => {
    const cancel = vi.fn(async () => undefined)
    const { backend, events, internals } = setup({
      newSession: async () => ({ sessionId: 'session-1' }),
      cancel,
    })
    await backend.ensureSession(route)
    const pending = internals.elicitationRequest({
      sessionId: 'session-1',
      mode: 'form',
      message: 'Name it',
      requestedSchema: {
        type: 'object',
        properties: { name: { type: 'string', title: 'Name' } },
        required: ['name'],
      },
    })

    await backend.cancel({ ...route, sessionId: 'session-1' })

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
