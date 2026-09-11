import type { DatabaseSync } from 'node:sqlite'
import { EXPIRED_EVENTS_BY_SCOPE_SQL, FIRST_UNEXPIRED_SEQUENCE_SQL } from './queries.ts'

/** Replayable events older than this are pruned; a client further behind must snapshot. */
export const DEFAULT_EVENT_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Each scope keeps at most this many newest events regardless of age. */
export const DEFAULT_MAX_EVENTS_PER_SCOPE = 10_000
/** How often the background job runs when scheduled with the defaults. */
export const DEFAULT_EVENT_PRUNE_INTERVAL_MS = 15 * 60 * 1000

export interface EventRetentionPolicy {
  /** Events whose `created_at` is older than `now - windowMs` are pruned. */
  readonly windowMs: number
  /** Upper bound on retained events per scope; the oldest are pruned first. */
  readonly maxEventsPerScope: number
}

export interface EventRetentionOptions extends Partial<EventRetentionPolicy> {
  now?: () => number
}

export interface PruneReport {
  /** Wall-clock time the pass was evaluated against. */
  readonly at: number
  /** Number of `event_log` rows deleted by this pass. */
  readonly deleted: number
  /** Scopes whose retention boundary moved, with their new oldest retained sequence. */
  readonly streams: ReadonlyArray<{ scopeKey: string; oldestSequence: number | null }>
}

export interface EventRetention {
  readonly policy: EventRetentionPolicy
  /** Run one pruning pass inside a single IMMEDIATE transaction. */
  prune(): PruneReport
  /** Run `prune` on an interval until the returned function is called. */
  schedule(options?: { intervalMs?: number; onError?: (error: unknown) => void }): () => void
}

interface StreamRow {
  scope_key: string
  head_sequence: number
  oldest_sequence: number
}

interface ExpiredRow {
  scope_key: string
  expired_count: number
  expired_max: number
}

interface FirstRetainedRow {
  first_retained: number | null
}

interface StreamSequenceRow {
  oldest: number | null
}

/**
 * Bound the replayable `event_log` by age and by count per scope.
 *
 * Pruning never touches domain rows: messages, parts, turns, and interactions
 * are the history source and stay. Only the replay tail shrinks, and
 * `event_streams.oldest_sequence` moves with it so `decideReplay` forces a
 * snapshot for any cursor that now points before the retained range.
 */
export function createEventRetention(
  database: DatabaseSync,
  options: EventRetentionOptions = {},
): EventRetention {
  const policy: EventRetentionPolicy = {
    windowMs: options.windowMs ?? DEFAULT_EVENT_RETENTION_WINDOW_MS,
    maxEventsPerScope: options.maxEventsPerScope ?? DEFAULT_MAX_EVENTS_PER_SCOPE,
  }
  if (!Number.isFinite(policy.windowMs) || policy.windowMs < 0) {
    throw new Error('Event retention window must be a non-negative number of milliseconds')
  }
  if (!Number.isInteger(policy.maxEventsPerScope) || policy.maxEventsPerScope < 0) {
    throw new Error('Event retention cap must be a non-negative integer')
  }
  const now = options.now ?? Date.now

  const statements = {
    /** Streams that retain at least one row, in a stable order for reporting. */
    selectStreams: database.prepare(
      `SELECT scope_key, head_sequence, oldest_sequence
       FROM event_streams
       WHERE oldest_sequence IS NOT NULL
       ORDER BY scope_key`,
    ),
    /**
     * `INDEXED BY` pins the covering range scan: without statistics the planner
     * otherwise walks the whole primary key to satisfy GROUP BY in order.
     */
    selectExpired: database.prepare(EXPIRED_EVENTS_BY_SCOPE_SQL),
    selectFirstRetained: database.prepare(FIRST_UNEXPIRED_SEQUENCE_SQL),
    deleteBefore: database.prepare('DELETE FROM event_log WHERE scope_key = ? AND sequence < ?'),
    selectOldest: database.prepare(
      'SELECT MIN(sequence) AS oldest FROM event_log WHERE scope_key = ?',
    ),
    setOldest: database.prepare(
      'UPDATE event_streams SET oldest_sequence = ?, updated_at = ? WHERE scope_key = ?',
    ),
  }

  function prune(): PruneReport {
    const at = now()
    const cutoff = at - policy.windowMs
    const streams: Array<{ scopeKey: string; oldestSequence: number | null }> = []
    let deleted = 0

    /**
     * The first sequence of `stream` that survives the window. Expired rows are
     * normally a contiguous prefix of the stream, so the boundary is one past the
     * newest of them. If timestamps ran out of order and a younger row sits below
     * that, the boundary drops back to the oldest row still inside the window:
     * the retained range must stay contiguous, and it may never lose an event
     * that is still inside the window.
     */
    const windowBoundary = (stream: StreamRow, expired: ExpiredRow | undefined): number => {
      if (!expired) return stream.oldest_sequence
      const prefixLength = expired.expired_max - stream.oldest_sequence + 1
      if (prefixLength === expired.expired_count) return expired.expired_max + 1
      const { first_retained } = statements.selectFirstRetained.get(
        stream.scope_key,
        cutoff,
      ) as unknown as FirstRetainedRow
      return first_retained ?? stream.head_sequence + 1
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      const expiredByScope = new Map(
        (statements.selectExpired.all(cutoff) as unknown as ExpiredRow[]).map((row) => [
          row.scope_key,
          row,
        ]),
      )
      for (const stream of statements.selectStreams.all() as unknown as StreamRow[]) {
        const capBoundary = stream.head_sequence - policy.maxEventsPerScope + 1
        const keepFrom = Math.max(
          windowBoundary(stream, expiredByScope.get(stream.scope_key)),
          capBoundary,
        )
        if (keepFrom <= stream.oldest_sequence) continue
        deleted += Number(statements.deleteBefore.run(stream.scope_key, keepFrom).changes)
        const { oldest } = statements.selectOldest.get(
          stream.scope_key,
        ) as unknown as StreamSequenceRow
        statements.setOldest.run(oldest, at, stream.scope_key)
        streams.push({ scopeKey: stream.scope_key, oldestSequence: oldest })
      }
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // A failed COMMIT may already have ended the transaction.
      }
      throw error
    }
    return { at, deleted, streams }
  }

  return {
    policy,
    prune,
    schedule(scheduleOptions = {}) {
      const intervalMs = scheduleOptions.intervalMs ?? DEFAULT_EVENT_PRUNE_INTERVAL_MS
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new Error('Event prune interval must be a positive number of milliseconds')
      }
      const timer = setInterval(() => {
        try {
          prune()
        } catch (error) {
          scheduleOptions.onError?.(error)
        }
      }, intervalMs)
      timer.unref()
      return () => clearInterval(timer)
    },
  }
}
