import type { AgentEvent } from '@agentpack/contract'
import { AgentRuntime, type BackendEvent } from '@agentpack/runtime'
import { foldAgentEvents } from '@agentpack/view'
import { describe, expect, it } from 'vitest'
import { StreamingMessagesStore } from './active-session-provider'

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
      data: { prompt: 'Inspect the project' },
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
      data: { prompt: 'Second turn' },
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
})
