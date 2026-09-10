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

export const STREAM_BATCH_MAX_BYTES = 16 * 1024
export const STREAM_BATCH_MAX_WAIT_MS = 100

type ThreadScope = Extract<SubscriptionScope, { type: 'thread' }>
type TerminalEvent = Extract<
  ProofEvent,
  { name: 'turn.completed' | 'turn.interrupted' | 'turn.failed' }
>

export interface EventRepositoryOptions {
  /** Host-owned provider identity, absent from the public session summary. */
  sessionProviderId?: (
    session: Extract<ProofEvent, { name: 'session.created' }>['payload']['session'],
  ) => string
  epoch?: string
  now?: () => number
  /** Test seam used to stop a child process after writes but before COMMIT. */
  beforeCommit?: () => void
}

export interface EventRepository {
  appendEvents(scope: SubscriptionScope, events: readonly ProofEvent[]): DurableEvent[]
  finalizeTurn(scope: ThreadScope, events: readonly ProofEvent[]): DurableEvent[]
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

  const write = (scope: SubscriptionScope, events: readonly ProofEvent[]): DurableEvent[] => {
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
      database
        .prepare(
          `INSERT INTO event_streams (
             scope_key, scope_type, session_id, thread_id, epoch, head_sequence,
             oldest_sequence, updated_at
           ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
           ON CONFLICT(scope_key) DO NOTHING`,
        )
        .run(
          key,
          scope.type,
          scope.type === 'environment' ? null : scope.sessionId,
          scope.type === 'thread' ? scope.threadId : null,
          newEpoch,
          writtenAt,
        )
      const stream = database
        .prepare('SELECT epoch, head_sequence FROM event_streams WHERE scope_key = ?')
        .get(key) as { epoch: string; head_sequence: number }
      const records: DurableEvent[] = []
      let head = stream.head_sequence
      for (const event of events) {
        const record = DurableEventSchema.parse({
          cursor: { scope, epoch: stream.epoch, sequence: head + 1 },
          event,
        })
        const existing = database
          .prepare('SELECT scope_key, sequence, event_json FROM event_log WHERE event_id = ?')
          .get(event.eventId) as
          { scope_key: string; sequence: number; event_json: string } | undefined
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
        database
          .prepare(
            `INSERT INTO event_log (
               scope_key, sequence, event_id, event_name, event_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            key,
            record.cursor.sequence,
            event.eventId,
            event.name,
            JSON.stringify(record.event),
            timestampMs(event.timestamp),
          )
        projectEvent(database, record.event, options)
        head = record.cursor.sequence
        records.push(record)
      }

      if (head !== stream.head_sequence) {
        database
          .prepare(
            `UPDATE event_streams
             SET head_sequence = ?, oldest_sequence = COALESCE(oldest_sequence, ?), updated_at = ?
             WHERE scope_key = ?`,
          )
          .run(head, stream.head_sequence + 1, writtenAt, key)
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

function isTerminal(event: ProofEvent): event is TerminalEvent {
  return (
    event.name === 'turn.completed' ||
    event.name === 'turn.interrupted' ||
    event.name === 'turn.failed'
  )
}

function eventTurnId(event: ProofEvent): string | undefined {
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
    case 'turn.notice':
      return event.payload.turnId
    default:
      return undefined
  }
}

function timestampMs(timestamp: string): number {
  return Date.parse(timestamp)
}

function projectEvent(
  database: DatabaseSync,
  event: ProofEvent,
  options: EventRepositoryOptions,
): void {
  const updatedAt = timestampMs(event.timestamp)
  switch (event.name) {
    case 'session.created': {
      const session = event.payload.session
      const providerId = options.sessionProviderId?.(session)
      if (!providerId?.trim()) {
        throw new Error('session.created requires a host sessionProviderId resolver')
      }
      database
        .prepare(
          `INSERT INTO sessions (
             session_id, workspace_id, provider_id, title, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
        )
        .run(
          session.sessionId,
          session.workspaceId,
          providerId,
          session.title,
          updatedAt,
          updatedAt,
        )
      return
    }
    case 'workspace.updated':
      database
        .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE workspace_id = ?')
        .run(event.payload.workspace.name, updatedAt, event.payload.workspace.workspaceId)
      return
    case 'session.updated':
      if (event.payload.title !== undefined) {
        database
          .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE session_id = ?')
          .run(event.payload.title, updatedAt, event.payload.sessionId)
      }
      return
    case 'session.deleted':
      database.prepare('DELETE FROM sessions WHERE session_id = ?').run(event.payload.sessionId)
      return
    case 'thread.created': {
      const session = database
        .prepare('SELECT workspace_id FROM sessions WHERE session_id = ?')
        .get(event.scope.sessionId) as { workspace_id: string } | undefined
      if (!session)
        throw new Error(`Cannot project thread for missing session ${event.scope.sessionId}`)
      database
        .prepare(
          `INSERT INTO threads (
             thread_id, session_id, workspace_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          event.payload.thread.threadId,
          event.scope.sessionId,
          session.workspace_id,
          updatedAt,
          updatedAt,
        )
      return
    }
    case 'turn.started':
      projectTurnStarted(database, event, updatedAt)
      return
    case 'message.delta':
      projectMessageDelta(database, event, updatedAt)
      return
    case 'interaction.requested': {
      const interaction = event.payload.interaction
      database
        .prepare(
          `INSERT INTO interactions (
             interaction_id, turn_id, kind, state, request_json, expires_at,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          interaction.interactionId,
          event.payload.turnId,
          interaction.kind,
          JSON.stringify(interaction),
          interaction.kind === 'permission' && interaction.expiresAt
            ? timestampMs(interaction.expiresAt)
            : null,
          updatedAt,
          updatedAt,
        )
      database
        .prepare("UPDATE turns SET state = 'waiting', updated_at = ? WHERE turn_id = ?")
        .run(updatedAt, event.payload.turnId)
      database
        .prepare("UPDATE sessions SET status = 'waiting', updated_at = ? WHERE session_id = ?")
        .run(updatedAt, event.scope.sessionId)
      return
    }
    case 'interaction.resolved':
      database
        .prepare(
          `UPDATE interactions
           SET state = 'resolved', response_json = ?, resolved_at = ?, updated_at = ?
           WHERE interaction_id = ?`,
        )
        .run(
          JSON.stringify(event.payload.response),
          updatedAt,
          updatedAt,
          event.payload.response.interactionId,
        )
      database
        .prepare("UPDATE turns SET state = 'running', updated_at = ? WHERE turn_id = ?")
        .run(updatedAt, event.payload.turnId)
      database
        .prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE session_id = ?")
        .run(updatedAt, event.scope.sessionId)
      return
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed': {
      const state =
        event.name === 'turn.completed'
          ? 'completed'
          : event.name === 'turn.interrupted'
            ? 'interrupted'
            : 'failed'
      const turnUpdate = database
        .prepare(
          `UPDATE turns
           SET state = ?, failure_reason = ?, finished_at = ?, updated_at = ?
           WHERE turn_id = ? AND thread_id = ?`,
        )
        .run(
          state,
          event.name === 'turn.failed' ? event.payload.reason : null,
          updatedAt,
          updatedAt,
          event.payload.turnId,
          event.scope.threadId,
        )
      if (turnUpdate.changes !== 1) {
        throw new Error(`Cannot finalize missing turn ${event.payload.turnId}`)
      }
      database
        .prepare('UPDATE messages SET is_final = 1, updated_at = ? WHERE turn_id = ?')
        .run(updatedAt, event.payload.turnId)
      const sessionUpdate = database
        .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?')
        .run(event.name === 'turn.failed' ? 'error' : 'idle', updatedAt, event.scope.sessionId)
      if (sessionUpdate.changes !== 1) {
        throw new Error(`Cannot finalize turn for missing session ${event.scope.sessionId}`)
      }
      return
    }
    case 'message.reasoning':
    case 'tool.updated':
    case 'turn.notice':
      return
  }
}

function projectTurnStarted(
  database: DatabaseSync,
  event: Extract<ProofEvent, { name: 'turn.started' }>,
  updatedAt: number,
): void {
  const thread = database
    .prepare('SELECT workspace_id FROM threads WHERE thread_id = ?')
    .get(event.scope.threadId) as { workspace_id: string } | undefined
  if (!thread) throw new Error(`Cannot project turn for missing thread ${event.scope.threadId}`)
  database
    .prepare(
      `INSERT INTO turns (
         turn_id, thread_id, workspace_id, state, started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.payload.turn.turnId,
      event.scope.threadId,
      thread.workspace_id,
      event.payload.turn.state,
      updatedAt,
      updatedAt,
    )
  insertMessage(database, event.payload.userMessage, thread.workspace_id, true, updatedAt)
  database
    .prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE session_id = ?")
    .run(updatedAt, event.scope.sessionId)
}

function projectMessageDelta(
  database: DatabaseSync,
  event: Extract<ProofEvent, { name: 'message.delta' }>,
  updatedAt: number,
): void {
  const turn = database
    .prepare('SELECT workspace_id FROM turns WHERE turn_id = ? AND thread_id = ?')
    .get(event.payload.turnId, event.scope.threadId) as { workspace_id: string } | undefined
  if (!turn) throw new Error(`Cannot project message for missing turn ${event.payload.turnId}`)
  const exists = database
    .prepare('SELECT 1 AS present FROM messages WHERE message_id = ?')
    .get(event.payload.messageId)
  if (!exists) {
    insertMessage(
      database,
      {
        messageId: event.payload.messageId,
        threadId: event.scope.threadId,
        turnId: event.payload.turnId,
        role: event.payload.role,
        content: [],
      },
      turn.workspace_id,
      false,
      updatedAt,
    )
  }
  appendContent(database, event.payload.messageId, event.payload.content, updatedAt)
  database
    .prepare('UPDATE messages SET updated_at = ? WHERE message_id = ?')
    .run(updatedAt, event.payload.messageId)
}

function insertMessage(
  database: DatabaseSync,
  message: Extract<ProofEvent, { name: 'turn.started' }>['payload']['userMessage'],
  workspaceId: string,
  isFinal: boolean,
  updatedAt: number,
): void {
  const ordinalRow = database
    .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM messages WHERE thread_id = ?')
    .get(message.threadId) as { ordinal: number }
  database
    .prepare(
      `INSERT INTO messages (
         message_id, workspace_id, thread_id, turn_id, role, ordinal, is_final,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      message.messageId,
      workspaceId,
      message.threadId,
      message.turnId,
      message.role,
      ordinalRow.ordinal,
      isFinal ? 1 : 0,
      updatedAt,
      updatedAt,
    )
  for (const content of message.content)
    appendContent(database, message.messageId, content, updatedAt)
}

function appendContent(
  database: DatabaseSync,
  messageId: string,
  content: Extract<ProofEvent, { name: 'message.delta' }>['payload']['content'],
  updatedAt: number,
): void {
  const last = database
    .prepare(
      `SELECT part_id, ordinal, part_type, content_json
       FROM message_parts WHERE message_id = ? ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(messageId) as
    { part_id: string; ordinal: number; part_type: string; content_json: string } | undefined
  if (content.type === 'text' && last?.part_type === 'text') {
    const previous = JSON.parse(last.content_json) as { type: 'text'; text: string }
    database
      .prepare('UPDATE message_parts SET content_json = ?, updated_at = ? WHERE part_id = ?')
      .run(
        JSON.stringify({ type: 'text', text: previous.text + content.text }),
        updatedAt,
        last.part_id,
      )
    return
  }
  database
    .prepare(
      `INSERT INTO message_parts (
         part_id, message_id, ordinal, part_type, content_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      messageId,
      (last?.ordinal ?? -1) + 1,
      content.type,
      JSON.stringify(content),
      updatedAt,
      updatedAt,
    )
}

export interface StreamingEventBatcherOptions {
  maxBytes?: number
  maxWaitMs?: number
  /** Timer failures retain the batch for the next flush, close, or append. */
  onError?: (error: unknown) => void
}

/** Route streaming batches through the matching atomic repository operation. */
export function createRepositoryEventBatcher(
  repository: EventRepository,
  publish: (records: readonly DurableEvent[]) => void = () => undefined,
  options: StreamingEventBatcherOptions = {},
) {
  return createStreamingEventBatcher((scope, events) => {
    const last = events.at(-1)
    const records =
      scope.type === 'thread' && last && isTerminal(last)
        ? repository.finalizeTurn(scope, events)
        : repository.appendEvents(scope, events)
    publish(records)
  }, options)
}

/**
 * Coalesce token-sized text deltas and flush on either the byte or time limit.
 * Non-stream events are ordering barriers and flush buffered deltas first.
 */
export function createStreamingEventBatcher(
  flush: (scope: SubscriptionScope, events: readonly ProofEvent[]) => void,
  options: StreamingEventBatcherOptions = {},
) {
  const maxBytes = options.maxBytes ?? STREAM_BATCH_MAX_BYTES
  const maxWaitMs = options.maxWaitMs ?? STREAM_BATCH_MAX_WAIT_MS
  let buffered: ProofEvent[] = []
  let pending: ProofEvent[] | undefined
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const flushBuffered = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (buffered.length === 0) return
    // Freeze the coalesced batch across retries, including publish-after-commit failures.
    pending ??= coalesceDeltas(buffered)
    flush(pending[0]!.scope, pending)
    pending = undefined
    buffered = []
    bytes = 0
  }

  return {
    append(event: ProofEvent) {
      // Finish a failed batch before accepting more input or changing its event IDs.
      if (pending) flushBuffered()
      const streamEvent = event.name === 'message.delta' || event.name === 'message.reasoning'
      if (isTerminal(event)) {
        if (buffered.length > 0 && !sameScope(buffered[0]!.scope, event.scope)) {
          flushBuffered()
        }
        buffered.push(event)
        flushBuffered()
        return
      }
      if (!streamEvent || (buffered.length > 0 && !sameScope(buffered[0]!.scope, event.scope))) {
        flushBuffered()
      }
      buffered.push(event)
      bytes += Buffer.byteLength(JSON.stringify(event.payload), 'utf8')
      if (!streamEvent || bytes >= maxBytes) flushBuffered()
      else if (!timer) {
        timer = setTimeout(() => {
          try {
            flushBuffered()
          } catch (error) {
            options.onError?.(error)
          }
        }, maxWaitMs)
      }
    },
    flush: flushBuffered,
    close: flushBuffered,
  }
}

function coalesceDeltas(events: readonly ProofEvent[]): ProofEvent[] {
  const result: ProofEvent[] = []
  for (const event of events) {
    const previous = result.at(-1)
    if (
      previous?.name === 'message.delta' &&
      event.name === 'message.delta' &&
      previous.payload.messageId === event.payload.messageId &&
      previous.payload.turnId === event.payload.turnId &&
      previous.payload.role === event.payload.role &&
      previous.payload.content.type === 'text' &&
      event.payload.content.type === 'text'
    ) {
      result[result.length - 1] = {
        ...previous,
        timestamp: event.timestamp,
        payload: {
          ...previous.payload,
          content: {
            type: 'text',
            text: previous.payload.content.text + event.payload.content.text,
          },
        },
      }
    } else if (
      previous?.name === 'message.reasoning' &&
      event.name === 'message.reasoning' &&
      previous.payload.messageId === event.payload.messageId &&
      previous.payload.turnId === event.payload.turnId &&
      previous.payload.phase === 'delta' &&
      event.payload.phase === 'delta' &&
      previous.payload.content?.type === 'text' &&
      event.payload.content?.type === 'text'
    ) {
      result[result.length - 1] = {
        ...previous,
        timestamp: event.timestamp,
        payload: {
          ...previous.payload,
          content: {
            type: 'text',
            text: previous.payload.content.text + event.payload.content.text,
          },
          ...(event.payload.tokens === undefined ? {} : { tokens: event.payload.tokens }),
        },
      }
    } else {
      result.push(event)
    }
  }
  return result
}
