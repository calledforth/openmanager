import { describe, expect, it, vi } from 'vitest'
import { ProofEventSchemas, type DurableEvent } from '@openmanager/protocol/node'
import { createEventService } from '../src/event-service.js'

const event = (threadId: string, eventId: string) =>
  ProofEventSchemas['turn.completed'].parse({
    type: 'event',
    name: 'turn.completed',
    eventId,
    timestamp: '2026-09-09T00:00:00Z',
    scope: {
      type: 'thread',
      environmentId: 'environment-1',
      sessionId: 'session-1',
      threadId,
    },
    payload: { turnId: `turn-${threadId}` },
  })

describe('protocol event sequencing', () => {
  it('assigns contiguous sequence numbers independently for each scope', () => {
    const records: DurableEvent[] = []
    const append = vi.fn((record: DurableEvent) => records.push(record))
    const service = createEventService(append, 'epoch-1')

    service.append(event('a', 'event-1'))
    service.append(event('b', 'event-2'))
    service.append(event('a', 'event-3'))

    expect(records.map((record) => record.cursor)).toEqual([
      expect.objectContaining({ epoch: 'epoch-1', sequence: 1 }),
      expect.objectContaining({ epoch: 'epoch-1', sequence: 1 }),
      expect.objectContaining({ epoch: 'epoch-1', sequence: 2 }),
    ])
    expect(append).toHaveBeenCalledTimes(3)
  })

  it('does not consume a sequence when the append boundary rejects a record', () => {
    const records: DurableEvent[] = []
    const append = vi
      .fn<(record: DurableEvent) => void>()
      .mockImplementationOnce(() => {
        throw new Error('database unavailable')
      })
      .mockImplementation((record) => records.push(record))
    const service = createEventService(append, 'epoch-1')

    expect(() => service.append(event('a', 'event-1'))).toThrow('database unavailable')
    service.append(event('a', 'event-2'))

    expect(records[0]?.cursor.sequence).toBe(1)
  })
})
