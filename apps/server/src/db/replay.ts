import { Buffer } from 'node:buffer'
import type { DatabaseSync } from 'node:sqlite'
import {
  ScopeSnapshotSchema,
  decideReplay,
  type Cursor,
  type Environment,
  type ScopeSnapshot,
  type SnapshotReason,
  type SubscriptionScope,
  type Workspace,
} from '@openmanager/protocol/node'
import {
  preferenceFromRow,
  profileFromRow,
  readPreferenceRows,
  readProfileRows,
} from './composer-rows.ts'
import { scopeKey } from './event-repository.ts'
import {
  EVENTS_AFTER_CURSOR_SQL,
  REPLAY_SIZE_SQL,
  STREAM_BOUNDS_SQL,
  THREAD_STATE_BYTES_SQL,
} from './queries.ts'
import {
  getSessionSummary,
  listAllSessionSummaries,
  listThreadsForSession,
  readThreadState,
} from './session-store.ts'

/**
 * The answer to a catch-up (docs/sync-foundations.md §6.1), already
 * serialized: a replay's records are the stored event JSON, verbatim, inside
 * a fixed wrapper, so the size the decision compared is exactly what is sent.
 */
export type ReplayResult =
  | {
      mode: 'replay'
      from: Cursor
      to: Cursor
      /** Number of records. */
      count: number
      /** The records, comma-separated, without the brackets. */
      eventsJson: string
    }
  | { mode: 'snapshot'; reason: SnapshotReason; snapshot: ScopeSnapshot; snapshotJson: string }
  /** The scope's session or thread no longer exists; there is nothing to replay or snapshot. */
  | { mode: 'missing' }

export interface ReplayReaderOptions {
  /** Epoch a scope gets with its first event; a scope with no stream yet sits at sequence 0 of it. */
  epoch: string
  environment: () => Environment
  workspaces: () => Workspace[]
}

interface StreamBoundsRow {
  epoch: string
  head_sequence: number
  oldest_sequence: number | null
  replay_floor: number
}

/**
 * The oldest sequence a replay may carry. Retention prunes from the front;
 * the replay floor (db/replay-floor.ts) hides everything written in an older
 * event format. A floor at or above the head leaves nothing replayable,
 * which `decideReplay` reads as `null`: a cursor at the head replays empty,
 * any lower one gets a snapshot.
 */
export function oldestReplayable(bounds: StreamBoundsRow): number | null {
  const retained = bounds.oldest_sequence
  if (retained === null || bounds.replay_floor <= 0) return retained
  if (bounds.replay_floor >= bounds.head_sequence) return null
  return Math.max(retained, bounds.replay_floor + 1)
}

interface EventRow {
  sequence: number
  event_json: string
}

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8')

/** Σ of the decimal digit counts of the integers in [from, to]. */
export function digitsBetween(from: number, to: number): number {
  let total = 0
  for (let digits = 1, low = 1; low <= to; digits++, low *= 10) {
    const high = low * 10 - 1
    const start = Math.max(from, low)
    const end = Math.min(to, high)
    if (end >= start) total += (end - start + 1) * digits
  }
  return total
}

/**
 * The payload of a `subscription.replay` answer or a `subscription.catchup`,
 * as JSON text. Key order is the protocol schema's, so it parses to exactly
 * what `ReplayResponseSchema` would have produced.
 */
export function answerPayloadJson(
  result: Exclude<ReplayResult, { mode: 'missing' }>,
  subscriptionId: string,
): string {
  const id = JSON.stringify(subscriptionId)
  if (result.mode === 'replay') {
    return `{"mode":"replay","subscriptionId":${id},"from":${JSON.stringify(result.from)},"to":${JSON.stringify(result.to)},"events":[${result.eventsJson}]}`
  }
  return `{"mode":"snapshot","subscriptionId":${id},"reason":${JSON.stringify(result.reason)},"snapshot":${result.snapshotJson}}`
}

/** A subscription id the size of a real one (a UUID), for comparing sizes. */
const SIZE_PROBE_ID = '00000000-0000-0000-0000-000000000000'

/**
 * The exact UTF-8 length of a replay answer's payload (`answerPayloadJson`)
 * for the records after `from` up to `to`, given their stored event bytes,
 * without building it (docs/sync-foundations.md §6.1 point 2).
 */
export function replayPayloadBytes(
  scope: SubscriptionScope,
  from: Cursor,
  to: Cursor,
  eventBytes: number,
  count: number,
): number {
  const scopeJson = JSON.stringify(scope)
  // `{"cursor":{"scope":S,"epoch":E,"sequence":N},"event":X}` per record.
  const wrapper = utf8(
    `{"cursor":{"scope":${scopeJson},"epoch":${JSON.stringify(to.epoch)},"sequence":},"event":}`,
  )
  const records =
    count === 0
      ? 0
      : eventBytes + count * wrapper + digitsBetween(from.sequence + 1, to.sequence) + (count - 1)
  const envelope = utf8(
    answerPayloadJson({ mode: 'replay', from, to, count: 0, eventsJson: '' }, SIZE_PROBE_ID),
  )
  return envelope + records
}

/**
 * Answer `subscription.replay` (and the server's own catch-ups) from the
 * SQLite event log, by the rule of docs/sync-foundations.md §6.1:
 *
 * | condition                     | answer                       |
 * | ----------------------------- | ---------------------------- |
 * | no cursor                     | `initial` snapshot           |
 * | another epoch                 | `stream_reset` snapshot      |
 * | cursor ahead of head          | `cursor_ahead` snapshot      |
 * | events not retained           | `gap_expired` snapshot       |
 * | replay bytes > snapshot bytes | `snapshot_smaller` snapshot  |
 * | anything else                 | replay (ties go to replay)   |
 *
 * Sizes are exact: the replay's from `SUM(octet_length(event_json))` plus
 * its fixed wrapper, the snapshot's from its serialized text. A thread's
 * snapshot is built only when it could win: it embeds every message part and
 * activity row byte for byte, so their stored size is a lower bound on it.
 * Everything runs in one synchronous tick, with the caller registering the
 * live subscription in that same tick, so nothing commits in between.
 */
export function createReplayReader(database: DatabaseSync, options: ReplayReaderOptions) {
  const statements = {
    bounds: database.prepare(STREAM_BOUNDS_SQL),
    after: database.prepare(EVENTS_AFTER_CURSOR_SQL),
    size: database.prepare(REPLAY_SIZE_SQL),
    threadBytes: database.prepare(THREAD_STATE_BYTES_SQL),
  }

  const snapshotOf = (scope: SubscriptionScope, head: Cursor): ScopeSnapshot | undefined => {
    if (scope.type === 'environment') {
      const workspaces = options.workspaces()
      const known = new Set(workspaces.map((workspace) => workspace.workspaceId))
      // Every session, preference and provider profile: the client replaces
      // its whole sidebar with this (§6.2).
      const sessions = listAllSessionSummaries(database).filter((session) =>
        known.has(session.workspaceId),
      )
      const preferences = readPreferenceRows(database)
        .filter((row) => known.has(row.workspace_id))
        .map((row) => ({
          workspaceId: row.workspace_id,
          providerId: row.provider_id,
          preference: preferenceFromRow(row),
          revision: row.revision,
        }))
      return ScopeSnapshotSchema.parse({
        cursor: head,
        state: {
          environment: options.environment(),
          workspaces,
          sessions,
          preferences,
          providerProfiles: readProfileRows(database).map(profileFromRow),
        },
      })
    }
    if (scope.type === 'session') {
      const summary = getSessionSummary(database, scope.sessionId)
      if (!summary) return undefined
      return ScopeSnapshotSchema.parse({
        cursor: head,
        state: {
          session: summary,
          threads: listThreadsForSession(database, scope.sessionId),
        },
      })
    }
    const state = readThreadState(database, {
      sessionId: scope.sessionId,
      threadId: scope.threadId,
    })
    if (!state) return undefined
    return ScopeSnapshotSchema.parse({ cursor: head, state })
  }

  const snapshot = (
    scope: SubscriptionScope,
    head: Cursor,
    reason: SnapshotReason,
  ): Extract<ReplayResult, { mode: 'snapshot' | 'missing' }> => {
    const state = snapshotOf(scope, head)
    return state
      ? { mode: 'snapshot', reason, snapshot: state, snapshotJson: JSON.stringify(state) }
      : { mode: 'missing' }
  }

  const replayBytes = replayPayloadBytes

  const snapshotBytes = (result: Extract<ReplayResult, { mode: 'snapshot' }>) =>
    utf8(answerPayloadJson({ ...result, reason: 'snapshot_smaller' }, SIZE_PROBE_ID))

  return {
    /** Throws `ReplayCursorError` for a cursor that cannot belong to the scope. */
    read(scope: SubscriptionScope, cursor: Cursor | null): ReplayResult {
      const key = scopeKey(scope)
      const bounds = statements.bounds.get(key) as StreamBoundsRow | undefined
      const head: Cursor = bounds
        ? { scope, epoch: bounds.epoch, sequence: bounds.head_sequence }
        : { scope, epoch: options.epoch, sequence: 0 }
      const decision = decideReplay(scope, cursor, head, bounds ? oldestReplayable(bounds) : null)
      if (decision.mode === 'snapshot' || !cursor) {
        return snapshot(scope, head, decision.mode === 'snapshot' ? decision.reason : 'initial')
      }
      const missing = head.sequence - cursor.sequence
      const size = statements.size.get(key, cursor.sequence) as { bytes: number; count: number }
      // Defensive: the stream row promised a contiguous tail the log lacks.
      if (size.count !== missing) return snapshot(scope, head, 'gap_expired')
      const from = cursor
      const bytes = replayBytes(scope, from, head, size.bytes, size.count)
      if (missing > 0) {
        // A thread's snapshot embeds every stored part and activity row byte
        // for byte, so their size bounds it from below: a replay no larger
        // than that cannot lose, and the snapshot is not built.
        const couldWin =
          scope.type !== 'thread' ||
          bytes >
            (statements.threadBytes.get(scope.threadId, scope.threadId) as { bytes: number }).bytes
        if (couldWin) {
          const result = snapshot(scope, head, 'snapshot_smaller')
          if (result.mode === 'missing' || bytes > snapshotBytes(result)) return result
        }
      }
      const rows = statements.after.all(key, cursor.sequence, -1) as unknown as EventRow[]
      const scopeJson = JSON.stringify(scope)
      const epochJson = JSON.stringify(head.epoch)
      const eventsJson = rows
        .map(
          (row) =>
            `{"cursor":{"scope":${scopeJson},"epoch":${epochJson},"sequence":${row.sequence}},"event":${row.event_json}}`,
        )
        .join(',')
      return { mode: 'replay', from, to: head, count: rows.length, eventsJson }
    },
  }
}

export type ReplayReader = ReturnType<typeof createReplayReader>
