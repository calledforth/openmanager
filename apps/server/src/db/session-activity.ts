import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { InteractionKind } from '@openmanager/protocol/node'
import {
  OPEN_TURN_FOR_SESSION_SQL,
  PENDING_INTERACTIONS_FOR_NATIVE_SUBAGENTS_SQL,
  PENDING_INTERACTIONS_FOR_SESSION_SQL,
} from './queries.ts'

/**
 * What a session's status alone does not say: what a waiting session waits
 * on, and whether a running one is running only because of background work.
 * Both are read from the turn and interaction rows, so they can never
 * disagree with them; see docs/session-status.md.
 */
export type SessionActivity = { waitingOn?: InteractionKind; inBackground?: true }

type Statements = { pending: StatementSync; subagentsPending: StatementSync; openTurn: StatementSync }
const statements = new WeakMap<DatabaseSync, Statements>()

function prepared(database: DatabaseSync): Statements {
  let cached = statements.get(database)
  if (!cached) {
    cached = {
      pending: database.prepare(PENDING_INTERACTIONS_FOR_SESSION_SQL),
      subagentsPending: database.prepare(PENDING_INTERACTIONS_FOR_NATIVE_SUBAGENTS_SQL),
      openTurn: database.prepare(OPEN_TURN_FOR_SESSION_SQL),
    }
    statements.set(database, cached)
  }
  return cached
}

/** A question wins, since only the user can answer it; otherwise the oldest request. */
export function waitingKind(
  pending: Iterable<{ kind: InteractionKind; createdAt: number }>,
): InteractionKind | undefined {
  let oldest: { kind: InteractionKind; createdAt: number } | undefined
  for (const request of pending) {
    if (request.kind === 'question') return 'question'
    if (!oldest || request.createdAt < oldest.createdAt) oldest = request
  }
  return oldest?.kind
}

type PendingRow = { kind: InteractionKind; created_at: number }

/**
 * The requests a session waits on: its own, and those of its native
 * subagents, whose provider is the session's own and is blocked on them.
 */
export function pendingRequestsOf(
  database: DatabaseSync,
  sessionId: string,
): { kind: InteractionKind; createdAt: number }[] {
  const statements = prepared(database)
  return [
    ...(statements.pending.all(sessionId) as PendingRow[]),
    ...(statements.subagentsPending.all(sessionId) as PendingRow[]),
  ].map((row) => ({ kind: row.kind, createdAt: row.created_at }))
}

/** Only waiting and running sessions are looked into, so a listing stays cheap. */
export function readSessionActivity(
  database: DatabaseSync,
  session: { session_id: string; status: string; background_tasks_json?: string | null },
): SessionActivity {
  if (session.status === 'waiting') {
    const kind = waitingKind(pendingRequestsOf(database, session.session_id))
    return kind ? { waitingOn: kind } : {}
  }
  if (session.status === 'running' && session.background_tasks_json) {
    return prepared(database).openTurn.get(session.session_id) ? {} : { inBackground: true }
  }
  return {}
}
