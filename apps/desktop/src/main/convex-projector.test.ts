import type { AgentEvent } from '@agentpack/contract'
import type { ConvexClient } from 'convex/browser'
import { describe, expect, it, vi } from 'vitest'
import { ConvexProjector } from './convex-projector'

vi.mock('./convex-telemetry', () => ({
  estimateConvexPayloadBytes: () => 0,
  extractConvexTelemetryContext: () => ({}),
  recordConvexTelemetry: () => undefined,
}))

const base = {
  threadId: 'thread-1',
  workspaceId: 'C:/workspace',
  sessionId: 'session-1',
  providerId: 'opencode',
  messageId: 'assistant-1',
} as const

function event(
  seq: number,
  patch: Partial<AgentEvent> & Pick<AgentEvent, 'category' | 'event' | 'data'>,
): AgentEvent {
  return {
    id: `event-${seq}`,
    timestamp: new Date(seq).toISOString(),
    seq,
    ...base,
    ...patch,
  } as AgentEvent
}

function setup() {
  const mutations: Record<string, unknown>[] = []
  const convex = {
    mutation: async (_reference: unknown, args: Record<string, unknown>) => {
      mutations.push(args)
      return 'record-id'
    },
  } as unknown as ConvexClient
  return { projector: new ConvexProjector(convex, 'client-1'), mutations }
}

describe('ConvexProjector streaming contracts', () => {
  it('persists one canonical user message when ACP echoes the prompt', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Hello', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'stream',
        event: 'user_message_chunk',
        data: { messageId: 'provider-user-1', content: { type: 'text', text: 'Hello' } },
      }),
    )
    projector.consume(
      event(3, {
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    )
    projector.consume(
      event(4, {
        category: 'stream',
        event: 'user_message_chunk',
        data: { messageId: 'late-provider-echo', content: { type: 'text', text: 'Hello' } },
      }),
    )
    await projector.waitForThread(base.threadId)

    const userWrites = mutations.filter((args) => args.role === 'user')
    expect(userWrites).toHaveLength(1)
    expect(userWrites[0]).toMatchObject({ externalId: 'user-1', content: 'Hello' })
  })

  it('starts remote chunks at zero and does not persist every text token', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Hello', userMessageId: 'user-1' },
      }),
    )
    for (const [index, text] of ['One', ' two', ' three', '.'].entries()) {
      projector.consume(
        event(index + 2, {
          category: 'stream',
          event: 'agent_message_chunk',
          data: { content: { type: 'text', text } },
        }),
      )
    }
    await projector.waitForThread(base.threadId)

    const chunks = mutations.filter((args) => typeof args.chunkIndex === 'number')
    expect(chunks.length).toBeLessThan(4)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1])
    expect(chunks[1]).toMatchObject({ chunkText: 'One two three.' })
  })

  it('finalizes reasoning and unfinished tools at prompt completion', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Inspect', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'stream',
        event: 'agent_thought_chunk',
        data: { content: { type: 'text', text: 'Thinking' } },
      }),
    )
    projector.consume(
      event(3, {
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'tool-1', title: 'Read', status: 'in_progress' },
      }),
    )
    projector.consume(
      event(4, {
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    )
    await projector.waitForThread(base.threadId)

    const finalized = [...mutations]
      .reverse()
      .find((args) => args.externalId === base.messageId && args.role === 'assistant')
    const parts = finalized?.parts as Array<Record<string, unknown>>
    expect((parts.find((part) => part.type === 'reasoning')?.time as { end?: number }).end).toEqual(
      expect.any(Number),
    )
    const toolState = parts.find((part) => part.type === 'tool')?.state as
      Record<string, unknown> | undefined
    expect(toolState?.status).toBe('completed')
  })
})
