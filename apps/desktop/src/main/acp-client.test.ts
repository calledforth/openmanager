import { describe, expect, it } from 'vitest'
import { ACPClient } from './acp-client'

interface CapturedEnvelope {
  payload?: {
    type?: string
    properties?: Record<string, unknown>
  }
}

describe('ACPClient projector', () => {
  it('splits text parts around tool boundaries', () => {
    let notify: ((method: string, params: unknown) => void) | null = null
    const envelopes: CapturedEnvelope[] = []

    const connection = {
      onNotification(handler: (method: string, params: unknown) => void) {
        notify = handler
        return () => undefined
      },
      setRequestHandler() {
        return undefined
      },
    }

    const bridge = {
      ingestEnvelope(envelope: Record<string, unknown>) {
        envelopes.push(envelope as CapturedEnvelope)
      },
    }

    const mainWindow = {
      isDestroyed() {
        return false
      },
      webContents: {
        send() {
          return undefined
        },
      },
    }

    const client = new ACPClient(connection as never, () => bridge as never, mainWindow as never)

    ;(client as unknown as { sessionWorkspace: Map<string, string> }).sessionWorkspace.set(
      's1',
      'ws1',
    )

    const emit = (update: Record<string, unknown>) => {
      notify?.('session/update', { sessionId: 's1', update })
    }

    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } })
    emit({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool_1',
      title: 'bash',
      rawInput: { command: 'pwd' },
    })
    emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool_1',
      status: 'completed',
      rawOutput: { output: '/repo' },
    })
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } })

    const deltas = envelopes
      .filter((entry) => entry.payload?.type === 'message.part.delta')
      .map((entry) => entry.payload?.properties as { partID?: string; delta?: string })

    expect(deltas.length).toBe(2)
    expect(deltas[0].delta).toBe('Hello ')
    expect(deltas[1].delta).toBe('world')
    expect(deltas[0].partID).toBeDefined()
    expect(deltas[1].partID).toBeDefined()
    expect(deltas[0].partID).not.toBe(deltas[1].partID)
  })

  it('routes replayed session updates while session/load is in flight', async () => {
    let notify: ((method: string, params: unknown) => void) | null = null
    const envelopes: CapturedEnvelope[] = []
    const connection = {
      onNotification(handler: (method: string, params: unknown) => void) {
        notify = handler
        return () => undefined
      },
      setRequestHandler() {
        return undefined
      },
      async call(method: string) {
        if (method === 'initialize') return {}
        if (method === 'session/load') {
          notify?.('session/update', {
            sessionId: 's1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'replayed' },
            },
          })
          return { sessionId: 's1' }
        }
        if (method === 'session/list') return { sessions: [] }
        throw new Error(`Unexpected method: ${method}`)
      },
    }
    const bridge = {
      ingestEnvelope(envelope: Record<string, unknown>) {
        envelopes.push(envelope as CapturedEnvelope)
      },
    }
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: () => undefined },
    }
    const client = new ACPClient(connection as never, () => bridge as never, mainWindow as never)

    await client.loadSessionForWorkspace('ws1', 's1')

    expect(envelopes.some((entry) => entry.payload?.type === 'message.part.delta')).toBe(true)
  })

  it('normalizes configOptions and uses current ACP config and cancellation methods', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const notifications: Array<{ method: string; params?: unknown }> = []
    const rendererEvents: Array<{ type?: string; payload?: any }> = []
    const connection = {
      onNotification() {
        return () => undefined
      },
      setRequestHandler() {
        return undefined
      },
      async call(method: string, params?: unknown) {
        calls.push({ method, params })
        if (method === 'initialize') return {}
        if (method === 'session/new') {
          return {
            sessionId: 's1',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                currentValue: 'provider/model-a',
                options: [{ value: 'provider/model-a', name: 'Model A' }],
              },
              {
                id: 'mode',
                category: 'mode',
                currentValue: 'build',
                options: [{ value: 'build', name: 'Build' }],
              },
            ],
          }
        }
        if (method === 'session/list') return { sessions: [] }
        if (method === 'session/set_config_option') return { configOptions: [] }
        throw new Error(`Unexpected method: ${method}`)
      },
      notify(method: string, params?: unknown) {
        notifications.push({ method, params })
      },
    }
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send(_channel: string, event: { type?: string; payload?: any }) {
          rendererEvents.push(event)
        },
      },
    }
    const client = new ACPClient(connection as never, () => null, mainWindow as never)

    await client.createSessionForWorkspace('ws1')
    await client.setSessionModelForWorkspace('ws1', 's1', 'provider/model-b')
    await client.setSessionModeForWorkspace('ws1', 's1', 'plan')
    await client.abortSessionForWorkspace('ws1', 's1')

    const created = rendererEvents.find((event) => event.type === 'session.new.result')?.payload
    expect(created.models.currentModelId).toBe('provider/model-a')
    expect(created.models.availableModels).toEqual([
      { modelId: 'provider/model-a', name: 'Model A' },
    ])
    expect(created.modes.currentModeId).toBe('build')
    expect(calls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: 's1', configId: 'model', value: 'provider/model-b' },
    })
    expect(calls).toContainEqual({
      method: 'session/set_config_option',
      params: { sessionId: 's1', configId: 'mode', value: 'plan' },
    })
    expect(notifications).toEqual([{ method: 'session/cancel', params: { sessionId: 's1' } }])
  })
})
