import type { AgentEvent } from '@agentpack/contract'
import { AgentRuntime, type BackendEvent } from '@agentpack/runtime'
import { foldAgentEvents } from '@agentpack/view'
import { describe, expect, it } from 'vitest'
import {
  mergePersistedAndOptimisticMessages,
  StreamingMessagesStore,
} from './active-session-provider'

const base = {
  threadId: 'thread-1',
  workspaceId: 'C:/workspace',
  sessionId: 'session-1',
} as const

function event(
  patch: Partial<AgentEvent> & Pick<AgentEvent, 'category' | 'event' | 'data'>,
): AgentEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    seq: 1,
    providerId: 'opencode',
    ...base,
    ...patch,
  } as AgentEvent
}

describe('agent streaming regressions', () => {
  it('uses one host-owned message ID for token and tool-first turns', () => {
    const emitted: AgentEvent[] = []
    const runtime = new AgentRuntime({ emitEvent: (value) => emitted.push(value), log: () => {} })
    const forward = (
      runtime as unknown as {
        forward: (providerId: 'opencode', value: BackendEvent) => void
      }
    ).forward.bind(runtime)

    forward('opencode', {
      ...base,
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'Inspect the project', userMessageId: 'user-1' },
    })
    forward('opencode', {
      ...base,
      category: 'tool',
      event: 'tool_call',
      data: { toolCallId: 'tool-1', title: 'Read', status: 'pending' },
    })
    forward('opencode', {
      ...base,
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: 'Done' } },
    })

    expect(emitted[0]?.messageId).toMatch(/^agent_asst_/)
    expect(emitted.map((value) => value.messageId)).toEqual([
      emitted[0]?.messageId,
      emitted[0]?.messageId,
      emitted[0]?.messageId,
    ])

    const store = new StreamingMessagesStore()
    store.update(emitted[1]!)
    store.update(emitted[2]!)
    expect(store.get(emitted[0]!.messageId!)).toMatchObject({ content: 'Done' })
    expect(store.get(emitted[0]!.messageId!)?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool', callID: 'tool-1' })]),
    )

    forward('opencode', {
      ...base,
      category: 'lifecycle',
      event: 'prompt_completed',
      data: {},
    })
    forward('opencode', {
      ...base,
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'Second turn', userMessageId: 'user-2' },
    })
    forward('opencode', {
      ...base,
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: 'Second response' } },
    })
    const secondMessageId = emitted.at(-1)!.messageId!
    expect(secondMessageId).not.toBe(emitted[0]!.messageId)
    store.update(emitted.at(-1)!)
    expect(store.get(secondMessageId)).toMatchObject({ content: 'Second response' })

    runtime.dispose()
  })

  it('does not downgrade a completed tool or erase input with sparse updates', () => {
    const events = [
      event({
        category: 'tool',
        event: 'tool_call',
        data: {
          toolCallId: 'tool-1',
          title: 'Read',
          status: 'pending',
          rawInput: { path: 'README.md' },
        },
      }),
      event({
        seq: 2,
        category: 'tool',
        event: 'tool_call_update',
        data: { toolCallId: 'tool-1', status: 'completed', rawOutput: 'contents' },
      }),
      event({
        seq: 3,
        category: 'tool',
        event: 'tool_call_update',
        data: { toolCallId: 'tool-1', status: 'pending' },
      }),
    ]

    const tool = foldAgentEvents(events, { summarizeWork: false }).find(
      (row) => row.type === 'tool',
    )
    expect(tool).toMatchObject({
      type: 'tool',
      status: 'completed',
      rawInput: { path: 'README.md' },
      rawOutput: 'contents',
    })
  })

  it('keeps embedded tool content singular', () => {
    const item = { type: 'content', content: { type: 'text', text: 'result' } } as const
    const tool = foldAgentEvents(
      [
        event({
          category: 'tool',
          event: 'tool_call_update',
          data: { toolCallId: 'tool-1', status: 'completed', content: [item] },
        }),
      ],
      { summarizeWork: false },
    ).find((row) => row.type === 'tool')

    expect(tool?.type === 'tool' ? tool.contentItems : []).toEqual([item])
  })

  it('reduces live chunks incrementally across tool boundaries and closes activity', () => {
    const messageId = 'assistant-1'
    const store = new StreamingMessagesStore()
    const updates = [
      event({
        messageId,
        seq: 1,
        category: 'stream',
        event: 'agent_thought_chunk',
        data: { content: { type: 'text', text: 'Checking' } },
      }),
      event({
        messageId,
        seq: 2,
        category: 'tool',
        event: 'tool_call',
        data: { toolCallId: 'tool-1', title: 'Read', status: 'in_progress' },
      }),
      event({
        messageId,
        seq: 3,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'First. ' } },
      }),
      event({
        messageId,
        seq: 4,
        category: 'tool',
        event: 'tool_call_update',
        data: { toolCallId: 'tool-1', status: 'completed' },
      }),
      event({
        messageId,
        seq: 5,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'Second.' } },
      }),
      event({
        messageId,
        seq: 6,
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'end_turn' },
      }),
    ]
    for (const update of updates) store.update(update)

    const snapshot = store.get(messageId)!
    expect(snapshot.content).toBe('First. Second.')
    expect(snapshot.parts.map((part) => part.type)).toEqual(['reasoning', 'tool', 'text', 'text'])
    expect((snapshot.parts[0]?.time as { end?: number }).end).toEqual(expect.any(Number))
    expect((snapshot.parts[1]?.state as { status?: string }).status).toBe('completed')
  })

  it('renders subtask updates live and settles Cursor cancellation from the turn result', () => {
    const messageId = 'assistant-subtask'
    const store = new StreamingMessagesStore()
    store.update(
      event({
        messageId,
        category: 'session',
        event: 'subtask_update',
        data: {
          taskId: 'task-1',
          status: 'running',
          statusSource: 'task_event',
          title: 'Inspect workspace',
        },
      }),
    )
    store.update(
      event({
        id: 'cancelled-turn',
        messageId,
        seq: 2,
        providerId: 'cursor',
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'cancelled' },
      }),
    )

    expect(store.get(messageId)?.parts[0]).toMatchObject({
      type: 'subtask',
      title: 'Inspect workspace',
      status: 'cancelled',
      statusSource: 'turn_result',
      statusReason: 'cancelled',
    })
  })

  it('does not overwrite an OpenCode interrupted task with parent cancellation fallback', () => {
    const messageId = 'assistant-interrupted-subtask'
    const store = new StreamingMessagesStore()
    store.update(
      event({
        messageId,
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
    store.update(
      event({
        id: 'cancelled-turn',
        messageId,
        seq: 2,
        category: 'lifecycle',
        event: 'prompt_completed',
        data: { stopReason: 'cancelled' },
      }),
    )

    expect(store.get(messageId)?.parts[0]).toMatchObject({
      status: 'interrupted',
      statusSource: 'task_event',
      statusReason: 'Tool execution aborted',
    })
  })

  it('ignores replayed events by host event identity', () => {
    const store = new StreamingMessagesStore()
    const chunk = event({
      id: 'stable-event',
      messageId: 'assistant-1',
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: 'once' } },
    })
    store.update(chunk)
    store.update(chunk)
    expect(store.get('assistant-1')?.content).toBe('once')
  })

  it('reconciles optimistic messages by canonical identity, not message counts', () => {
    const optimistic = [
      {
        externalId: 'user-local',
        role: 'user',
        isFinal: true,
        sequenceNum: 2,
        optimisticContent: 'mine',
        isOptimistic: true,
      },
    ]
    const unrelated = [{ externalId: 'user-remote', role: 'user', isFinal: true, sequenceNum: 1 }]
    expect(mergePersistedAndOptimisticMessages(unrelated, optimistic)).toHaveLength(2)
    expect(
      mergePersistedAndOptimisticMessages(
        [...unrelated, { externalId: 'user-local', role: 'user', isFinal: true, sequenceNum: 2 }],
        optimistic,
      ).map((message) => message.externalId),
    ).toEqual(['user-remote', 'user-local'])
  })
})
