import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agentpack/contract'
import { createBackgroundTurnFilter } from './background-turns'

let seq = 0
const event = (
  name: AgentEvent['event'],
  data: unknown = {},
  messageId?: string,
  threadId = 'thread-1',
) =>
  ({
    id: `event-${++seq}`,
    seq,
    threadId,
    providerId: 'claude',
    sessionId: 'session-1',
    timestamp: '2026-09-30T10:00:00.000Z',
    category: 'lifecycle',
    event: name,
    data,
    ...(messageId ? { messageId } : {}),
  }) as unknown as AgentEvent

describe('background turn filter', () => {
  it('names the start and the end of a turn the provider began by itself', () => {
    const classify = createBackgroundTurnFilter()
    expect(classify(event('background_turn_started', {}, 'assistant-2'))).toBe('started')
    expect(classify(event('agent_message_chunk', {}, 'assistant-2'))).toBeUndefined()
    expect(classify(event('prompt_completed', {}, 'assistant-2'))).toBe('ended')
    // Closed: the next completion belongs to a turn this host did start.
    expect(classify(event('prompt_completed', {}, 'assistant-3'))).toBeUndefined()
  })

  it('says when the turn asked the user something, since that left the session waiting', () => {
    const classify = createBackgroundTurnFilter()
    classify(event('background_turn_started', {}, 'assistant-2'))
    // The request itself still reaches the host: it has to be answered or the
    // provider waits on it forever.
    expect(
      classify(event('permission_request', { requestId: 'r1' }, 'assistant-2')),
    ).toBeUndefined()
    expect(classify(event('prompt_completed', {}, 'assistant-2'))).toBe('ended_waiting')
  })

  it('names the failure that ends one, but not a retry notice', () => {
    const classify = createBackgroundTurnFilter()
    classify(event('background_turn_started', {}, 'assistant-2'))
    const retry = event('rpc_error', { source: 'claude/api', message: 'retry', recoverable: true })
    expect(classify({ ...retry, messageId: 'assistant-2' } as AgentEvent)).toBeUndefined()
    expect(
      classify(event('runtime_error', { kind: 'provider', message: 'overloaded' }, 'assistant-2')),
    ).toBe('ended')
  })

  it('lets a prompt or an exit take over without claiming its events', () => {
    const classify = createBackgroundTurnFilter()
    classify(event('background_turn_started', {}, 'assistant-2'))
    // The runtime closes the background turn before it opens the user's.
    expect(classify(event('prompt_completed', {}, 'assistant-2'))).toBe('ended')
    expect(classify(event('prompt_started', { prompt: 'hi' }, 'assistant-3'))).toBeUndefined()
    expect(classify(event('prompt_completed', {}, 'assistant-3'))).toBeUndefined()

    classify(event('background_turn_started', {}, 'assistant-4'))
    expect(classify(event('process_exited', { exitCode: 1, expected: false }))).toBeUndefined()
    expect(classify(event('prompt_completed', {}, 'assistant-4'))).toBeUndefined()
  })

  it('keeps threads apart', () => {
    const classify = createBackgroundTurnFilter()
    classify(event('background_turn_started', {}, 'assistant-2'))
    expect(classify(event('prompt_completed', {}, 'assistant-9', 'thread-2'))).toBeUndefined()
  })
})
