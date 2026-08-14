import type { AgentEvent } from '@agentpack/contract'
import type { ConvexClient } from 'convex/browser'
import { describe, expect, it, vi } from 'vitest'
import {
  reconstructSnapshot,
  type StreamChunk,
} from '@openmanager/shared/lib/stream-reconstruction'
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
  it('uploads Cursor generated images and appends a durable assistant image part', async () => {
    const mutations: Record<string, unknown>[] = []
    const convex = {
      mutation: async (_reference: unknown, args: Record<string, unknown>) => {
        mutations.push(args)
        if (Object.keys(args).length === 1 && args.clientId === 'client-1') {
          return 'https://upload.example.test/generated'
        }
        if (args.storageId === 'storage-1') return 'attachment-1'
        return 'record-id'
      },
    } as unknown as ConvexClient
    const upload = vi.fn(
      async () =>
        new Response(JSON.stringify({ storageId: 'storage-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    )
    const projector = new ConvexProjector(convex, 'client-1', {
      readGeneratedImage: async () => ({
        bytes: Buffer.from('png bytes'),
        name: 'generated.png',
        mimeType: 'image/png',
        size: 9,
      }),
      fetch: upload as typeof fetch,
    })

    projector.consume(
      event(1, {
        providerId: 'cursor',
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Generate it', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        providerId: 'cursor',
        category: 'tool',
        event: 'tool_call',
        data: {
          toolCallId: 'image-tool-1',
          title: 'Generate Image',
          status: 'in_progress',
        },
      }),
    )
    projector.consume(
      event(3, {
        providerId: 'cursor',
        category: 'extension',
        event: 'extension_request',
        data: {
          requestId: 'request-1',
          method: 'cursor/generate_image',
          params: {
            toolCallId: 'image-tool-1',
            description: 'A generated test image',
            filePath: 'C:/fake/generated.png',
            referenceImagePaths: [],
          },
        },
      }),
    )
    await projector.waitForThread(base.threadId)

    expect(upload).toHaveBeenCalledWith(
      'https://upload.example.test/generated',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(mutations).toContainEqual(
      expect.objectContaining({
        storageId: 'storage-1',
      }),
    )
    expect(mutations).toContainEqual(
      expect.objectContaining({
        ids: ['attachment-1'],
        messageExternalId: 'assistant-1',
      }),
    )
    expect(mutations).toContainEqual(
      expect.objectContaining({
        partUpdate: {
          kind: 'part.updated',
          part: expect.objectContaining({
            type: 'image',
            attachmentId: 'attachment-1',
            generated: true,
          }),
        },
      }),
    )
  })

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

  it('persists enough mid-turn for a reconnecting client to rebuild everything', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Go', userMessageId: 'user-1' },
      }),
    )
    // Coalescing skips most of these; closing the run has to flush the rest,
    // or a snapshot rebuilt from chunks silently loses ' beta gamma'.
    for (const [index, text] of ['alpha', ' beta', ' gamma'].entries()) {
      projector.consume(
        event(index + 2, {
          category: 'stream',
          event: 'agent_message_chunk',
          data: { content: { type: 'text', text } },
        }),
      )
    }
    projector.consume(
      event(5, {
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'tool-1', title: 'Read', status: 'in_progress' },
      }),
    )
    projector.consume(
      event(6, {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: ' done.' } },
      }),
    )
    await projector.waitForThread(base.threadId)

    const chunks = mutations.filter((args) => 'chunkIndex' in args) as unknown as StreamChunk[]
    const snapshot = reconstructSnapshot(chunks)
    const parts = snapshot.parts ?? []
    expect(
      parts
        .filter((part) => part.type === 'text')
        .map((part) => String(part.text ?? ''))
        .join(''),
    ).toBe('alpha beta gamma done.')
    expect(parts.find((part) => part.type === 'tool')).toMatchObject({ tool: 'Read' })
    // Every event is now represented, so the snapshot covers the whole stream.
    expect(snapshot.throughSeq).toBe(6)
  })

  it('keys text parts by the event that opened the run, not by part position', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Go', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'tool-1', title: 'Read', status: 'completed' },
      }),
    )
    projector.consume(
      event(3, {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'after the tool.' } },
      }),
    )
    await projector.waitForThread(base.threadId)

    const textChunk = mutations.find(
      (args) =>
        (args.partUpdate as { part?: { type?: string } } | undefined)?.part?.type === 'text',
    )
    expect((textChunk?.partUpdate as { part: { id: string } }).part.id).toBe(
      'assistant-1_text_event-3',
    )
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

  it('ignores session/load replay until a real prompt establishes the active turn', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        messageId: undefined,
        category: 'stream',
        event: 'agent_thought_chunk',
        data: { phase: 'delta', content: { type: 'text', text: 'Old reasoning' } },
      }),
    )
    projector.consume(
      event(2, {
        messageId: undefined,
        category: 'tool',
        event: 'tool_call',
        data: {
          toolCallId: 'replay-0-2',
          title: 'Read old file',
          status: 'completed',
          rawOutput: { content: 'old' },
        },
      }),
    )
    projector.consume(
      event(3, {
        messageId: undefined,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'Old answer' } },
      }),
    )
    await projector.waitForThread(base.threadId)

    expect(mutations).toEqual([])

    projector.consume(
      event(4, {
        messageId: 'assistant-real',
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'New prompt', userMessageId: 'user-real' },
      }),
    )
    projector.consume(
      event(5, {
        messageId: 'assistant-real',
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'tool-real', title: 'Read new file', status: 'completed' },
      }),
    )
    projector.consume(
      event(6, {
        messageId: 'assistant-real',
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    )
    await projector.waitForThread(base.threadId)

    const finalized = [...mutations]
      .reverse()
      .find((args) => args.externalId === 'assistant-real' && args.role === 'assistant')
    expect(finalized?.parts).toEqual([expect.objectContaining({ type: 'tool', id: 'tool-real' })])
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
        data: { phase: 'delta', content: { type: 'text', text: 'Thinking' } },
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
    expect(finalized?.runtimeMetadata).toMatchObject({
      startedAt: 1,
      completedAt: 4,
      finishReason: 'end_turn',
    })
  })

  it('persists a textless reasoning block from its phases and token estimate', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Think', userMessageId: 'user-1' },
      }),
    )
    // Claude Code's thinking blocks: empty text throughout, a monotonic token
    // estimate, and start/stop framing as the only other signal.
    projector.consume(
      event(2, { category: 'stream', event: 'agent_thought_chunk', data: { phase: 'start' } }),
    )
    projector.consume(
      event(3, {
        category: 'stream',
        event: 'agent_thought_chunk',
        data: { phase: 'delta', content: { type: 'text', text: '' }, tokens: 0 },
      }),
    )
    projector.consume(
      event(4, {
        category: 'stream',
        event: 'agent_thought_chunk',
        data: { phase: 'delta', tokens: 150 },
      }),
    )
    // A duplicated/late delta must not inflate a cumulative counter.
    projector.consume(
      event(5, {
        category: 'stream',
        event: 'agent_thought_chunk',
        data: { phase: 'delta', tokens: 150 },
      }),
    )
    projector.consume(
      event(6, { category: 'stream', event: 'agent_thought_chunk', data: { phase: 'stop' } }),
    )
    projector.consume(
      event(7, {
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    )
    await projector.waitForThread(base.threadId)

    const finalized = [...mutations]
      .reverse()
      .find((args) => args.externalId === base.messageId && args.role === 'assistant')
    const reasoning = (finalized?.parts as Array<Record<string, unknown>>).find(
      (part) => part.type === 'reasoning',
    )
    expect(reasoning).toMatchObject({ text: '', tokens: 150 })
    const time = reasoning?.time as { start: number; end?: number }
    expect(time.start).toEqual(expect.any(Number))
    // `stop` is the only thing that can close a block with no text in it.
    expect(time.end).toEqual(expect.any(Number))
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
        category: 'session',
        event: 'plan_review_resolved',
        data: {
          requestId: 'plan-1',
          outcome: { outcome: 'rejected', reason: '  Add rollback tests.  ' },
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

  it('clears a question row on its own settlement, not on an extension one', async () => {
    const { projector, mutations } = setup()
    // Regression: questions and plans used to be cleared off extension_resolved,
    // which never fires for a provider that raises them off-wire.
    projector.consume(
      event(1, {
        category: 'extension',
        event: 'extension_resolved',
        data: {
          requestId: 'question-1',
          method: 'cursor/ask_question',
          outcome: { outcome: 'responded', response: {} },
        },
      }),
    )
    await projector.waitForThread(base.threadId)
    expect(mutations).toEqual([])

    projector.consume(
      event(2, {
        category: 'session',
        event: 'question_resolved',
        data: { requestId: 'question-1', outcome: { outcome: 'cancelled', reason: 'timeout' } },
      }),
    )
    await projector.waitForThread(base.threadId)
    expect(mutations).toContainEqual({ requestId: 'question-1' })
  })

  /** A Claude Code `api_retry` reaches the projector as an `rpc_error` with
   * `recoverable: true`. Finalizing the turn on it closed the assistant
   * message for good: `finalizeTurn` deletes the thread's `ActiveTurn`, so
   * every part the successful retry then produced was written against a turn
   * that no longer existed and never reached `messages.metadata.parts`. The
   * truncation was permanent, unlike the live one. */
  it('does not finalize a turn on a recoverable error', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Go', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'partial ' } },
      }),
    )
    projector.consume(
      event(3, {
        category: 'error',
        event: 'rpc_error',
        data: { source: 'claude/api', message: 'Retrying after Overloaded', recoverable: true },
      }),
    )
    projector.consume(
      event(4, {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'and the rest' } },
      }),
    )
    projector.consume(event(5, { category: 'lifecycle', event: 'prompt_completed', data: {} }))
    await projector.waitForThread(base.threadId)

    // The persisted turn, not the live stream: this is `messages.metadata.parts`,
    // where the truncation used to be permanent.
    expect(mutations.filter((args) => 'parts' in args).at(-1)).toMatchObject({
      externalId: 'assistant-1',
      content: 'partial and the rest',
    })
  })

  it('finalizes an errored turn when no workspace path is available', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        workspaceId: undefined,
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Go', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        workspaceId: undefined,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'partial' } },
      }),
    )
    projector.consume(
      event(3, {
        workspaceId: undefined,
        category: 'error',
        event: 'rpc_error',
        data: { source: 'session/prompt', message: 'the runtime stopped' },
      }),
    )
    await projector.waitForThread(base.threadId)

    expect(mutations).toContainEqual(
      expect.objectContaining({
        externalId: base.messageId,
        runtimeMetadata: expect.objectContaining({
          startedAt: 1,
          completedAt: 3,
          finishReason: 'error',
        }),
      }),
    )
    expect(mutations).not.toContainEqual(expect.objectContaining({ status: 'error' }))
  })

  /** The negative case: an error with no `recoverable` flag is still terminal,
   * which is the behaviour every ACP provider depends on. */
  it('still finalizes a turn on an ordinary rpc_error', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Go', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'partial ' } },
      }),
    )
    projector.consume(
      event(3, {
        category: 'error',
        event: 'rpc_error',
        data: { source: 'session/prompt', message: 'the agent gave up' },
      }),
    )
    await projector.waitForThread(base.threadId)

    expect(mutations).toContainEqual(expect.objectContaining({ status: 'error' }))
    expect(mutations).toContainEqual(
      expect.objectContaining({
        externalId: base.messageId,
        runtimeMetadata: expect.objectContaining({
          startedAt: 1,
          completedAt: 3,
          finishReason: 'error',
        }),
      }),
    )
  })

  it('marks the session waiting on permission/question and done when the turn ends', async () => {
    const { projector, mutations } = setup()
    projector.consume(
      event(1, {
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Do the thing', userMessageId: 'user-1' },
      }),
    )
    projector.consume(
      event(2, {
        category: 'permission',
        event: 'permission_request',
        data: {
          requestId: 'perm-1',
          sessionId: base.sessionId,
          toolCall: { toolCallId: 'tool-1', title: 'Write', kind: 'edit' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      }),
    )
    await projector.waitForThread(base.threadId)
    expect(mutations).toContainEqual(
      expect.objectContaining({ externalId: base.sessionId, status: 'waiting' }),
    )

    projector.consume(
      event(3, {
        category: 'permission',
        event: 'permission_resolved',
        data: { requestId: 'perm-1', outcome: { outcome: 'selected', optionId: 'allow' } },
      }),
    )
    await projector.waitForThread(base.threadId)
    expect(mutations).toContainEqual(
      expect.objectContaining({ externalId: base.sessionId, status: 'running' }),
    )

    projector.consume(
      event(4, {
        category: 'session',
        event: 'question_request',
        data: {
          requestId: 'q-1',
          sessionId: base.sessionId,
          title: 'Pick one',
          questions: [],
        },
      }),
    )
    await projector.waitForThread(base.threadId)
    expect(mutations).toContainEqual(
      expect.objectContaining({ externalId: base.sessionId, status: 'waiting' }),
    )

    projector.consume(
      event(5, {
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    )
    await projector.waitForThread(base.threadId)
    expect(mutations).toContainEqual(
      expect.objectContaining({ externalId: base.sessionId, status: 'done' }),
    )
  })
})
