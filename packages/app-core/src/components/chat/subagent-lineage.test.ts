import { describe, expect, it } from 'vitest'
import type { Subagent } from '@openmanager/protocol'
import { buildLineage, lineageRows, type LineageSession } from './subagent-lineage'

const record = (patch: Partial<Subagent> & Pick<Subagent, 'subagentId'>): Subagent => ({
  parentSessionId: 'root',
  turnId: 't1',
  depth: 1,
  origin: 'native',
  providerId: 'claude',
  title: patch.subagentId,
  status: 'running',
  background: true,
  promptable: false,
  stoppable: true,
  stats: {},
  startedAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  ...patch,
})

const session = (sessionId: string, patch: Partial<LineageSession> = {}): LineageSession => ({
  sessionId,
  title: sessionId,
  status: 'idle',
  providerId: 'claude',
  threadIds: [`${sessionId}-thread`],
  ...patch,
})

const child = (sessionId: string, parent: string, patch: Partial<LineageSession> = {}) =>
  session(sessionId, {
    parentSessionId: parent,
    subagent: { subagentId: `sa-${sessionId}`, origin: 'native', promptable: false },
    ...patch,
  })

describe('subagent lineage', () => {
  // root ─┬─ a (done, from a turn ago)
  //       ├─ b (running) ── b1 (running, b's own subagent)
  //       └─ c (done) ── c1 (waiting on a permission)
  const sessions: Record<string, LineageSession> = {
    root: session('root'),
    a: child('a', 'root'),
    b: child('b', 'root', { status: 'running' }),
    b1: child('b1', 'b', { status: 'running', providerId: 'codex' }),
    c: child('c', 'root'),
    c1: child('c1', 'c', { status: 'waiting', waitingOn: 'permission' }),
    other: session('other', { status: 'running' }),
  }
  const records: Record<string, Subagent[]> = {
    'root-thread': [
      record({
        subagentId: 'sa-a',
        childSessionId: 'a',
        status: 'completed',
        startedAt: '2026-11-18T09:00:00.000Z',
        title: 'Map callers',
      }),
      record({
        subagentId: 'sa-b',
        childSessionId: 'b',
        activity: 'Reading auth.ts',
        startedAt: '2026-11-18T09:01:00.000Z',
      }),
      record({
        subagentId: 'sa-c',
        childSessionId: 'c',
        status: 'completed',
        startedAt: '2026-11-18T09:02:00.000Z',
      }),
    ],
  }
  const lineage = buildLineage('root', sessions, (threadId) => records[threadId])

  it('builds the tree from child sessions, at any depth, joined to the records held', () => {
    expect(lineage.roots.map((node) => node.key)).toEqual(['sa-a', 'sa-b', 'sa-c'])
    const b = lineage.roots[1]!
    expect(b.subagent?.activity).toBe('Reading auth.ts')
    expect(b.children.map((node) => [node.key, node.depth, node.providerId])).toEqual([
      ['sa-b1', 2, 'codex'],
    ])
    // Not its thread held: the nested one is drawn from its summary alone.
    expect(b.children[0]!.subagent).toBeUndefined()
    expect(lineage.roots[0]!.title).toBe('Map callers')
    expect(lineage.all).toHaveLength(5)
    // Another top-level chat is not part of this family.
    expect(lineage.all.some((node) => node.sessionId === 'other')).toBe(false)
  })

  it('counts a parent live while anything under it works, by itself or not', () => {
    const [a, b, c] = lineage.roots
    expect(a!.live).toBe(false)
    expect(b!.live).toBe(true)
    // Done itself, but its subagent waits on the user.
    expect(c!.tone).toBe('done')
    expect(c!.live).toBe(true)
    expect(c!.children[0]).toMatchObject({ status: 'waiting', waitingOn: 'permission' })
    expect(lineage.live.map((node) => node.key)).toEqual(['sa-b', 'sa-b1', 'sa-c1'])
    expect(lineage.settled).toBe(2)
  })

  it('shows what is live and the way to it, and everything when asked', () => {
    const live = lineageRows(lineage, false).map(({ node, last, rails }) => [node.key, last, rails])
    expect(live).toEqual([
      ['sa-b', false, []],
      ['sa-b1', true, [true]],
      ['sa-c', true, []],
      ['sa-c1', true, [false]],
    ])
    expect(lineageRows(lineage, true).map(({ node }) => node.key)).toEqual([
      'sa-a',
      'sa-b',
      'sa-b1',
      'sa-c',
      'sa-c1',
    ])
  })

  it('keeps a record whose child session has not arrived yet', () => {
    const early = buildLineage('root', { root: session('root') }, (threadId) =>
      threadId === 'root-thread' ? [record({ subagentId: 'sa-new', title: 'Just started' })] : [],
    )
    expect(early.roots).toHaveLength(1)
    expect(early.roots[0]).toMatchObject({ key: 'sa-new', title: 'Just started', live: true })
    expect(early.roots[0]!.sessionId).toBeUndefined()
  })

  it('is empty without a root, and never loops on a cycle', () => {
    expect(buildLineage(null, sessions, () => undefined).all).toEqual([])
    const looped = buildLineage(
      'root',
      {
        root: session('root'),
        x: child('x', 'root', { status: 'running' }),
        y: child('y', 'x', { status: 'running' }),
        // A bad parent link back up the tree.
        root2: child('root', 'y'),
      },
      () => undefined,
    )
    expect(looped.all.map((node) => node.sessionId)).toEqual(['x', 'y'])
  })
})
