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
})
