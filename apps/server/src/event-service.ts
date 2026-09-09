import { randomUUID } from 'node:crypto'
import {
  DurableEventSchema,
  type DurableEvent,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'

export type AppendProtocolEvent = (record: DurableEvent) => void

/**
 * Assign host-owned, scope-local cursors before the persistence boundary.
 *
 * The callback is the SQLite insertion seam: it receives a fully validated
 * record and must append it before publishing it to subscribers.
 */
export function createEventService(
  append: AppendProtocolEvent,
  epoch: string = randomUUID(),
) {
  const sequences = new Map<string, number>()

  return {
    append(event: ProofEvent): DurableEvent {
      const key = scopeKey(event.scope)
      const sequence = (sequences.get(key) ?? 0) + 1
      const record = DurableEventSchema.parse({
        cursor: { scope: event.scope, epoch, sequence },
        event,
      })
      append(record)
      sequences.set(key, sequence)
      return record
    },
  }
}

function scopeKey(scope: SubscriptionScope): string {
  switch (scope.type) {
    case 'environment':
      return `environment:${scope.environmentId}`
    case 'session':
      return `session:${scope.environmentId}:${scope.sessionId}`
    case 'thread':
      return `thread:${scope.environmentId}:${scope.sessionId}:${scope.threadId}`
  }
}
