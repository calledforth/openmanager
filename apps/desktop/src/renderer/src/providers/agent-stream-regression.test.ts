import type { AgentEvent } from '@agentpack/contract'
import { AgentRuntime, type BackendEvent } from '@agentpack/runtime'
import { foldAgentEvents } from '@agentpack/view'
import { describe, expect, it, vi } from 'vitest'
import {
  mergePersistedAndOptimisticMessages,
  StreamingMessagesStore,
  type StreamHydrationSnapshot,
} from './active-session-provider'
import { shouldHydrateLocalStream, shouldUseRemoteStreaming } from '../lib/stream-continuity'

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
        data: { phase: 'delta', content: { type: 'text', text: 'Checking' } },
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

  it('opens, updates and closes a reasoning part that never carries any text', () => {
    const messageId = 'assistant-textless-thought'
    const store = new StreamingMessagesStore()
    const thought = (
      seq: number,
      data: Extract<AgentEvent, { event: 'agent_thought_chunk' }>['data'],
    ) => event({ messageId, seq, category: 'stream', event: 'agent_thought_chunk', data })

    // The block opens with nothing to show: no start would mean no shimmer for
    // the several seconds it runs.
    store.update(thought(1, { phase: 'start' }))
    expect(store.get(messageId)?.parts[0]).toMatchObject({ type: 'reasoning', text: '' })
    expect((store.get(messageId)?.parts[0]?.time as { start: number }).start).toEqual(
      expect.any(Number),
    )

    // `tokens: 0` is a real reading, so it must not be treated as absent.
    store.update(thought(2, { phase: 'delta', tokens: 0 }))
    expect(store.get(messageId)?.parts[0]?.tokens).toBe(0)

    store.update(thought(3, { phase: 'delta', tokens: 150 }))
    // estimated_tokens is cumulative: a repeat must not accumulate.
    store.update(thought(4, { phase: 'delta', tokens: 150 }))
    expect(store.get(messageId)?.parts[0]?.tokens).toBe(150)
    expect((store.get(messageId)?.parts[0]?.time as { end?: number }).end).toBeUndefined()

    store.update(thought(5, { phase: 'stop' }))
    expect((store.get(messageId)?.parts[0]?.time as { end?: number }).end).toEqual(
      expect.any(Number),
    )

    // A second block after the first one stopped is its own part.
    store.update(thought(6, { phase: 'start', tokens: 20 }))
    const parts = store.get(messageId)!.parts
    expect(parts).toHaveLength(2)
    expect(parts[1]?.tokens).toBe(20)
  })

  it('folds a textless reasoning run into one thinking row carrying its tokens', () => {
    const rows = foldAgentEvents(
      [
        event({
          seq: 1,
          category: 'stream',
          event: 'agent_thought_chunk',
          data: { phase: 'start' },
        }),
        event({
          seq: 2,
          category: 'stream',
          event: 'agent_thought_chunk',
          data: { phase: 'delta', tokens: 150 },
        }),
        event({
          seq: 3,
          category: 'stream',
          event: 'agent_thought_chunk',
          data: { phase: 'stop' },
        }),
      ],
      { summarizeWork: false },
    )

    expect(rows).toEqual([{ type: 'thinking', id: expect.any(String), text: '', tokens: 150 }])
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

  it('retains and updates a streaming session while another session is selected', () => {
    const store = new StreamingMessagesStore()
    const sessionA = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      messageId: 'assistant-a',
    }
    const sessionB = {
      sessionId: 'session-b',
      threadId: 'thread-b',
      messageId: 'assistant-b',
    }

    store.update(
      event({
        ...sessionA,
        id: 'a-start',
        seq: 1,
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'A', userMessageId: 'user-a' },
      }),
    )
    store.update(
      event({
        ...sessionA,
        id: 'a-first',
        seq: 2,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'before navigation ' } },
      }),
    )
    store.update(
      event({
        ...sessionB,
        id: 'b-start',
        seq: 1,
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'B', userMessageId: 'user-b' },
      }),
    )
    store.update(
      event({
        ...sessionA,
        id: 'a-second',
        seq: 3,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'after navigation' } },
      }),
    )

    expect(store.get('assistant-a')?.content).toBe('before navigation after navigation')
    expect(store.get('assistant-b')).toBeDefined()
  })

  it('stays authoritative across unrelated AgentEvent sequence gaps', () => {
    // The renderer is sent a filtered subset of the stream (no permission,
    // usage or session-info events), so a turn watched from the very start
    // still skips sequence numbers. That must never be read as missing history.
    const store = new StreamingMessagesStore()
    store.setSnapshotSource(async () => {
      throw new Error('hydration must not be attempted here')
    })
    store.update(
      event({
        id: 'gap-start',
        messageId: 'assistant-gap',
        seq: 5,
        category: 'lifecycle',
        event: 'prompt_started',
        data: { prompt: 'Start', userMessageId: 'user-gap' },
      }),
    )
    store.update(
      event({
        id: 'gap-tail',
        messageId: 'assistant-gap',
        seq: 8,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'tail' } },
      }),
    )

    expect(store.get('assistant-gap')?.content).toBe('tail')
    expect(store.get('assistant-gap')?.hasCompleteHistory).toBe(true)
  })

  it('rebuilds a reloaded turn from the Convex snapshot and resumes over IPC', async () => {
    const messageId = 'assistant-reload'
    const store = new StreamingMessagesStore()
    let resolveSnapshot: (value: StreamHydrationSnapshot | null) => void = () => {}
    store.setSnapshotSource(
      () =>
        new Promise<StreamHydrationSnapshot | null>((resolve) => {
          resolveSnapshot = resolve
        }),
    )

    // A reloaded renderer never sees prompt_started; the first thing it gets is
    // whatever the turn happens to be doing right now.
    store.update(
      event({
        id: 'covered',
        messageId,
        seq: 12,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'before reload. ' } },
      }),
    )
    store.update(
      event({
        id: 'fresh',
        messageId,
        seq: 13,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'after reload' } },
      }),
    )
    // Nothing is rendered from a half-turn: the live tail waits for the snapshot.
    expect(store.get(messageId)).toBeUndefined()

    resolveSnapshot({
      parts: [
        { type: 'reasoning', id: `${messageId}_reasoning_e1`, text: 'thinking' },
        {
          type: 'tool',
          id: 'tool-1',
          callID: 'tool-1',
          tool: 'Read',
          state: { status: 'completed', input: { path: 'a.ts' } },
        },
        { type: 'text', id: `${messageId}_text_e2`, text: 'before reload. ' },
      ],
      throughSeq: 12,
    })
    await vi.waitFor(() =>
      expect(store.get(messageId)?.content).toBe('before reload. after reload'),
    )

    const snapshot = store.get(messageId)!
    expect(snapshot.hasCompleteHistory).toBe(true)
    // The seq-12 event was already in the snapshot, so it is dropped rather
    // than replayed into a second, duplicate text part.
    expect(snapshot.parts.map((part) => part.type)).toEqual(['reasoning', 'tool', 'text', 'text'])
    expect(snapshot.parts[1]).toMatchObject({
      tool: 'Read',
      state: { status: 'completed', input: { path: 'a.ts' } },
    })
  })

  it('replays a thin live tool update onto the richer hydrated part', async () => {
    const messageId = 'assistant-merge'
    const store = new StreamingMessagesStore()
    let resolveSnapshot: (value: StreamHydrationSnapshot | null) => void = () => {}
    store.setSnapshotSource(
      () =>
        new Promise<StreamHydrationSnapshot | null>((resolve) => {
          resolveSnapshot = resolve
        }),
    )

    store.update(
      event({
        id: 'thin-update',
        messageId,
        seq: 20,
        category: 'tool',
        event: 'tool_call_update',
        data: { toolCallId: 'tool-1', status: 'completed' },
      }),
    )
    resolveSnapshot({
      parts: [
        {
          type: 'tool',
          id: 'tool-1',
          callID: 'tool-1',
          tool: 'Read',
          state: { status: 'running', input: { path: 'a.ts' } },
        },
      ],
      throughSeq: 19,
    })
    await vi.waitFor(() =>
      expect((store.get(messageId)?.parts[0]?.state as { status?: string })?.status).toBe(
        'completed',
      ),
    )

    expect(store.get(messageId)?.parts[0]).toMatchObject({
      tool: 'Read',
      state: { status: 'completed', input: { path: 'a.ts' } },
    })
  })

  it('restores a turn that stopped emitting events when the app was restarted', async () => {
    const store = new StreamingMessagesStore()
    store.setSnapshotSource(async () => ({
      parts: [{ type: 'text', id: 'orphan-text', text: 'the turn nobody finalized' }],
      throughSeq: 40,
    }))

    // No live event will ever arrive for this message, so the view layer has to
    // be the one that asks.
    store.ensureHydrated('assistant-orphan')
    await vi.waitFor(() =>
      expect(store.get('assistant-orphan')?.content).toBe('the turn nobody finalized'),
    )
  })

  it('falls back to the live tail when the snapshot cannot be fetched', async () => {
    const store = new StreamingMessagesStore()
    store.setSnapshotSource(async () => {
      throw new Error('offline')
    })
    store.update(
      event({
        id: 'tail-only',
        messageId: 'assistant-offline',
        seq: 4,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'tail only' } },
      }),
    )

    await vi.waitFor(() => expect(store.get('assistant-offline')?.content).toBe('tail only'))
  })

  it('replays the whole tail when the snapshot carries no sequence to join on', async () => {
    const messageId = 'assistant-legacy'
    const store = new StreamingMessagesStore()
    store.setSnapshotSource(async () => ({
      parts: [{ type: 'text', id: 'legacy-text', text: 'persisted. ' }],
    }))
    store.update(
      event({
        id: 'legacy-tail',
        messageId,
        seq: 9,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'live' } },
      }),
    )

    await vi.waitFor(() => expect(store.get(messageId)?.content).toBe('persisted. live'))
  })

  it('routes live streaming by session ownership and backfills the driven side', () => {
    expect(shouldUseRemoteStreaming('assistant', false, true)).toBe(false)
    expect(shouldUseRemoteStreaming('assistant', false, false)).toBe(true)
    expect(shouldUseRemoteStreaming('assistant', true, false)).toBe(false)
    expect(shouldUseRemoteStreaming('user', false, false)).toBe(false)

    expect(shouldHydrateLocalStream('assistant', false, true)).toBe(true)
    expect(shouldHydrateLocalStream('assistant', true, true)).toBe(false)
    expect(shouldHydrateLocalStream('assistant', false, false)).toBe(false)
    expect(shouldHydrateLocalStream('user', false, true)).toBe(false)
  })

  it('evicts the least-recently-updated streaming snapshot at the configured bound', () => {
    const store = new StreamingMessagesStore(2)
    for (const [index, messageId] of ['assistant-a', 'assistant-b'].entries()) {
      store.update(
        event({
          id: `event-${messageId}`,
          threadId: `thread-${messageId}`,
          messageId,
          seq: index + 1,
          category: 'stream',
          event: 'agent_message_chunk',
          data: { content: { type: 'text', text: messageId } },
        }),
      )
    }
    store.update(
      event({
        id: 'event-assistant-a-again',
        threadId: 'thread-assistant-a',
        messageId: 'assistant-a',
        seq: 3,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: '-again' } },
      }),
    )
    store.update(
      event({
        id: 'event-assistant-c',
        threadId: 'thread-assistant-c',
        messageId: 'assistant-c',
        seq: 4,
        category: 'stream',
        event: 'agent_message_chunk',
        data: { content: { type: 'text', text: 'assistant-c' } },
      }),
    )

    expect(store.get('assistant-a')?.content).toBe('assistant-a-again')
    expect(store.get('assistant-b')).toBeUndefined()
    expect(store.get('assistant-c')?.content).toBe('assistant-c')
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

  /** The live half of the same truncation. `StreamingMessagesStore` closed the
   * running text part and failed every running tool row on any error, so a
   * Claude Code `api_retry` — which is a retry notice, not a failure — split
   * the answer in two and painted the tools red while the retry was still
   * working. */
  it('does not close the live message on a recoverable error', () => {
    const store = new StreamingMessagesStore()
    const messageId = 'agent_asst_retry'
    const live = (
      patch: Partial<AgentEvent> & Pick<AgentEvent, 'category' | 'event' | 'data'>,
    ): void => store.update(event({ ...patch, messageId }) as AgentEvent)

    live({
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'Go', userMessageId: 'user-1' },
    })
    live({
      category: 'tool',
      event: 'tool_call',
      data: { toolCallId: 'tool-1', title: 'Read', status: 'in_progress' },
    })
    live({
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: 'partial ' } },
    })
    live({
      category: 'error',
      event: 'rpc_error',
      data: { source: 'claude/api', message: 'Retrying after Overloaded', recoverable: true },
    })
    live({
      category: 'stream',
      event: 'agent_message_chunk',
      data: { content: { type: 'text', text: 'and the rest' } },
    })

    const message = store.get(messageId)
    // One part, not two: the retry did not close the run the text was landing in.
    expect(message?.parts.filter((part) => part.type === 'text')).toEqual([
      expect.objectContaining({ text: 'partial and the rest' }),
    ])
    expect(message?.parts.find((part) => part.type === 'tool')).toMatchObject({
      state: expect.objectContaining({ status: 'running' }),
    })
  })

  /** The negative case: an error carrying no `recoverable` flag still ends the
   * live turn, which is what every ACP provider relies on. */
  it('still closes the live message on an ordinary rpc_error', () => {
    const store = new StreamingMessagesStore()
    const messageId = 'agent_asst_failed'
    const live = (
      patch: Partial<AgentEvent> & Pick<AgentEvent, 'category' | 'event' | 'data'>,
    ): void => store.update(event({ ...patch, messageId }) as AgentEvent)

    live({
      category: 'lifecycle',
      event: 'prompt_started',
      data: { prompt: 'Go', userMessageId: 'user-1' },
    })
    live({
      category: 'tool',
      event: 'tool_call',
      data: { toolCallId: 'tool-1', title: 'Read', status: 'in_progress' },
    })
    live({
      category: 'error',
      event: 'rpc_error',
      data: { source: 'session/prompt', message: 'the agent gave up' },
    })

    expect(store.get(messageId)?.parts.find((part) => part.type === 'tool')).toMatchObject({
      state: expect.objectContaining({ status: 'error' }),
    })
  })
})
