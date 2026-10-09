import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderNotice, ProviderProblem, RpcErrorData } from '@agentpack/contract'
import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '../../backends/Backend.js'
import { ClaudeMessageTranslator } from './ClaudeMessageTranslator.js'
import { classifyClaudeFailure, retryProblem } from './claude-problems.js'

/** How Claude Code's problem and notice frames map, driven through the
 * translator the way the runtime drives it. */
function build() {
  const translator = new ClaudeMessageTranslator({
    route: () => ({ threadId: 'thread-1', workspaceId: 'workspace-1' }),
    log: vi.fn(),
  })
  const events: BackendEvent[] = []
  const feed = (message: unknown) => {
    const translated = translator.translate(message as SDKMessage)
    events.push(...translated.events)
    return translated
  }
  return { events, feed }
}

const dataOf = <T>(events: BackendEvent[], name: string): T[] =>
  events.filter((event) => event.event === name).map((event) => event.data as T)
const notices = (events: BackendEvent[]) => dataOf<ProviderNotice>(events, 'provider_notice')

const system = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype,
  uuid: 'uuid-1',
  session_id: 'session-1',
  ...extra,
})
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { id: 'msg-1', model: '<synthetic>', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  uuid: 'uuid-2',
  session_id: 'session-1',
  ...extra,
})
const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'end_turn',
  session_id: 'session-1',
  errors: [],
  result: '',
  ...extra,
})
const stream = (event: Record<string, unknown>) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: null,
  uuid: 'uuid-3',
  session_id: 'session-1',
})

describe('Claude retries', () => {
  it('carries the attempt, the limit, the delay and the cause', () => {
    const { events, feed } = build()
    feed(
      system('api_retry', {
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 4000,
        error_status: 529,
        error: 'overloaded',
      }),
    )
    const [error] = dataOf<RpcErrorData>(events, 'rpc_error')
    expect(error).toMatchObject({
      recoverable: true,
      problem: { code: 'overloaded', retry: { attempt: 2, maxAttempts: 10, delayMs: 4000 } },
    })
  })

  it.each([
    [{ error_status: 429, error: 'rate_limit' }, 'rate_limited'],
    [{ error_status: 500, error: 'server_error' }, 'server_error'],
    [{ error_status: null, error: 'unknown' }, 'network'],
    [{ error_status: 401, error: 'authentication_failed' }, 'unauthorized'],
  ])('types a retry after %j as %s', (raw, code) => {
    expect(retryProblem({ attempt: 1, max_retries: 3, ...raw }).code).toBe(code)
  })
})

describe("Claude Code's synthetic API-error text", () => {
  it('is held back from the reply and becomes the typed failure', () => {
    const { events, feed } = build()
    feed(assistant('API Error: 529 {"type":"overloaded_error"}', { error: 'overloaded' }))
    const translated = feed(result({ is_error: true, result: 'API Error: 529' }))

    expect(dataOf(events, 'agent_message_chunk')).toEqual([])
    expect(translated.completed).toMatchObject({
      isError: true,
      problem: { code: 'overloaded' },
    })
  })

  it('keeps text that really streamed even on a flagged message', () => {
    const { events, feed } = build()
    feed(stream({ type: 'message_start' }))
    feed(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))
    feed(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Partial answer' },
      }),
    )
    feed(assistant('Partial answer', { error: 'max_output_tokens' }))
    expect(dataOf<{ content: { text: string } }>(events, 'agent_message_chunk')).toHaveLength(1)
  })

  it('becomes a warning notice when the turn recovers', () => {
    const { events, feed } = build()
    feed(assistant('Response exceeded the output token maximum', { error: 'max_output_tokens' }))
    const translated = feed(result())
    expect(translated.completed?.isError).toBe(false)
    expect(notices(events)).toEqual([
      { kind: 'warning', message: "Part of the reply was cut off at the model's output limit." },
    ])
  })

  it('does not carry a flag into the next turn', () => {
    const { feed } = build()
    feed(assistant('API Error: 529', { error: 'overloaded' }))
    feed(result({ is_error: true }))
    const next = feed(result({ is_error: true, subtype: 'error_during_execution', errors: [] }))
    expect(next.completed?.problem).toEqual({ code: 'unknown' })
  })
})

describe('Claude usage and rate limits', () => {
  const limit = (info: Record<string, unknown>) => ({
    type: 'rate_limit_event',
    rate_limit_info: info,
    uuid: 'uuid-4',
    session_id: 'session-1',
  })

  it('fails a spent allowance as a usage limit with its reset time', () => {
    const { feed } = build()
    feed(limit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_791_000_000 }))
    feed(assistant("You've hit your limit · resets 3pm", { error: 'rate_limit' }))
    const translated = feed(result({ is_error: true }))
    expect(translated.completed?.problem).toEqual({
      code: 'usage_limit',
      resetsAt: new Date(1_791_000_000 * 1000).toISOString(),
    })
  })

  it('keeps a throttled burst a rate limit, which a retry can clear', () => {
    const { feed } = build()
    feed(assistant('API Error: 429 rate_limit_error', { error: 'rate_limit' }))
    expect(feed(result({ is_error: true })).completed?.problem).toEqual({ code: 'rate_limited' })
  })

  it('reads the reset time the legacy wording carried', () => {
    const problem = classifyClaudeFailure({
      text: 'Claude AI usage limit reached|1791000000',
      refused: false,
    })
    expect(problem).toEqual({
      code: 'usage_limit',
      resetsAt: new Date(1_791_000_000 * 1000).toISOString(),
    })
  })

  it('warns once per threshold as a limit gets close', () => {
    const { events, feed } = build()
    const warning = {
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      surpassedThreshold: 0.8,
      resetsAt: 1_791_000_000,
    }
    feed(limit(warning))
    feed(limit(warning))
    feed(limit({ status: 'allowed' }))
    expect(notices(events)).toEqual([
      {
        kind: 'usage_warning',
        message: 'Approaching your weekly usage limit',
        resetsAt: new Date(1_791_000_000 * 1000).toISOString(),
      },
    ])
  })

  it('warns again at the same threshold once the allowance has reset', () => {
    const { events, feed } = build()
    const warning = (resetsAt: number) => ({
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      surpassedThreshold: 0.9,
      resetsAt,
    })
    feed(limit(warning(1_791_000_000)))
    feed(limit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1_791_018_000 }))
    feed(limit(warning(1_791_018_000)))
    feed(limit(warning(1_791_018_000)))
    expect(notices(events).map((notice) => notice.resetsAt)).toEqual([
      new Date(1_791_000_000 * 1000).toISOString(),
      new Date(1_791_018_000 * 1000).toISOString(),
    ])
  })
})

describe('Claude failure classification', () => {
  it.each<[string, Parameters<typeof classifyClaudeFailure>[0], ProviderProblem]>([
    [
      'a prompt that is too long',
      { terminalReason: 'prompt_too_long', text: '', refused: false },
      { code: 'context_window_exceeded', action: 'compact' },
    ],
    [
      'the context blocking limit',
      { terminalReason: 'blocking_limit', text: '', refused: false },
      { code: 'context_window_exceeded', action: 'compact' },
    ],
    [
      'an invalid request that says the prompt is too long',
      {
        apiError: { error: 'invalid_request', text: 'Prompt is too long' },
        text: '',
        refused: false,
      },
      { code: 'context_window_exceeded', action: 'compact' },
    ],
    [
      'a failed sign-in',
      { apiError: { error: 'authentication_failed', text: '' }, text: '', refused: false },
      { code: 'unauthorized' },
    ],
    [
      'a billing error',
      { apiError: { error: 'billing_error', text: '' }, text: '', refused: false },
      { code: 'usage_limit' },
    ],
    ['a refusal', { text: '', refused: true }, { code: 'refused' }],
    [
      'an unflagged 529 status',
      { apiErrorStatus: 529, text: '', refused: false },
      { code: 'overloaded' },
    ],
    [
      'an unknown flag over a recognisable status',
      { apiError: { error: 'unknown', text: '' }, apiErrorStatus: 503, text: '', refused: false },
      { code: 'server_error' },
    ],
    ['nothing at all', { text: '', refused: false }, { code: 'unknown' }],
  ])('types %s', (_, input, expected) => {
    expect(classifyClaudeFailure(input)).toEqual(expected)
  })
})

describe('Claude notices', () => {
  it('marks a compaction in the transcript with what it saved', () => {
    const { events, feed } = build()
    feed(
      system('compact_boundary', {
        compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 40_000 },
      }),
    )
    expect(notices(events)).toEqual([
      {
        kind: 'compacted',
        message: 'Conversation compacted',
        compaction: { trigger: 'manual', tokensBefore: 180_000, tokensAfter: 40_000 },
      },
    ])
  })

  it('says it is compacting while it is, and when compaction fails', () => {
    const { events, feed } = build()
    feed(system('status', { status: 'compacting' }))
    feed(system('status', { status: null, compact_result: 'failed', compact_error: 'Too short' }))
    feed(system('status', { status: null, compact_result: 'success' }))
    expect(notices(events)).toEqual([
      { kind: 'compacting', message: 'Compacting the conversation' },
      { kind: 'warning', message: 'The conversation could not be compacted', detail: 'Too short' },
    ])
  })

  it('names the models of a refusal fallback and keeps the explanation', () => {
    const { events, feed } = build()
    feed(
      system('model_refusal_fallback', {
        trigger: 'refusal',
        direction: 'retry',
        original_model: 'claude-opus-5',
        fallback_model: 'claude-sonnet-5',
        request_id: null,
        api_refusal_explanation: 'This touches on a restricted topic.',
        content: '',
      }),
    )
    expect(notices(events)).toEqual([
      {
        kind: 'model_fallback',
        message: 'Switched to claude-sonnet-5 after claude-opus-5 declined',
        model: { from: 'claude-opus-5', to: 'claude-sonnet-5' },
        detail: 'This touches on a restricted topic.',
      },
    ])
  })

  it('records a refusal without a fallback and fails the turn as refused', () => {
    const { events, feed } = build()
    feed(
      system('model_refusal_no_fallback', {
        original_model: 'claude-opus-5',
        request_id: null,
        api_refusal_explanation: null,
        content: '',
      }),
    )
    expect(notices(events)).toEqual([
      { kind: 'refusal', message: 'The model declined this request' },
    ])
    expect(feed(result({ is_error: true })).completed?.problem).toEqual({ code: 'refused' })
  })

  it('keeps warnings and suggestions, drops transcript-only chatter and tool progress', () => {
    const { events, feed } = build()
    feed(
      system('informational', { level: 'warning', content: '\u001b[33mSettings ignored\u001b[0m' }),
    )
    feed(system('informational', { level: 'suggestion', content: 'Try /compact' }))
    feed(system('informational', { level: 'info', content: 'Verbose detail' }))
    feed(system('informational', { level: 'warning', content: 'Progress', tool_use_id: 'toolu_1' }))
    expect(notices(events)).toEqual([
      { kind: 'warning', message: 'Settings ignored' },
      { kind: 'info', message: 'Try /compact' },
    ])
  })

  it('shows a notification once per turn and skips low priority ones', () => {
    const { events, feed } = build()
    const note = {
      key: 'model-switch',
      text: 'Using Sonnet until your limit resets',
      priority: 'high',
    }
    feed(system('notification', note))
    feed(system('notification', note))
    feed(system('notification', { key: 'tip', text: 'A tip', priority: 'low' }))
    expect(notices(events)).toEqual([
      { kind: 'info', message: 'Using Sonnet until your limit resets' },
    ])
    feed(result())
    feed(system('notification', note))
    expect(notices(events)).toHaveLength(2)
  })
})
