import { ABSENT, type DiffEntry } from './normalize.ts'
import {
  equals,
  satisfies,
  type CauseInstance,
  type Comparison,
  type ExpectedEntry,
} from './expectation.ts'
import type { ConvergenceResult } from './harness.ts'
import type { ClientWire, Provenance } from './provenance.ts'

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

/** What a scenario or a seeded run reads of the server: its provenance, and the client's wire. */
export interface Witness {
  provenance: Provenance
  wire: ClientWire
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

type Fingerprint = (entry: DiffEntry, result: ConvergenceResult, context: RunContext) => boolean

/**
 * Empty since F3: the runtime stamp and the recency it moved, the workspace
 * recency mirror and the partial `session.created` are fixed (§4.4, §4.7.1,
 * §4.7.2), so whatever a seeded run shows is a bug no fingerprint excuses.
 * A phase that documents a new cause adds its fingerprint here.
 */
export const FINGERPRINTS: Record<string, Fingerprint> = {}

/** Each entry with the cause whose fingerprint explains it; `undefined`: nobody documented it. */
export function classify(result: ConvergenceResult, context: RunContext) {
  return result.entries.map((entry) => ({
    entry,
    cause: Object.entries(FINGERPRINTS).find(([, fingerprint]) =>
      fingerprint(entry, result, context),
    )?.[0],
  }))
}
