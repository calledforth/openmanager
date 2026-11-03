import { describe, expect, it } from 'vitest'
import { sessionBusyTone } from '@openmanager/app-core/components/sidebar/session-busy-tone'

import { FIXTURE_DRAFTS, FIXTURE_SESSIONS, FIXTURE_WORKSPACES } from '../src/home/fixture'
import {
  countNeedsYou,
  dayLabel,
  selectDraftRows,
  selectHomeRows,
  selectTabRows,
  statusCountOf,
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
  status: 'ready',
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
  })

  it('reads the statuses the shared provider emits for idle, as the web sidebar does', () => {
    // Protocol idle with an unseen completion arrives as `done`; plain idle as `ready`.
    expect(statusMarkOf(session({ status: 'done' }))).toBe('done')
    expect(statusMarkOf(session({ status: 'ready' }))).toBe('idle')
    expect(statusMarkOf(session({ status: 'idle' }))).toBe('idle')
    expect(statusMarkOf(session({ status: 'busy' }))).toBe('working')
    expect(statusLineOf(session({ status: 'done' }))).toBe('Done')
    expect(statusLineOf(session({ status: 'busy' }))).toBe('Working')
  })

  it('agrees with the web sidebar on every status', () => {
    for (const status of ['running', 'waiting', 'busy', 'done', 'ready', 'idle', 'error']) {
      for (const detail of [{}, { waitingOn: 'question' }, { inBackground: true }]) {
        expect(statusMarkOf(session({ status, ...detail }))).toBe(
          sessionBusyTone(status, detail) ?? 'idle',
        )
      }
    }
  })

  it('never invents a state: an unknown status reads idle', () => {
    expect(statusMarkOf(session({ status: 'something-new' }))).toBe('idle')
  })

  it('puts the ask into words, as the web sidebar does', () => {
    expect(statusLineOf(session({ status: 'waiting', waitingOn: 'plan' }))).toBe('Plan ready')
    expect(statusLineOf(session({ status: 'waiting', waitingOn: 'permission' }))).toBe(
      'Needs input',
    )
    expect(statusLineOf(session({ status: 'waiting', waitingOn: 'question' }))).toBe(
      'Has a question',
    )
    expect(statusLineOf(session({ status: 'running', inBackground: true }))).toBe('Background')
    expect(statusLineOf(session({ status: 'ready' }))).toBeNull()
  })

  it('counts background work beside a live status, and nowhere else', () => {
    const bg = session({ status: 'running', inBackground: true, backgroundTaskCount: 2 })
    expect(statusCountOf(bg)).toBe(2)
    // A turn in flight with work behind it still says how much.
    expect(statusCountOf(session({ status: 'running', backgroundTaskCount: 1 }))).toBe(1)
    expect(statusCountOf(session({ status: 'running' }))).toBeNull()
    expect(statusCountOf(session({ status: 'done', backgroundTaskCount: 3 }))).toBeNull()
  })
})

describe('tab rows with drafts', () => {
  const now = NOW
  const today = local(2026, 10, 21, 9)
  const yesterday = local(2026, 10, 20, 9)
  const draft = (overrides: Partial<(typeof FIXTURE_DRAFTS)[number]>) => ({
    ...FIXTURE_DRAFTS[0]!,
    draftId: 'd1',
    sessionId: 's-d1',
    workspaceId: FIXTURE_WORKSPACES[0]!.path,
    ...overrides,
  })

  it('opens Active with a Drafts group above the live work', () => {
    const rows = selectTabRows({
      sessions: [session({ externalId: 'a', status: 'running', updatedAt: today })],
      drafts: [draft({ editedAt: new Date(yesterday).getTime() })],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now,
    })
    expect(rows.map((g) => g.label)).toEqual(['Drafts', 'Working'])
    expect(rows[0]!.rows[0]!.kind).toBe('draft')
  })

  it('leaves the Drafts group out of Active when there are none', () => {
    const rows = selectTabRows({
      sessions: [session({ externalId: 'a', status: 'running', updatedAt: today })],
      drafts: [],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now,
    })
    expect(rows.map((g) => g.label)).toEqual(['Working'])
  })

  it('places a draft in All on the day it was edited, above that day sessions', () => {
    const rows = selectTabRows({
      sessions: [
        session({ externalId: 'a', updatedAt: today }),
        session({ externalId: 'b', updatedAt: yesterday }),
      ],
      drafts: [draft({ editedAt: new Date(yesterday).getTime() + 60_000 })],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now,
    })
    expect(rows.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
    expect(rows[1]!.rows.map((r) => r.kind)).toEqual(['draft', 'session'])
  })

  it('lets a fresh draft start a day of its own, newest first', () => {
    const rows = selectTabRows({
      sessions: [session({ externalId: 'b', updatedAt: yesterday })],
      drafts: [draft({ editedAt: new Date(today).getTime() })],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now,
    })
    expect(rows.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
    expect(rows[0]!.rows[0]!.kind).toBe('draft')
  })

  it('keeps the Drafts tab to drafts alone', () => {
    const rows = selectTabRows({
      sessions: [session({ externalId: 'a', updatedAt: today })],
      drafts: [draft({ editedAt: new Date(today).getTime() })],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'drafts',
      now,
    })
    expect(rows.flatMap((g) => g.rows.map((r) => r.kind))).toEqual(['draft'])
  })
})

describe('day labels', () => {
  it('names the day relative to now', () => {
    expect(dayLabel(local(2026, 10, 21, 8), NOW)).toBe('Today')
    expect(dayLabel(local(2026, 10, 20, 23), NOW)).toBe('Yesterday')
    expect(dayLabel(local(2026, 10, 17), NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2026, 9, 17, 10)),
    )
    expect(dayLabel(local(2026, 10, 3), NOW)).toBe('Earlier this month')
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
    // Epoch ms, as draft cards carry their edits.
    expect(dayLabel(new Date(2026, 9, 21, 9).getTime(), NOW)).toBe('Today')
    expect(dayLabel(0, NOW)).toBe('Earlier')
  })

  it('turns over at local midnight, not at a fixed number of hours', () => {
    const justAfterMidnight = new Date(2026, 9, 21, 0, 0, 30)
    expect(dayLabel(local(2026, 10, 21, 0), justAfterMidnight)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 20, 23, 59, 59).toISOString(), justAfterMidnight)).toBe(
      'Yesterday',
    )
    // Six days back is still a weekday name; seven is earlier this month.
    expect(dayLabel(local(2026, 10, 15), NOW)).toBe(
      new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date(2026, 9, 15, 10)),
    )
    expect(dayLabel(local(2026, 10, 14), NOW)).toBe('Earlier this month')
    // A week back across a month boundary is that month.
    const earlyNovember = new Date(2026, 10, 4, 12)
    expect(dayLabel(local(2026, 10, 27), earlyNovember)).toBe(
      new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(2026, 9, 27, 10)),
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

  it('groups Active as needs you, working, failed, recent', () => {
    const active = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    expect(
      active.map((g) => [g.label, g.rows.filter((r) => r.depth === 0).map((r) => r.mark)]),
    ).toEqual([
      ['Needs you', ['needs', 'question']],
      ['Working', ['working', 'background']],
      ['Failed', ['error']],
      ['Recent', ['done', 'idle']],
    ])
  })

  it('leaves an empty Active group out', () => {
    const at = NOW.toISOString()
    const active = selectHomeRows({
      sessions: [
        session({ externalId: 'w', status: 'running', updatedAt: at }),
        session({ externalId: 'r', status: 'ready', updatedAt: at }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    expect(active.map((g) => g.label)).toEqual(['Working', 'Recent'])
  })

  it('ranks an Active tree by its most urgent member, at any depth', () => {
    const active = selectHomeRows({
      sessions: [
        session({ externalId: 'busy', status: 'running', updatedAt: local(2026, 10, 21, 11) }),
        session({ externalId: 'quiet-parent', status: 'ready', updatedAt: local(2026, 10, 19) }),
        session({
          externalId: 'child',
          parentExternalId: 'quiet-parent',
          status: 'ready',
          updatedAt: local(2026, 10, 19),
        }),
        session({
          externalId: 'asking-grandchild',
          parentExternalId: 'child',
          status: 'waiting',
          waitingOn: 'permission',
          updatedAt: local(2026, 10, 20),
        }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    expect(active[0]!.label).toBe('Needs you')
    expect(active[0]!.rows.map((r) => [r.session.externalId, r.depth, r.mark])).toEqual([
      ['quiet-parent', 0, 'idle'],
      ['child', 1, 'idle'],
      ['asking-grandchild', 2, 'needs'],
    ])
    expect(active[1]!.label).toBe('Working')
  })

  it('dates an All tree by its newest member', () => {
    const all = selectHomeRows({
      sessions: [
        session({ externalId: 'yesterday', status: 'ready', updatedAt: local(2026, 10, 20) }),
        session({
          externalId: 'settled-parent',
          status: 'ready',
          updatedAt: local(2026, 10, 12),
          settledAt: local(2026, 10, 13),
        }),
        session({
          externalId: 'running-child',
          parentExternalId: 'settled-parent',
          status: 'running',
          updatedAt: local(2026, 10, 21, 11),
        }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
      now: NOW,
    })
    expect(all.map((g) => [g.label, g.rows.map((r) => r.session.externalId)])).toEqual([
      ['Today', ['settled-parent', 'running-child']],
      ['Yesterday', ['yesterday']],
    ])
  })

  it('nests a child under its parent and never starts a group with one', () => {
    const active = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'active',
      now: NOW,
    })
    const rows = active.find((g) => g.key === 'working')!.rows
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
    // Each tree by its newest member.
    const times = all.flatMap((g) =>
      g.rows.flatMap((r, i) => {
        if (r.depth > 0) return []
        const tree = [r]
        for (let j = i + 1; j < g.rows.length && g.rows[j]!.depth > 0; j++) tree.push(g.rows[j]!)
        return [Math.max(...tree.map((member) => Date.parse(member.session.updatedAt!)))]
      }),
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

  it('places a draft in its project by id, and in none once that project is gone', () => {
    const first = FIXTURE_DRAFTS[0]!
    const groups = selectDraftRows({
      drafts: [first, { ...first, draftId: 'orphan', workspaceId: null }],
      workspaces: FIXTURE_WORKSPACES,
      now: NOW,
    })
    const rows = groups.flatMap((g) => g.rows)
    expect(rows.find((r) => r.draft.draftId === first.draftId)!.workspace?.name).toBe('openmanager')
    expect(rows.find((r) => r.draft.draftId === 'orphan')!.workspace).toBeUndefined()
  })
})
