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
  it('drops the start and the end of a turn the provider began by itself', () => {
    const dropped = createBackgroundTurnFilter()
    expect(dropped(event('background_turn_started', {}, 'assistant-2'))).toBe(true)
    // What happens inside it still reaches the host: a permission prompt has
    // to be answered or the provider waits on it forever.
    expect(dropped(event('permission_request', { requestId: 'r1' }, 'assistant-2'))).toBe(false)
    expect(dropped(event('agent_message_chunk', {}, 'assistant-2'))).toBe(false)
    expect(dropped(event('prompt_completed', {}, 'assistant-2'))).toBe(true)
    // Closed: the next completion belongs to a turn this host did start.
    expect(dropped(event('prompt_completed', {}, 'assistant-3'))).toBe(false)
  })

  it('drops the failure that ends one, but not a retry notice', () => {
    const dropped = createBackgroundTurnFilter()
    dropped(event('background_turn_started', {}, 'assistant-2'))
    const retry = event('rpc_error', { source: 'claude/api', message: 'retry', recoverable: true })
    expect(dropped({ ...retry, messageId: 'assistant-2' } as AgentEvent)).toBe(false)
    expect(
      dropped(event('runtime_error', { kind: 'provider', message: 'overloaded' }, 'assistant-2')),
    ).toBe(true)
  })

  it('lets a prompt or an exit take over without swallowing its events', () => {
    const dropped = createBackgroundTurnFilter()
    dropped(event('background_turn_started', {}, 'assistant-2'))
    // The runtime closes the background turn before it opens the user's.
    expect(dropped(event('prompt_completed', {}, 'assistant-2'))).toBe(true)
    expect(dropped(event('prompt_started', { prompt: 'hi' }, 'assistant-3'))).toBe(false)
    expect(dropped(event('prompt_completed', {}, 'assistant-3'))).toBe(false)

    dropped(event('background_turn_started', {}, 'assistant-4'))
    expect(dropped(event('process_exited', { exitCode: 1, expected: false }))).toBe(false)
    expect(dropped(event('prompt_completed', {}, 'assistant-4'))).toBe(false)
  })

  it('keeps threads apart', () => {
    const dropped = createBackgroundTurnFilter()
    dropped(event('background_turn_started', {}, 'assistant-2'))
    expect(dropped(event('prompt_completed', {}, 'assistant-9', 'thread-2'))).toBe(false)
  })
})
