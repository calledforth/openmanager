import type { DatabaseSync } from 'node:sqlite'
import {
  DurableEventSchema,
  PAGE_LIMIT_MAX,
  ScopeSnapshotSchema,
  SessionSchema,
  decideReplay,
  type Cursor,
  type DurableEvent,
  type Environment,
  type ScopeSnapshot,
  type SnapshotReason,
  type SubscriptionScope,
  type Workspace,
} from '@openmanager/protocol/node'
import { scopeKey } from './event-repository.ts'
import { EVENTS_AFTER_CURSOR_SQL, STREAM_BOUNDS_SQL } from './queries.ts'
import {
  getSessionSummary,
  listSessionHistory,
  listSessionSummaries,
  listThreadsForSession,
} from './session-store.ts'

/**
 * A replay is one socket frame, so it is bounded twice: by event count and by
 * serialized bytes. A gap that does not fit is answered with a snapshot, the
 * same as a gap that retention has already pruned. Both limits stay well
 * under the socket's slow-consumer budget.
 */
export const REPLAY_LIMITS = Object.freeze({
  maxEvents: 500,
  maxBytes: 256 * 1024,
})

export type ReplayResult =
  | { mode: 'replay'; from: Cursor; to: Cursor; events: DurableEvent[] }
  | { mode: 'snapshot'; reason: SnapshotReason; snapshot: ScopeSnapshot }
  /** The scope's session or thread no longer exists; there is nothing to replay or snapshot. */
  | { mode: 'missing' }

export interface ReplayReaderOptions {
  /** Epoch a scope gets with its first event; a scope with no stream yet sits at sequence 0 of it. */
  epoch: string
  environment: () => Environment
  workspaces: () => Workspace[]
  limits?: Partial<typeof REPLAY_LIMITS>
}

interface StreamBoundsRow {
  epoch: string
  head_sequence: number
  oldest_sequence: number | null
}

interface EventRow {
  sequence: number
  event_json: string
}

/**
 * Answer `subscription.replay` from the SQLite event log.
 *
 * `decideReplay` is the protocol's rule; this reader supplies its inputs
 * (head and retention boundary, read together from the stream row) and
 * builds the answer: the exact contiguous tail after the cursor, or a
 * snapshot of the scope at head. The caller registers the live subscription
 * in the same tick, so nothing commits between the read and the registration.
 */
export function createReplayReader(database: DatabaseSync, options: ReplayReaderOptions) {
  const limits = { ...REPLAY_LIMITS, ...options.limits }
  const statements = {
    bounds: database.prepare(STREAM_BOUNDS_SQL),
    after: database.prepare(EVENTS_AFTER_CURSOR_SQL),
  }

  const snapshotOf = (scope: SubscriptionScope, head: Cursor): ScopeSnapshot | undefined => {
    if (scope.type === 'environment') {
      const workspaces = options.workspaces()
      const known = new Set(workspaces.map((workspace) => workspace.workspaceId))
      // Newest sessions only: the snapshot is the sidebar's first page, and
      // the rest pages exactly as `session.list` does.
      const sessions = listSessionSummaries(database, { limit: PAGE_LIMIT_MAX }).sessions.filter(
        (session) => known.has(session.workspaceId),
      )
      return ScopeSnapshotSchema.parse({
        cursor: head,
        state: { environment: options.environment(), workspaces, sessions },
      })
    }
    if (scope.type === 'session') {
      const summary = getSessionSummary(database, scope.sessionId)
      if (!summary) return undefined
      return ScopeSnapshotSchema.parse({
        cursor: head,
        state: {
          session: SessionSchema.parse(summary),
          threads: listThreadsForSession(database, scope.sessionId),
        },
      })
    }
    const page = listSessionHistory(database, {
      sessionId: scope.sessionId,
      threadId: scope.threadId,
      limit: PAGE_LIMIT_MAX,
    })
    if (!page) return undefined
    return ScopeSnapshotSchema.parse({
      cursor: head,
      state: {
        thread: { threadId: scope.threadId, sessionId: scope.sessionId },
        turns: page.turns,
        // The newest history page, as `session.open` then `session.history`
        // would load it. Reasoning and tool state live only in the event log,
        // which is what the snapshot stands in for, so they start over.
        messages: page.messages,
        reasoning: [],
        tools: [],
        interactions: page.interactions.map(({ turnId, interaction }) => ({ turnId, interaction })),
      },
    })
  }

  const snapshot = (
    scope: SubscriptionScope,
    head: Cursor,
    reason: SnapshotReason,
  ): ReplayResult => {
    const state = snapshotOf(scope, head)
    return state ? { mode: 'snapshot', reason, snapshot: state } : { mode: 'missing' }
  }

  return {
    /** Throws `ReplayCursorError` for a cursor that cannot belong to the scope. */
    read(scope: SubscriptionScope, cursor: Cursor | null): ReplayResult {
      const key = scopeKey(scope)
      const bounds = statements.bounds.get(key) as StreamBoundsRow | undefined
      const head: Cursor = bounds
        ? { scope, epoch: bounds.epoch, sequence: bounds.head_sequence }
        : { scope, epoch: options.epoch, sequence: 0 }
      const decision = decideReplay(scope, cursor, head, bounds?.oldest_sequence ?? null)
      if (decision.mode === 'snapshot' || !cursor) {
        return snapshot(scope, head, decision.mode === 'snapshot' ? decision.reason : 'initial')
      }
      const rows = statements.after.all(
        key,
        cursor.sequence,
        limits.maxEvents + 1,
      ) as unknown as EventRow[]
      const missing = head.sequence - cursor.sequence
      let bytes = 0
      const fits =
        rows.length === missing &&
        rows.every((row, index) => {
          bytes += row.event_json.length
          return row.sequence === cursor.sequence + index + 1 && bytes <= limits.maxBytes
        })
      // Too large to carry, or (defensively) not the contiguous tail the
      // stream row promised: a snapshot replaces the scope either way.
      if (!fits) return snapshot(scope, head, 'gap_expired')
      const events = rows.map((row) =>
        DurableEventSchema.parse({
          cursor: { scope, epoch: head.epoch, sequence: row.sequence },
          event: JSON.parse(row.event_json),
        }),
      )
      return { mode: 'replay', from: cursor, to: head, events }
    },
  }
}

export type ReplayReader = ReturnType<typeof createReplayReader>
