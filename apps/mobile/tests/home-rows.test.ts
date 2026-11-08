import { describe, expect, it } from 'vitest'
import { sessionBusyTone } from '@openmanager/app-core/components/sidebar/session-busy-tone'

import { FIXTURE_DRAFTS, FIXTURE_SESSIONS, FIXTURE_WORKSPACES } from '../src/home/fixture'
import {
  countEnvironments,
  DRAFTS_GROUP,
  listShapeOf,
  PINNED_GROUP,
  selectDraftRows,
  selectHomeRows,
  selectTabRows,
  SETTLED_GROUP,
  statusCountOf,
  statusLineOf,
  statusMarkOf,
  tabCounts,
  type HomeListRow,
  type HomeSession,
} from '../src/home/rows'

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

const idOf = (row: HomeListRow) =>
  row.kind === 'session' ? row.session.externalId : row.draft.draftId

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

describe('the two views', () => {
  it('keeps settled sessions out of All and in Settled, every session in one of them', () => {
    const all = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    const settled = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'settled',
    })
    const ids = (groups: typeof all) =>
      groups.flatMap((g) => g.rows.map((r) => r.session.externalId))
    expect(ids(all)).not.toContain('s-grouped-themes')
    expect(ids(settled)).toContain('s-grouped-themes')
    expect(ids(settled)).not.toContain('s-tool-payloads')
    expect([...ids(all), ...ids(settled)].sort()).toEqual(
      FIXTURE_SESSIONS.map((s) => s.externalId).sort(),
    )
  })

  it('lists Settled flat, newest first, under no heading', () => {
    const settled = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'settled',
    })
    expect(settled).toHaveLength(1)
    expect(settled[0]!.key).toBe(SETTLED_GROUP)
    expect(settled[0]!.label).toBeNull()
    const times = settled[0]!.rows.map((r) => Date.parse(r.session.updatedAt!))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('has no Settled group at all with nothing settled', () => {
    expect(
      selectHomeRows({
        sessions: [session({ externalId: 'a', status: 'running' })],
        workspaces: FIXTURE_WORKSPACES,
        tab: 'settled',
      }),
    ).toEqual([])
  })

  it('counts the views by sessions alone', () => {
    expect(tabCounts(FIXTURE_SESSIONS)).toEqual({
      all: FIXTURE_SESSIONS.filter((s) => !s.settledAt).length,
      settled: FIXTURE_SESSIONS.filter((s) => s.settledAt).length,
    })
  })
})

describe('All', () => {
  it('groups by what each session asks: needs you, working, failed, done, the rest', () => {
    const at = NOW.toISOString()
    const all = selectHomeRows({
      sessions: [
        session({ externalId: 'idle', updatedAt: at }),
        session({ externalId: 'done', status: 'done', updatedAt: at }),
        session({ externalId: 'failed', status: 'error', updatedAt: at }),
        session({ externalId: 'bg', status: 'running', inBackground: true, updatedAt: at }),
        session({ externalId: 'busy', status: 'running', updatedAt: at }),
        session({ externalId: 'asks', status: 'waiting', waitingOn: 'question', updatedAt: at }),
        session({ externalId: 'needs', status: 'waiting', waitingOn: 'permission', updatedAt: at }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(all.map((g) => [g.label, g.rows.map((r) => r.session.externalId)])).toEqual([
      ['Needs you', ['asks', 'needs']],
      ['Working', ['busy', 'bg']],
      ['Failed', ['failed']],
      ['Done', ['done']],
      ['Recent', ['idle']],
    ])
  })

  it('orders each group newest first', () => {
    const all = selectHomeRows({
      sessions: [
        session({ externalId: 'older', status: 'running', updatedAt: local(2026, 10, 20) }),
        session({ externalId: 'newer', status: 'running', updatedAt: local(2026, 10, 21) }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(all[0]!.rows.map((r) => r.session.externalId)).toEqual(['newer', 'older'])
  })

  it('leaves an empty group out', () => {
    const at = NOW.toISOString()
    const all = selectHomeRows({
      sessions: [
        session({ externalId: 'w', status: 'running', updatedAt: at }),
        session({ externalId: 'r', status: 'ready', updatedAt: at }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(all.map((g) => g.label)).toEqual(['Working', 'Recent'])
  })

  it('keeps pinned sessions above every group, most recently pinned first', () => {
    const at = NOW.toISOString()
    const all = selectHomeRows({
      sessions: [
        session({ externalId: 'needs', status: 'waiting', waitingOn: 'permission', updatedAt: at }),
        session({
          externalId: 'old-pin',
          updatedAt: local(2026, 10, 1),
          pinnedAt: local(2026, 10, 2),
        }),
        session({
          externalId: 'new-pin',
          status: 'running',
          updatedAt: at,
          pinnedAt: local(2026, 10, 3),
        }),
        session({ externalId: 'recent', updatedAt: at }),
        // Settled while pinned: in the long tail, as web keeps pins to Active.
        session({
          externalId: 'settled-pin',
          updatedAt: at,
          pinnedAt: local(2026, 10, 4),
          settledAt: local(2026, 10, 20),
        }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(all.map((g) => [g.key, g.rows.map((r) => r.session.externalId)])).toEqual([
      [PINNED_GROUP, ['new-pin', 'old-pin']],
      ['needs', ['needs']],
      ['recent', ['recent']],
    ])
  })

  it('ranks a tree by its most urgent member, at any depth', () => {
    const all = selectHomeRows({
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
      tab: 'all',
    })
    expect(all[0]!.label).toBe('Needs you')
    expect(all[0]!.rows.map((r) => [r.session.externalId, r.depth, r.mark])).toEqual([
      ['quiet-parent', 0, 'idle'],
      ['child', 1, 'idle'],
      ['asking-grandchild', 2, 'needs'],
    ])
    expect(all[1]!.label).toBe('Working')
  })

  it('dates a tree by its newest member', () => {
    const all = selectHomeRows({
      sessions: [
        session({ externalId: 'yesterday', status: 'ready', updatedAt: local(2026, 10, 20) }),
        session({ externalId: 'old-parent', status: 'ready', updatedAt: local(2026, 10, 12) }),
        session({
          externalId: 'fresh-child',
          parentExternalId: 'old-parent',
          status: 'ready',
          updatedAt: local(2026, 10, 21, 11),
        }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(all.map((g) => [g.label, g.rows.map((r) => r.session.externalId)])).toEqual([
      ['Recent', ['old-parent', 'fresh-child', 'yesterday']],
    ])
  })

  it('nests a child under its parent and never starts a group with one', () => {
    const all = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    const rows = all.find((g) => g.key === 'working')!.rows
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
      tab: 'all',
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
    const rows = selectHomeRows({ sessions: [orphan], workspaces: FIXTURE_WORKSPACES, tab: 'all' })
    expect(rows[0]!.rows[0]).toMatchObject({ depth: 0, session: { externalId: 'child' } })
  })

  it('makes a child whose parent is settled top-level in All', () => {
    const rows = selectHomeRows({
      sessions: [
        session({ externalId: 'parent', settledAt: local(2026, 10, 20) }),
        session({ externalId: 'child', parentExternalId: 'parent', status: 'running' }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(rows.flatMap((g) => g.rows.map((r) => [r.session.externalId, r.depth]))).toEqual([
      ['child', 0],
    ])
  })

  it('attaches the workspace so a row can show its project', () => {
    const settled = selectHomeRows({
      sessions: FIXTURE_SESSIONS,
      workspaces: FIXTURE_WORKSPACES,
      tab: 'settled',
    })
    const row = settled.flatMap((g) => g.rows).find((r) => r.session.externalId === 's-t3code')!
    expect(row.workspace?.name).toBe('t3code')
    expect(row.session.workspaceUnavailable).toBe(true)
  })
})

describe('drafts', () => {
  const draft = (overrides: Partial<(typeof FIXTURE_DRAFTS)[number]>) => ({
    ...FIXTURE_DRAFTS[0]!,
    draftId: 'd1',
    sessionId: 's-d1',
    workspaceId: FIXTURE_WORKSPACES[0]!.path,
    ...overrides,
  })

  it('opens All with the draft cards, newest edit first, above Pinned', () => {
    const rows = selectTabRows({
      sessions: [
        session({
          externalId: 'pin',
          updatedAt: local(2026, 10, 21),
          pinnedAt: local(2026, 10, 21),
        }),
        session({ externalId: 'a', status: 'running', updatedAt: local(2026, 10, 21) }),
      ],
      drafts: [
        draft({ draftId: 'older', editedAt: new Date(local(2026, 10, 1)).getTime() }),
        draft({ draftId: 'newer', editedAt: new Date(local(2026, 10, 21)).getTime() }),
      ],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(rows.map((g) => [g.key, g.label, g.rows.map(idOf)])).toEqual([
      [DRAFTS_GROUP, 'Drafts', ['newer', 'older']],
      [PINNED_GROUP, 'Pinned', ['pin']],
      ['working', 'Working', ['a']],
    ])
  })

  it('leaves the Drafts group out when there are none, and out of Settled always', () => {
    const none = selectTabRows({
      sessions: [session({ externalId: 'a', status: 'running' })],
      drafts: [],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    expect(none.map((g) => g.key)).toEqual(['working'])
    const settled = selectTabRows({
      sessions: [session({ externalId: 'a', settledAt: local(2026, 10, 20) })],
      drafts: [draft({})],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'settled',
    })
    expect(settled.flatMap((g) => g.rows.map((r) => r.kind))).toEqual(['session'])
  })

  it('places a draft in its project by id, and in none once that project is gone', () => {
    const first = FIXTURE_DRAFTS[0]!
    const rows = selectDraftRows({
      drafts: [first, { ...first, draftId: 'orphan', workspaceId: null }],
      workspaces: FIXTURE_WORKSPACES,
    })
    expect(rows.find((r) => r.draft.draftId === first.draftId)!.workspace?.name).toBe('openmanager')
    expect(rows.find((r) => r.draft.draftId === 'orphan')!.workspace).toBeUndefined()
  })
})

describe('environments', () => {
  const desktop = { environmentId: 'env-a', label: 'desktop' }
  const wsl = { environmentId: 'env-b', label: 'wsl' }

  it('counts the environments the rows span, ignoring rows that name none', () => {
    expect(countEnvironments([])).toBe(0)
    expect(countEnvironments([session({}), session({})])).toBe(0)
    expect(
      countEnvironments([session({ environment: desktop }), session({ environment: desktop })]),
    ).toBe(1)
    expect(
      countEnvironments([
        session({ environment: desktop }),
        session({}),
        { ...FIXTURE_DRAFTS[0]!, environment: wsl },
      ]),
    ).toBe(2)
  })

  it('carries each row its environment, untouched', () => {
    const rows = selectTabRows({
      sessions: [session({ externalId: 'a', status: 'running', environment: wsl })],
      drafts: [{ ...FIXTURE_DRAFTS[0]!, environment: desktop }],
      workspaces: FIXTURE_WORKSPACES,
      tab: 'all',
    })
    const [draftRow, sessionRow] = rows.flatMap((g) => g.rows)
    expect(draftRow!.kind === 'draft' && draftRow!.draft.environment).toBe(desktop)
    expect(sessionRow!.kind === 'session' && sessionRow!.session.environment).toBe(wsl)
  })

  it('spans two environments in the fixture, so the labels can be seen', () => {
    expect(countEnvironments([...FIXTURE_SESSIONS, ...FIXTURE_DRAFTS])).toBe(2)
  })
})

describe('list shape', () => {
  it('changes when rows come, go or move, never with what a row shows', () => {
    const keyOf = (row: HomeListRow) => idOf(row)
    const sections = (sessions: HomeSession[]) =>
      selectTabRows({ sessions, drafts: [], workspaces: FIXTURE_WORKSPACES, tab: 'all' }).map(
        (g) => ({ key: g.key, data: g.rows }),
      )
    const at = NOW.toISOString()
    const a = session({ externalId: 'a', status: 'running', updatedAt: at, title: 'one' })
    const b = session({ externalId: 'b', status: 'ready', updatedAt: at })
    const before = listShapeOf(sections([a, b]), keyOf)
    expect(listShapeOf(sections([{ ...a, title: 'two' }, b]), keyOf)).toBe(before)
    expect(listShapeOf(sections([{ ...a, status: 'ready' }, b]), keyOf)).not.toBe(before)
    expect(listShapeOf(sections([a]), keyOf)).not.toBe(before)
  })
})
