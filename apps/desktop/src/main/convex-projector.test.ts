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
  it('syncs only titled provider sessions through the metadata mutation', async () => {
    const { projector, mutations } = setup()

    await projector.syncProviderSessionTitles('C:/workspace', 'cursor', [
      {
        sessionId: 'session-1',
        cwd: 'C:/workspace',
        title: ' Cursor title ',
        updatedAt: '2026-07-19T14:32:22.082Z',
      },
      { sessionId: 'session-2', cwd: 'C:/workspace' },
      { sessionId: 'session-3', cwd: 'C:/workspace', title: '  ' },
    ])

    expect(mutations).toContainEqual({
      workspacePath: 'C:/workspace',
      providerId: 'cursor',
      sessions: [{ externalId: 'session-1', title: 'Cursor title' }],
    })
  })

  it('marks first-prompt titles as fallbacks and provider titles as authoritative', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'First prompt', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        providerId: 'cursor',
        category: 'session',
        event: 'session_info_update',
        data: { title: 'Provider title', updatedAt: null },
      }),
    )
    await projector.waitForThread(base.threadId)

    expect(mutations).toContainEqual(
      expect.objectContaining({
        externalId: 'session-1',
        title: 'First prompt',
        source: 'fallback',
      }),
    )
    expect(mutations).toContainEqual(
      expect.objectContaining({
        externalId: 'session-1',
        title: 'Provider title',
        source: 'provider',
      }),
    )
  })

  it('persists the provider with a session so it survives an app restart', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        providerId: 'cursor',
        category: 'lifecycle',
        event: 'session_created',
        data: {},
      }),
    )
    await projector.waitForThread(base.threadId)

    expect(mutations).toContainEqual(
      expect.objectContaining({
        externalId: base.sessionId,
        providerId: 'cursor',
        status: 'idle',
      }),
    )
  })

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

  it('persists image references with the canonical user message', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: {
          prompt: '',
          userMessageId: 'user-image-1',
          attachments: [
            {
              id: 'attachment-1',
              name: 'icon.png',
              mimeType: 'image/png',
              size: 1129,
            },
          ],
        },
      }),
    )
    await projector.waitForThread(base.threadId)

    const userWrite = mutations.find((args) => args.externalId === 'user-image-1')
    expect(userWrite).toMatchObject({
      content: '',
      parts: [
        expect.objectContaining({
          type: 'image',
          attachmentId: 'attachment-1',
          name: 'icon.png',
        }),
      ],
    })
    expect(mutations).toContainEqual(
      expect.objectContaining({
        ids: ['attachment-1'],
        clientId: 'client-1',
        messageExternalId: 'user-image-1',
      }),
    )
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

  it('settles Cursor subtasks from the provider turn result when cancel has no task terminal', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        providerId: 'cursor',
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Delegate', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        providerId: 'cursor',
        category: 'session',
        event: 'subtask_update',
        data: {
          taskId: 'task-1',
          status: 'running',
          statusSource: 'task_event',
        },
      }),
    )
    projector.consume(
      event(3, {
        providerId: 'cursor',
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'cancelled' },
      }),
    )
    await projector.waitForThread(base.threadId)

    const finalized = [...mutations]
      .reverse()
      .find((args) => args.externalId === base.messageId && args.role === 'assistant')
    expect((finalized?.parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'subtask',
      status: 'cancelled',
      statusSource: 'turn_result',
      statusReason: 'cancelled',
    })
  })

  it('keeps Cursor completion authoritative when cursor/task enrichment arrives afterward', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        providerId: 'cursor',
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Delegate', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        providerId: 'cursor',
        category: 'session',
        event: 'subtask_update',
        data: {
          taskId: 'task-1',
          status: 'completed',
          statusSource: 'task_event',
          durationMs: 7420,
        },
      }),
    )
    projector.consume(
      event(3, {
        providerId: 'cursor',
        category: 'session',
        event: 'subtask_update',
        data: {
          taskId: 'task-1',
          description: 'Read package.json name',
          modelId: 'composer-2.5',
        },
      }),
    )
    projector.consume(
      event(4, {
        providerId: 'cursor',
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    )
    await projector.waitForThread(base.threadId)

    const finalized = [...mutations]
      .reverse()
      .find((args) => args.externalId === base.messageId && args.role === 'assistant')
    expect((finalized?.parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'subtask',
      status: 'completed',
      statusSource: 'task_event',
      description: 'Read package.json name',
      modelId: 'composer-2.5',
      durationMs: 7420,
    })
  })

  it('preserves OpenCode interrupted task status when the parent turn is cancelled', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Delegate', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'session',
        event: 'subtask_update',
        data: {
          taskId: 'task-1',
          status: 'interrupted',
          statusSource: 'task_event',
          statusReason: 'Tool execution aborted',
        },
      }),
    )
    projector.consume(
      event(3, {
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'cancelled' },
      }),
    )
    await projector.waitForThread(base.threadId)

    const finalized = [...mutations]
      .reverse()
      .find((args) => args.externalId === base.messageId && args.role === 'assistant')
    expect((finalized?.parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'subtask',
      status: 'interrupted',
      statusSource: 'task_event',
      statusReason: 'Tool execution aborted',
    })
  })

  it('marks a missing successful-turn subtask terminal as unknown', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Delegate', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'session',
        event: 'subtask_update',
        data: { taskId: 'task-1', status: 'running', statusSource: 'task_event' },
      }),
    )
    projector.consume(
      event(3, {
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    )
    await projector.waitForThread(base.threadId)

    const finalized = [...mutations]
      .reverse()
      .find((args) => args.externalId === base.messageId && args.role === 'assistant')
    expect((finalized?.parts as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'subtask',
      status: 'unknown',
      statusSource: 'turn_result',
      statusReason: 'end_turn',
    })
  })

  it('keeps requested plan changes with the rejected revision', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'extension',
        event: 'extension_resolved',
        data: {
          requestId: 'plan-1',
          method: 'cursor/create_plan',
          outcome: {
            outcome: 'responded',
            response: { outcome: { outcome: 'rejected', reason: '  Add rollback tests.  ' } },
          },
        },
      }),
    )
    await projector.waitForThread(base.threadId)

    expect(mutations).toContainEqual({
      requestId: 'plan-1',
      status: 'rejected',
      resolutionReason: 'Add rollback tests.',
    })
  })
})
