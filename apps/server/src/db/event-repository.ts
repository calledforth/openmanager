import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { ProjectionRefusal } from './write-errors.ts'
import {
  DurableEventSchema,
  ProofEventSchemas,
  sameScope,
  type Cursor,
  type DurableEvent,
  type ProofEvent,
  type SubscriptionScope,
  type SessionStatus,
} from '@openmanager/protocol/node'
import { createEventProjector } from './event-projection.ts'
import { EVENT_TOMBSTONE_SQL } from './queries.ts'
import { readSessionActivity, type SessionActivity } from './session-activity.ts'
import { createTurnClosure } from './turn-closure.ts'
import { readWorkspace } from './workspace-rows.ts'

type ThreadScope = Extract<SubscriptionScope, { type: 'thread' }>
export type TerminalEvent = Extract<
  ProofEvent,
  { name: 'turn.completed' | 'turn.interrupted' | 'turn.failed' }
>
/** Events that receive durable cursors. `turn.notice` is transient and is never persisted. */
export type DurableProofEvent = Exclude<ProofEvent, { name: 'turn.notice' }>

export interface EventRepositoryOptions {
  epoch?: string
  now?: () => number
  /**
   * Test seams around every write, with the records it commits: `beforeCommit`
   * runs after every write of the transaction and just before COMMIT,
   * `afterCommit` just after it. A test stops a child process in either to
   * prove the rows and the log are both present or both absent.
   */
  beforeCommit?: (records: readonly DurableEvent[]) => void
  afterCommit?: (records: readonly DurableEvent[]) => void
}

/** Events for one scope; several groups may commit in one transaction. */
export interface EventGroup {
  scope: SubscriptionScope
  events: readonly DurableProofEvent[]
}

/**
 * Host-private facts that ride one write, never an event: they are no
 * client's business (docs/sync-foundations.md I1).
 */
export interface WriteOptions {
  /**
   * The provider's own session id of a session this write creates, by host
   * session id. The `session.created` projection stores it with the row, so
   * a child session is never durable without the identity it resumes by
   * (§4.7.4 (e)). Every key must name a session the same write creates.
   */
  identities?: Readonly<Record<string, string>>
}

export interface EventRepository {
  appendEvents(scope: SubscriptionScope, events: readonly DurableProofEvent[]): DurableEvent[]
  /** Commit several scopes' events together, in order: all or none become durable. */
  appendGroups(groups: readonly EventGroup[], options?: WriteOptions): DurableEvent[]
  finalizeTurn(scope: ThreadScope, events: readonly DurableProofEvent[]): DurableEvent[]
  /**
   * The last committed record of a scope, or sequence 0 of this process's
   * epoch for a scope with no stream yet, as the replay reader answers it.
   */
  head(scope: SubscriptionScope): Cursor
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
  const project = createEventProjector(database)
  const closure = createTurnClosure(database)
  const statements = {
    sessionStatus: database.prepare(
      `SELECT session_id, workspace_id, status, updated_at, settled_at, done_at, background_tasks_json
       FROM sessions WHERE session_id = ?`,
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
    selectSessionWorkspace: database.prepare(
      'SELECT workspace_id FROM sessions WHERE session_id = ?',
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

  const readStatus = (
    sessionId: string,
  ): (SessionStatusRow & { activity: SessionActivity }) | undefined => {
    const row = statements.sessionStatus.get(sessionId) as SessionStatusRow | undefined
    return row ? { ...row, activity: readSessionActivity(database, row) } : undefined
  }

  /**
   * The sessions one transaction touches, for the status pass that runs once
   * every group of it is projected (docs/sync-foundations.md §4.3, §4.7.8).
   * `announced` starts as the row before the first event that touched the
   * session, and takes in whatever the transaction's own `session.updated`
   * events state, so the pass only says what nothing in the transaction said.
   */
  type Tracked = {
    environmentId: string
    announced: StatusState
    lastEventId: string
    lastTimestamp: string
  }
  /**
   * One transaction's state, passed down its writes rather than kept between
   * them: the sessions it touched, and the status records of retried events,
   * re-published with their original cursors. Derived writes pass none: they
   * state the pass itself.
   */
  type Transaction = {
    tracked: Map<string, Tracked>
    workspaces: Map<string, TrackedWorkspace>
    retriedStatus: { environmentId: string; event: DurableProofEvent }[]
  }
  /**
   * A workspace whose sessions or row one transaction touches, for the
   * recency pass (§4.4, §4.7.1). `announced` starts as its `lastActivityAt`
   * before the first such event and takes in what the transaction's own
   * `workspace.updated` events state.
   */
  type TrackedWorkspace = {
    environmentId: string
    announced: string | null
    removed: boolean
    lastEventId: string
    lastTimestamp: string
  }

  /** The workspace an event can move the recency of, read before it is projected. */
  const recencyWorkspaceOf = (event: DurableProofEvent, session?: string): string | undefined => {
    switch (event.name) {
      case 'workspace.updated':
        return event.payload.workspace.workspaceId
      case 'workspace.removed':
        return event.payload.workspaceId
      case 'session.created':
        return event.payload.session.workspaceId
      case 'session.deleted':
        session = event.payload.sessionId
    }
    if (!session) return undefined
    const row = statements.selectSessionWorkspace.get(session) as
      { workspace_id: string } | undefined
    return row?.workspace_id
  }

  const writeScope = (
    scope: SubscriptionScope,
    events: readonly DurableProofEvent[],
    writtenAt: number,
    transaction?: Transaction,
    writeOptions?: WriteOptions,
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
    const replayStatus = (event: DurableProofEvent) => {
      if (!transaction) return
      for (const suffix of DERIVED_SUFFIXES) {
        const derived = statements.selectByEventId.get(`${event.eventId}${suffix}`) as
          ExistingEventRow | undefined
        if (derived) {
          transaction.retriedStatus.push({
            environmentId: scope.environmentId,
            event: JSON.parse(derived.event_json) as DurableProofEvent,
          })
        }
      }
    }
    let head = stream.head_sequence
    // A turn's end closes what the turn left open, before the terminal and in
    // its transaction (turn-closure.ts). The closes are read from the rows
    // when the terminal is reached, so a child the same batch already closed
    // is not closed twice. A terminal already written brings back the closes
    // it wrote, so a retried publish carries them again with their cursors.
    const queue: DurableProofEvent[] = [...events]
    const closed = new Set<string>()
    for (let index = 0; index < queue.length; index++) {
      const event = queue[index]!
      if (scope.type === 'thread' && isTerminal(event) && !closed.has(event.eventId)) {
        closed.add(event.eventId)
        const written =
          statements.selectByEventId.get(event.eventId) !== undefined ||
          statements.selectTombstone.get(event.eventId) !== undefined
        const closes = written
          ? closure.closedBy(event.eventId).map((eventId) => {
              const row = statements.selectByEventId.get(eventId) as unknown as ExistingEventRow
              return JSON.parse(row.event_json) as DurableProofEvent
            })
          : closure.closesFor(event)
        if (closes.length > 0) {
          queue.splice(index, 0, ...closes)
          index -= 1
          continue
        }
      }
      const record = DurableEventSchema.parse({
        cursor: { scope, epoch: stream.epoch, sequence: head + 1 },
        event,
      })
      const existing = statements.selectByEventId.get(event.eventId) as ExistingEventRow | undefined
      if (existing) {
        const storedEvent: unknown = JSON.parse(existing.event_json)
        if (existing.scope_key !== key || !isDeepStrictEqual(storedEvent, record.event)) {
          throw new ProjectionRefusal(
            `Event ID ${event.eventId} already belongs to a different event`,
          )
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
          throw new ProjectionRefusal(
            `Event ID ${event.eventId} already belongs to a different event`,
          )
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
      const sessionId = transaction ? statusSessionOf(event) : undefined
      let entry = sessionId ? transaction!.tracked.get(sessionId) : undefined
      if (sessionId && !entry) {
        const before = readStatus(sessionId)
        if (before) {
          entry = {
            environmentId: scope.environmentId,
            announced: before,
            lastEventId: event.eventId,
            lastTimestamp: event.timestamp,
          }
          transaction!.tracked.set(sessionId, entry)
        }
      }
      const workspaceId = transaction ? recencyWorkspaceOf(event, sessionId) : undefined
      let place = workspaceId ? transaction!.workspaces.get(workspaceId) : undefined
      if (workspaceId && !place) {
        place = {
          environmentId: scope.environmentId,
          announced: readWorkspace(database, workspaceId)?.lastActivityAt ?? null,
          removed: false,
          lastEventId: event.eventId,
          lastTimestamp: event.timestamp,
        }
        transaction!.workspaces.set(workspaceId, place)
      }
      project(event, writeOptions)
      if (place) {
        place.lastEventId = event.eventId
        place.lastTimestamp = event.timestamp
        if (event.name === 'workspace.updated') {
          place.announced = event.payload.workspace.lastActivityAt
          place.removed = false
        }
        if (event.name === 'workspace.removed') place.removed = true
      }
      if (entry) {
        entry.lastEventId = event.eventId
        entry.lastTimestamp = event.timestamp
        if (event.name === 'session.updated') entry.announced = stated(entry.announced, event)
      }
      head = record.cursor.sequence
      records.push(record)
    }

    if (head !== stream.head_sequence) {
      statements.advanceHead.run(head, stream.head_sequence + 1, writtenAt, key)
    }
    return records
  }

  /**
   * Once per session per transaction: one `session.updated` for whatever the
   * transaction changed in the session's status, activity, settling or done
   * time that its own events did not already state. It commits with the rows,
   * so clients subscribed only to the environment see the status without
   * loading thread history, and a batch that closes a question and then ends
   * the turn publishes one change, not two.
   */
  const deriveStatus = (transaction: Transaction, writtenAt: number): DurableEvent[] => {
    const byEnvironment = new Map<string, DurableProofEvent[]>()
    const add = (environmentId: string, event: DurableProofEvent) => {
      const list = byEnvironment.get(environmentId) ?? []
      list.push(event)
      byEnvironment.set(environmentId, list)
    }
    for (const { environmentId, event } of transaction.retriedStatus) add(environmentId, event)
    for (const [sessionId, entry] of transaction.tracked) {
      const after = readStatus(sessionId)
      if (!after) continue
      const before = entry.announced
      // Activity that unsettles a session rides the same event as its status.
      const unsettled = before.settled_at !== null && after.settled_at === null
      // Done rides it too: set when a turn completes, cleared when the next starts.
      const doneChanged = before.done_at !== after.done_at
      // So does what the status alone does not say: a second request can
      // change what a session waits on, and a turn ending or starting can
      // leave it running only for its background work, or no longer.
      const activityChanged =
        before.activity.waitingOn !== after.activity.waitingOn ||
        before.activity.inBackground !== after.activity.inBackground
      // And so does the session's place in the list (§4.7.1): every move of
      // `updated_at` is announced, a second request while waiting included.
      const moved = before.updated_at !== after.updated_at
      if (
        before.status === after.status &&
        !unsettled &&
        !doneChanged &&
        !activityChanged &&
        !moved
      ) {
        continue
      }
      add(
        entry.environmentId,
        ProofEventSchemas['session.updated'].parse({
          type: 'event',
          name: 'session.updated',
          eventId: `${entry.lastEventId}:status`,
          timestamp: entry.lastTimestamp,
          scope: { type: 'environment', environmentId: entry.environmentId },
          payload: {
            sessionId,
            status: after.status,
            updatedAt: new Date(after.updated_at).toISOString(),
            // Only when they apply: a status without them clears them.
            ...after.activity,
            ...(unsettled ? { settledAt: null } : {}),
            ...(doneChanged
              ? { doneAt: after.done_at === null ? null : new Date(after.done_at).toISOString() }
              : {}),
          },
        }),
      )
    }
    // A workspace's recency follows its sessions and its own last use, read
    // from the rows with the registry's own reader. Announced when it moved,
    // backwards too: deleting the newest session lowers it.
    for (const [workspaceId, place] of transaction.workspaces) {
      if (place.removed) continue
      const workspace = readWorkspace(database, workspaceId)
      if (!workspace || workspace.lastActivityAt === place.announced) continue
      add(
        place.environmentId,
        ProofEventSchemas['workspace.updated'].parse({
          type: 'event',
          name: 'workspace.updated',
          eventId: `${place.lastEventId}:recency`,
          timestamp: place.lastTimestamp,
          scope: { type: 'environment', environmentId: place.environmentId },
          payload: { workspace },
        }),
      )
    }
    // The derived records are written with no transaction state: they state
    // the pass itself.
    return [...byEnvironment].flatMap(([environmentId, events]) =>
      writeScope({ type: 'environment', environmentId }, events, writtenAt),
    )
  }

  const write = (groups: readonly EventGroup[], writeOptions?: WriteOptions): DurableEvent[] => {
    const pending = groups.filter((group) => group.events.length > 0)
    if (pending.length === 0) return []
    for (const { scope, events } of pending) {
      for (const event of events) {
        if (!sameScope(scope, event.scope)) {
          throw new ProjectionRefusal('Every appended event must belong to the requested scope')
        }
      }
    }
    if (writeOptions?.identities) {
      const created = new Set(
        pending.flatMap(({ events }) =>
          events.flatMap((event) =>
            event.name === 'session.created' ? [event.payload.session.sessionId] : [],
          ),
        ),
      )
      for (const sessionId of Object.keys(writeOptions.identities)) {
        if (!created.has(sessionId)) {
          throw new ProjectionRefusal(
            `An identity was given for session ${sessionId}, which this write does not create`,
          )
        }
      }
    }
    database.exec('BEGIN IMMEDIATE')
    try {
      const writtenAt = now()
      const transaction: Transaction = {
        tracked: new Map(),
        workspaces: new Map(),
        retriedStatus: [],
      }
      const records = pending.flatMap(({ scope, events }) =>
        writeScope(scope, events, writtenAt, transaction, writeOptions),
      )
      records.push(...deriveStatus(transaction, writtenAt))
      options.beforeCommit?.(records)
      database.exec('COMMIT')
      options.afterCommit?.(records)
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
    head(scope) {
      const row = statements.selectStream.get(scopeKey(scope)) as StreamRow | undefined
      return row
        ? { scope, epoch: row.epoch, sequence: row.head_sequence }
        : { scope, epoch: newEpoch, sequence: 0 }
    },
    appendEvents: (scope, events) => write([{ scope, events }]),
    appendGroups: (groups, options) => write(groups, options),
    finalizeTurn(scope, events) {
      const terminal = events.at(-1)
      if (!terminal || !isTerminal(terminal)) {
        throw new ProjectionRefusal(
          'finalizeTurn requires a terminal turn event as the final event',
        )
      }
      if (events.slice(0, -1).some(isTerminal)) {
        throw new ProjectionRefusal('finalizeTurn accepts exactly one terminal turn event')
      }
      const terminalTurnId = terminal.payload.turnId
      if (
        events.some(
          (event) => eventTurnId(event) !== undefined && eventTurnId(event) !== terminalTurnId,
        )
      ) {
        throw new ProjectionRefusal('finalizeTurn events must all belong to the terminal turn')
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

/** The ids of a source event's derived records: its session's status, its workspace's recency. */
const DERIVED_SUFFIXES = [':status', ':recency'] as const

/** Whether the repository's own pass wrote this record, rather than a producer. */
export function isDerivedRecord(event: { eventId: string }): boolean {
  return DERIVED_SUFFIXES.some((suffix) => event.eventId.endsWith(suffix))
}

type SessionStatusRow = {
  session_id: string
  workspace_id: string
  status: SessionStatus
  updated_at: number
  settled_at: number | null
  done_at: number | null
  background_tasks_json: string | null
}

type StatusState = SessionStatusRow & { activity: SessionActivity }

/**
 * The session an event can change the status of: a turn's start and end and
 * every request event, and any `session.updated` (a background roster moves a
 * resting session between idle and running; a producer may state a status).
 */
function statusSessionOf(event: ProofEvent): string | undefined {
  if (event.scope.type === 'thread') {
    return event.name === 'turn.started' ||
      isTerminal(event) ||
      event.name === 'interaction.requested' ||
      event.name === 'interaction.resolved' ||
      event.name === 'interaction.expired' ||
      event.name === 'interaction.cancelled'
      ? event.scope.sessionId
      : undefined
  }
  return event.name === 'session.updated' ? event.payload.sessionId : undefined
}

/** What a `session.updated` itself states, laid over what was known before it. */
function stated(
  before: StatusState,
  event: Extract<ProofEvent, { name: 'session.updated' }>,
): StatusState {
  const { status, updatedAt, settledAt, doneAt, waitingOn, inBackground } = event.payload
  return {
    ...before,
    ...(updatedAt === undefined ? {} : { updated_at: Date.parse(updatedAt) }),
    ...(status === undefined
      ? {}
      : {
          status,
          // A status says what goes with it; one that leaves these out clears them.
          activity: {
            ...(waitingOn ? { waitingOn } : {}),
            ...(inBackground ? { inBackground: true as const } : {}),
          },
        }),
    ...(settledAt === undefined
      ? {}
      : { settled_at: settledAt === null ? null : Date.parse(settledAt) }),
    ...(doneAt === undefined ? {} : { done_at: doneAt === null ? null : Date.parse(doneAt) }),
  }
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
    case 'interaction.cancelled':
      return event.payload.turnId
    default:
      return undefined
  }
}
