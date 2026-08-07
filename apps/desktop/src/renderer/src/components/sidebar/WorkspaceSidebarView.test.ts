import { describe, expect, it } from 'vitest'
import {
  flattenSidebarSessions,
  isSidebarSessionActive,
  type SidebarSession,
} from './WorkspaceSidebarView'
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

describe('isSidebarSessionActive', () => {
  it('keeps in-flight and waiting sessions visible under a collapsed project', () => {
    expect(isSidebarSessionActive('running')).toBe(true)
    expect(isSidebarSessionActive('busy')).toBe(true)
    expect(isSidebarSessionActive('waiting')).toBe(true)
    expect(isSidebarSessionActive('idle')).toBe(false)
    expect(isSidebarSessionActive('error')).toBe(false)
  })
})

describe('sessionBusyTone', () => {
  it('maps waiting to the needs cross-blink and everything else active to working', () => {
    expect(sessionBusyTone('waiting')).toBe('needs')
    expect(sessionBusyTone('running')).toBe('working')
    expect(sessionBusyTone('busy')).toBe('working')
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
