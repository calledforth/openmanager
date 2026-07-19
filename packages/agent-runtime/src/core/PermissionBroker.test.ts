import type { PermissionOption } from '@agentpack/contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PERMISSION_TIMEOUT_MS,
  PermissionBroker,
  type PermissionSettlement,
} from './PermissionBroker.js'

const options: PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
]

function addPending(broker: PermissionBroker, requestId: string, threadId = 'thread-1') {
  let resolved: unknown
  const promise = new Promise((resolve) => {
    broker.add(requestId, {
      providerId: 'opencode',
      threadId,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      options,
      resolve,
    })
  }).then((value) => {
    resolved = value
    return value
  })
  return { promise, isResolved: () => resolved !== undefined }
}

describe('PermissionBroker', () => {
  let settlements: PermissionSettlement[]
  let broker: PermissionBroker

  beforeEach(() => {
    settlements = []
    broker = new PermissionBroker((settlement) => settlements.push(settlement))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports selected settlements with full routing info', async () => {
    const pending = addPending(broker, 'req-1')
    expect(broker.respond('req-1', { outcome: 'selected', optionId: 'allow' })).toBe(true)
    await expect(pending.promise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    })
    expect(settlements).toEqual([
      {
        requestId: 'req-1',
        providerId: 'opencode',
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        outcome: { outcome: 'selected', optionId: 'allow' },
      },
    ])
  })

  it('rejects unknown optionIds and keeps the request pending', () => {
    const pending = addPending(broker, 'req-1')
    expect(() => broker.respond('req-1', { outcome: 'selected', optionId: 'nope' })).toThrow(
      /Invalid permission optionId/,
    )
    expect(settlements).toEqual([])
    expect(pending.isResolved()).toBe(false)
    expect(broker.respond('req-1', { outcome: 'selected', optionId: 'deny' })).toBe(true)
  })

  it('times out with a cancelled settlement', async () => {
    vi.useFakeTimers()
    const pending = addPending(broker, 'req-1')
    vi.advanceTimersByTime(PERMISSION_TIMEOUT_MS + 1)
    await expect(pending.promise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(settlements[0]?.outcome).toEqual({ outcome: 'cancelled', reason: 'timeout' })
  })

  it('cancelThread settles only that thread as tool_cancelled', async () => {
    const one = addPending(broker, 'req-1', 'thread-1')
    addPending(broker, 'req-2', 'thread-2')
    broker.cancelThread('opencode', 'thread-1')
    await expect(one.promise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(settlements.map((s) => [s.requestId, s.outcome])).toEqual([
      ['req-1', { outcome: 'cancelled', reason: 'tool_cancelled' }],
    ])
    expect(broker.respond('req-2', { outcome: 'selected', optionId: 'allow' })).toBe(true)
  })

  it('settleAll reports runtime_disposed and later responses are ignored', async () => {
    const pending = addPending(broker, 'req-1')
    broker.settleAll()
    await expect(pending.promise).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(settlements[0]?.outcome).toEqual({ outcome: 'cancelled', reason: 'runtime_disposed' })
    expect(broker.respond('req-1', { outcome: 'selected', optionId: 'allow' })).toBe(false)
    expect(settlements).toHaveLength(1)
  })
})
