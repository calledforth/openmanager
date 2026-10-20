/**
 * The checker itself, with no server: a demonstration must fail when the
 * diff names the wrong entity, goes the wrong way, carries one more missing
 * item than the cause produces, shows the cause only in part, or has the
 * fresh load disagree with the server; it must ask to flip when only the
 * named residuals are left. The seeded runs' fingerprints get the same tests.
 *
 * Time-valued causes are judged by provenance (provenance.ts), so each test
 * writes the server's story as the child's audit and delivery log would
 * record it (`Story`), including the adversarial ones: a rename or a
 * `turn.started` the client missed must never pass as a known cause.
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
import { verdictOf } from './evidence.ts'
import { s8Causes, x2Causes } from './fixtures.ts'
import type { AuditRow, Delivery } from './child-protocol.ts'
import type { ConvergenceResult } from './harness.ts'
import { ABSENT, type DiffEntry, type NormalizedView } from './normalize.ts'
import type { ClientWire, Provenance } from './provenance.ts'

const T = 'thread-1'
const S = 'session-new'
const O = 'session-older'
const W = 'workspace-1'
const E = '["environment","env-1"]'
const K = `["thread","env-1","${S}","${T}"]`
const at = (iso: string) => Date.parse(iso)
const held = '2026-10-18T10:00:00.000Z'
const stamped = '2026-10-18T10:00:00.523Z'
/** What B was sent last for the workspace: markUsed, just before the stamp. */
const usedAt = '2026-10-18T10:00:00.521Z'
/** The client under test: one socket, port 5001. */
const SOCKET = '1:1'
const wire: ClientWire = { ports: new Set([5001]) }

/**
 * A server's story, as the child's triggers and delivery log record it. The
 * session-time writes and their events go in together, as the projection
 * commits them (event-repository.ts, `writeScope`).
 */
class Story {
  readonly audit: AuditRow[] = []
  readonly deliveries: Delivery[] = []
  private readonly sequences = new Map<string, number>()
  private readonly providers = new Map<string, string | null>()
  private readonly times = new Map<string, number>()

  constructor() {
    this.audit.push({ seq: 1, kind: 'boot' })
    this.deliver({ k: 'grant', key: E, mode: 'live', base: null, replayed: [] })
  }

  private next() {
    return this.audit.length + 1
  }

  private deliver(record: Record<string, unknown>, socket: string | null = SOCKET) {
    this.deliveries.push({
      ...(socket ? { s: socket, port: 5001 } : {}),
      a: this.audit.length,
      at: 0,
      ...record,
    } as Delivery)
  }

  event(
    name: string,
    ts: string,
    fields: Partial<Extract<AuditRow, { kind: 'event' }>> = {},
  ): Extract<AuditRow, { kind: 'event' }> {
    const scopeKey = fields.scopeKey ?? E
    const sequence = (this.sequences.get(scopeKey) ?? 0) + 1
    this.sequences.set(scopeKey, sequence)
    const row = {
      seq: this.next(),
      kind: 'event' as const,
      scopeKey,
      sequence,
      name,
      eventId: `${name}-${sequence}`,
      ts: at(ts),
      sessionId: null,
      workspaceId: null,
      threadId: null,
      title: false,
      status: null,
      lastActivityAt: null,
      ...fields,
    }
    this.audit.push(row)
    return row
  }

  /**
   * A publish of `event` to this client: owed and handed over; owed and not
   * while the socket stayed open (false); or not sent because the send
   * closed the socket ('closed', slow_consumer).
   */
  publish(
    event: { scopeKey: string; sequence: number; name: string },
    handed: boolean | 'closed' = true,
  ) {
    this.deliver(
      {
        k: 'publish',
        key: event.scopeKey,
        seq: event.sequence,
        name: event.name,
        owed: [SOCKET],
        pending: [],
        sent: handed === true ? [SOCKET] : [],
        withheld: handed === false ? [SOCKET] : [],
      },
      null,
    )
  }

  write(sessionId: string, ts: string, provider?: string) {
    const old = this.times.get(sessionId) ?? null
    const oldProvider = this.providers.get(sessionId) ?? null
    const newProvider = provider ?? oldProvider
    this.audit.push({
      seq: this.next(),
      kind: 'session',
      op: old === null ? 'insert' : 'update',
      sessionId,
      workspaceId: W,
      old,
      new: at(ts),
      oldProvider: old === null ? null : oldProvider,
      newProvider,
    })
    this.times.set(sessionId, at(ts))
    this.providers.set(sessionId, newProvider)
  }

  created(sessionId: string, ts: string) {
    this.publish(this.event('session.created', ts, { sessionId, workspaceId: W }))
    this.write(sessionId, ts)
  }

  /** The provider resolves: markUsed (and its workspace.updated), then the silent stamp. */
  started(sessionId: string, used: string, stamp: string) {
    this.audit.push({
      seq: this.next(),
      kind: 'workspace',
      workspaceId: W,
      old: null,
      new: at(used),
    })
    this.publish(this.event('workspace.updated', used, { workspaceId: W, lastActivityAt: used }))
    this.write(sessionId, stamp, `fake-${sessionId}`)
  }

  renamed(sessionId: string, ts: string) {
    this.publish(this.event('session.updated', ts, { sessionId, title: true }))
    this.write(sessionId, ts)
  }

  /** A turn starts: the thread event, its write, and the status event, in one transaction. */
  turnStarted(sessionId: string, ts: string, handed: boolean | 'closed' | 'not subscribed' = true) {
    const started = this.event('turn.started', ts, {
      scopeKey: K,
      sessionId,
      threadId: T,
    })
    if (handed !== 'not subscribed') this.publish(started, handed)
    this.write(sessionId, ts)
    this.publish(this.event('session.updated', ts, { sessionId, status: 'running' }))
  }

  subscribeThread() {
    this.deliver({ k: 'grant', key: K, mode: 'snapshot', base: 0, replayed: [] })
  }

  get provenance(): Provenance {
    return { audit: this.audit, deliveries: this.deliveries }
  }

  get witness() {
    return { provenance: this.provenance, wire }
  }
}

/** S8's story: Older stamped, New announced, Older renamed, then New's provider resolves. */
function s8Story(): Story {
  const story = new Story()
  story.created(O, '2026-10-18T09:59:59.000Z')
  story.started(O, '2026-10-18T09:59:59.400Z', '2026-10-18T09:59:59.401Z')
  story.created(S, held)
  story.renamed(O, '2026-10-18T10:00:00.200Z')
  story.started(S, usedAt, stamped)
  return story
}

const s8 = (story = s8Story()) =>
  runtimeStamp({
    sessionId: S,
    heldUpdatedAt: held,
    witness: story.witness,
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
    server: { threads: {}, sessions: (fresh.sessions ?? []) as unknown[] },
  } as ConvergenceResult
}

const contextOf = (story: Story) => ({ witness: story.witness, restarts: [] })
const recencyEntry = (left: unknown, right: unknown) =>
  e('fresh', `workspaces.${W}.lastActivityAt`, left, right)
const timeEntries = (left: unknown, right: unknown) =>
  ['fresh', 'server'].map((comparison) => e(comparison, `sessions[${S}].updatedAt`, left, right))

/** X1's story: a turn the client watched, then a rename (session.updated, no workspace event). */
function x1Story() {
  const story = new Story()
  story.created(S, held)
  story.started(S, '2026-10-18T10:00:00.030Z', '2026-10-18T10:00:00.031Z')
  story.subscribeThread()
  story.turnStarted(S, '2026-10-18T10:00:00.400Z')
  story.renamed(S, '2026-10-18T10:00:00.800Z')
  return story
}

describe('the seeded runs’ fingerprints', () => {
  it('explain recency only by provenance: an unannounced write, nothing newer offered', () => {
    const story = x1Story()
    const lastTurn = '2026-10-18T10:00:00.400Z'
    const renamed = '2026-10-18T10:00:00.800Z'
    const classifyOne = (entry: DiffEntry) =>
      classify(result([entry], {}), contextOf(story))[0]!.cause
    expect(classifyOne(recencyEntry(lastTurn, renamed))).toBe('WORKSPACE_RECENCY_MIRROR')
    // Any other server time is not what the writes add up to.
    expect(classifyOne(recencyEntry(lastTurn, '2026-10-18T11:00:00.000Z'))).toBeUndefined()
    // Nor the other way round.
    expect(classifyOne(recencyEntry(renamed, lastTurn))).toBeUndefined()
    // A client older than the turn it was handed lost that turn.started.
    expect(classifyOne(recencyEntry(held, renamed))).toBeUndefined()
    // The scenarios' instance agrees.
    const cause = workspaceRecencyMirror({ workspaceId: W, held: lastTurn, witness: story.witness })
    expect(judge([recencyEntry(lastTurn, renamed)], cause).outcome).toBe('primary-remains')
    expect(judge([recencyEntry(lastTurn, '2027-01-01T00:00:00.000Z')], cause).outcome).toBe(
      'unexpected',
    )
    // A client value other than the one it was sent is not this cause, even if older.
    expect(judge([recencyEntry('2026-10-18T09:00:00.000Z', renamed)], cause).outcome).toBe(
      'unexpected',
    )
  })

  it('explain a stamp only when the server’s value is the audited, unannounced stamp', () => {
    const story = s8Story()
    const entries = timeEntries(held, stamped)
    expect(classify(result(entries, {}), contextOf(story))[0]!.cause).toBe('RUNTIME_STAMP')
    // A server time the stamp did not write.
    expect(
      classify(result(timeEntries(held, '2026-10-18T10:00:00.700Z'), {}), contextOf(story))[0]!
        .cause,
    ).toBeUndefined()
    // No stamp in the story: the same shape is nobody's cause.
    const unstamped = new Story()
    unstamped.created(S, held)
    unstamped.write(S, stamped)
    expect(classify(result(entries, {}), contextOf(unstamped))[0]!.cause).toBeUndefined()
  })

  it('never pass a missed rename as the stamp, either way round', () => {
    // Stamp, then a rename whose session.updated the client missed.
    const after = s8Story()
    const renamed = '2026-10-18T10:00:00.900Z'
    after.renamed(S, renamed)
    expect(
      classify(result(timeEntries(held, renamed), {}), contextOf(after))[0]!.cause,
    ).toBeUndefined()
    // A rename the client missed, then the stamp: the stamp is the server's
    // value, but a newer time than the client's was announced.
    const before = new Story()
    before.created(S, held)
    before.renamed(S, '2026-10-18T10:00:00.300Z')
    before.started(S, usedAt, stamped)
    expect(
      classify(result(timeEntries(held, stamped), {}), contextOf(before))[0]!.cause,
    ).toBeUndefined()
    // The scenarios' builder refuses both.
    for (const [story, right] of [
      [after, renamed],
      [before, stamped],
    ] as const) {
      const cause = runtimeStamp({ sessionId: S, heldUpdatedAt: held, witness: story.witness })
      expect(judge(timeEntries(held, right), cause).outcome).toBe('unexpected')
    }
  })

  it('never pass a missed turn.started as recency', () => {
    const story = new Story()
    story.created(S, held)
    story.started(S, usedAt, stamped)
    story.subscribeThread()
    const turnAt = '2026-10-18T10:00:01.000Z'
    // Handed to the client's socket, and the client still holds markUsed's value.
    story.turnStarted(S, turnAt)
    expect(
      classify(result([recencyEntry(usedAt, turnAt)], {}), contextOf(story))[0]!.cause,
    ).toBeUndefined()
    // Owed to the open socket and never handed over: the server's own loss.
    const lost = new Story()
    lost.created(S, held)
    lost.started(S, usedAt, stamped)
    lost.subscribeThread()
    lost.turnStarted(S, turnAt, false)
    expect(
      classify(result([recencyEntry(usedAt, turnAt)], {}), contextOf(lost))[0]!.cause,
    ).toBeUndefined()
    const cause = workspaceRecencyMirror({ workspaceId: W, held: usedAt, witness: lost.witness })
    expect(judge([recencyEntry(usedAt, turnAt)], cause).outcome).toBe('unexpected')
    // Not sent because the send closed the socket (slow_consumer): the client
    // recovers by replay (which offers it again) or by a snapshot, not offered here.
    const closed = new Story()
    closed.created(S, held)
    closed.started(S, usedAt, stamped)
    closed.subscribeThread()
    closed.turnStarted(S, turnAt, 'closed')
    expect(classify(result([recencyEntry(usedAt, turnAt)], {}), contextOf(closed))[0]!.cause).toBe(
      'WORKSPACE_RECENCY_MIRROR',
    )
    // A client that never watched the thread is X1's: nothing offered it the turn.
    const sidebar = new Story()
    sidebar.created(S, held)
    sidebar.started(S, usedAt, stamped)
    sidebar.turnStarted(S, turnAt, 'not subscribed')
    expect(classify(result([recencyEntry(usedAt, turnAt)], {}), contextOf(sidebar))[0]!.cause).toBe(
      'WORKSPACE_RECENCY_MIRROR',
    )
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
    const context = contextOf(new Story())
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
    expect(classify(result(entries, {}), contextOf(new Story()))[0]!.cause).toBeUndefined()
  })
})

/**
 * The S8 and X2 expectations exactly as the scenarios build them
 * (fixtures.ts), judged through verdictOf as demonstrateDiff judges them.
 */
describe('the S8 and X2 expectation factories', () => {
  const story = s8Story()
  const captured = {
    olderId: O,
    newId: S,
    workspaceId: W,
    providerId: 'opencode',
    createdAt: held,
    // What B was sent last for the workspace (markUsed, just before the stamp).
    heldRecency: usedAt,
    witness: story.witness,
  }
  const recency = (left: unknown, right: unknown) =>
    e('fresh', `workspaces.${W}.lastActivityAt`, left, right)
  const genuine = () => [...s8Diff(), recency(captured.heldRecency, stamped)]
  const verdict = (entries: DiffEntry[]) => {
    const { primary, residuals } = s8Causes(captured)
    return verdictOf(result(entries, {}), primary, residuals)
  }

  it('accepts the genuine S8 diff, with and without the recency entry', () => {
    expect(verdict(genuine()).outcome).toBe('primary-remains')
    expect(verdict(s8Diff()).outcome).toBe('primary-remains')
  })

  it('fails when the stamp hides a rename the client missed', () => {
    const renamed = s8Story()
    const at = '2026-10-18T10:00:00.900Z'
    renamed.renamed(S, at)
    const { primary, residuals } = s8Causes({ ...captured, witness: renamed.witness })
    const entries = s8Diff().map((entry) =>
      entry.path === `sessions[${S}].updatedAt` ? { ...entry, right: at } : entry,
    )
    expect(verdictOf(result(entries, {}), primary, residuals).outcome).toBe('unexpected')
  })

  it('fails when a future workspace timestamp rides along with the genuine stamp', () => {
    const future = genuine().map((entry) =>
      entry.path.startsWith('workspaces.')
        ? recency(captured.heldRecency, '2027-01-01T00:00:00.000Z')
        : entry,
    )
    expect(verdict(future).outcome).toBe('unexpected')
  })

  it('fails when the client holds a workspace time it was never sent', () => {
    const corrupted = genuine().map((entry) =>
      entry.path.startsWith('workspaces.') ? recency('2026-10-18T09:59:00.000Z', stamped) : entry,
    )
    expect(verdict(corrupted).outcome).toBe('unexpected')
    // Even a future client value, with the right fresh value.
    const ahead = genuine().map((entry) =>
      entry.path.startsWith('workspaces.') ? recency('2027-01-01T00:00:00.000Z', stamped) : entry,
    )
    expect(verdict(ahead).outcome).toBe('unexpected')
  })

  it('fails on a second, unrelated recency entry for another workspace', () => {
    expect(
      verdict([...genuine(), e('fresh', 'workspaces.other.lastActivityAt', held, stamped)]).outcome,
    ).toBe('unexpected')
  })

  it('asks to flip when only X2 is left', () => {
    const left = s8Diff().filter((entry) => entry.path.endsWith('providerId'))
    expect(verdict(left).outcome).toBe('primary-gone')
  })

  it('judges X2 the same way', () => {
    const x2 = x2Causes({ ...captured, sessionId: S })
    const judgeX2 = (entries: DiffEntry[]) =>
      verdictOf(result(entries, {}), x2.primary, x2.residuals)
    const providers = ['fresh', 'server'].map((comparison) =>
      e(comparison, `sessions[${S}].providerId`, ABSENT, 'opencode'),
    )
    const stamp = ['fresh', 'server'].map((comparison) =>
      e(comparison, `sessions[${S}].updatedAt`, held, stamped),
    )
    expect(judgeX2([...providers, ...stamp, recency(captured.heldRecency, stamped)]).outcome).toBe(
      'primary-remains',
    )
    expect(
      judgeX2([...providers, ...stamp, recency(captured.heldRecency, '2027-01-01T00:00:00.000Z')])
        .outcome,
    ).toBe('unexpected')
    expect(judgeX2([...stamp]).outcome).toBe('primary-gone')
  })
})
