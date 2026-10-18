import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describeDiff, trim, type DiffEntry } from './normalize.ts'
import { report, type ConvergenceResult, type Rig, type TestClient } from './harness.ts'

/**
 * How a scenario that fails on main proves it fails for the stated reason.
 *
 * `it.fails` passes on any throw: a crash of the harness, a timeout, a typo.
 * Here a scenario is a normal test that only passes when
 *
 *   1. every step completed, and
 *   2. the observation is the documented one: a structural diff in which
 *      every entry is explained by the stated cause and the cause's own
 *      signature is present, or (for transport failures) the documented
 *      close reason seen in a reconnect loop.
 *
 * Anything else fails loudly, with a message that says which:
 *   - a step threw: the error, as any test;
 *   - the property now holds: "now converges on this build: flip it";
 *   - it diverged some other way: the unexplained entries, or the missing
 *     signature.
 */

export type Comparison = 'fresh' | 'server' | 'fresh-vs-server'

export interface DiffMatcher {
  /** Which comparison the entry comes from; any when absent. */
  comparison?: Comparison | readonly Comparison[]
  path: RegExp
  left?: (value: unknown) => boolean
  right?: (value: unknown) => boolean
  /** A condition on both sides at once. */
  pair?: (left: unknown, right: unknown) => boolean
}

export interface DiffCause {
  /** The cause as the doc states it, with its reference. */
  cause: string
  /** Entries the cause accounts for. Every entry of the diff must match one. */
  explains: DiffMatcher[]
  /** Entries the cause must produce. Each must match at least one entry. */
  requires: DiffMatcher[]
}

export class FlipError extends Error {
  constructor(scenario: string, detail: string) {
    super(
      `${scenario} now converges on this build: flip it from a known divergence to a regression guard. ${detail}`,
    )
    this.name = 'FlipError'
  }
}

export class WrongCauseError extends Error {
  constructor(scenario: string, detail: string) {
    super(`${scenario} diverged, but not for the stated cause.\n${detail}`)
    this.name = 'WrongCauseError'
  }
}

export const matches = (matcher: DiffMatcher, entry: DiffEntry) =>
  (matcher.comparison === undefined ||
    (typeof matcher.comparison === 'string'
      ? matcher.comparison === entry.comparison
      : matcher.comparison.includes(entry.comparison as Comparison))) &&
  matcher.path.test(entry.path) &&
  (matcher.left === undefined || matcher.left(entry.left)) &&
  (matcher.right === undefined || matcher.right(entry.right)) &&
  (matcher.pair === undefined || matcher.pair(entry.left, entry.right))

/** The verdict on one diff against one cause. */
export function judge(entries: readonly DiffEntry[], cause: DiffCause) {
  const unexplained = entries.filter((entry) => !cause.explains.some((m) => matches(m, entry)))
  const missing = cause.requires.filter((m) => !entries.some((entry) => matches(m, entry)))
  return { unexplained, missing }
}

export const is =
  (expected: unknown) =>
  (value: unknown): boolean =>
    Object.is(value, expected)

export interface Evidence {
  scenario: string
  bucket: 'known-divergence' | 'regression-guard' | 'timing'
  cause: string
  alsoExplainedBy?: string[]
  observed: unknown
}

/** Where evidence goes, one JSON line per demonstration, when the env var names a directory. */
export function recordEvidence(evidence: Evidence): void {
  const directory = process.env.CONVERGENCE_EVIDENCE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  appendFileSync(
    join(directory, 'evidence.jsonl'),
    `${JSON.stringify({ ...evidence, recordedAt: new Date().toISOString() })}\n`,
  )
}

/**
 * Demonstrate a known divergence of the convergence property. Returns the
 * diff it observed, trimmed to what shows the cause.
 */
export async function demonstrateDiff(
  scenario: string,
  rig: Rig,
  subject: TestClient,
  cause: DiffCause,
  options: {
    timeoutMs?: number
    /**
     * Other documented causes the same construction cannot avoid. Their
     * entries are allowed; only `cause` has to show its signature.
     */
    alsoExplainedBy?: DiffCause[]
  } = {},
): Promise<ConvergenceResult> {
  const result = await rig.checkConvergence(subject, options)
  if (result.converged) throw new FlipError(scenario, 'The property held within the window.')
  const co = options.alsoExplainedBy ?? []
  const { unexplained, missing } = judge(result.entries, {
    ...cause,
    explains: [...cause.explains, ...co.flatMap((other) => other.explains)],
  })
  if (unexplained.length > 0 || missing.length > 0) {
    throw new WrongCauseError(
      scenario,
      [
        `Stated cause: ${cause.cause}`,
        unexplained.length
          ? `Entries the cause does not explain:\n${describeDiff(unexplained)}`
          : '',
        missing.length
          ? `Signature entries that never appeared: ${missing.map((m) => `${m.comparison ?? '*'} ${m.path}`).join(', ')}`
          : '',
        `Whole diff:\n${describeDiff(result.entries)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  recordEvidence({
    scenario,
    bucket: 'known-divergence',
    cause: cause.cause,
    ...(co.length ? { alsoExplainedBy: co.map((other) => other.cause) } : {}),
    observed: result.entries.map((entry) => ({
      ...entry,
      left: trim(entry.left),
      right: trim(entry.right),
    })),
  })
  return result
}

/** A regression guard: the property must hold. */
export async function expectConverges(
  scenario: string,
  rig: Rig,
  subject: TestClient,
  observed: Record<string, unknown> = {},
): Promise<ConvergenceResult> {
  const result = await rig.checkConvergence(subject)
  if (!result.converged)
    throw new Error(`${scenario}: the property does not hold.\n${report(result)}`)
  recordEvidence({ scenario, bucket: 'regression-guard', cause: 'converges', observed })
  return result
}

/**
 * A guard on one thing while another documented cause unavoidably shows in
 * the same state: every entry must be explained by `allowed`, and nothing
 * else may differ. The allowed causes are named, never a wildcard.
 */
export async function expectConvergesExcept(
  scenario: string,
  rig: Rig,
  subject: TestClient,
  allowed: readonly DiffCause[],
): Promise<ConvergenceResult> {
  const unexplainedIn = (entries: readonly DiffEntry[]) =>
    entries.filter(
      (entry) => !allowed.some((cause) => cause.explains.some((m) => matches(m, entry))),
    )
  // One round first: a named cause is permanent, so only something else
  // needs the whole eventual window before it counts.
  let result = await rig.checkConvergence(subject, { timeoutMs: 1 })
  if (unexplainedIn(result.entries).length > 0) result = await rig.checkConvergence(subject)
  const unexplained = unexplainedIn(result.entries)
  if (unexplained.length > 0) {
    throw new Error(
      `${scenario}: the property does not hold, and not only for ${allowed.map((c) => c.cause.slice(0, 40)).join('; ')}.
${describeDiff(unexplained)}`,
    )
  }
  recordEvidence({
    scenario,
    bucket: 'regression-guard',
    cause: 'converges apart from named causes',
    observed: result.entries.map((entry) => ({
      ...entry,
      left: trim(entry.left),
      right: trim(entry.right),
    })),
  })
  return result
}
