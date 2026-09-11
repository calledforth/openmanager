import type { DatabaseSync } from 'node:sqlite'
import { EXPIRED_EVENTS_BY_SCOPE_SQL } from './queries.ts'

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

interface PruneCandidate {
  scope_key: string
  keep_from: number
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
    /**
     * For every scope, the first sequence that survives this pass:
     * one past the newest expired row, or `head - cap + 1`, whichever is larger.
     * Only scopes that still hold something older than that are returned.
     * Cutting at the newest expired sequence keeps the retained range contiguous:
     * if timestamps ever run out of order, a younger row below that sequence is
     * pruned too, because replay cannot skip a hole.
     * `INDEXED BY` pins the covering range scan: without statistics the planner
     * otherwise walks the whole primary key to satisfy GROUP BY in order.
     */
    selectCandidates: database.prepare(
      `WITH expired AS (${EXPIRED_EVENTS_BY_SCOPE_SQL}),
       capped AS (
         SELECT scope_key, head_sequence - ? + 1 AS keep_from
         FROM event_streams
         WHERE oldest_sequence IS NOT NULL
       )
       SELECT s.scope_key AS scope_key,
              MAX(COALESCE(expired.keep_from, 1), COALESCE(capped.keep_from, 1)) AS keep_from
       FROM event_streams AS s
       LEFT JOIN expired ON expired.scope_key = s.scope_key
       LEFT JOIN capped ON capped.scope_key = s.scope_key
       WHERE s.oldest_sequence IS NOT NULL
         AND s.oldest_sequence < MAX(COALESCE(expired.keep_from, 1), COALESCE(capped.keep_from, 1))
       ORDER BY s.scope_key`,
    ),
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

    database.exec('BEGIN IMMEDIATE')
    try {
      const candidates = statements.selectCandidates.all(
        cutoff,
        policy.maxEventsPerScope,
      ) as unknown as PruneCandidate[]
      for (const candidate of candidates) {
        deleted += Number(
          statements.deleteBefore.run(candidate.scope_key, candidate.keep_from).changes,
        )
        const { oldest } = statements.selectOldest.get(
          candidate.scope_key,
        ) as unknown as StreamSequenceRow
        statements.setOldest.run(oldest, at, candidate.scope_key)
        streams.push({ scopeKey: candidate.scope_key, oldestSequence: oldest })
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
