import { describe, expect, it } from 'vitest'
import { flattenSidebarSessions, type SidebarSession } from './WorkspaceSidebarView'

const session = (externalId: string, parentExternalId?: string): SidebarSession => ({
  externalId,
  parentExternalId,
  status: 'idle',
  providerId: 'opencode',
})

describe('flattenSidebarSessions', () => {
  it('places nested subagent transcripts directly beneath their ancestry', () => {
    const rows = flattenSidebarSessions([
      session('new-root'),
      session('grandchild', 'child'),
      session('child', 'root'),
      session('root'),
    ])

    expect(
      rows.map(({ session: row, depth, isChild }) => ({
        id: row.externalId,
        depth,
        isChild,
      })),
    ).toEqual([
      { id: 'new-root', depth: 0, isChild: false },
      { id: 'root', depth: 0, isChild: false },
      { id: 'child', depth: 1, isChild: true },
      { id: 'grandchild', depth: 2, isChild: true },
    ])
  })

  it('keeps orphaned and cyclic child sessions visible', () => {
    const rows = flattenSidebarSessions([
      session('orphan', 'missing'),
      session('cycle-a', 'cycle-b'),
      session('cycle-b', 'cycle-a'),
    ])

    expect(rows.map(({ session: row }) => row.externalId).sort()).toEqual([
      'cycle-a',
      'cycle-b',
      'orphan',
    ])
    expect(rows.find(({ session: row }) => row.externalId === 'orphan')).toMatchObject({
      depth: 0,
      isChild: true,
      isOrphan: true,
    })
  })
})
