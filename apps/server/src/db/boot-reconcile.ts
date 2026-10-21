import type { DatabaseSync } from 'node:sqlite'
import { ProofEventSchemas, type SubscriptionScope } from '@openmanager/protocol/node'
import type { DurableEvent } from '@openmanager/protocol/node'
import type { DurableProofEvent, EventRepository } from './event-repository.ts'
import { reasoningIsOpen, toolIsOpen } from './turn-closure.ts'

type ThreadScope = Extract<SubscriptionScope, { type: 'thread' }>

/** What one boot's reconcile did, for the log and for the boot-on-a-copy report. */
export interface BootReconcileReport {
  turnsRecovered: number
  toolsCancelled: number
  thoughtsClosed: number
  questionsCancelled: number
  /** Threads whose ended turns the legacy repair closed children in (one transaction each). */
  threadsRepaired: number
  eventsWritten: number
  /** Turns or threads whose write failed: left as they are, retried next boot. */
  failures: { kind: 'recovery' | 'repair'; ids: Record<string, string>; reason: string }[]
  durationMs: number
}

type OpenTurnRow = { turn_id: string; thread_id: string; session_id: string }
type LegacyChildRow = {
  activity_id: string
  kind: 'tool' | 'reasoning'
  state_json: string
  turn_id: string
  thread_id: string
  session_id: string
}

/**
 * Run once per boot, before the server listens, after the event service and
 * the environment id exist (docs/sync-foundations.md §4.1, §4.2). Every change
 * is an ordinary event through the repository, on the existing streams, so a
 * client resuming from its bookmark replays exactly what changed.
 *
 * 1. **Recovery.** A turn the last process left `running` or `waiting` cannot
 *    still be live. Each gets `turn.interrupted {reason: 'server_restarted'}`
 *    through the terminal path, which first closes every open tool, thought
 *    and request (turn-closure.ts), in one transaction per turn.
 * 2. **The legacy repair.** Turns that ended before servers closed their
 *    children still have open tools and thoughts. One transaction per thread
 *    writes their closes, with ids derived from the child, so a second run
 *    finds nothing to do.
 *
 * A turn or thread whose write fails is logged with its ids and left as it is
 * for the next boot; the boot goes on, so a bad row cannot cause a crash loop.
 */
export function reconcileAfterRestart(
  database: DatabaseSync,
  repository: Pick<EventRepository, 'appendEvents' | 'finalizeTurn'>,
  environmentId: string,
  now: () => number = Date.now,
): BootReconcileReport {
  const started = performance.now()
  const report: BootReconcileReport = {
    turnsRecovered: 0,
    toolsCancelled: 0,
    thoughtsClosed: 0,
    questionsCancelled: 0,
    threadsRepaired: 0,
    eventsWritten: 0,
    failures: [],
    durationMs: 0,
  }
  const count = (records: readonly DurableEvent[]) => {
    report.eventsWritten += records.length
    for (const { event } of records) {
      if (event.name === 'tool.updated') report.toolsCancelled += 1
      else if (event.name === 'message.reasoning') report.thoughtsClosed += 1
      else if (event.name === 'interaction.cancelled') report.questionsCancelled += 1
    }
  }
  const scopeOf = (row: { session_id: string; thread_id: string }): ThreadScope => ({
    type: 'thread',
    environmentId,
    sessionId: row.session_id,
    threadId: row.thread_id,
  })

  const open = database
    .prepare(
      `SELECT turns.turn_id, turns.thread_id, threads.session_id
       FROM turns JOIN threads ON threads.thread_id = turns.thread_id
       WHERE turns.state IN ('running', 'waiting')
       ORDER BY turns.started_at, turns.turn_id`,
    )
    .all() as OpenTurnRow[]
  for (const row of open) {
    const scope = scopeOf(row)
    const interrupted = ProofEventSchemas['turn.interrupted'].parse({
      type: 'event',
      name: 'turn.interrupted',
      // Derived from the turn: a boot that dies after this commit and a
      // retry of it can only ever write it once.
      eventId: `recover:${row.turn_id}`,
      timestamp: new Date(now()).toISOString(),
      scope,
      payload: { turnId: row.turn_id, reason: 'server_restarted' },
    })
    try {
      const records = repository.finalizeTurn(scope, [interrupted])
      report.turnsRecovered += 1
      count(records)
    } catch (error) {
      report.failures.push({
        kind: 'recovery',
        ids: { sessionId: row.session_id, threadId: row.thread_id, turnId: row.turn_id },
        reason: String(error),
      })
    }
  }

  const legacy = (
    database
      .prepare(
        `SELECT turn_activity.activity_id, turn_activity.kind, turn_activity.state_json,
                turn_activity.turn_id, turn_activity.thread_id, threads.session_id
         FROM turn_activity
         JOIN turns ON turns.turn_id = turn_activity.turn_id
         JOIN threads ON threads.thread_id = turn_activity.thread_id
         WHERE turns.state NOT IN ('running', 'waiting')
         ORDER BY turn_activity.thread_id, turn_activity.ordinal`,
      )
      .all() as LegacyChildRow[]
  ).filter((row) => {
    const state = JSON.parse(row.state_json) as { status?: string; phase?: string }
    return row.kind === 'tool' ? toolIsOpen(state) : reasoningIsOpen(state)
  })
  const byThread = new Map<string, LegacyChildRow[]>()
  for (const row of legacy) {
    const rows = byThread.get(row.thread_id) ?? []
    rows.push(row)
    byThread.set(row.thread_id, rows)
  }
  for (const [threadId, rows] of byThread) {
    const scope = scopeOf(rows[0]!)
    const timestamp = new Date(now()).toISOString()
    const events: DurableProofEvent[] = rows.map((row) =>
      row.kind === 'tool'
        ? ProofEventSchemas['tool.updated'].parse({
            type: 'event',
            name: 'tool.updated',
            eventId: `repair:tool:${row.activity_id}`,
            timestamp,
            scope,
            payload: { toolCallId: row.activity_id, turnId: row.turn_id, status: 'cancelled' },
          })
        : ProofEventSchemas['message.reasoning'].parse({
            type: 'event',
            name: 'message.reasoning',
            eventId: `repair:reasoning:${row.activity_id}`,
            timestamp,
            scope,
            payload: { messageId: row.activity_id, turnId: row.turn_id, phase: 'stop' },
          }),
    )
    try {
      count(repository.appendEvents(scope, events))
      report.threadsRepaired += 1
    } catch (error) {
      report.failures.push({
        kind: 'repair',
        ids: { sessionId: scope.sessionId, threadId },
        reason: String(error),
      })
    }
  }
  report.durationMs = Math.round(performance.now() - started)
  return report
}
