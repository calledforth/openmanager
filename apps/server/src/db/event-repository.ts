import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  DurableEventSchema,
  ProofEventSchemas,
  sameScope,
  type DurableEvent,
  type ProofEvent,
  type SubscriptionScope,
  type SessionStatus,
} from '@openmanager/protocol/node'
import { createEventProjector, type EventProjectionOptions } from './event-projection.ts'
import { EVENT_TOMBSTONE_SQL } from './queries.ts'

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

/** Events for one scope; several groups may commit in one transaction. */
export interface EventGroup {
  scope: SubscriptionScope
  events: readonly DurableProofEvent[]
}

export interface EventRepository {
  appendEvents(scope: SubscriptionScope, events: readonly DurableProofEvent[]): DurableEvent[]
  /** Commit several scopes' events together, in order: all or none become durable. */
  appendGroups(groups: readonly EventGroup[]): DurableEvent[]
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

interface TombstoneRow {
  scope_key: string
  sequence: number
  event_hash: Uint8Array
}

/** Stable digest of a serialized event, shared with retention's tombstone writer. */
export function hashEvent(eventJson: string): Buffer {
  return createHash('sha256').update(eventJson).digest()
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
    sessionStatus: database.prepare(
      'SELECT status, settled_at, done_at FROM sessions WHERE session_id = ?',
    ),
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
    selectTombstone: database.prepare(EVENT_TOMBSTONE_SQL),
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

  const writeScope = (
    scope: SubscriptionScope,
    events: readonly DurableProofEvent[],
    writtenAt: number,
  ): DurableEvent[] => {
    const key = scopeKey(scope)
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
    const statusEvents: DurableProofEvent[] = []
    const replayStatus = (event: DurableProofEvent) => {
      if (!changesSessionStatus(event)) return
      const statusRecord = statements.selectByEventId.get(`${event.eventId}:status`) as
        ExistingEventRow | undefined
      if (statusRecord) statusEvents.push(JSON.parse(statusRecord.event_json) as DurableProofEvent)
    }
    let head = stream.head_sequence
    for (const event of events) {
      const record = DurableEventSchema.parse({
        cursor: { scope, epoch: stream.epoch, sequence: head + 1 },
        event,
      })
      const existing = statements.selectByEventId.get(event.eventId) as ExistingEventRow | undefined
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
        // A publisher can fail after COMMIT. Retry the accompanying status
        // record too, with its original cursor, instead of losing the broadcast.
        replayStatus(event)
        continue
      }
      // The event may have been pruned by retention; its tombstone still carries
      // the original cursor and a payload hash, so a late retry deduplicates.
      const tombstone = statements.selectTombstone.get(event.eventId) as TombstoneRow | undefined
      if (tombstone) {
        const serialized = JSON.stringify(record.event)
        if (
          tombstone.scope_key !== key ||
          !hashEvent(serialized).equals(Buffer.from(tombstone.event_hash))
        ) {
          throw new Error(`Event ID ${event.eventId} already belongs to a different event`)
        }
        records.push(
          DurableEventSchema.parse({
            cursor: { scope, epoch: stream.epoch, sequence: tombstone.sequence },
            event: record.event,
          }),
        )
        replayStatus(event)
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
      const sessionId =
        changesSessionStatus(event) && event.scope.type === 'thread'
          ? event.scope.sessionId
          : undefined
      const before = sessionId
        ? (statements.sessionStatus.get(sessionId) as SessionStatusRow | undefined)
        : undefined
      project(event)
      const after = sessionId
        ? (statements.sessionStatus.get(sessionId) as SessionStatusRow | undefined)
        : undefined
      // Activity that unsettles a session rides the same environment event as
      // its status, so a sidebar that never loads the thread still sees it.
      const unsettled = !!before?.settled_at && after?.settled_at === null
      // Done rides it too: set when a turn completes, cleared when the next starts.
      const doneChanged = !!before && !!after && before.done_at !== after.done_at
      if (
        sessionId &&
        before &&
        after &&
        (before.status !== after.status || unsettled || doneChanged)
      ) {
        statusEvents.push(
          ProofEventSchemas['session.updated'].parse({
            type: 'event',
            name: 'session.updated',
            eventId: `${event.eventId}:status`,
            timestamp: event.timestamp,
            scope: { type: 'environment', environmentId: scope.environmentId },
            payload: {
              sessionId,
              status: after.status,
              ...(unsettled ? { settledAt: null } : {}),
              ...(doneChanged
                ? { doneAt: after.done_at === null ? null : new Date(after.done_at).toISOString() }
                : {}),
            },
          }),
        )
      }
      head = record.cursor.sequence
      records.push(record)
    }

    if (head !== stream.head_sequence) {
      statements.advanceHead.run(head, stream.head_sequence + 1, writtenAt, key)
    }
    // Both streams and the session row commit together. Clients subscribed
    // only to the environment receive status without loading thread history.
    if (statusEvents.length > 0) {
      records.push(
        ...writeScope(
          { type: 'environment', environmentId: scope.environmentId },
          statusEvents,
          writtenAt,
        ),
      )
    }
    return records
  }

  const write = (groups: readonly EventGroup[]): DurableEvent[] => {
    const pending = groups.filter((group) => group.events.length > 0)
    if (pending.length === 0) return []
    for (const { scope, events } of pending) {
      for (const event of events) {
        if (!sameScope(scope, event.scope)) {
          throw new Error('Every appended event must belong to the requested scope')
        }
      }
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      const writtenAt = now()
      const records = pending.flatMap(({ scope, events }) => writeScope(scope, events, writtenAt))
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
    appendEvents: (scope, events) => write([{ scope, events }]),
    appendGroups: write,
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
      return write([{ scope, events }])
    },
  }
}

/** The `event_streams` / `event_log` key of a scope; shared with the replay reader. */
export function scopeKey(scope: SubscriptionScope): string {
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

type SessionStatusRow = {
  status: SessionStatus
  settled_at: number | null
  done_at: number | null
}

function changesSessionStatus(event: ProofEvent): boolean {
  return (
    event.name === 'turn.started' ||
    isTerminal(event) ||
    event.name === 'interaction.requested' ||
    event.name === 'interaction.resolved' ||
    event.name === 'interaction.expired'
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
    case 'interaction.expired':
      return event.payload.turnId
    default:
      return undefined
  }
}
