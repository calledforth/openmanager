import { canonical, describeDiff, trim, type DiffEntry } from './normalize.ts'

/**
 * What a documented cause does to one fixture, as the exact diff entries it
 * produces: which comparison, which path (the fixture's own ids), and which
 * values on each side (the fixture's captured values, or a stated relation).
 *
 * A scenario's verdict needs every observed entry to be one of these, so an
 * unrelated difference can never hide behind a cause that happens to touch
 * the same kind of field.
 */

export type Comparison = 'fresh' | 'server' | 'fresh-vs-server'

/** A value an entry side must have: exact (deep, canonical), or a named check. */
export type Side = { equals: unknown } | { check: (value: unknown) => boolean; describe: string }

export const equals = (value: unknown): Side => ({ equals: value })
export const satisfies = (describe: string, check: (value: unknown) => boolean): Side => ({
  check,
  describe,
})

export interface ExpectedEntry {
  /** Each listed comparison must show this entry (for a primary cause). */
  comparisons: readonly Comparison[]
  path: string
  left: Side
  right: Side
  /** A relation between the two sides, beyond each side's own check. */
  relation?: { describe: string; check: (left: unknown, right: unknown) => boolean }
}

/** One documented cause, instantiated for one fixture. */
export interface CauseInstance {
  name: string
  /** The cause as the doc states it, with its references. */
  cause: string
  entries: ExpectedEntry[]
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

function sideMatches(side: Side, value: unknown): boolean {
  return 'equals' in side ? same(side.equals, value) : side.check(value)
}

function entryMatches(expected: ExpectedEntry, comparison: Comparison, entry: DiffEntry) {
  return (
    entry.comparison === comparison &&
    entry.path === expected.path &&
    sideMatches(expected.left, entry.left) &&
    sideMatches(expected.right, entry.right) &&
    (expected.relation === undefined || expected.relation.check(entry.left, entry.right))
  )
}

export type Outcome =
  /** Every entry of the primary cause, and nothing but it and named residuals. */
  | 'primary-remains'
  /** None of the primary cause is left; only named residuals, or nothing at all. */
  | 'primary-gone'
  /** Something no instantiated cause explains, or only part of the primary cause. */
  | 'unexpected'

export interface Verdict {
  outcome: Outcome
  /** Observed entries no expectation explains. */
  residual: DiffEntry[]
  /** Primary expectations (per comparison) that did not appear. */
  missing: string[]
  /** Primary expectations that did appear. */
  present: string[]
  /** Which named residual causes showed. */
  residualCauses: string[]
}

const label = (expected: ExpectedEntry, comparison: Comparison) =>
  `[${comparison}] ${expected.path}`

/**
 * Judge a diff against one primary cause and the residual causes the
 * scenario names. Each observed entry is explained by at most one expected
 * entry; each primary expected entry must be seen in each of its comparisons.
 */
export function judge(
  entries: readonly DiffEntry[],
  primary: CauseInstance | undefined,
  residuals: readonly CauseInstance[] = [],
): Verdict {
  const residual: DiffEntry[] = []
  const seen = new Set<string>()
  const residualCauses = new Set<string>()
  for (const entry of entries) {
    const comparison = entry.comparison as Comparison
    const hit = primary?.entries.find(
      (expected) =>
        expected.comparisons.includes(comparison) && entryMatches(expected, comparison, entry),
    )
    if (hit) {
      seen.add(label(hit, comparison))
      continue
    }
    const other = residuals.find((cause) =>
      cause.entries.some(
        (expected) =>
          expected.comparisons.includes(comparison) && entryMatches(expected, comparison, entry),
      ),
    )
    if (other) {
      residualCauses.add(other.name)
      continue
    }
    residual.push(entry)
  }
  const wanted = (primary?.entries ?? []).flatMap((expected) =>
    expected.comparisons.map((comparison) => label(expected, comparison)),
  )
  const present = wanted.filter((key) => seen.has(key))
  const missing = wanted.filter((key) => !seen.has(key))
  const outcome: Outcome =
    residual.length > 0
      ? 'unexpected'
      : missing.length === 0 && wanted.length > 0
        ? 'primary-remains'
        : present.length === 0
          ? 'primary-gone'
          : 'unexpected'
  return { outcome, residual, missing, present, residualCauses: [...residualCauses] }
}

export function describeVerdict(verdict: Verdict, entries: readonly DiffEntry[]): string {
  return [
    `Outcome: ${verdict.outcome}`,
    verdict.residual.length ? `Unexplained entries:\n${describeDiff(verdict.residual)}` : '',
    verdict.missing.length && verdict.present.length
      ? `Primary entries missing while others showed: ${verdict.missing.join(', ')}`
      : '',
    `Whole diff:\n${describeDiff(entries)}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Entries trimmed for the evidence file. */
export const trimmed = (entries: readonly DiffEntry[]) =>
  entries.map((entry) => ({ ...entry, left: trim(entry.left), right: trim(entry.right) }))

// Shared side checks -------------------------------------------------------

export const isTimestamp = satisfies(
  'an ISO timestamp',
  (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)),
)
