import type {
  Cursor,
  DurableEvent,
  EventEnvelope,
  TransientEvent,
} from '@openmanager/protocol/node'
import type { AuthenticatedClient } from './authorized-clients.ts'

/**
 * One thing the server sends to clients, in the order it happened
 * (docs/sync-foundations.md §5.2):
 *
 * - `record`: a committed durable event, to the subscriptions of its scope;
 * - `transient`: an event that is never stored, to the subscriptions of its
 *   scope, placed `after` the durable record it followed;
 * - `broadcast`: a current reading every socket gets, such as provider health;
 * - `followers`: a current reading for the sockets following `topic`, built
 *   per socket, such as the device list.
 */
export type Delivery =
  | { kind: 'record'; record: DurableEvent }
  | { kind: 'transient'; event: TransientEvent; after: Cursor }
  | { kind: 'broadcast'; event: EventEnvelope }
  | { kind: 'followers'; topic: string; build: (client: AuthenticatedClient) => EventEnvelope }

export interface DeliveryQueue {
  /** Add to the end; the queue drains in one scheduled microtask. */
  enqueue(item: Delivery): void
  /**
   * Send everything enqueued so far, now. A command's answer calls this
   * first, so no answer overtakes an event committed before it.
   */
  drain(): void
  /** Where items go. Until it is set nothing can be connected, and items are discarded. */
  attach(sink: (item: Delivery) => void): void
  /** Items waiting. */
  readonly size: number
}

/**
 * The process's one delivery queue: an explicit array drained strictly in
 * order by one scheduled microtask. Everything the server sends outside a
 * command's answer goes through it, so a client receives durable records,
 * transients and readings in the order the server produced them.
 *
 * The sink owns every failure of its own: one socket that cannot be sent to
 * is closed there, and the rest of the item still goes out. A sink that
 * throws anyway is a bug; it is reported and the queue moves on, because
 * stopping would hold back every later item for every client.
 */
export function createDeliveryQueue(
  options: { onError?: (error: unknown, item: Delivery) => void } = {},
): DeliveryQueue {
  const items: Delivery[] = []
  let sink: (item: Delivery) => void = () => undefined
  let scheduled = false
  let draining = false

  const drain = () => {
    // A drain started while one runs (a sink that answers a command, say)
    // leaves the items to the loop already running, which keeps the order.
    if (draining) return
    draining = true
    try {
      for (let item = items.shift(); item; item = items.shift()) {
        try {
          sink(item)
        } catch (error) {
          options.onError?.(error, item)
        }
      }
    } finally {
      draining = false
    }
  }

  return {
    enqueue(item) {
      items.push(item)
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        drain()
      })
    },
    drain,
    attach(next) {
      sink = next
    },
    get size() {
      return items.length
    },
  }
}
