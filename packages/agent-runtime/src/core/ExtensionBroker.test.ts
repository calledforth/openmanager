import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EXTENSION_TIMEOUT_MS,
  ExtensionBroker,
  type ExtensionSettlement,
} from './ExtensionBroker.js'

function addPending(broker: ExtensionBroker, requestId: string, threadId = 'thread-1') {
  let resolved: unknown
  const promise = new Promise((resolve) => {
    broker.add(requestId, {
      providerId: 'cursor',
      threadId,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      method: 'cursor/ask_question',
      resolve,
    })
  }).then((value) => {
    resolved = value
    return value
  })
  return { promise, isResolved: () => resolved !== undefined }
}

describe('ExtensionBroker', () => {
  let settlements: ExtensionSettlement[]
  let broker: ExtensionBroker

  beforeEach(() => {
    settlements = []
    broker = new ExtensionBroker((settlement) => settlements.push(settlement))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the UI response and reports the settlement', async () => {
    const pending = addPending(broker, 'req-1')
    const response = { outcome: { outcome: 'answered', answers: ['B'] } }
    expect(broker.respond('req-1', response)).toBe(true)
    await expect(pending.promise).resolves.toEqual({ outcome: 'responded', response })
    expect(settlements).toEqual([
      {
        requestId: 'req-1',
        providerId: 'cursor',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        method: 'cursor/ask_question',
        outcome: { outcome: 'responded', response },
      },
    ])
  })

  it('times out as cancelled', async () => {
    vi.useFakeTimers()
    const pending = addPending(broker, 'req-1')
    vi.advanceTimersByTime(EXTENSION_TIMEOUT_MS + 1)
    await expect(pending.promise).resolves.toEqual({ outcome: 'cancelled', reason: 'timeout' })
    expect(broker.respond('req-1', {})).toBe(false)
  })

  it('honors a custom per-request timeout', async () => {
    vi.useFakeTimers()
    let outcome: unknown
    const promise = new Promise((resolve) => {
      broker.add(
        'req-1',
        {
          providerId: 'cursor',
          threadId: 'thread-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          method: 'cursor/create_plan',
          resolve,
        },
        10_000,
      )
    }).then((value) => {
      outcome = value
      return value
    })
    vi.advanceTimersByTime(9_999)
    expect(outcome).toBeUndefined()
    vi.advanceTimersByTime(2)
    await expect(promise).resolves.toEqual({ outcome: 'cancelled', reason: 'timeout' })
  })

  it('cancelThread settles only the matching thread', async () => {
    const one = addPending(broker, 'req-1', 'thread-1')
    addPending(broker, 'req-2', 'thread-2')
    broker.cancelThread('cursor', 'thread-1')
    await expect(one.promise).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'tool_cancelled',
    })
    expect(settlements).toHaveLength(1)
    expect(broker.respond('req-2', {})).toBe(true)
  })

  it('settleAll cancels everything as runtime_disposed', async () => {
    const pending = addPending(broker, 'req-1')
    broker.settleAll()
    await expect(pending.promise).resolves.toEqual({
      outcome: 'cancelled',
      reason: 'runtime_disposed',
    })
  })
})
