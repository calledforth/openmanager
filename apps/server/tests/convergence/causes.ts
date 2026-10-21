import { ABSENT, type DiffEntry } from './normalize.ts'
import {
  equals,
  isTimestamp,
  satisfies,
  type CauseInstance,
  type Comparison,
  type ExpectedEntry,
} from './expectation.ts'
import type { ConvergenceResult } from './harness.ts'
import {
  explainRecency,
  explainSessionTime,
  type ClientWire,
  type Provenance,
} from './provenance.ts'

/**
 * The documented reasons today's `main` violates the convergence property.
 *
 * For scenarios each cause is a builder: given the fixture's ids and the
 * values captured while building it, it returns the exact entries the cause
 * produces (expectation.ts). For the seeded runs, which have no fixture, each
 * cause has a fingerprint that checks the entry against the views and what
 * the run recorded (`classify`). A phase that fixes a cause deletes it here.
 */

const BOTH: readonly Comparison[] = ['fresh', 'server']
const FRESH: readonly Comparison[] = ['fresh']
const thread = (threadId: string) => `active.threads.${threadId}`
const absent = equals(ABSENT)

const entry = (
  comparisons: readonly Comparison[],
  path: string,
  left: ExpectedEntry['left'],
  right: ExpectedEntry['right'],
  relation?: ExpectedEntry['relation'],
): ExpectedEntry => ({ comparisons, path, left, right, ...(relation ? { relation } : {}) })

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * W2, S4, S10: a snapshot over held history keeps older messages but
 * replaces reasoning and tools with the newest page's. `server` holds the
 * server's own read of exactly the older activity the construction puts
 * outside the newest page, captured before the gap.
 */
export function snapshotMergeDropsOlderActivity(fixture: {
  threadId: string
  reasoning: Record<string, unknown>
  tools: Record<string, unknown>
  /** The order refs of that activity, as the server read places them. */
  refs: Array<{ kind: 'reasoning' | 'tool'; id: string; turnId: string }>
}): CauseInstance {
  const at = thread(fixture.threadId)
  return {
    name: 'SNAPSHOT_MERGE_DROPS_OLDER_ACTIVITY',
    cause:
      'applySnapshot keeps older messages it holds (state.ts:572, :616-622) and the history ' +
      'cursor (:588-594), rebuilds their order from messages alone (:584-587) and replaces ' +
      'reasoning and tools with the newest page’s (:595-596). Older thoughts and tools are gone ' +
      'and, with the cursor kept at null, never come back. W2, S4, S10.',
    entries: [
      ...Object.entries(fixture.reasoning).map(([id, value]) =>
        entry(BOTH, `${at}.reasoning.${id}`, absent, equals(value)),
      ),
      ...Object.entries(fixture.tools).map(([id, value]) =>
        entry(BOTH, `${at}.tools.${id}`, absent, equals(value)),
      ),
      ...fixture.refs.map((ref) =>
        entry(BOTH, `${at}.order[${ref.kind}:${ref.id}]`, absent, equals(ref)),
      ),
    ],
  }
}

const NOT_LOADED = /^\[(\d+) characters of thinking not loaded\]\n([\s\S]*)$/

/** §7.1, S6(b): the 384 KiB reasoning budget puts a marker in what a fresh load shows. */
export function reasoningBudgetMarker(fixture: {
  threadId: string
  messageId: string
  /** The whole thought, as streamed. */
  text: string
}): CauseInstance {
  const cut = satisfies(
    'the note "[N characters of thinking not loaded]" and the thought’s last characters',
    (value) => {
      const match = typeof value === 'string' ? NOT_LOADED.exec(value) : null
      if (!match) return false
      const omitted = Number(match[1])
      const tail = match[2]!
      return (
        omitted > 0 && omitted + tail.length === fixture.text.length && fixture.text.endsWith(tail)
      )
    },
  )
  return {
    name: 'REASONING_BUDGET_MARKER',
    cause:
      'Snapshots and history pages cap reasoning text at 384 KiB and replace the rest with a ' +
      '"not loaded" note (session-store.ts:379-418, applied at :306); the client that streamed ' +
      'the thought holds all of it. §7.1, S6(b).',
    entries: [
      entry(
        BOTH,
        `${thread(fixture.threadId)}.reasoning.${fixture.messageId}.content[0].text`,
        equals(fixture.text),
        cut,
      ),
    ],
  }
}

/**
 * What a time-valued cause is judged with: the server's write and event
 * provenance (provenance.ts), read after the check, and the client's wire.
 */
export interface Witness {
  provenance: Provenance
  wire: ClientWire
}

/**
 * §4.4, S8: `persistRuntimeSession` stamps `updated_at` once the provider
 * session resolves, after `session.created` committed, with no event. The
 * fingerprint is provenance, not shape: the server's value must come from
 * that audited write (provider identity and time, no event), and nothing
 * the server announced or handed the client may carry a newer time, so a
 * lost rename or status update can never pass as the stamp.
 */
export function runtimeStamp(fixture: {
  sessionId: string
  /** What the watching client holds: the `session.created` time. */
  heldUpdatedAt: string
  witness: Witness
  /** The sidebar order the stamp turns around, if the construction puts one session between. */
  order?: { held: string[]; stamped: string[] }
}): CauseInstance {
  const { provenance, wire } = fixture.witness
  return {
    name: 'RUNTIME_STAMP',
    cause:
      'persistRuntimeSession writes updated_at once the provider session resolves ' +
      '(thread-service.ts:435-443, called at :1880), after session.created committed, with no ' +
      'event; the other client keeps the event time and sorts the sidebar by it. §4.4, S8.',
    entries: [
      entry(
        BOTH,
        `sessions[${fixture.sessionId}].updatedAt`,
        equals(fixture.heldUpdatedAt),
        isTimestamp,
        {
          describe:
            'the server’s value is the audited runtime stamp, and nothing offered the client a newer time',
          check: (left, right) =>
            explainSessionTime(provenance, fixture.sessionId, left, right, wire).cause ===
            'RUNTIME_STAMP',
        },
      ),
      ...(fixture.order
        ? [
            entry(
              BOTH,
              'sessions(order)',
              equals(fixture.order.held),
              equals(fixture.order.stamped),
            ),
          ]
        : []),
    ],
  }
}

/**
 * The stamp moves the workspace's recency too (MAX(sessions.updated_at)),
 * with no event. Whether this entry shows depends on the stamp landing in a
 * later millisecond than what the client last mirrored, so scenarios name it
 * as a residual. `held` is what the client should hold, derived from what
 * the server sent it (mirror.ts); provenance names the write.
 */
export function stampMovesRecency(fixture: {
  workspaceId: string
  held: string | null
  witness: Witness
}): CauseInstance {
  return recencyCause(
    'RUNTIME_STAMP_RECENCY',
    'The runtime stamp (S8) also moves the workspace’s lastActivityAt, which is MAX of the ' +
      'sessions’ updated_at at read time (workspaces.ts:151, :238-241), with no workspace event.',
    fixture,
  )
}

function recencyCause(
  name: string,
  cause: string,
  fixture: { workspaceId: string; held: string | null; witness: Witness },
): CauseInstance {
  const { provenance, wire } = fixture.witness
  return {
    name,
    cause,
    entries: [
      entry(
        FRESH,
        `workspaces.${fixture.workspaceId}.lastActivityAt`,
        equals(fixture.held),
        isTimestamp,
        {
          describe: `provenance names ${name}, and nothing offered the client a newer value`,
          check: (left, right) =>
            explainRecency(provenance, fixture.workspaceId, left, right, wire).cause === name,
        },
      ),
    ],
  }
}

/** §3.6 rows 19 and 23, S9: deleted sessions stay listed. `rows` are the client's rows, captured. */
export function environmentSnapshotNeverRemoves(fixture: {
  rows: Record<string, unknown>
}): CauseInstance {
  return {
    name: 'ENVIRONMENT_SNAPSHOT_NEVER_REMOVES',
    cause:
      'A gap_expired environment snapshot only upserts sessions (state.ts:549-557), and ' +
      'reconcileCachedSessions drops nothing when none of its three passes fits on one page ' +
      '(websocket.ts:946-1004, :977-993), so sessions deleted during the gap stay listed. ' +
      '§3.6 rows 19 and 23, S9.',
    entries: Object.entries(fixture.rows).map(([id, row]) =>
      entry(BOTH, `sessions[${id}]`, equals(row), absent),
    ),
  }
}

/**
 * X1 (§3.6 row 14, §4.4): a workspace's `lastActivityAt` is MAX(sessions.updated_at)
 * at read time; the client moves its copy only on session.created and the turn
 * events it receives. By provenance: the server's value came from a session
 * write announced only by `session.updated` (a rename, a status) or by turn
 * events of a thread the client was not offered, and nothing offered the
 * client a newer value (provenance.ts, `explainRecency`).
 */
export function workspaceRecencyMirror(fixture: {
  workspaceId: string
  /** What the client should hold, derived from what the server sent it (mirror.ts). */
  held: string | null
  witness: Witness
}): CauseInstance {
  return recencyCause(
    'WORKSPACE_RECENCY_MIRROR',
    'lastActivityAt is computed from MAX(sessions.updated_at) when read (workspaces.ts:151, ' +
      ':238-241) and changes with no workspace event; the client mirrors it only on session.created ' +
      'and the turn events it receives (state.ts:253-270), not on session.updated or a thread ' +
      'snapshot. §3.6 row 14, §4.4.',
    fixture,
  )
}

/** X2 (§6.3): session.created carries a bare Session, so a watching client lacks the provider. */
export function sessionCreatedPartial(fixture: {
  sessionIds: string[]
  providerId: string
}): CauseInstance {
  return {
    name: 'SESSION_CREATED_PARTIAL',
    cause:
      'session.created carries a bare Session (events.ts session.created; thread-service.ts:590-605), ' +
      'so a client that only heard the event has no providerId until a listing; §6.3 makes it a ' +
      'SessionSummary in F5.',
    entries: fixture.sessionIds.map((id) =>
      entry(BOTH, `sessions[${id}].providerId`, absent, equals(fixture.providerId)),
    ),
  }
}

// ---------------------------------------------------------------------------
// Fingerprints for the seeded runs
// ---------------------------------------------------------------------------

/** What a seeded run knows beyond the views, read after the convergence read it judges. */
export interface RunContext {
  /** The server's write and event provenance, and the subject client's wire. */
  witness: Witness
  /** When each restart or crash brought the server back up. */
  restarts: number[]
}

const ID = '[^.\\[\\]]+'
const pattern = (source: string) => new RegExp(`^${source}$`)
const UPDATED = pattern(`sessions\\[(${ID})\\]\\.updatedAt`)
const PROVIDER = pattern(`sessions\\[(${ID})\\]\\.providerId`)
const RECENCY = pattern(`workspaces\\.(${ID})\\.lastActivityAt`)

type Fingerprint = (entry: DiffEntry, result: ConvergenceResult, context: RunContext) => boolean

const sessionsOnly = (comparison: string) => comparison === 'fresh' || comparison === 'server'
/** A recency entry whose provenance names `cause` (provenance.ts, `explainRecency`). */
function recency(entry: DiffEntry, context: RunContext, cause: string): boolean {
  const match = RECENCY.exec(entry.path)
  if (!match || entry.comparison !== 'fresh') return false
  const { provenance, wire } = context.witness
  return explainRecency(provenance, match[1]!, entry.left, entry.right, wire).cause === cause
}

export const FINGERPRINTS: Record<string, Fingerprint> = {
  RUNTIME_STAMP: (entry, _result, context) => {
    const match = UPDATED.exec(entry.path)
    if (!match || !sessionsOnly(entry.comparison)) return false
    const { provenance, wire } = context.witness
    return (
      explainSessionTime(provenance, match[1]!, entry.left, entry.right, wire).cause ===
      'RUNTIME_STAMP'
    )
  },
  WORKSPACE_RECENCY_MIRROR: (entry, _result, context) =>
    recency(entry, context, 'WORKSPACE_RECENCY_MIRROR'),
  RUNTIME_STAMP_RECENCY: (entry, _result, context) =>
    recency(entry, context, 'RUNTIME_STAMP_RECENCY'),
  SESSION_CREATED_PARTIAL: (entry) =>
    sessionsOnly(entry.comparison) &&
    PROVIDER.test(entry.path) &&
    entry.left === ABSENT &&
    typeof entry.right === 'string',
}

/**
 * The sidebar order is a consequence: it is explained when sorting the
 * client's rows by the fresh load's times gives the fresh order, and every
 * time that moved is itself explained.
 */
function orderExplained(
  entry: DiffEntry,
  result: ConvergenceResult,
  explainedTimes: ReadonlySet<string>,
): boolean {
  if (entry.path !== 'sessions(order)' || !sessionsOnly(entry.comparison)) return false
  const left = entry.left as string[]
  const right = entry.right as string[]
  if (left.length !== right.length || [...left].sort().join() !== [...right].sort().join())
    return false
  const moved = left.filter((id, index) => right[index] !== id)
  return moved.every((id) => explainedTimes.has(id))
}

/** Each entry with the cause whose fingerprint explains it; `undefined`: nobody documented it. */
export function classify(result: ConvergenceResult, context: RunContext) {
  const classified = result.entries.map((entry) => ({
    entry,
    cause: Object.entries(FINGERPRINTS).find(([, fingerprint]) =>
      fingerprint(entry, result, context),
    )?.[0],
  }))
  const explainedTimes = new Set(
    classified.flatMap(({ entry, cause }) => {
      const match = cause ? UPDATED.exec(entry.path) : null
      return match ? [match[1]!] : []
    }),
  )
  return classified.map((item) =>
    item.cause === undefined && orderExplained(item.entry, result, explainedTimes)
      ? { ...item, cause: 'RUNTIME_STAMP' }
      : item,
  )
}
