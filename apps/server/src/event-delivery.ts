import type { DurableEvent, EventEnvelope } from '@openmanager/protocol/node'

/**
 * How stored and transient events leave for the sockets, in one order.
 *
 * A stored event is sent on a microtask: thread dispatch persists it
 * synchronously, and the command's response must reach the socket first.
 * `workspace.*` events go at once, as they always have.
 *
 * A transient event (a `turn.notice`) takes the same microtask queue, so it
 * cannot overtake output stored just before it. Sent at once, a retry notice
 * would reach clients ahead of the reply text the provider produced before
 * it, and that text would then read as the recovery and clear the notice.
 */
export function createEventDelivery(options: {
  durable: (record: DurableEvent) => void
  transient: (event: EventEnvelope) => void
  onError: (name: string, error: unknown) => void
}) {
  const guarded = (name: string, send: () => void) => () => {
    try {
      send()
    } catch (error) {
      options.onError(name, error)
    }
  }
  return {
    durable(record: DurableEvent) {
      const send = guarded(record.event.name, () => options.durable(record))
      if (record.event.name.startsWith('workspace.')) send()
      else queueMicrotask(send)
    },
    transient(event: EventEnvelope) {
      queueMicrotask(guarded(event.name, () => options.transient(event)))
    },
  }
}
