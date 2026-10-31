/**
 * The checker itself, with no server: a demonstration must fail when the
 * diff names the wrong entity, goes the wrong way, carries a value the cause
 * does not produce or one more missing item than it produces, shows the
 * cause only in part, or has the fresh load disagree with the server; it
 * must ask to flip when only the named residuals are left.
 *
 * The worked examples are S9's deleted sessions (the primary) and S6(b)'s
 * reasoning marker (a residual): causes that remain after F3. The seeded
 * runs' fingerprints are empty since F3, so nothing a run shows is excused.
 */
import { describe, expect, it } from 'vitest'
import {
  classify,
  environmentSnapshotNeverRemoves,
  reasoningBudgetMarker,
  snapshotMergeDropsOlderActivity,
} from './causes.ts'
import { judge } from './expectation.ts'
import type { ConvergenceResult } from './harness.ts'
import { ABSENT, type DiffEntry, type NormalizedView } from './normalize.ts'

const T = 'thread-1'
const P = 'session-parent'
const C = 'session-child'
const row = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  workspaceId: 'workspace-1',
  title: sessionId,
  status: 'idle',
  providerId: 'opencode',
  updatedAt: '2026-10-18T10:00:00.000Z',
  ...extra,
})
const rows = { [P]: row(P), [C]: row(C, { parentSessionId: P }) }
const thought = `${'x'.repeat(40)}the end of the thought`
const marker = `[40 characters of thinking not loaded]\nthe end of the thought`

const s9 = () => environmentSnapshotNeverRemoves({ rows })
const s6b = () => reasoningBudgetMarker({ threadId: T, messageId: 'r1', text: thought })

const e = (comparison: string, path: string, left: unknown, right: unknown): DiffEntry => ({
  comparison,
  path,
  left,
  right,
})

/** S9's diff on both comparisons, and S6(b)'s marker beside it. */
const s9Diff = (): DiffEntry[] =>
  ['fresh', 'server'].flatMap((comparison) => [
    e(comparison, `sessions[${P}]`, rows[P], ABSENT),
    e(comparison, `sessions[${C}]`, rows[C], ABSENT),
  ])
const markerDiff = (): DiffEntry[] =>
  ['fresh', 'server'].map((comparison) =>
    e(comparison, `active.threads.${T}.reasoning.r1.content[0].text`, thought, marker),
  )

describe('the demonstration checker', () => {
  it('accepts exactly the primary cause plus named residuals', () => {
    expect(judge([...s9Diff(), ...markerDiff()], s9(), [s6b()]).outcome).toBe('primary-remains')
    expect(judge(s9Diff(), s9(), [s6b()]).outcome).toBe('primary-remains')
  })

  it('fails on the wrong entity', () => {
    const diff = s9Diff().map((entry) =>
      entry.path === `sessions[${C}]` ? { ...entry, path: 'sessions[other]' } : entry,
    )
    expect(judge(diff, s9(), [s6b()]).outcome).toBe('unexpected')
  })

  it('fails on the wrong direction', () => {
    const diff = s9Diff().map((entry) =>
      entry.path === `sessions[${C}]` ? { ...entry, left: ABSENT, right: entry.left } : entry,
    )
    expect(judge(diff, s9(), [s6b()]).outcome).toBe('unexpected')
  })

  it('fails on a value the cause does not hold', () => {
    const diff = s9Diff().map((entry) =>
      entry.path === `sessions[${P}]` ? { ...entry, left: row(P, { title: 'Renamed' }) } : entry,
    )
    expect(judge(diff, s9(), [s6b()]).outcome).toBe('unexpected')
  })

  it('fails when the primary cause shows only in part', () => {
    const diff = s9Diff().filter(
      (entry) => entry.comparison !== 'server' || entry.path !== `sessions[${C}]`,
    )
    expect(judge(diff, s9(), [s6b()]).outcome).toBe('unexpected')
  })

  it('asks to flip when only the named residuals are left', () => {
    const verdict = judge(markerDiff(), s9(), [s6b()])
    expect(verdict.outcome).toBe('primary-gone')
    expect(verdict.residualCauses).toEqual(['REASONING_BUDGET_MARKER'])
    expect(judge([], s9(), [s6b()]).outcome).toBe('primary-gone')
  })

  it('fails when a residual names a thought it was not instantiated for', () => {
    const stranger = markerDiff().map((entry) => ({
      ...entry,
      path: entry.path.replace('reasoning.r1', 'reasoning.r2'),
    }))
    expect(judge([...s9Diff(), ...stranger], s9(), [s6b()]).outcome).toBe('unexpected')
  })

  it('fails on an unexpected fresh/server disagreement', () => {
    const diff = [...s9Diff(), e('fresh-vs-server', `sessions[${P}]`, rows[P], ABSENT)]
    expect(judge(diff, s9(), [s6b()]).outcome).toBe('unexpected')
  })

  it('fails on one more missing item than the snapshot merge drops', () => {
    const lost = { messageId: 'r-old', turnId: 'turn-1', phase: 'delta', content: [] }
    const tool = { toolCallId: 't-old', turnId: 'turn-1', status: 'completed' }
    const cause = snapshotMergeDropsOlderActivity({
      threadId: T,
      reasoning: { 'r-old': lost },
      tools: { 't-old': tool },
      refs: [],
    })
    const at = `active.threads.${T}`
    const diff = ['fresh', 'server'].flatMap((comparison) => [
      e(comparison, `${at}.reasoning.r-old`, ABSENT, lost),
      e(comparison, `${at}.tools.t-old`, ABSENT, tool),
    ])
    expect(judge(diff, cause).outcome).toBe('primary-remains')
    const extra = [
      ...diff,
      e('fresh', `${at}.reasoning.r-newer`, ABSENT, { ...lost, messageId: 'r-newer' }),
    ]
    expect(judge(extra, cause).outcome).toBe('unexpected')
    // The right entity, but not the value the server read holds.
    const changed = diff.map((entry) =>
      entry.path.endsWith('r-old') ? { ...entry, right: { ...lost, phase: 'stop' } } : entry,
    )
    expect(judge(changed, cause).outcome).toBe('unexpected')
  })
})

/** The smallest result `classify` looks at. */
function result(entries: DiffEntry[]) {
  const base: NormalizedView = {
    environment: null,
    workspaces: {},
    workspaceOrder: [],
    sessions: [],
    drafts: {},
    composerPreferences: {},
    composerListings: {},
    active: null,
  }
  return {
    converged: entries.length === 0,
    entries,
    view: base,
    fresh: base,
    server: { threads: {}, sessions: [] },
  } as ConvergenceResult
}

const context = {
  witness: { provenance: { audit: [], deliveries: [] }, wire: { ports: new Set<number>() } },
  restarts: [],
}

describe('the seeded runs’ fingerprints', () => {
  it('explain nothing since F3: every documented cause a run could show is fixed', () => {
    const at = `active.threads.${T}`
    const entries = [
      // Once the runtime stamp (§4.4).
      e('fresh', `sessions[${P}].updatedAt`, '2026-10-18T10:00:00.000Z', '2026-10-18T10:00:00.5Z'),
      e('fresh', 'sessions(order)', [P, C], [C, P]),
      // Once the workspace recency mirror (X1) and the stamp's recency.
      e(
        'fresh',
        'workspaces.workspace-1.lastActivityAt',
        '2026-10-18T10:00:00.000Z',
        '2026-10-18T10:00:00.8Z',
      ),
      // Once the partial session.created (X2).
      e('server', `sessions[${P}].providerId`, ABSENT, 'opencode'),
      // Once a thought closed only on the client (A4).
      e('fresh', `${at}.reasoning.r1.phase`, 'stop', 'delta'),
      // Never explained.
      e('fresh-vs-server', `sessions[${P}].providerId`, ABSENT, 'opencode'),
    ]
    expect(classify(result(entries), context).map((item) => item.cause)).toEqual(
      entries.map(() => undefined),
    )
  })
})
