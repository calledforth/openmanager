import type { SessionConfigOption } from '@agentpack/contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../Backend.js'
import { opencode } from '../../providers/opencode.js'
import { AcpBackend } from './AcpBackend.js'

type BackendInternals = {
  connection: unknown
  process: { exitCode: null }
  initialized: boolean
  authenticated: boolean
  sessionUpdate(params: { sessionId: string; update: Record<string, unknown> }): Promise<void>
}

const route = {
  providerId: 'opencode' as const,
  threadId: 'thread-1',
  workspaceId: 'workspace-1',
  cwd: 'C:/workspace',
}

function setup(connection: Record<string, unknown>) {
  const events: BackendEvent[] = []
  const backend = new AcpBackend(opencode, {
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
    const unstableSetSessionModel = vi.fn(async () => ({}))
    const setSessionMode = vi.fn(async () => ({}))
    const { backend } = setup({
      newSession: async () => ({ sessionId: 'session-1' }),
      unstable_setSessionModel: unstableSetSessionModel,
      setSessionMode,
    })
    await backend.ensureSession(route)

    await backend.setModel({ ...route, sessionId: 'session-1', modelId: 'legacy-model' })
    await backend.setMode({ ...route, sessionId: 'session-1', modeId: 'legacy-mode' })

    expect(unstableSetSessionModel).toHaveBeenCalledWith({
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
})
