import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  DurableEventSchema,
  sameScope,
  type DurableEvent,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import {
  createEventRepository,
  isTerminal,
  type DurableProofEvent,
  type EventGroup,
  type EventRepositoryOptions,
} from './db/event-repository.ts'
import {
  createRepositoryEventBatcher,
  type StreamingEventBatcherOptions,
} from './db/event-batcher.ts'

export type AppendProtocolEvent = (record: DurableEvent) => void

/**
 * Assign host-owned, scope-local cursors before the persistence boundary.
 *
 * The callback is the SQLite insertion seam: it receives a fully validated
 * record and must append it before publishing it to subscribers.
 */
export function createEventService(append: AppendProtocolEvent, epoch: string = randomUUID()) {
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
      return JSON.stringify([scope.type, scope.environmentId])
    case 'session':
      return JSON.stringify([scope.type, scope.environmentId, scope.sessionId])
    case 'thread':
      return JSON.stringify([scope.type, scope.environmentId, scope.sessionId, scope.threadId])
  }
}

/** Production boundary: coalesce first, allocate persisted cursors, commit, then publish. */
export function createPersistentEventService(
  database: DatabaseSync,
  publish: AppendProtocolEvent,
  options: EventRepositoryOptions & StreamingEventBatcherOptions = {},
) {
  const repository = createEventRepository(database, options)
  const batcher = createRepositoryEventBatcher(
    repository,
    (records) => records.forEach(publish),
    options,
  )
  const durable = (event: ProofEvent): DurableProofEvent => {
    if (event.name === 'turn.notice') throw new Error('turn.notice is transient')
    return event
  }
  return {
    append(event: ProofEvent) {
      batcher.append(durable(event))
    },
    /**
     * Commit host-owned events together, after anything already buffered, so
     * a session never becomes durable without its thread. Terminal turn events
     * keep going through `append`, which routes them to turn finalization.
     */
    appendAtomic(events: readonly ProofEvent[]) {
      const groups: { scope: SubscriptionScope; events: DurableProofEvent[] }[] = []
      for (const event of events.map(durable)) {
        if (isTerminal(event)) throw new Error('Terminal turn events are appended one at a time')
        const last = groups.at(-1)
        if (last && sameScope(last.scope, event.scope)) last.events.push(event)
        else groups.push({ scope: event.scope, events: [event] })
      }
      batcher.flush()
      repository.appendGroups(groups satisfies readonly EventGroup[]).forEach(publish)
    },
    flush: batcher.flush,
    close: batcher.close,
  }
}
