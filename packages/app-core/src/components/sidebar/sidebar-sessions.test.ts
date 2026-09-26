import { describe, expect, it } from 'vitest'
import { flattenSidebarSessions, type SidebarSession } from './sidebar-sessions'
import { sessionBusyTone } from './SessionBusyLoader'

const session = (
  externalId: string,
  parentExternalId?: string,
  status: string = 'idle',
): SidebarSession => ({
  externalId,
  parentExternalId,
  status,
  providerId: 'opencode',
})

describe('sessionBusyTone', () => {
  it('maps waiting to needs, unseen completions to done, and in-flight statuses to working', () => {
    expect(sessionBusyTone('waiting')).toBe('needs')
    expect(sessionBusyTone('done')).toBe('done')
    expect(sessionBusyTone('running')).toBe('working')
    expect(sessionBusyTone('busy')).toBe('working')
    expect(sessionBusyTone('error')).toBe('error')
    // At rest (and already seen): no glyph, the card shows its age.
    expect(sessionBusyTone('ready')).toBe(null)
    expect(sessionBusyTone('idle')).toBe(null)
  })
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
