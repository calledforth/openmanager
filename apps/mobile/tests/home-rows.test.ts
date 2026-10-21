import { describe, expect, it } from 'vitest'

import { FIXTURE_DRAFTS, FIXTURE_SESSIONS, FIXTURE_WORKSPACES } from '../src/home/fixture'
import {
  countNeedsYou,
  dayLabel,
  selectDraftRows,
  selectHomeRows,
  statusLineOf,
  statusMarkOf,
  tabCounts,
  type HomeSession,
} from '../src/home/rows'

// Local time, since day boundaries are the reader's.
const NOW = new Date(2026, 9, 21, 12, 0, 0)
const local = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).toISOString()

const session = (overrides: Partial<HomeSession>): HomeSession => ({
  externalId: overrides.externalId ?? 'x',
  status: 'idle',
  providerId: 'claude',
  isDriven: false,
  workspacePath: FIXTURE_WORKSPACES[0]!.path,
  ...overrides,
})

describe('status marks', () => {
  it("reads the server's lifecycle and what it waits on as one glyph", () => {
    expect(statusMarkOf(session({ status: 'running' }))).toBe('working')
    expect(statusMarkOf(session({ status: 'running', inBackground: true }))).toBe('background')
    expect(statusMarkOf(session({ status: 'waiting', waitingOn: 'permission' }))).toBe('needs')
    expect(statusMarkOf(session({ status: 'waiting', waitingOn: 'plan' }))).toBe('needs')
    expect(statusMarkOf(session({ status: 'waiting', waitingOn: 'question' }))).toBe('question')
    expect(statusMarkOf(session({ status: 'error' }))).toBe('error')
    expect(statusMarkOf(session({ status: 'idle', doneUnseen: true }))).toBe('done')
    expect(statusMarkOf(session({ status: 'idle' }))).toBe('idle')
  })

  it('never invents a state: an unknown status reads idle', () => {
    expect(statusMarkOf(session({ status: 'something-new' }))).toBe('idle')
  })

  it('puts the ask into words', () => {
    expect(statusLineOf(session({ status: 'waiting', waitingOn: 'plan' }))).toBe('Plan ready')
    expect(
      statusLineOf(session({ status: 'running', inBackground: true, backgroundTaskCount: 2 })),
    ).toBe('2 in the background')
    expect(statusLineOf(session({ status: 'idle' }))).toBeNull()
  })
})

describe('day labels', () => {
  it('names the day relative to now', () => {
    expect(dayLabel(local(2026, 10, 21, 8), NOW)).toBe('Today')
    expect(dayLabel(local(2026, 10, 20, 23), NOW)).toBe('Yesterday')
    expect(dayLabel(local(2026, 10, 17), NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2026, 9, 17, 10)),
    )
    expect(dayLabel(local(2026, 9, 2), NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(2026, 8, 2, 10)),
    )
    expect(dayLabel(local(2025, 3, 2), NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
        new Date(2025, 2, 2, 10),
      ),
    )
    expect(dayLabel(undefined, NOW)).toBe('Earlier')
    expect(dayLabel('not a date', NOW)).toBe('Earlier')
  })

  it('turns over at local midnight, not at a fixed number of hours', () => {
    const justAfterMidnight = new Date(2026, 9, 21, 0, 0, 30)
    expect(dayLabel(local(2026, 10, 21, 0), justAfterMidnight)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 20, 23, 59, 59).toISOString(), justAfterMidnight)).toBe(
      'Yesterday',
    )
    // Six days back is still a weekday name; seven is the month.
    expect(dayLabel(local(2026, 10, 15), NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2026, 9, 15, 10)),
    )
    expect(dayLabel(local(2026, 10, 14), NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(2026, 9, 14, 10)),
    )
  })
})

describe('home rows', () => {
  it('keeps settled sessions out of Active and in All', () => {
    const all = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now: NOW,
    })
    const active = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    const ids = (groups: typeof all) =>
      groups.flatMap((g) => g.rows.map((r) => r.session.externalId))
    expect(ids(all)).toContain('s-grouped-themes')
    expect(ids(active)).not.toContain('s-grouped-themes')
    expect(ids(all)).toHaveLength(FIXTURE_SESSIONS.length)
  })

  it('leads Active with what needs you, then working, then background, then failed', () => {
    const active = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    expect(active[0]!.label).toBe('Working')
    const marks = active[0]!.rows.filter((r) => r.depth === 0).map((r) => r.mark)
    expect(marks).toEqual(['needs', 'question', 'working', 'background', 'error'])
    expect(active[1]!.label).toBe('Recent')
    expect(active[1]!.rows.map((r) => r.mark)).toEqual(['done', 'idle'])
  })

  it('nests a child under its parent and never starts a group with one', () => {
    const active = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    const rows = active[0]!.rows
    const parent = rows.findIndex((r) => r.session.externalId === 's-tool-payloads')
    expect(rows[parent + 1]!.session.externalId).toBe('s-tool-payloads-tests')
    expect(rows[parent + 1]!.depth).toBe(1)
    expect(rows[0]!.depth).toBe(0)
  })

  it('keeps every generation: a grandchild sits one level under its parent', () => {
    const at = NOW.toISOString()
    const rows = selectHomeRows({
      sessions: [
        session({ externalId: 'root', status: 'running', updatedAt: at }),
        session({
          externalId: 'child',
          parentExternalId: 'root',
          status: 'running',
          updatedAt: at,
        }),
        session({
          externalId: 'grandchild',
          parentExternalId: 'child',
          status: 'running',
          updatedAt: at,
        }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    expect(rows[0]!.rows.map((r) => [r.session.externalId, r.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 2],
    ])
  })

  it('keeps a parent cycle visible instead of losing both sessions', () => {
    const at = NOW.toISOString()
    const rows = selectHomeRows({
      sessions: [
        session({ externalId: 'a', parentExternalId: 'b', updatedAt: at }),
        session({ externalId: 'b', parentExternalId: 'a', updatedAt: at }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now: NOW,
    })
    const ids = rows.flatMap((g) => g.rows.map((r) => r.session.externalId)).sort()
    expect(ids).toEqual(['a', 'b'])
    expect(rows.flatMap((g) => g.rows).filter((r) => r.depth === 0)).toHaveLength(1)
  })

  it('shows an orphaned child as a top-level row rather than dropping it', () => {
    const orphan = session({
      externalId: 'child',
      parentExternalId: 'gone',
      status: 'running',
      updatedAt: NOW.toISOString(),
    })
    const rows = selectHomeRows({
      sessions: [orphan],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now: NOW,
    })
    expect(rows[0]!.rows[0]).toMatchObject({ depth: 0, session: { externalId: 'child' } })
  })

  it('groups All by day, newest first', () => {
    const all = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now: new Date(),
    })
    expect(all[0]!.label).toBe('Today')
    const times = all.flatMap((g) =>
      g.rows.filter((r) => r.depth === 0).map((r) => Date.parse(r.session.updatedAt!)),
    )
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('attaches the workspace so a row can show its project', () => {
    const all = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now: NOW,
    })
    const row = all.flatMap((g) => g.rows).find((r) => r.session.externalId === 's-t3code')!
    expect(row.workspace?.name).toBe('t3code')
    expect(row.session.workspaceUnavailable).toBe(true)
  })

  it('counts the inbox badge and the tab labels', () => {
    expect(countNeedsYou(FIXTURE_SESSIONS)).toBe(2)
    expect(tabCounts(FIXTURE_SESSIONS, FIXTURE_DRAFTS)).toEqual({
      all: FIXTURE_SESSIONS.length,
      active: FIXTURE_SESSIONS.filter((s) => !s.settledAt).length,
      drafts: FIXTURE_DRAFTS.length,
    })
  })

  it('lists drafts newest first by day', () => {
    const groups = selectDraftRows({
      drafts: FIXTURE_DRAFTS,
      workspaces: FIXTURE_WORKSPACES,
      now: new Date(),
    })
    expect(groups[0]!.label).toBe('Today')
    expect(groups[0]!.rows[0]!.draft.draftId).toBe('d-upload-retry')
    expect(groups.flatMap((g) => g.rows)).toHaveLength(FIXTURE_DRAFTS.length)
  })
})
