import { describe, expect, it } from 'vitest'
import { sessionBusyTone } from '@openmanager/app-core/components/sidebar/session-busy-tone'

import { FIXTURE_DRAFTS, FIXTURE_SESSIONS, FIXTURE_WORKSPACES } from '../src/home/fixture'
import {
  ACTIVE_GROUP,
  canCook,
  canSettle,
  COOKING_GROUP,
  countEnvironments,
  DRAFTS_GROUP,
  homeSummary,
  isPinnedSession,
  listShapeOf,
  placeOf,
  selectDraftRows,
  selectHomeBoard,
  selectHomeSections,
  SETTLED_GROUP,
  SETTLED_PAGE_SIZE,
  statusCountOf,
  statusLineOf,
  statusMarkOf,
  type HomeCard,
  type HomeDraft,
  type HomeListRow,
  type HomeSession,
} from '../src/home/rows'
import { DEFAULT_SHELVES_OPEN, readShelvesOpen } from '../src/home/shelves'

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

const idOf = (row: HomeListRow) => {
  switch (row.kind) {
    case 'draft':
      return row.draft.draftId
    case 'card':
      return row.root.session.externalId
    case 'shelf':
      return row.row.session.externalId
    default:
      return 'more'
  }
}

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

const board = (sessions: HomeSession[]) =>
  selectHomeBoard({ sessions, workspaces: FIXTURE_WORKSPACES })
const rootIds = (cards: HomeCard[]) => cards.map((card) => card.root.session.externalId)
const OPEN = { cooking: true, settled: true }
const FOLDED = { cooking: false, settled: false }

describe('the board', () => {
  it('puts every top-level session in one place: active, cooking or settled', () => {
    const { active, cooking, settled } = board(FIXTURE_SESSIONS)
    expect(rootIds(active)).toContain('s-tool-payloads')
    expect(rootIds(cooking)).toContain('s-mcp-server')
    expect(rootIds(settled)).toContain('s-grouped-themes')
    const everyone = [...active, ...cooking, ...settled].flatMap((card) =>
      [card.root, ...card.children].map((row) => row.session.externalId),
    )
    expect([...everyone].sort()).toEqual(FIXTURE_SESSIONS.map((s) => s.externalId).sort())
  })

  it('lets settled win over cooking, as the server does', () => {
    const both = session({
      externalId: 'both',
      cookingAt: local(2026, 10, 20),
      settledAt: local(2026, 10, 21),
    })
    expect(placeOf(both)).toBe('settled')
    expect(rootIds(board([both]).settled)).toEqual(['both'])
  })

  it('lists active by last activity under no urgency groups, whatever each is doing', () => {
    const { active } = board([
      session({ externalId: 'old-ask', status: 'waiting', updatedAt: local(2026, 10, 1) }),
      session({ externalId: 'idle', updatedAt: local(2026, 10, 21) }),
      session({ externalId: 'working', status: 'running', updatedAt: local(2026, 10, 10) }),
    ])
    expect(rootIds(active)).toEqual(['idle', 'working', 'old-ask'])
  })

  it('keeps pinned sessions on top, most recently pinned first', () => {
    const { active } = board([
      session({ externalId: 'new', status: 'running', updatedAt: local(2026, 10, 21) }),
      session({
        externalId: 'pin-old',
        updatedAt: local(2026, 10, 2),
        pinnedAt: local(2026, 10, 3),
      }),
      session({
        externalId: 'pin-new',
        updatedAt: local(2026, 10, 1),
        pinnedAt: local(2026, 10, 9),
      }),
    ])
    expect(rootIds(active)).toEqual(['pin-new', 'pin-old', 'new'])
  })

  it('orders cooking by when it was sent and settled by when it was put away', () => {
    const { cooking, settled } = board([
      session({ externalId: 'c1', cookingAt: local(2026, 10, 1), updatedAt: local(2026, 10, 21) }),
      session({ externalId: 'c2', cookingAt: local(2026, 10, 5), updatedAt: local(2026, 10, 2) }),
      session({ externalId: 's1', settledAt: local(2026, 10, 1), updatedAt: local(2026, 10, 21) }),
      session({ externalId: 's2', settledAt: local(2026, 10, 5), updatedAt: local(2026, 10, 2) }),
    ])
    expect(rootIds(cooking)).toEqual(['c2', 'c1'])
    expect(rootIds(settled)).toEqual(['s2', 's1'])
  })

  it('carries children inside their parent, wherever the parent was put', () => {
    const { active, cooking } = board([
      session({ externalId: 'parent', updatedAt: local(2026, 10, 21) }),
      session({ externalId: 'child', parentExternalId: 'parent', status: 'running' }),
      session({ externalId: 'grandchild', parentExternalId: 'child' }),
      session({ externalId: 'pot', cookingAt: local(2026, 10, 20) }),
      // Its own place is its parent's: a child rides along.
      session({ externalId: 'pot-child', parentExternalId: 'pot' }),
    ])
    expect(active).toHaveLength(1)
    expect(active[0]!.children.map((row) => [row.session.externalId, row.depth])).toEqual([
      ['child', 1],
      ['grandchild', 2],
    ])
    expect(cooking[0]!.children.map((row) => row.session.externalId)).toEqual(['pot-child'])
  })

  it('keeps an orphan and a parent cycle visible as top-level cards', () => {
    const { active } = board([
      session({ externalId: 'orphan', parentExternalId: 'gone' }),
      session({ externalId: 'a', parentExternalId: 'b' }),
      session({ externalId: 'b', parentExternalId: 'a' }),
    ])
    const seen = active.flatMap((card) =>
      [card.root, ...card.children].map((row) => row.session.externalId),
    )
    expect([...seen].sort()).toEqual(['a', 'b', 'orphan'])
    expect(rootIds(active)).toContain('orphan')
  })

  it('looks a parent up in its own environment only', () => {
    const a = { environmentId: 'env-a', label: 'a' }
    const b = { environmentId: 'env-b', label: 'b' }
    const { active } = board([
      session({ externalId: 'p', environment: a }),
      session({ externalId: 'c', parentExternalId: 'p', environment: b }),
    ])
    expect(active.map((card) => card.children.length)).toEqual([0, 0])
  })

  it('attaches the workspace so a card can show its project', () => {
    const { active } = board(FIXTURE_SESSIONS)
    const card = active.find((c) => c.root.session.externalId === 's-pricing')
    expect(card?.root.workspace?.name).toBe('salesmaxai')
  })
})

describe('cooking and settling', () => {
  it('offers cooking to anything that does not already need the reader', () => {
    expect((['idle', 'working', 'background'] as const).every(canCook)).toBe(true)
    expect((['needs', 'question', 'done', 'error'] as const).some(canCook)).toBe(false)
  })

  it('will not settle live work, background work included', () => {
    expect(canSettle('idle', false)).toBe(true)
    expect(canSettle('done', false)).toBe(true)
    expect(canSettle('done', true)).toBe(false)
    expect(
      (['working', 'background', 'needs', 'question'] as const).some((m) => canSettle(m, false)),
    ).toBe(false)
  })

  it('pins only what is active', () => {
    const pinnedAt = local(2026, 10, 1)
    expect(isPinnedSession({ pinnedAt })).toBe(true)
    expect(isPinnedSession({ pinnedAt, cookingAt: pinnedAt })).toBe(false)
    expect(isPinnedSession({ pinnedAt, settledAt: pinnedAt })).toBe(false)
  })

  it('counts top-level sessions that wait or work, cooking included, settled not', () => {
    expect(
      homeSummary(
        board([
          session({ externalId: 'q', status: 'waiting', waitingOn: 'question' }),
          session({ externalId: 'w', status: 'waiting' }),
          session({ externalId: 'r', status: 'running' }),
          // A child rides in its parent's card: counted once, as its parent.
          session({ externalId: 'r-child', parentExternalId: 'r', status: 'running' }),
          session({
            externalId: 'pot',
            status: 'running',
            inBackground: true,
            cookingAt: local(2026, 10, 1),
          }),
          session({ externalId: 'away', status: 'running', settledAt: local(2026, 10, 1) }),
          // Put away with its parent, whatever it is doing.
          session({ externalId: 'away-child', parentExternalId: 'away', status: 'waiting' }),
          session({ externalId: 'done', status: 'done' }),
        ]),
      ),
    ).toEqual({ needs: 2, working: 2 })
  })
})

describe('the list', () => {
  const draft = (overrides: Partial<(typeof FIXTURE_DRAFTS)[number]>) => ({
    ...FIXTURE_DRAFTS[0]!,
    draftId: 'd1',
    sessionId: 's-d1',
    workspaceId: FIXTURE_WORKSPACES[0]!.path,
    ...overrides,
  })
  const sections = (
    sessions: HomeSession[],
    drafts: HomeDraft[] = [],
    open = OPEN,
    settledShown?: number,
  ) =>
    selectHomeSections({
      board: board(sessions),
      drafts: selectDraftRows({ drafts, workspaces: FIXTURE_WORKSPACES }),
      open,
      ...(settledShown ? { settledShown } : {}),
    })

  it('is drafts, then active under no heading, then Cooking, then Settled', () => {
    const list = sections(
      [
        session({ externalId: 'settled', settledAt: local(2026, 10, 20) }),
        session({ externalId: 'pot', status: 'running', cookingAt: local(2026, 10, 20) }),
        session({ externalId: 'a', status: 'running', updatedAt: local(2026, 10, 21) }),
      ],
      [
        draft({ draftId: 'older', editedAt: new Date(local(2026, 10, 1)).getTime() }),
        draft({ draftId: 'newer', editedAt: new Date(local(2026, 10, 21)).getTime() }),
      ],
    )
    expect(list.map((s) => [s.key, s.label, s.rows.map(idOf)])).toEqual([
      [DRAFTS_GROUP, 'Drafts', ['newer', 'older']],
      [ACTIVE_GROUP, null, ['a']],
      [COOKING_GROUP, 'Cooking', ['pot']],
      [SETTLED_GROUP, 'Settled', ['settled']],
    ])
  })

  it('leaves out a group with nothing in it', () => {
    expect(sections([session({ externalId: 'a' })]).map((s) => s.key)).toEqual([ACTIVE_GROUP])
    expect(sections([])).toEqual([])
  })

  it('keeps a folded shelf as its heading alone, still saying work goes on', () => {
    const list = sections(
      [
        session({ externalId: 'pot', status: 'running', cookingAt: local(2026, 10, 20) }),
        session({ externalId: 'idle-pot', cookingAt: local(2026, 10, 19) }),
        session({ externalId: 'settled', settledAt: local(2026, 10, 20) }),
      ],
      [],
      FOLDED,
    )
    expect(list.map((s) => [s.key, s.rows.length, s.shelf])).toEqual([
      [COOKING_GROUP, 0, { shelf: 'cooking', count: 2, open: false, live: 'working' }],
      [SETTLED_GROUP, 0, { shelf: 'settled', count: 1, open: false, live: null }],
    ])
  })

  it('lists a shelf as one-line rows, children under their parent', () => {
    const [cooking] = sections([
      session({ externalId: 'pot', cookingAt: local(2026, 10, 20) }),
      session({ externalId: 'pot-child', parentExternalId: 'pot' }),
    ])
    expect(
      cooking!.rows.map(
        (row) => row.kind === 'shelf' && [row.row.session.externalId, row.row.depth],
      ),
    ).toEqual([
      ['pot', 0],
      ['pot-child', 1],
    ])
  })

  it('shows Settled a page at a time', () => {
    const many = Array.from({ length: SETTLED_PAGE_SIZE + 3 }, (_, index) =>
      session({ externalId: `s${index}`, settledAt: local(2026, 9, 1 + (index % 28)) }),
    )
    const [first] = sections(many)
    expect(first!.rows).toHaveLength(SETTLED_PAGE_SIZE + 1)
    expect(first!.rows.at(-1)).toEqual({ kind: 'more', hidden: 3 })
    const [all] = sections(many, [], OPEN, SETTLED_PAGE_SIZE * 2)
    expect(all!.rows).toHaveLength(SETTLED_PAGE_SIZE + 3)
    expect(all!.shelf?.count).toBe(SETTLED_PAGE_SIZE + 3)
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

  it('changes shape when rows come, go, move or fold, never with what a row shows', () => {
    const shape = (sessions: HomeSession[], open = OPEN) =>
      listShapeOf(
        sections(sessions, [], open).map((s) => ({ key: s.key, data: s.rows })),
        idOf,
      )
    const at = NOW.toISOString()
    const a = session({ externalId: 'a', status: 'running', updatedAt: at, title: 'one' })
    const b = session({ externalId: 'b', updatedAt: at, settledAt: at })
    const before = shape([a, b])
    expect(shape([{ ...a, title: 'two', status: 'ready' }, b])).toBe(before)
    expect(shape([{ ...a, cookingAt: at }, b])).not.toBe(before)
    expect(shape([a])).not.toBe(before)
    expect(shape([a, b], FOLDED)).not.toBe(before)
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
    const { active } = board([session({ externalId: 'a', status: 'running', environment: wsl })])
    expect(active[0]!.root.session.environment).toBe(wsl)
    const [draftRow] = selectDraftRows({
      drafts: [{ ...FIXTURE_DRAFTS[0]!, environment: desktop }],
      workspaces: FIXTURE_WORKSPACES,
    })
    expect(draftRow!.draft.environment).toBe(desktop)
  })

  it('spans two environments in the fixture, so the labels can be seen', () => {
    expect(countEnvironments([...FIXTURE_SESSIONS, ...FIXTURE_DRAFTS])).toBe(2)
  })
})

describe('shelf folds', () => {
  it('reads what was saved, and falls back to Cooking open, Settled folded', () => {
    expect(readShelvesOpen(null)).toEqual(DEFAULT_SHELVES_OPEN)
    expect(readShelvesOpen('not json')).toEqual(DEFAULT_SHELVES_OPEN)
    expect(readShelvesOpen('{"cooking":false,"settled":true}')).toEqual({
      cooking: false,
      settled: true,
    })
    expect(readShelvesOpen('{"settled":"yes"}')).toEqual(DEFAULT_SHELVES_OPEN)
  })
})
