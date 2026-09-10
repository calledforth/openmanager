import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  DurableEventSchema,
  sameScope,
  type DurableEvent,
  type ProofEvent,
  type SubscriptionScope,
} from '@openmanager/protocol/node'
import { createEventProjector, type EventProjectionOptions } from './event-projection.ts'

type ThreadScope = Extract<SubscriptionScope, { type: 'thread' }>
export type TerminalEvent = Extract<
  ProofEvent,
  { name: 'turn.completed' | 'turn.interrupted' | 'turn.failed' }
>
/** Events that receive durable cursors. `turn.notice` is transient and is never persisted. */
export type DurableProofEvent = Exclude<ProofEvent, { name: 'turn.notice' }>

export interface EventRepositoryOptions extends EventProjectionOptions {
  epoch?: string
  now?: () => number
  /** Test seam used to stop a child process after writes but before COMMIT. */
  beforeCommit?: () => void
}

export interface EventRepository {
  appendEvents(scope: SubscriptionScope, events: readonly DurableProofEvent[]): DurableEvent[]
  finalizeTurn(scope: ThreadScope, events: readonly DurableProofEvent[]): DurableEvent[]
}

interface StreamRow {
  epoch: string
  head_sequence: number
}

interface ExistingEventRow {
  scope_key: string
  sequence: number
  event_json: string
}

/**
 * Persist replay events and their relational projection in the same SQLite transaction.
 * Cursor allocation is read from the database, so it remains contiguous across restarts.
 */
export function createEventRepository(
  database: DatabaseSync,
  options: EventRepositoryOptions = {},
): EventRepository {
  const newEpoch = options.epoch ?? randomUUID()
  const now = options.now ?? Date.now
  const project = createEventProjector(database, options)
  const statements = {
    ensureStream: database.prepare(
      `INSERT INTO event_streams (
         scope_key, scope_type, session_id, thread_id, epoch, head_sequence,
         oldest_sequence, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
       ON CONFLICT(scope_key) DO NOTHING`,
    ),
    selectStream: database.prepare(
      'SELECT epoch, head_sequence FROM event_streams WHERE scope_key = ?',
    ),
    selectByEventId: database.prepare(
      'SELECT scope_key, sequence, event_json FROM event_log WHERE event_id = ?',
    ),
    insertEvent: database.prepare(
      `INSERT INTO event_log (
         scope_key, sequence, event_id, event_name, event_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    advanceHead: database.prepare(
      `UPDATE event_streams
       SET head_sequence = ?, oldest_sequence = COALESCE(oldest_sequence, ?), updated_at = ?
       WHERE scope_key = ?`,
    ),
  }

  const write = (
    scope: SubscriptionScope,
    events: readonly DurableProofEvent[],
  ): DurableEvent[] => {
    if (events.length === 0) return []
    for (const event of events) {
      if (!sameScope(scope, event.scope)) {
        throw new Error('Every appended event must belong to the requested scope')
      }
    }

    const key = scopeKey(scope)
    database.exec('BEGIN IMMEDIATE')
    try {
      const writtenAt = now()
      statements.ensureStream.run(
        key,
        scope.type,
        scope.type === 'environment' ? null : scope.sessionId,
        scope.type === 'thread' ? scope.threadId : null,
        newEpoch,
        writtenAt,
      )
      // The row exists: ensureStream inserted it inside this same transaction.
      const stream = statements.selectStream.get(key) as StreamRow | undefined
      if (!stream) throw new Error(`Event stream ${key} vanished inside its transaction`)
      const records: DurableEvent[] = []
      let head = stream.head_sequence
      for (const event of events) {
        const record = DurableEventSchema.parse({
          cursor: { scope, epoch: stream.epoch, sequence: head + 1 },
          event,
        })
        const existing = statements.selectByEventId.get(event.eventId) as
          | ExistingEventRow
          | undefined
        if (existing) {
          const storedEvent: unknown = JSON.parse(existing.event_json)
          if (existing.scope_key !== key || !isDeepStrictEqual(storedEvent, record.event)) {
            throw new Error(`Event ID ${event.eventId} already belongs to a different event`)
          }
          records.push(
            DurableEventSchema.parse({
              cursor: { scope, epoch: stream.epoch, sequence: existing.sequence },
              event: storedEvent,
            }),
          )
          continue
        }
        statements.insertEvent.run(
          key,
          record.cursor.sequence,
          event.eventId,
          event.name,
          JSON.stringify(record.event),
          Date.parse(event.timestamp),
        )
        project(event)
        head = record.cursor.sequence
        records.push(record)
      }

      if (head !== stream.head_sequence) {
        statements.advanceHead.run(head, stream.head_sequence + 1, writtenAt, key)
      }
      options.beforeCommit?.()
      database.exec('COMMIT')
      return records
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // A killed process or a failed COMMIT may already have ended the transaction.
      }
      throw error
    }
  }

  return {
    appendEvents: write,
    finalizeTurn(scope, events) {
      const terminal = events.at(-1)
      if (!terminal || !isTerminal(terminal)) {
        throw new Error('finalizeTurn requires a terminal turn event as the final event')
      }
      if (events.slice(0, -1).some(isTerminal)) {
        throw new Error('finalizeTurn accepts exactly one terminal turn event')
      }
      const terminalTurnId = terminal.payload.turnId
      if (
        events.some(
          (event) => eventTurnId(event) !== undefined && eventTurnId(event) !== terminalTurnId,
        )
      ) {
        throw new Error('finalizeTurn events must all belong to the terminal turn')
      }
      return write(scope, events)
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

export function isTerminal(event: ProofEvent): event is TerminalEvent {
  return (
    event.name === 'turn.completed' ||
    event.name === 'turn.interrupted' ||
    event.name === 'turn.failed'
  )
}

function eventTurnId(event: DurableProofEvent): string | undefined {
  switch (event.name) {
    case 'turn.started':
      return event.payload.turn.turnId
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
    case 'message.delta':
    case 'message.reasoning':
    case 'tool.updated':
    case 'interaction.requested':
    case 'interaction.resolved':
      return event.payload.turnId
    default:
      return undefined
  }
}
