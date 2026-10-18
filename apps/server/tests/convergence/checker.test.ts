/**
 * The checker itself, with no server: a demonstration must fail when the
 * diff names the wrong entity, goes the wrong way, carries one more missing
 * item than the cause produces, shows the cause only in part, or has the
 * fresh load disagree with the server; it must ask to flip when only the
 * named residuals are left. The seeded runs' fingerprints get the same tests.
 */
import { describe, expect, it } from 'vitest'
import {
  classify,
  runtimeStamp,
  sessionCreatedPartial,
  snapshotMergeDropsOlderActivity,
  thoughtClosedByFold,
  workspaceRecencyMirror,
} from './causes.ts'
import { judge } from './expectation.ts'
import type { ConvergenceResult } from './harness.ts'
import { ABSENT, type DiffEntry, type NormalizedView } from './normalize.ts'

const T = 'thread-1'
const S = 'session-new'
const O = 'session-older'
const W = 'workspace-1'
const held = '2026-10-18T10:00:00.000Z'
const stampedAt = Date.parse('2026-10-18T10:00:00.520Z')
const stamped = '2026-10-18T10:00:00.523Z'

const s8 = () =>
  runtimeStamp({
    sessionId: S,
    heldUpdatedAt: held,
    stampedAt,
    order: { held: [O, S], stamped: [S, O] },
  })
const x2 = () => sessionCreatedPartial({ sessionIds: [O, S], providerId: 'opencode' })

const e = (comparison: string, path: string, left: unknown, right: unknown): DiffEntry => ({
  comparison,
  path,
  left,
  right,
})

/** S8's real diff: the stamp on both comparisons, the order, and X2 for both sessions. */
const s8Diff = (): DiffEntry[] => [
  e('fresh', `sessions[${S}].updatedAt`, held, stamped),
  e('server', `sessions[${S}].updatedAt`, held, stamped),
  e('fresh', 'sessions(order)', [O, S], [S, O]),
  e('server', 'sessions(order)', [O, S], [S, O]),
  e('fresh', `sessions[${O}].providerId`, ABSENT, 'opencode'),
  e('fresh', `sessions[${S}].providerId`, ABSENT, 'opencode'),
  e('server', `sessions[${O}].providerId`, ABSENT, 'opencode'),
  e('server', `sessions[${S}].providerId`, ABSENT, 'opencode'),
]

describe('the demonstration checker', () => {
  it('accepts exactly the primary cause plus named residuals', () => {
    expect(judge(s8Diff(), s8(), [x2()]).outcome).toBe('primary-remains')
  })

  it('fails on the wrong entity', () => {
    const diff = s8Diff().map((entry) =>
      entry.path === `sessions[${S}].updatedAt`
        ? { ...entry, path: `sessions[other].updatedAt` }
        : entry,
    )
    expect(judge(diff, s8(), [x2()]).outcome).toBe('unexpected')
  })

  it('fails on the wrong direction', () => {
    const diff = s8Diff().map((entry) =>
      entry.path === `sessions[${S}].updatedAt` ? { ...entry, left: stamped, right: held } : entry,
    )
    expect(judge(diff, s8(), [x2()]).outcome).toBe('unexpected')
  })

  it('fails on a stamp time that is not the provider session resolving', () => {
    const late = '2026-10-18T10:00:02.000Z'
    const diff = s8Diff().map((entry) =>
      entry.path === `sessions[${S}].updatedAt` ? { ...entry, right: late } : entry,
    )
    expect(judge(diff, s8(), [x2()]).outcome).toBe('unexpected')
  })

  it('fails when the primary cause shows only in part', () => {
    const diff = s8Diff().filter(
      (entry) => entry.comparison !== 'server' || !entry.path.endsWith('updatedAt'),
    )
    expect(judge(diff, s8(), [x2()]).outcome).toBe('unexpected')
  })

  it('asks to flip when only the named residuals are left', () => {
    const diff = s8Diff().filter((entry) => entry.path.endsWith('providerId'))
    const verdict = judge(diff, s8(), [x2()])
    expect(verdict.outcome).toBe('primary-gone')
    expect(verdict.residualCauses).toEqual(['SESSION_CREATED_PARTIAL'])
    expect(judge([], s8(), [x2()]).outcome).toBe('primary-gone')
  })

  it('fails when a residual names a session it was not instantiated for', () => {
    const diff = [...s8Diff(), e('fresh', 'sessions[stranger].providerId', ABSENT, 'opencode')]
    expect(judge(diff, s8(), [x2()]).outcome).toBe('unexpected')
  })

  it('fails on an unexpected fresh/server disagreement', () => {
    const diff = [...s8Diff(), e('fresh-vs-server', `sessions[${S}].updatedAt`, held, stamped)]
    expect(judge(diff, s8(), [x2()]).outcome).toBe('unexpected')
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

  it('fails on the thought cause for a thought it was not told about', () => {
    const cause = thoughtClosedByFold({ threadId: T, messageIds: ['r1'] })
    const at = `active.threads.${T}`
    const diff = ['fresh', 'server'].map((comparison) =>
      e(comparison, `${at}.reasoning.r1.phase`, 'stop', 'delta'),
    )
    expect(judge(diff, cause).outcome).toBe('primary-remains')
    expect(
      judge([...diff, e('fresh', `${at}.reasoning.r2.phase`, 'stop', 'delta')], cause).outcome,
    ).toBe('unexpected')
  })
})

/** The smallest result the fingerprints look at. */
function result(
  entries: DiffEntry[],
  fresh: Partial<NormalizedView>,
  view: Partial<NormalizedView> = {},
) {
  const base: NormalizedView = {
    environment: null,
    workspaces: {},
    workspaceOrder: [],
    sessions: [],
    drafts: {},
    composerPreferences: {},
    active: null,
  }
  return {
    converged: entries.length === 0,
    entries,
    view: { ...base, ...view },
    fresh: { ...base, ...fresh },
    server: { threads: {}, sessions: [] },
  } as ConvergenceResult
}

describe('the seeded runs’ fingerprints', () => {
  it('explain recency only when the fresh value is the newest session update', () => {
    const fresh = {
      sessions: [{ sessionId: S, workspaceId: W, updatedAt: stamped }],
    }
    const right = result([e('fresh', `workspaces.${W}.lastActivityAt`, held, stamped)], fresh)
    expect(classify(right, { stamps: {}, restarts: [] })[0]!.cause).toBe('WORKSPACE_RECENCY_MIRROR')
    // Any other time is not this cause.
    const other = result(
      [e('fresh', `workspaces.${W}.lastActivityAt`, held, '2026-10-18T11:00:00.000Z')],
      fresh,
    )
    expect(classify(other, { stamps: {}, restarts: [] })[0]!.cause).toBeUndefined()
    // Nor the other way round.
    const backwards = result(
      [e('fresh', `workspaces.${W}.lastActivityAt`, '2026-10-18T12:00:00.000Z', stamped)],
      fresh,
    )
    expect(classify(backwards, { stamps: {}, restarts: [] })[0]!.cause).toBeUndefined()
    // The relation the scenarios use agrees.
    const cause = workspaceRecencyMirror(right, W)
    expect(judge(right.entries, cause).outcome).toBe('primary-remains')
    expect(judge(other.entries, cause).outcome).toBe('unexpected')
  })

  it('explain a stamp only at the provider session’s resolution time', () => {
    const entries = [e('fresh', `sessions[${S}].updatedAt`, held, stamped)]
    expect(
      classify(result(entries, {}), { stamps: { [S]: stampedAt }, restarts: [] })[0]!.cause,
    ).toBe('RUNTIME_STAMP')
    expect(classify(result(entries, {}), { stamps: {}, restarts: [] })[0]!.cause).toBeUndefined()
    expect(
      classify(result(entries, {}), { stamps: { [S]: stampedAt - 5_000 }, restarts: [] })[0]!.cause,
    ).toBeUndefined()
  })

  it('explain a closed thought only when something followed it or its turn ended', () => {
    const at = `active.threads.${T}`
    const entries = [e('fresh', `${at}.reasoning.r1.phase`, 'stop', 'delta')]
    const threadWith = (order: unknown[], state: string) => ({
      active: {
        sessionId: S,
        present: true,
        threads: {
          [T]: {
            turns: [{ turnId: 'u1', state }],
            messages: [],
            reasoning: {},
            tools: {},
            order,
            unplaced: { reasoning: [], tools: [] },
            interactions: {},
            failures: {},
          },
        },
      },
    })
    const alone = [{ kind: 'reasoning', id: 'r1', turnId: 'u1' }]
    const followed = [...alone, { kind: 'message', id: 'm1', turnId: 'u1' }]
    const context = { stamps: {}, restarts: [] }
    expect(classify(result(entries, {}, threadWith(followed, 'running')), context)[0]!.cause).toBe(
      'THOUGHT_CLOSED_BY_FOLD',
    )
    expect(classify(result(entries, {}, threadWith(alone, 'completed')), context)[0]!.cause).toBe(
      'THOUGHT_CLOSED_BY_FOLD',
    )
    // An open thought nothing followed, in a running turn: the fold had no reason to close it.
    expect(
      classify(result(entries, {}, threadWith(alone, 'running')), context)[0]!.cause,
    ).toBeUndefined()
  })

  it('never explain a fresh-vs-server disagreement', () => {
    const entries = [e('fresh-vs-server', `sessions[${S}].providerId`, ABSENT, 'opencode')]
    expect(classify(result(entries, {}), { stamps: {}, restarts: [] })[0]!.cause).toBeUndefined()
  })
})
