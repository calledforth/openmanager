import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from '../../lib/relative-time'
import { partitionSidebarSessions, placeSidebarDrafts } from './WorkspaceSidebarView'
import type { SidebarDraft, SidebarSession, SidebarWorkspace } from './sidebar-sessions'

const session = (
  externalId: string,
  updatedAt: string,
  extra: Partial<SidebarSession> = {},
): SidebarSession => ({ externalId, status: 'ready', updatedAt, ...extra })

const workspace = (path: string, sessions: SidebarSession[]): SidebarWorkspace => ({
  path,
  name: path,
  sessions,
})

const ids = (entries: ReturnType<typeof partitionSidebarSessions>['active']) =>
  entries.map((entry) => [
    entry.root.session.externalId,
    ...entry.children.map((child) => child.session.externalId),
  ])

describe('partitionSidebarSessions', () => {
  it('merges every project into one newest-first active list', () => {
    const { active, settled } = partitionSidebarSessions([
      workspace('alpha', [
        session('a1', '2026-09-24T10:00:00Z'),
        session('a2', '2026-09-20T10:00:00Z'),
      ]),
      workspace('beta', [session('b1', '2026-09-23T10:00:00Z')]),
    ])
    expect(ids(active)).toEqual([['a1'], ['b1'], ['a2']])
    expect(active.map((entry) => entry.root.workspace.path)).toEqual(['alpha', 'beta', 'alpha'])
    expect(settled).toEqual([])
  })

  it('puts settled work away, most recently settled first, children with their parent', () => {
    const { active, settled } = partitionSidebarSessions([
      workspace('alpha', [
        session('old', '2026-09-24T09:00:00Z', { settledAt: '2026-09-22T10:00:00Z' }),
        session('parent', '2026-09-24T08:00:00Z', { settledAt: '2026-09-23T10:00:00Z' }),
        session('child', '2026-09-24T11:00:00Z', { parentExternalId: 'parent' }),
        session('live', '2026-09-24T07:00:00Z', { status: 'running' }),
      ]),
    ])
    expect(ids(active)).toEqual([['live']])
    expect(ids(settled)).toEqual([['parent', 'child'], ['old']])
  })

  it('keeps an orphaned child visible as its own entry', () => {
    const { active } = partitionSidebarSessions([
      workspace('alpha', [session('orphan', '2026-09-24T10:00:00Z', { parentExternalId: 'gone' })]),
    ])
    expect(ids(active)).toEqual([['orphan']])
  })
})

describe('placeSidebarDrafts', () => {
  const draft = (draftId: string, workspaceId: string | null): SidebarDraft => ({
    draftId,
    sessionId: `s-${draftId}`,
    workspaceId,
    providerId: 'opencode',
    preview: draftId,
    imageCount: 0,
    editedAt: 0,
  })

  it('pairs each draft with its project, and leaves a removed or unlisted one without', () => {
    const missing = { ...workspace('gone-folder', []), missing: true }
    const rows = placeSidebarDrafts(
      [draft('a', 'alpha'), draft('b', null), draft('c', 'unlisted'), draft('d', 'gone-folder')],
      [workspace('alpha', []), missing],
    )
    expect(rows.map((row) => [row.draft.draftId, row.workspace?.path])).toEqual([
      ['a', 'alpha'],
      ['b', undefined],
      ['c', undefined],
      // A missing folder is still its project: the card says so.
      ['d', 'gone-folder'],
    ])
    expect(rows[3]!.workspace?.missing).toBe(true)
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-24T12:00:00Z')
  it.each([
    ['2026-09-24T11:59:30Z', 'now'],
    ['2026-09-24T11:55:00Z', '5m'],
    ['2026-09-24T09:00:00Z', '3h'],
    ['2026-09-22T12:00:00Z', '2d'],
  ])('%s reads as %s', (iso, expected) => {
    expect(formatRelativeTime(iso, now)).toBe(expected)
  })

  it('falls back to a date after a week and to nothing for bad input', () => {
    expect(formatRelativeTime('2026-09-01T12:00:00Z', now)).not.toMatch(/d$/)
    expect(formatRelativeTime('not a date', now)).toBe('')
    expect(formatRelativeTime(undefined, now)).toBe('')
  })
})
