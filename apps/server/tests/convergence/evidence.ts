import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describeVerdict, judge, trimmed, type CauseInstance, type Verdict } from './expectation.ts'
import { report, type ConvergenceResult, type Rig, type TestClient } from './harness.ts'

/**
 * How a scenario that fails on main proves it fails for the stated reason.
 *
 * `it.fails` passes on any throw: a crash of the harness, a timeout, a typo.
 * Here a scenario is a normal test, and the diff it ends with is judged
 * against its primary cause and the residual causes it names, each
 * instantiated with the fixture's own ids and captured values
 * (expectation.ts, causes.ts). Three outcomes:
 *
 *   - primary cause remains, nothing unexplained: the demonstration passes;
 *   - primary cause gone, at most the named residuals left: FlipError, "flip
 *     it to a guard" (the phase that fixed it does so);
 *   - anything else, including part of the primary cause or an entry no
 *     instantiated cause explains: WrongCauseError, listing what.
 *
 * A step that throws fails the test as any error does.
 */

export class FlipError extends Error {
  constructor(scenario: string, detail: string) {
    super(
      `${scenario}: the primary cause is gone on this build; flip it from a known divergence to a regression guard. ${detail}`,
    )
    this.name = 'FlipError'
  }
}

export class WrongCauseError extends Error {
  constructor(scenario: string, detail: string) {
    super(`${scenario} diverged, but not (only) for the stated cause.\n${detail}`)
    this.name = 'WrongCauseError'
  }
}

export interface Evidence {
  scenario: string
  bucket: 'known-divergence' | 'regression-guard' | 'timing'
  cause: string
  residualCauses?: string[]
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
 * A cause instance, or a builder run after the check. A builder takes no
 * argument on purpose: nothing it expects may come from the result being
 * judged, only from values the scenario captured (events the proxy recorded,
 * the server's own reads, what it sent) and fresh server reads it makes itself.
 */
export type CauseSource = CauseInstance | (() => CauseInstance | Promise<CauseInstance>)
const build = async (source: CauseSource) => (typeof source === 'function' ? source() : source)

/** Judge a convergence result against instantiated causes. */
export function verdictOf(
  result: ConvergenceResult,
  primary: CauseInstance | undefined,
  residuals: readonly CauseInstance[],
): Verdict {
  return judge(result.entries, primary, residuals)
}

/**
 * Demonstrate a known divergence: the primary cause, exactly, and nothing
 * but it and the named residuals, after the whole eventual window.
 */
export async function demonstrateDiff(
  scenario: string,
  rig: Rig,
  subject: TestClient,
  primary: CauseSource,
  residuals: readonly CauseSource[] = [],
  options: { timeoutMs?: number } = {},
): Promise<ConvergenceResult> {
  const result = await rig.checkConvergence(subject, options)
  const primaryInstance = await build(primary)
  const verdict = verdictOf(result, primaryInstance, await Promise.all(residuals.map(build)))
  if (verdict.outcome === 'primary-gone') {
    throw new FlipError(
      scenario,
      verdict.residualCauses.length
        ? `Only the named residual causes remain: ${verdict.residualCauses.join(', ')}.`
        : 'The property holds.',
    )
  }
  if (verdict.outcome === 'unexpected') {
    throw new WrongCauseError(
      scenario,
      `Stated cause: ${primaryInstance.cause}\n${describeVerdict(verdict, result.entries)}`,
    )
  }
  recordEvidence({
    scenario,
    bucket: 'known-divergence',
    cause: primaryInstance.cause,
    ...(verdict.residualCauses.length ? { residualCauses: verdict.residualCauses } : {}),
    observed: trimmed(result.entries),
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
 * A guard on one thing while other documented causes unavoidably show in the
 * same state. Each is instantiated as tightly as a primary cause; anything
 * they do not explain fails. One round first: an instantiated residual is
 * permanent, so only something else needs the whole eventual window.
 */
export async function expectConvergesExcept(
  scenario: string,
  rig: Rig,
  subject: TestClient,
  residuals: readonly CauseSource[],
): Promise<ConvergenceResult> {
  let result = await rig.checkConvergence(subject, { timeoutMs: 1 })
  let verdict = verdictOf(result, undefined, await Promise.all(residuals.map(build)))
  if (verdict.outcome !== 'primary-gone') {
    result = await rig.checkConvergence(subject)
    verdict = verdictOf(result, undefined, await Promise.all(residuals.map(build)))
  }
  if (verdict.outcome !== 'primary-gone') {
    throw new Error(
      `${scenario}: the property does not hold beyond the named causes.\n${describeVerdict(verdict, result.entries)}`,
    )
  }
  recordEvidence({
    scenario,
    bucket: 'regression-guard',
    cause: 'converges apart from named, instantiated causes',
    residualCauses: verdict.residualCauses,
    observed: trimmed(result.entries),
  })
  return result
}
