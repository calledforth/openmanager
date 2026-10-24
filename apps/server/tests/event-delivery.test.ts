import { describe, expect, it, vi } from 'vitest'
import { createDeliveryQueue, type Delivery } from '../src/event-delivery.js'

const reading = (name: string): Delivery => ({
  kind: 'broadcast',
  event: { type: 'event', name, payload: null },
})
const nameOf = (item: Delivery) => (item.kind === 'broadcast' ? item.event.name : item.kind)

describe('the delivery queue', () => {
  it('sends in enqueue order, in one later microtask', async () => {
    const queue = createDeliveryQueue()
    const sent: string[] = []
    queue.attach((item) => sent.push(nameOf(item)))
    for (const name of ['a', 'b', 'c']) queue.enqueue(reading(name))
    expect(sent).toEqual([])
    expect(queue.size).toBe(3)
    await Promise.resolve()
    expect(sent).toEqual(['a', 'b', 'c'])
    expect(queue.size).toBe(0)
  })

  it('schedules one drain for any number of items', async () => {
    const scheduled = vi.spyOn(globalThis, 'queueMicrotask')
    try {
      const queue = createDeliveryQueue()
      queue.attach(() => undefined)
      for (let index = 0; index < 50; index++) queue.enqueue(reading(`e${index}`))
      expect(scheduled).toHaveBeenCalledTimes(1)
      await Promise.resolve()
      queue.enqueue(reading('next'))
      expect(scheduled).toHaveBeenCalledTimes(2)
    } finally {
      scheduled.mockRestore()
    }
  })

  it('drains at once when asked, and the scheduled drain then finds nothing', async () => {
    const queue = createDeliveryQueue()
    const sent: string[] = []
    queue.attach((item) => sent.push(nameOf(item)))
    queue.enqueue(reading('a'))
    queue.enqueue(reading('b'))
    queue.drain()
    expect(sent).toEqual(['a', 'b'])
    await Promise.resolve()
    expect(sent).toEqual(['a', 'b'])
  })

  it('sends an item enqueued while draining after everything before it', async () => {
    const queue = createDeliveryQueue()
    const sent: string[] = []
    queue.attach((item) => {
      sent.push(nameOf(item))
      if (nameOf(item) === 'a') queue.enqueue(reading('late'))
    })
    queue.enqueue(reading('a'))
    queue.enqueue(reading('b'))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual(['a', 'b', 'late'])
  })

  it('keeps the order when a sink drains the queue itself', async () => {
    const queue = createDeliveryQueue()
    const sent: string[] = []
    queue.attach((item) => {
      sent.push(nameOf(item))
      queue.drain()
    })
    for (const name of ['a', 'b', 'c']) queue.enqueue(reading(name))
    await Promise.resolve()
    expect(sent).toEqual(['a', 'b', 'c'])
  })

  it('reports a sink that throws and still sends what follows', async () => {
    const onError = vi.fn()
    const queue = createDeliveryQueue({ onError })
    const sent: string[] = []
    queue.attach((item) => {
      if (nameOf(item) === 'bad') throw new Error('boom')
      sent.push(nameOf(item))
    })
    for (const name of ['a', 'bad', 'c']) queue.enqueue(reading(name))
    await Promise.resolve()
    expect(sent).toEqual(['a', 'c'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![1]).toEqual(reading('bad'))
  })

  it('discards items while nothing is attached: nothing can be connected yet', async () => {
    const queue = createDeliveryQueue()
    queue.enqueue(reading('early'))
    await Promise.resolve()
    const sent: string[] = []
    queue.attach((item) => sent.push(nameOf(item)))
    queue.enqueue(reading('later'))
    await Promise.resolve()
    expect(sent).toEqual(['later'])
  })
})
