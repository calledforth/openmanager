import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { ProofEventSchemas, type InteractionKind } from '@openmanager/protocol/node'
import type { DurableProofEvent, TerminalEvent } from './event-repository.ts'

/**
 * What a turn's end closes (docs/sync-foundations.md §4.3, I3). Every child
 * still open when the turn ends gets its own close event, written before the
 * terminal event in the same transaction: a tool still running is
 * `cancelled`, a thought nothing closed is stopped, and a request nobody
 * answered is `interaction.cancelled`. The events are built from the rows
 * inside that transaction, so they close exactly what is open, and their ids
 * are derived from the terminal's, so a retried batch finds them again.
 */
export type TurnClosure = {
  /** The close events for a terminal that is about to be written. */
  closesFor(terminal: TerminalEvent): DurableProofEvent[]
  /** What a terminal that was already written closed, for a retried publish. */
  closedBy(terminalEventId: string): string[]
  /** The open children a terminal must not leave behind; empty when it may be written. */
  openChildren(turnId: string, threadId: string): string[]
}

/** A close event's id: the terminal's, the child's kind and the child's id. */
export function closeEventId(terminalEventId: string, kind: string, childId: string): string {
  return `${terminalEventId}:close:${kind}:${childId}`
}

type ActivityRow = { activity_id: string; kind: 'tool' | 'reasoning'; state_json: string }
type InteractionRow = { interaction_id: string; kind: InteractionKind }

/** A tool with no status, or one still `pending` or `in_progress`, is open. */
export function toolIsOpen(state: { status?: string }): boolean {
  return state.status === undefined || state.status === 'pending' || state.status === 'in_progress'
}

/** A thought is open until a `stop` closed it. */
export function reasoningIsOpen(state: { phase?: string }): boolean {
  return state.phase !== 'stop'
}

const statements = new WeakMap<
  DatabaseSync,
  { activity: StatementSync; interactions: StatementSync; closes: StatementSync }
>()

function prepared(database: DatabaseSync) {
  let cached = statements.get(database)
  if (!cached) {
    cached = {
      activity: database.prepare(
        `SELECT activity_id, kind, state_json FROM turn_activity
         WHERE turn_id = ? AND thread_id = ? ORDER BY ordinal`,
      ),
      interactions: database.prepare(
        `SELECT interaction_id, kind FROM interactions
         WHERE turn_id = ? AND state = 'pending' ORDER BY created_at, interaction_id`,
      ),
      // Close ids share the terminal's id as a prefix; the UNIQUE index on
      // event_id serves the range.
      closes: database.prepare(
        `SELECT event_id FROM event_log WHERE event_id >= ? AND event_id < ? ORDER BY sequence`,
      ),
    }
    statements.set(database, cached)
  }
  return cached
}

export function createTurnClosure(database: DatabaseSync): TurnClosure {
  const s = prepared(database)

  const openActivity = (turnId: string, threadId: string) =>
    (s.activity.all(turnId, threadId) as ActivityRow[]).filter((row) => {
      const state = JSON.parse(row.state_json) as { status?: string; phase?: string }
      return row.kind === 'tool' ? toolIsOpen(state) : reasoningIsOpen(state)
    })

  const pendingInteractions = (turnId: string) => s.interactions.all(turnId) as InteractionRow[]

  return {
    closesFor(terminal) {
      const { turnId } = terminal.payload
      const { threadId } = terminal.scope
      const base = { type: 'event' as const, timestamp: terminal.timestamp, scope: terminal.scope }
      const closes: DurableProofEvent[] = []
      for (const row of openActivity(turnId, threadId)) {
        closes.push(
          row.kind === 'tool'
            ? ProofEventSchemas['tool.updated'].parse({
                ...base,
                name: 'tool.updated',
                eventId: closeEventId(terminal.eventId, 'tool', row.activity_id),
                payload: { toolCallId: row.activity_id, turnId, status: 'cancelled' },
              })
            : ProofEventSchemas['message.reasoning'].parse({
                ...base,
                name: 'message.reasoning',
                eventId: closeEventId(terminal.eventId, 'reasoning', row.activity_id),
                payload: { messageId: row.activity_id, turnId, phase: 'stop' },
              }),
        )
      }
      const reason =
        terminal.name === 'turn.interrupted' && terminal.payload.reason === 'server_restarted'
          ? 'server_restarted'
          : 'turn_ended'
      const pending = pendingInteractions(turnId)
      pending.forEach((row, index) => {
        closes.push(
          ProofEventSchemas['interaction.cancelled'].parse({
            ...base,
            name: 'interaction.cancelled',
            eventId: closeEventId(terminal.eventId, 'interaction', row.interaction_id),
            payload: {
              turnId,
              response: {
                kind: row.kind,
                interactionId: row.interaction_id,
                outcome: { outcome: 'cancelled', reason },
              },
              // The turn waits until its last request is closed.
              turnState: index < pending.length - 1 ? 'waiting' : 'running',
            },
          }),
        )
      })
      return closes
    },

    closedBy(terminalEventId) {
      const prefix = `${terminalEventId}:close:`
      // ';' is the character after ':', so the range is exactly the prefix.
      const end = `${terminalEventId}:close;`
      return (s.closes.all(prefix, end) as { event_id: string }[]).map((row) => row.event_id)
    },

    openChildren(turnId, threadId) {
      return [
        ...openActivity(turnId, threadId).map((row) => `${row.kind} ${row.activity_id}`),
        ...pendingInteractions(turnId).map((row) => `${row.kind} ${row.interaction_id}`),
      ]
    },
  }
}
