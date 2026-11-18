import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SubtaskUpdate } from '@agentpack/contract'
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
const dataOf = <T>(events: BackendEvent[], name: string): T[] =>
  events.filter((event) => event.event === name).map((event) => event.data as T)

describe('ClaudeMessageTranslator thinking', () => {
  it('frames a thinking run without ever emitting its empty text', () => {
    const { events, feed } = build()
    feed(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: 'AAA' },
      }),
    )
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 },
      }),
    )
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'BBB' },
      }),
    )
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
      feed(
        stream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: '', estimated_tokens },
        }),
      )

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
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 0 },
      }),
    )

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
    expect(
      dataOf<{ status: string; rawInput: unknown }>(events, 'tool_call_update')[0],
    ).toMatchObject({
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

  it('states an answered question on the tool, from the structured result', () => {
    const { events, feed } = build()
    feed(toolStart(0, 'toolu_ask', 'AskUserQuestion'))
    const asked = { questions: [{ question: 'Which?' }] }
    feed(toolInput(0, JSON.stringify(asked)))
    feed(stream({ type: 'content_block_stop', index: 0 }))
    feed({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'User answered' }],
      },
      tool_use_result: { ...asked, answers: { 'Which?': 'A' } },
      parent_tool_use_id: null,
      session_id: 'session-1',
    })
    expect(dataOf<{ rawInput: unknown }>(events, 'tool_call_update').at(-1)?.rawInput).toEqual({
      ...asked,
      answers: { 'Which?': 'A' },
    })
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
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_bash', content: 'done', is_error: true },
        ],
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
    feed(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    )
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'streamed' },
      }),
    )
    feed(
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    )
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

  it('does not repeat text when the CLI snapshots each block on its own', () => {
    // The exact frame order live-captured from `claude --include-partial-messages`:
    // one `assistant` frame per content block, single-element content (so the
    // block is always at index 0), arriving BEFORE that block's stop.
    const { events, feed } = build()
    const snapshot = (uuid: string, content: Record<string, unknown>[]) => ({
      type: 'assistant',
      message: { id: 'msg_1', role: 'assistant', content },
      parent_tool_use_id: null,
      uuid,
      session_id: 'session-1',
    })
    feed(stream({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    feed(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
    )
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 },
      }),
    )
    feed(snapshot('uuid-thinking', [{ type: 'thinking', thinking: '', signature: 'AAA' }]))
    feed(stream({ type: 'content_block_stop', index: 0 }))
    feed(
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    )
    feed(
      stream({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hello ' },
      }),
    )
    feed(
      stream({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'there.' },
      }),
    )
    feed(snapshot('uuid-text', [{ type: 'text', text: 'Hello there.' }]))
    feed(stream({ type: 'content_block_stop', index: 1 }))
    feed(toolStart(2, 'toolu_1', 'Read'))
    feed(toolInput(2, '{"file_path":"a.ts"}'))
    feed(
      snapshot('uuid-tool', [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } },
      ]),
    )
    feed(stream({ type: 'content_block_stop', index: 2 }))

    const text = dataOf<{ content: { text: string } }>(events, 'agent_message_chunk')
    // Positional matching found nothing at index 0 for the text block and
    // emitted the whole answer a second time; a thinking-first answer is the
    // common case, so this was "every Claude Code reply renders twice".
    expect(text.map((chunk) => chunk.content.text)).toEqual(['Hello ', 'there.'])
    // And the thinking row still closes: its stop arrives after the frame
    // that used to wipe the index map.
    const phases = dataOf<{ phase: string }>(events, 'agent_thought_chunk').map((c) => c.phase)
    expect(phases).toEqual(['start', 'delta', 'stop'])
  })

  it('still backfills a block that never streamed, once, whatever its index', () => {
    const { events, feed } = build()
    feed(stream({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    feed(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    )
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Done.' },
      }),
    )
    // Two identical paragraphs: the streamed one is claimed exactly once, so
    // the second is genuinely new and must show.
    for (const uuid of ['uuid-a', 'uuid-b']) {
      feed({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        parent_tool_use_id: null,
        uuid,
        session_id: 'session-1',
      })
    }
    const chunks = dataOf<{ messageId?: string; content: { text: string } }>(
      events,
      'agent_message_chunk',
    )
    expect(chunks.map((chunk) => [chunk.content.text, chunk.messageId])).toEqual([
      ['Done.', undefined],
      ['Done.', 'uuid-b'],
    ])
  })

  it('gives each assistant message its own block index space', () => {
    const { events, feed } = build()
    feed(stream({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    feed(toolStart(0, 'toolu_1', 'Read'))
    // A second message restarts at index 0 with a text block. Carrying the map
    // over would feed its deltas into the previous message's tool buffer.
    feed(stream({ type: 'message_start', message: { role: 'assistant', content: [] } }))
    feed(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    )
    feed(
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
    )

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
    expect(
      feed(result({ usage: { input_tokens: 40, output_tokens: 2 } })).completed?.usage,
    ).toEqual({
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
  const assistant = (blocks: unknown[], parent: string | null, uuid = 'uuid-a') => ({
    type: 'assistant',
    message: { id: `msg-${uuid}`, role: 'assistant', content: blocks },
    parent_tool_use_id: parent,
    uuid,
    session_id: 'session-1',
  })
  const toolResult = (
    toolUseId: string,
    content: unknown,
    parent: string | null,
    extra: { structured?: unknown; isError?: boolean } = {},
  ) => ({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(extra.isError ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: parent,
    ...(extra.structured !== undefined ? { tool_use_result: extra.structured } : {}),
    session_id: 'session-1',
  })
  const system = (subtype: string, extra: Record<string, unknown>) => ({
    type: 'system',
    subtype,
    uuid: 'uuid-s',
    session_id: 'session-1',
    ...extra,
  })
  const taskStarted = (agentId: string, toolUseId: string, extra: Record<string, unknown> = {}) =>
    system('task_started', {
      task_id: agentId,
      tool_use_id: toolUseId,
      description: 'Survey the parser',
      subagent_type: 'Explore',
      task_type: 'local_agent',
      is_backgrounded: false,
      spawn_depth: 1,
      prompt: 'Read src/parser.',
      ...extra,
    })
  const result = () => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    session_id: 'session-1',
    errors: [],
  })
  /** The main agent calling `Agent`, streamed as the CLI streams it. */
  const spawn = (
    feed: (message: unknown) => unknown,
    index: number,
    id: string,
    input: Record<string, unknown> = {},
  ) => {
    feed(toolStart(index, id, 'Agent'))
    feed(
      toolInput(
        index,
        JSON.stringify({ description: 'Survey the parser', prompt: 'Read src/parser.', ...input }),
      ),
    )
  }
  const completed = (agentId: string, text: string) => ({
    status: 'completed',
    agentId,
    content: [{ type: 'text', text }],
    resolvedModel: 'claude-haiku-5',
    totalToolUseCount: 2,
    totalDurationMs: 4_000,
    totalTokens: 900,
    usage: {},
    prompt: 'Read src/parser.',
  })
  const subtasks = (events: BackendEvent[]) =>
    events.filter((event) => event.event === 'subtask_update')
  const of = (events: BackendEvent[], subtaskId: string) =>
    events.filter((event) => event.subtaskId === subtaskId)

  it("translates a subagent's work like the main agent's, tagged with its call", () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    const before = events.length
    feed(
      assistant(
        [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: 'Looking at the parser.' },
          { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/p.ts' } },
        ],
        'toolu_A',
      ),
    )
    feed(toolResult('toolu_read', 'export function parse() {}', 'toolu_A'))
    const inner = events.slice(before)

    expect(named(inner)).toEqual([
      'agent_thought_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'tool_call_update',
    ])
    expect(inner.every((event) => event.subtaskId === 'toolu_A')).toBe(true)
    expect(dataOf<{ phase: string }>(inner, 'agent_thought_chunk').map((c) => c.phase)).toEqual([
      'start',
      'stop',
    ])
    // Whole blocks: no stream ever arrives for a subagent's text.
    expect(dataOf(inner, 'agent_message_chunk')[0]).toEqual({
      messageId: 'uuid-a',
      content: { type: 'text', text: 'Looking at the parser.' },
    })
    expect(dataOf(inner, 'tool_call')[0]).toMatchObject({
      toolCallId: 'toolu_read',
      toolName: 'Read',
      rawInput: { file_path: '/p.ts' },
    })
    expect(dataOf<{ status?: string }>(inner, 'tool_call_update').at(-1)?.status).toBe('completed')
    // The main agent's own frames stay untagged.
    expect(events.slice(0, before).every((event) => event.subtaskId === undefined)).toBe(true)
  })

  it("keeps a subagent's frames out of the turn's books", () => {
    const { events, feed } = build({ subtasks: true })
    feed(stream({ type: 'message_start', message: {} }))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Same words' },
      }),
    )
    // A subagent saying the same words must not be taken for the main agent's
    // snapshot of its streamed block, nor stand in for its usage.
    feed(assistant([{ type: 'text', text: 'Same words' }], 'toolu_A'))
    feed(stream({ type: 'message_delta', delta: {}, usage: { output_tokens: 7 } }, 'toolu_A'))
    feed(assistant([{ type: 'text', text: 'Same words' }], null, 'uuid-top'))

    expect(
      dataOf<{ content: { text: string } }>(events, 'agent_message_chunk').map(
        (chunk) => chunk.content.text,
      ),
    ).toEqual(['Same words', 'Same words'])
    expect(of(events, 'toolu_A')).toHaveLength(1)
    expect(feed(result()).completed?.usage).toBeUndefined()
  })

  it('keeps interleaved parallel subagents apart by the call that started each', () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    spawn(feed, 1, 'toolu_B', { description: 'Survey the lexer' })
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    feed(taskStarted('agent00000000000b', 'toolu_B', { description: 'Survey the lexer' }))
    feed(assistant([{ type: 'tool_use', id: 'toolu_a1', name: 'Grep', input: {} }], 'toolu_A'))
    feed(assistant([{ type: 'tool_use', id: 'toolu_b1', name: 'Glob', input: {} }], 'toolu_B'))
    feed(toolResult('toolu_b1', 'lexer.ts', 'toolu_B'))
    feed(toolResult('toolu_a1', 'parser.ts', 'toolu_A'))
    feed(assistant([{ type: 'text', text: 'B is done' }], 'toolu_B', 'uuid-b'))
    feed(assistant([{ type: 'text', text: 'A is done' }], 'toolu_A', 'uuid-a'))

    const ids = (subtaskId: string) =>
      of(events, subtaskId).map((event) => (event.data as { toolCallId?: string }).toolCallId)
    expect(ids('toolu_A').filter(Boolean)).toEqual(['toolu_a1', 'toolu_a1', 'toolu_a1'])
    expect(ids('toolu_B').filter(Boolean)).toEqual(['toolu_b1', 'toolu_b1', 'toolu_b1'])
    const text = (subtaskId: string) =>
      dataOf<{ content: { text: string } }>(of(events, subtaskId), 'agent_message_chunk').map(
        (chunk) => chunk.content.text,
      )
    expect(text('toolu_A')).toEqual(['A is done'])
    expect(text('toolu_B')).toEqual(['B is done'])
    // Both cards sit in the parent's transcript, at depth 1.
    const cards = subtasks(events).filter((event) => event.subtaskId === undefined)
    expect(new Set(cards.map((event) => (event.data as SubtaskUpdate).taskId))).toEqual(
      new Set(['toolu_A', 'toolu_B']),
    )
    expect(cards.every((event) => (event.data as SubtaskUpdate).depth === 1)).toBe(true)
  })

  it('files a nested subagent under the subagent that started it', () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    feed(
      assistant(
        [
          {
            type: 'tool_use',
            id: 'toolu_N',
            name: 'Agent',
            input: { description: 'Read one file', prompt: 'Read p.ts', subagent_type: 'Explore' },
          },
        ],
        'toolu_A',
      ),
    )
    feed(
      taskStarted('agent00000000000n', 'toolu_N', {
        description: 'Read one file',
        spawn_depth: 2,
        parent_task_id: 'agent00000000000a',
      }),
    )
    feed(assistant([{ type: 'text', text: 'p.ts exports parse' }], 'toolu_N'))
    feed(
      toolResult('toolu_N', 'p.ts exports parse', 'toolu_A', {
        structured: completed('agent00000000000n', 'p.ts exports parse'),
      }),
    )

    const nested = subtasks(events).filter(
      (event) => (event.data as SubtaskUpdate).taskId === 'toolu_N',
    )
    expect(nested.length).toBeGreaterThan(0)
    // Every update about it lands in A's transcript, where its call is.
    expect(nested.every((event) => event.subtaskId === 'toolu_A')).toBe(true)
    expect(nested.every((event) => (event.data as SubtaskUpdate).depth === 2)).toBe(true)
    expect(nested.every((event) => (event.data as SubtaskUpdate).parentTaskId === 'toolu_A')).toBe(
      true,
    )
    expect(nested.at(-1)?.data).toMatchObject({
      status: 'completed',
      resultText: 'p.ts exports parse',
      providerTaskId: 'agent00000000000n',
    })
    // Its own work lands in its own session.
    expect(named(of(events, 'toolu_N'))).toEqual(['agent_message_chunk'])
  })

  it("maps task frames onto the subagent's taskId", () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    feed(
      system('task_progress', {
        task_id: 'agent00000000000a',
        tool_use_id: 'toolu_A',
        description: 'Survey the parser',
        usage: { total_tokens: 1_200, tool_uses: 3, duration_ms: 5_000 },
        last_tool_name: 'Grep',
      }),
    )
    feed(
      system('task_progress', {
        task_id: 'agent00000000000a',
        description: 'Survey the parser',
        usage: { total_tokens: 2_400, tool_uses: 5, duration_ms: 31_000 },
        last_tool_name: 'Read',
        summary: 'Reading the grammar',
      }),
    )
    feed(system('task_updated', { task_id: 'agent00000000000a', patch: { is_backgrounded: true } }))
    feed(
      system('task_notification', {
        task_id: 'agent00000000000a',
        status: 'completed',
        output_file: '/tmp/out',
        summary: 'The parser has two entry points.',
        usage: { total_tokens: 3_000, tool_uses: 6, duration_ms: 40_000 },
      }),
    )

    const updates = subtasks(events).map((event) => event.data as SubtaskUpdate)
    expect(updates.every((update) => update.taskId === 'toolu_A')).toBe(true)
    const started = updates.find((update) => update.providerTaskId === 'agent00000000000a')
    expect(started).toMatchObject({
      toolCallId: 'toolu_A',
      status: 'running',
      depth: 1,
      background: false,
      stoppable: true,
      promptable: false,
      subagentType: 'Explore',
      prompt: 'Read src/parser.',
    })
    const tail = updates.slice(-4)
    expect(tail[0]).toEqual({
      taskId: 'toolu_A',
      tokens: 1_200,
      toolCallCount: 3,
      durationMs: 5_000,
      currentActivity: 'Grep',
    })
    expect(tail[1]?.currentActivity).toBe('Reading the grammar')
    expect(tail[2]).toEqual({ taskId: 'toolu_A', background: true })
    expect(tail[3]).toEqual({
      taskId: 'toolu_A',
      status: 'completed',
      statusSource: 'task_event',
      stoppable: false,
      resultText: 'The parser has two entry points.',
      tokens: 3_000,
      toolCallCount: 6,
      durationMs: 40_000,
    })
  })

  it("ignores task frames for a subagent's own shell commands", () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    const before = events.length
    feed(
      taskStarted('bash0001', 'toolu_bash', { task_type: 'local_bash', description: 'npm test' }),
    )
    feed(
      system('task_notification', {
        task_id: 'bash0001',
        status: 'completed',
        output_file: '/tmp/out',
        summary: 'done',
      }),
    )
    expect(events.slice(before)).toEqual([])
  })

  it('revives a finished subagent under the taskId it already had', () => {
    const { events, feed, translator } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    feed(
      toolResult('toolu_A', 'first answer', null, {
        structured: completed('agent00000000000a', 'first answer'),
      }),
    )
    expect(subtasks(events).at(-1)?.data).toMatchObject({ status: 'completed' })

    // `SendMessage({to})` revives it from a new call, but its frames still name
    // the original `Agent` call.
    feed(taskStarted('agent00000000000a', 'toolu_send', { prompt: 'Now the lexer too.' }))
    expect(subtasks(events).at(-1)?.data).toMatchObject({
      taskId: 'toolu_A',
      status: 'running',
      prompt: 'Now the lexer too.',
      stoppable: true,
    })
    feed(assistant([{ type: 'text', text: 'The lexer is small.' }], 'toolu_A', 'uuid-r'))
    expect(events.at(-1)?.subtaskId).toBe('toolu_A')
    feed(
      system('task_notification', {
        task_id: 'agent00000000000a',
        status: 'completed',
        output_file: '/tmp/out',
        summary: 'The lexer is small.',
      }),
    )
    expect(subtasks(events).at(-1)?.data).toMatchObject({
      taskId: 'toolu_A',
      status: 'completed',
      resultText: 'The lexer is small.',
    })
    expect(translator.subtaskIdForAgent('agent00000000000a')).toBe('toolu_A')
    expect(translator.agentIdForSubtask('toolu_A')).toBe('agent00000000000a')
  })

  it('keeps a background subagent running past its call, and after the turn', () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A', { run_in_background: true })
    feed(taskStarted('agent00000000000a', 'toolu_A', { is_backgrounded: true }))
    feed(
      toolResult('toolu_A', 'Async agent launched successfully.', null, {
        structured: {
          status: 'async_launched',
          agentId: 'agent00000000000a',
          description: 'Survey the parser',
          prompt: 'Read src/parser.',
          outputFile: '/tmp/out',
        },
      }),
    )
    expect(subtasks(events).at(-1)?.data).toMatchObject({
      taskId: 'toolu_A',
      status: 'running',
      background: true,
    })
    expect(feed(result()).completed).toBeDefined()

    // The parent's turn is over; the subagent is not.
    const before = events.length
    feed(assistant([{ type: 'tool_use', id: 'toolu_g', name: 'Grep', input: {} }], 'toolu_A'))
    feed(toolResult('toolu_g', 'hits', 'toolu_A'))
    feed(assistant([{ type: 'text', text: 'Found it.' }], 'toolu_A', 'uuid-late'))
    expect(events.slice(before).every((event) => event.subtaskId === 'toolu_A')).toBe(true)
    feed(
      system('task_notification', {
        task_id: 'agent00000000000a',
        tool_use_id: 'toolu_A',
        status: 'completed',
        output_file: '/tmp/out',
        summary: 'Found it.',
      }),
    )
    expect(subtasks(events).at(-1)?.data).toMatchObject({
      taskId: 'toolu_A',
      status: 'completed',
      resultText: 'Found it.',
    })
    // Nothing before the notification said it had finished.
    const early = subtasks(events.slice(0, before)).map((event) => event.data as SubtaskUpdate)
    expect(early.some((update) => update.status === 'completed')).toBe(false)
  })

  it('does not take a moved-to-background call returning for the end of the run', () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    feed(system('task_updated', { task_id: 'agent00000000000a', patch: { is_backgrounded: true } }))
    // What Ctrl+B makes the call return, with no structured output to read.
    feed(toolResult('toolu_A', 'Async agent launched successfully.', null))
    expect(subtasks(events).at(-1)?.data).not.toHaveProperty('status')
  })

  it('keeps a stopped subagent cancelled when its call fails afterwards', () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    feed(
      system('task_notification', {
        task_id: 'agent00000000000a',
        status: 'stopped',
        output_file: '/tmp/out',
        summary: 'Stopped by the user',
      }),
    )
    expect(subtasks(events).at(-1)?.data).toMatchObject({
      status: 'cancelled',
      statusReason: 'Stopped by the user',
      stoppable: false,
    })
    feed(toolResult('toolu_A', 'interrupted', null, { isError: true }))
    expect(subtasks(events).at(-1)?.data).not.toHaveProperty('status')
  })

  it('keeps a stopped subagent cancelled when its answer arrives afterwards', () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(taskStarted('agent00000000000a', 'toolu_A'))
    feed(system('task_notification', { task_id: 'agent00000000000a', status: 'stopped' }))
    feed(
      toolResult('toolu_A', 'partial answer', null, {
        structured: completed('agent00000000000a', 'partial answer'),
      }),
    )
    const last = subtasks(events).at(-1)?.data
    expect(last).not.toHaveProperty('status')
    expect(last).toMatchObject({ resultText: 'partial answer', stoppable: false })
  })

  it("reads a foreground run's end from its call's structured result", () => {
    const { events, feed } = build({ subtasks: true })
    spawn(feed, 0, 'toolu_A')
    feed(
      toolResult('toolu_A', 'two entry points', null, {
        structured: completed('agent00000000000a', 'two entry points'),
      }),
    )
    expect(subtasks(events).at(-1)?.data).toEqual({
      taskId: 'toolu_A',
      toolCallId: 'toolu_A',
      status: 'completed',
      statusSource: 'task_event',
      depth: 1,
      promptable: false,
      stoppable: false,
      modelId: 'claude-haiku-5',
      providerTaskId: 'agent00000000000a',
      resultText: 'two entry points',
      tokens: 900,
      toolCallCount: 2,
      durationMs: 4_000,
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

    expect(
      dataOf<{ availableCommands: unknown[] }>(events, 'available_commands_update')[0],
    ).toEqual({
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
    feed(
      system('api_retry', { attempt: 1, max_retries: 3, error: 'overloaded', error_status: 529 }),
    )

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
    expect(log.mock.calls.some(([entry]) => String(entry?.message).includes('compacted'))).toBe(
      true,
    )
  })

  it('fails the tool row an auto-deny short-circuited', () => {
    const { events, feed } = build()
    feed(system('permission_denied', { tool_name: 'Bash', tool_use_id: 'toolu_denied' }))

    expect(
      dataOf<{ toolCallId: string; status: string }>(events, 'tool_call_update')[0],
    ).toMatchObject({ toolCallId: 'toolu_denied', status: 'failed' })
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
