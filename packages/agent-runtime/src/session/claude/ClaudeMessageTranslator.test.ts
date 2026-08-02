import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { claude } from '../../providers/claude.js'
import { ClaudeMessageTranslator } from './ClaudeMessageTranslator.js'

/** Drives the translator directly, without a process. Everything the runtime
 * does around it — turn binding, `prompt_completed`, `usage_update` — is
 * covered in `ClaudeSessionRuntime.test.ts`; this file is about the mapping. */
function build(options: { subtasks?: boolean } = {}) {
  const log = vi.fn()
  const translator = new ClaudeMessageTranslator({
    route: () => ({ threadId: 'thread-1', workspaceId: 'workspace-1' }),
    log,
    ...(options.subtasks && claude.subtasks ? { subtasks: claude.subtasks } : {}),
  })
  const events: BackendEvent[] = []
  const feed = (message: unknown) => {
    const translated = translator.translate(message as SDKMessage)
    events.push(...translated.events)
    return translated
  }
  return { translator, events, feed, log }
}

const stream = (event: Record<string, unknown>, parent: string | null = null) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: parent,
  uuid: 'uuid-1',
  session_id: 'session-1',
})

const toolStart = (index: number, id: string, name: string, type = 'tool_use') =>
  stream({ type: 'content_block_start', index, content_block: { type, id, name, input: {} } })
const toolInput = (index: number, partial_json: string) =>
  stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })

const named = (events: BackendEvent[]) => events.map((event) => event.event)
const dataOf = <T,>(events: BackendEvent[], name: string): T[] =>
  events.filter((event) => event.event === name).map((event) => event.data as T)

describe('ClaudeMessageTranslator thinking', () => {
  it('frames a thinking run without ever emitting its empty text', () => {
    const { events, feed } = build()
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'AAA' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'BBB' } }))
    feed(stream({ type: 'content_block_stop', index: 0 }))

    const chunks = dataOf<{ phase: string; tokens?: number; content?: unknown }>(
      events,
      'agent_thought_chunk',
    )
    expect(chunks.map((chunk) => chunk.phase)).toEqual(['start', 'delta', 'stop'])
    // The text is the empty string on every model, and the signature is an
    // encrypted blob. Emitting either renders a blank reasoning row.
    expect(chunks.every((chunk) => chunk.content === undefined)).toBe(true)
    expect(chunks[1]?.tokens).toBe(50)
  })

  it('never lets the token estimate walk backwards', () => {
    const { events, feed } = build()
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }))
    for (const estimated_tokens of [50, 100, 60])
      feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens } }))

    const tokens = dataOf<{ tokens?: number }>(events, 'agent_thought_chunk')
      .map((chunk) => chunk.tokens)
      .filter((value) => value !== undefined)
    // `estimated_tokens` is a running total, so a repeated or re-ordered frame
    // must not make the indicator count down.
    expect(tokens).toEqual([50, 100, 100])
  })

  it('reports a first reading of zero rather than swallowing it', () => {
    const { events, feed } = build()
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 0 } }))

    expect(dataOf<{ tokens?: number }>(events, 'agent_thought_chunk')[1]?.tokens).toBe(0)
  })
})

describe('ClaudeMessageTranslator tools', () => {
  it('opens a tool row on the block and completes it only on its result', () => {
    const { events, feed } = build()
    feed(toolStart(0, 'toolu_1', 'Read'))
    feed(toolInput(0, '{"file_path":'))
    // A truncated object is not "the input so far" — nothing may be emitted.
    expect(named(events)).toEqual(['tool_call'])

    feed(toolInput(0, '"C:/a.ts"}'))
    feed(stream({ type: 'content_block_stop', index: 0 }))
    // The stop means the ARGUMENTS are complete, never the tool.
    expect(named(events)).toEqual(['tool_call', 'tool_call_update'])
    expect(dataOf<{ status: string; rawInput: unknown }>(events, 'tool_call_update')[0]).toMatchObject({
      status: 'in_progress',
      rawInput: { file_path: 'C:/a.ts' },
    })

    feed({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })
    expect(dataOf<{ status: string }>(events, 'tool_call_update').at(-1)?.status).toBe('completed')
  })

  it('does not re-emit an input that has not changed', () => {
    const { events, feed } = build()
    feed(toolStart(0, 'toolu_1', 'Bash'))
    // Parses on the first fragment and stays parseable on the second, which is
    // exactly the case a naive "emit whenever it parses" gets wrong.
    feed(toolInput(0, '{"command":"ls"}'))
    feed(toolInput(0, ''))
    feed(toolInput(0, ''))

    expect(named(events).filter((name) => name === 'tool_call_update')).toHaveLength(1)
  })

  it('matches results to calls by tool_use_id, never by stream index', () => {
    const { events, feed } = build()
    feed(toolStart(0, 'toolu_read', 'Read'))
    feed(toolStart(1, 'toolu_bash', 'Bash'))
    // The second tool answers first; an index-based correlation would put this
    // output on the Read row.
    feed({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'done', is_error: true }],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })

    const update = dataOf<{ toolCallId: string; status: string }>(events, 'tool_call_update').at(-1)
    expect(update).toMatchObject({ toolCallId: 'toolu_bash', status: 'failed' })
  })

  it('treats server and MCP tool calls as ordinary tools', () => {
    const { events, feed } = build()
    feed(toolStart(0, 'toolu_a', 'WebSearch', 'server_tool_use'))
    feed(toolStart(1, 'mcp_a', 'mcp__github__list_issues', 'mcp_tool_use'))

    expect(dataOf<{ toolCallId: string; kind: string }>(events, 'tool_call')).toEqual([
      expect.objectContaining({ toolCallId: 'toolu_a', kind: 'fetch' }),
      expect.objectContaining({ toolCallId: 'mcp_a', kind: 'other' }),
    ])
  })

  it('publishes a TodoWrite input as a plan as well as a tool row', () => {
    const { events, feed } = build()
    feed(toolStart(0, 'toolu_todo', 'TodoWrite'))
    feed(
      toolInput(
        0,
        JSON.stringify({
          todos: [
            { content: 'First', status: 'completed', activeForm: 'Doing first' },
            { content: 'Second', status: 'in_progress', activeForm: 'Doing second' },
          ],
        }),
      ),
    )

    expect(named(events)).toEqual(['tool_call', 'tool_call_update', 'plan_update'])
    expect(dataOf<{ entries: unknown[] }>(events, 'plan_update')[0]?.entries).toEqual([
      { content: 'First', priority: 'medium', status: 'completed' },
      { content: 'Second', priority: 'medium', status: 'in_progress' },
    ])
  })

  it('keeps an edit diff instead of overwriting it with the result text', () => {
    const { events, feed } = build()
    feed(toolStart(0, 'toolu_edit', 'Edit'))
    feed(
      toolInput(
        0,
        JSON.stringify({ file_path: 'C:/a.ts', old_string: 'before', new_string: 'after' }),
      ),
    )
    feed({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'applied' }],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })

    const updates = dataOf<{ content?: unknown[] }>(events, 'tool_call_update')
    expect(updates[0]?.content).toEqual([
      { type: 'diff', path: 'C:/a.ts', oldText: 'before', newText: 'after' },
    ])
    // `content` is replaced wholesale downstream, so the completion must not
    // ship one — the diff would be lost.
    expect(updates[1]?.content).toBeUndefined()
  })

  it('routes a Task tool through the subtask adapter instead of a tool row', () => {
    const { events, feed } = build({ subtasks: true })
    feed(toolStart(0, 'toolu_task', 'Task'))
    feed(
      toolInput(
        0,
        JSON.stringify({ description: 'Find it', prompt: 'go', subagent_type: 'Explore' }),
      ),
    )
    feed({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'found' }],
      },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })

    // Every phase, including the result — which carries no title and would be
    // unidentifiable without the id the adapter already claimed.
    expect(named(events)).toEqual(['subtask_update', 'subtask_update', 'subtask_update'])
    expect(dataOf<Record<string, unknown>>(events, 'subtask_update')[1]).toMatchObject({
      taskId: 'toolu_task',
      description: 'Find it',
      subagentType: 'Explore',
    })
    expect(dataOf<{ status?: string }>(events, 'subtask_update').at(-1)?.status).toBe('completed')
  })
})

describe('ClaudeMessageTranslator assistant snapshots', () => {
  it('backfills only the text blocks that never streamed', () => {
    const { events, feed } = build()
    feed(stream({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'streamed' } }))
    feed(stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
    feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'streamed' },
          { type: 'text', text: 'never streamed' },
        ],
      },
      parent_tool_use_id: null,
      uuid: 'assistant-uuid',
      session_id: 'session-1',
    })

    const chunks = dataOf<{ messageId?: string; content: { text: string } }>(
      events,
      'agent_message_chunk',
    )
    // Re-emitting the streamed block would duplicate the paragraph on screen.
    expect(chunks.map((chunk) => chunk.content.text)).toEqual(['streamed', 'never streamed'])
    expect(chunks[1]?.messageId).toBe('assistant-uuid')
  })

  it('gives each assistant message its own block index space', () => {
    const { events, feed } = build()
    feed(stream({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    feed(toolStart(0, 'toolu_1', 'Read'))
    // A second message restarts at index 0 with a text block. Carrying the map
    // over would feed its deltas into the previous message's tool buffer.
    feed(stream({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }))

    expect(named(events)).toEqual(['tool_call', 'agent_message_chunk'])
  })
})

describe('ClaudeMessageTranslator usage', () => {
  const messageDelta = (usage: Record<string, number>) =>
    stream({ type: 'message_delta', delta: {}, usage })

  const result = (overrides: Record<string, unknown> = {}) => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    session_id: 'session-1',
    errors: [],
    ...overrides,
  })

  it('accumulates deltas into the turn and folds cache tokens into input', () => {
    const { feed } = build()
    feed(messageDelta({ input_tokens: 100, output_tokens: 10 }))
    feed(
      messageDelta({
        input_tokens: 0,
        output_tokens: 5,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      }),
    )

    expect(feed(result()).completed?.usage).toEqual({
      // Cache reads and writes are input — the same prompt, billed differently.
      inputTokens: 1050,
      outputTokens: 15,
      totalTokens: 1065,
      cachedReadTokens: 900,
      cachedWriteTokens: 50,
    })
  })

  it('starts each turn from zero', () => {
    const { feed } = build()
    feed(messageDelta({ input_tokens: 100, output_tokens: 10 }))
    feed(result())
    feed(messageDelta({ input_tokens: 7, output_tokens: 3 }))

    expect(feed(result()).completed?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 })
  })

  it('falls back to the result usage only when nothing streamed', () => {
    const { feed } = build()
    // Double counting is the failure mode this guards: a streamed turn already
    // reported its tokens through message_delta.
    expect(feed(result({ usage: { input_tokens: 40, output_tokens: 2 } })).completed?.usage).toEqual({
      inputTokens: 40,
      outputTokens: 2,
      totalTokens: 42,
    })
  })

  it('reports no usage rather than zeros when nothing carried any', () => {
    const { feed } = build()
    expect(feed(result({ usage: {} })).completed?.usage).toBeUndefined()
  })

  it('ignores usage that belongs to a subagent', () => {
    const { feed } = build()
    feed(stream({ type: 'message_delta', delta: {}, usage: { input_tokens: 999 } }, 'toolu_child'))
    expect(feed(result()).completed?.usage).toBeUndefined()
  })
})

describe('ClaudeMessageTranslator subagents', () => {
  it('drops subagent traffic and counts the loss', () => {
    const { events, feed, log } = build()
    feed(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inner' } }, 'toolu_task'))
    feed({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-1',
      errors: [],
    })

    // Without the drop, a subagent's prose renders as the main agent's answer.
    expect(named(events)).not.toContain('agent_message_chunk')
    expect(
      log.mock.calls.some(
        ([entry]) =>
          String(entry?.message).includes('Dropped subagent messages') &&
          (entry?.data as { count: number }).count === 1,
      ),
    ).toBe(true)
  })

  it('keeps the parent Task row alive from the subagent it dropped', () => {
    const { events, feed } = build()
    feed({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking for the config\nsecond line' },
          { type: 'tool_use', id: 'toolu_inner', name: 'Grep', input: {} },
        ],
      },
      parent_tool_use_id: 'toolu_task',
      uuid: 'uuid-inner',
      session_id: 'session-1',
    })

    expect(dataOf<Record<string, unknown>>(events, 'subtask_update')[0]).toEqual({
      taskId: 'toolu_task',
      status: 'running',
      statusSource: 'task_event',
      currentActivity: 'Looking for the config',
      toolCallCount: 1,
    })
  })
})

describe('ClaudeMessageTranslator system frames', () => {
  const system = (subtype: string, extra: Record<string, unknown> = {}) => ({
    type: 'system',
    subtype,
    uuid: 'uuid-1',
    session_id: 'session-1',
    ...extra,
  })

  it('republishes a changed command list', () => {
    const { events, feed } = build()
    feed(
      system('commands_changed', {
        commands: [{ name: 'compact', description: 'Compact', argumentHint: '<focus>' }],
      }),
    )

    expect(dataOf<{ availableCommands: unknown[] }>(events, 'available_commands_update')[0]).toEqual({
      availableCommands: [
        {
          name: 'compact',
          description: 'Compact',
          input: { type: 'unstructured', placeholder: '<focus>' },
        },
      ],
    })
  })

  it('reports an API retry as recoverable', () => {
    const { events, feed } = build()
    feed(system('api_retry', { attempt: 1, max_retries: 3, error: 'overloaded', error_status: 529 }))

    expect(dataOf<{ recoverable: boolean; code?: number }>(events, 'rpc_error')[0]).toMatchObject({
      recoverable: true,
      code: 529,
    })
  })

  it('logs a compaction without inventing a context size', () => {
    const { events, feed, log } = build()
    feed(system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 150_000 } }))

    // `SessionUsage` needs a denominator a compaction does not carry; a meter
    // drawn against a guessed one is worse than no meter.
    expect(named(events)).not.toContain('usage_update')
    expect(log.mock.calls.some(([entry]) => String(entry?.message).includes('compacted'))).toBe(true)
  })

  it('fails the tool row an auto-deny short-circuited', () => {
    const { events, feed } = build()
    feed(system('permission_denied', { tool_name: 'Bash', tool_use_id: 'toolu_denied' }))

    expect(dataOf<{ toolCallId: string; status: string }>(events, 'tool_call_update')[0]).toMatchObject(
      { toolCallId: 'toolu_denied', status: 'failed' },
    )
  })
})

describe('ClaudeMessageTranslator tolerance', () => {
  it('drops what it cannot understand instead of throwing', () => {
    const { events, feed } = build()
    expect(() => feed({ type: 'a_future_message', session_id: 'session-1' })).not.toThrow()
    expect(() => feed(system())).not.toThrow()
    expect(() => feed(null)).not.toThrow()
    expect(() => feed(stream({ type: 'content_block_delta', index: 9, delta: null }))).not.toThrow()
    expect(events).toHaveLength(0)
  })

  const system = () => ({ type: 'system', subtype: 'a_future_subtype', session_id: 'session-1' })
})
