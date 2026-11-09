import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@openmanager/protocol'
import type { EnvironmentClient } from '@openmanager/environment-client'
import type {
  SidebarDraft,
  SidebarSessionEntry,
  SidebarSessionsByWorkspace,
  WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

import type { PhoneConnectionReading } from '../src/environment/connection-ui'
import type {
  PhoneEnvironment,
  PhoneLinkState,
  PhoneLinkStatus,
} from '../src/environment/controller'
import { FIXTURE_SESSIONS } from '../src/home/fixture'
import { selectDraftRows, selectHomeRows, statusMarkOf, tabCounts } from '../src/home/rows'
import type { HomeSlice, HomeSourceInputs } from '../src/home/source'

// The hook reads the controller through the provider, which needs React
// Native's runtime; the pure parts are what is tested here.
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({ usePhoneConnection: () => null }))
const {
  homeDraftsOf,
  homeEnvironmentOf,
  homeEnvironmentsOf,
  homeRowsOf,
  homeSessionsOf,
  homeSourceOf,
} = await import('../src/home/source')

const NOW = new Date(2026, 9, 21, 12, 0, 0)
const REPO = 'C:/repo'
const OTHER = 'C:/other'
const GONE = 'C:/gone'
const DESK_LAN = 'http://192.168.1.4:43120'
const DESK_TUNNEL = 'https://desk.cletus.xyz'
const LAPTOP_TUNNEL = 'https://laptop.cletus.xyz'

const WORKSPACES: WorkspaceEntry[] = [
  { path: REPO, name: 'repo', availability: 'available' },
  { path: OTHER, name: 'other', availability: 'available' },
  { path: GONE, name: 'gone', missing: true, availability: 'missing' },
]

const DESK: PhoneEnvironment = {
  environmentId: 'env-1',
  label: 'Desk',
  routes: [
    { type: 'lan', endpoint: DESK_LAN, priority: 0, health: { status: 'available' } },
    { type: 'cloudflare', endpoint: DESK_TUNNEL, priority: 1, health: { status: 'unknown' } },
  ],
  paired: true,
  appOrigin: 'https://app.example.test',
}
const LAPTOP: PhoneEnvironment = {
  environmentId: 'env-2',
  label: 'Laptop',
  routes: [
    { type: 'cloudflare', endpoint: LAPTOP_TUNNEL, priority: 0, health: { status: 'unknown' } },
  ],
  paired: true,
  appOrigin: null,
}
/** How the home tags a row of each environment. */
const ON_DESK = { environmentId: DESK.environmentId, label: DESK.label }
const ON_LAPTOP = { environmentId: LAPTOP.environmentId, label: LAPTOP.label }

/** Views only check that a connected link holds a client. */
const CLIENT = {} as EnvironmentClient

const entry = (overrides: Partial<SidebarSessionEntry>): SidebarSessionEntry => ({
  externalId: 'x',
  status: 'ready',
  providerId: 'claude',
  isDriven: true,
  settledAt: null,
  ...overrides,
})

/** One environment's link, as the controller reports it. */
function link(
  environmentId: string,
  status: PhoneLinkStatus = 'connected',
  endpoint: string | null = DESK_LAN,
  overrides: Partial<PhoneLinkState> = {},
): PhoneLinkState {
  return {
    environmentId,
    status,
    endpoint,
    bootstrap: { status: 'idle' },
    routeFailure: null,
    connection: null,
    protocol: { client: PROTOCOL_VERSION, environment: null },
    attempt: 0,
    retryAt: null,
    socketOrigin: null,
    client: status === 'connected' ? CLIENT : null,
    ...overrides,
  }
}

/** The phone with one saved environment, Desk, connected over its LAN route unless said otherwise. */
const connection = (
  overrides: Partial<PhoneConnectionReading> & {
    status?: PhoneLinkStatus
    endpoint?: string | null
  } = {},
): PhoneConnectionReading => {
  const { status = 'connected', endpoint = DESK_LAN, ...rest } = overrides
  return {
    loaded: true,
    selectedId: DESK.environmentId,
    environments: [DESK],
    links: { [DESK.environmentId]: link(DESK.environmentId, status, endpoint) },
    network: { online: true },
    ...rest,
  }
}

/** Nothing saved, read. */
const NONE: PhoneConnectionReading = connection({ selectedId: null, environments: [], links: {} })
/** Still reading what the phone saved. */
const STARTING: PhoneConnectionReading = { ...NONE, loaded: false }

const slice = (
  sessions: SidebarSessionsByWorkspace,
  overrides: Partial<HomeSlice> = {},
): HomeSlice => ({
  environmentId: DESK.environmentId,
  workspaces: WORKSPACES,
  sessions,
  drafts: [],
  discardDraft: null,
  ...overrides,
})

/** Desk's providers serving `sessionsByWorkspace`; none up at all for `null`. */
const inputs = (
  sessionsByWorkspace: SidebarSessionsByWorkspace | null,
  overrides: Partial<HomeSourceInputs> & { drafts?: readonly SidebarDraft[] | null } = {},
): HomeSourceInputs => {
  const { drafts, ...rest } = overrides
  return {
    connection: connection(),
    slices:
      sessionsByWorkspace === null
        ? []
        : [slice(sessionsByWorkspace, drafts === undefined ? {} : { drafts })],
    fixture: false,
    ...rest,
  }
}

describe('the home source over the shared sidebar providers', () => {
  it('passes every status through as the environment served it', () => {
    const statuses = ['done', 'ready', 'running', 'busy', 'waiting', 'error', 'something-new']
    const byWorkspace = {
      [REPO]: statuses.map((status) =>
        entry({
          externalId: status,
          status,
          ...(status === 'waiting' ? { waitingOn: 'question' } : {}),
        }),
      ),
    }
    const source = homeSourceOf(inputs(byWorkspace))
    expect(source.kind).toBe('environment')
    expect(source.sessions.map((session) => session.status)).toEqual(statuses)
    expect(source.sessions.map(statusMarkOf)).toEqual([
      'done',
      'idle',
      'working',
      'working',
      'question',
      'error',
      'idle',
    ])
    // Every other field is the entry's own; the row only learns its
    // workspace and which environment it is on.
    expect(source.sessions[0]).toEqual({
      ...byWorkspace[REPO]![0],
      workspacePath: REPO,
      environment: ON_DESK,
    })
  })

  it('flattens the workspace groups and keeps each row the same object while its entry is', () => {
    const a = entry({ externalId: 'a' })
    const b = entry({ externalId: 'b' })
    const first = homeSessionsOf({ [REPO]: [a], [OTHER]: [b] }, ON_DESK)
    expect(first.map((row) => [row.externalId, row.workspacePath])).toEqual([
      ['a', REPO],
      ['b', OTHER],
    ])
    const b2 = entry({ externalId: 'b', status: 'running' })
    const second = homeSessionsOf({ [REPO]: [a], [OTHER]: [b2] }, ON_DESK)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1]!.status).toBe('running')
    // The same entry on another environment is another row.
    expect(homeSessionsOf({ [REPO]: [a] }, ON_LAPTOP)[0]).not.toBe(first[0])
  })

  it('nests a child under its parent, across the provider groups', () => {
    const byWorkspace = {
      [REPO]: [
        entry({ externalId: 'parent', updatedAt: NOW.toISOString() }),
        entry({
          externalId: 'child',
          parentExternalId: 'parent',
          status: 'waiting',
          waitingOn: 'permission',
          updatedAt: NOW.toISOString(),
        }),
      ],
      [OTHER]: [entry({ externalId: 'orphan', parentExternalId: 'unlisted' })],
    }
    const { sessions, workspaces } = homeSourceOf(inputs(byWorkspace))
    const active = selectHomeRows({ sessions, workspaces, tab: 'all' })
    // The waiting child ranks its whole tree under Needs you.
    expect(active[0]!.label).toBe('Needs you')
    expect(active[0]!.rows.map((row) => [row.session.externalId, row.depth])).toEqual([
      ['parent', 0],
      ['child', 1],
    ])
    // A child whose parent is not listed stands on its own.
    const all = selectHomeRows({ sessions, workspaces, tab: 'all' })
    const orphan = all
      .flatMap((group) => group.rows)
      .find((row) => row.session.externalId === 'orphan')
    expect(orphan?.depth).toBe(0)
  })

  it('keeps an unavailable workspace and its sessions, as the provider marks them', () => {
    const byWorkspace = {
      [GONE]: [entry({ externalId: 'stranded', workspaceUnavailable: true })],
    }
    const { sessions, workspaces } = homeSourceOf(inputs(byWorkspace))
    expect(sessions[0]).toMatchObject({ workspaceUnavailable: true, workspacePath: GONE })
    const [group] = selectHomeRows({ sessions, workspaces, tab: 'all' })
    expect(group!.rows[0]!.workspace).toMatchObject({ name: 'gone', availability: 'missing' })
  })

  it('leaves a missing title and a missing time missing', () => {
    const byWorkspace = { [REPO]: [entry({ externalId: 'bare' })] }
    const { sessions, workspaces } = homeSourceOf(inputs(byWorkspace))
    expect(sessions[0]!.title).toBeUndefined()
    expect(sessions[0]!.updatedAt).toBeUndefined()
    const groups = selectHomeRows({ sessions, workspaces, tab: 'all' })
    expect(groups.map((group) => group.label)).toEqual(['Recent'])
  })

  it('serves the shared draft cards as they are, each saying which environment it is on', () => {
    const drafts: SidebarDraft[] = [
      {
        draftId: 'd1',
        sessionId: 's-d1',
        workspaceId: REPO,
        providerId: 'claude',
        preview: 'Write the tests',
        imageCount: 1,
        editedAt: NOW.getTime(),
        unsynced: 'offline',
      },
      {
        draftId: 'd2',
        sessionId: 's-d2',
        workspaceId: null,
        providerId: 'opencode',
        preview: '',
        imageCount: 2,
        editedAt: NOW.getTime() - 1000,
      },
    ]
    const source = homeSourceOf(inputs({}, { drafts }))
    expect(source.drafts).toEqual(drafts.map((draft) => ({ ...draft, environment: ON_DESK })))
    // The same card while its draft is the same object.
    expect(homeDraftsOf(drafts, ON_DESK)[0]).toBe(source.drafts[0])
    expect(tabCounts(source.sessions)).toEqual({ all: 0, settled: 0 })
    const rows = selectDraftRows({ drafts: source.drafts, workspaces: source.workspaces })
    expect(rows.map((row) => row.workspace?.name ?? null)).toEqual(['repo', null])
  })

  it('has no drafts on a host that serves none', () => {
    const source = homeSourceOf(inputs({}, { drafts: null }))
    expect(source.drafts).toEqual([])
    expect(source.discardDraft).toBeUndefined()
  })
})

describe('several environments on the home', () => {
  const both = (overrides: Partial<PhoneConnectionReading> = {}): PhoneConnectionReading =>
    connection({
      environments: [DESK, LAPTOP],
      links: {
        [DESK.environmentId]: link(DESK.environmentId),
        [LAPTOP.environmentId]: link(LAPTOP.environmentId, 'connected', LAPTOP_TUNNEL),
      },
      ...overrides,
    })
  const draft = (draftId: string): SidebarDraft => ({
    draftId,
    sessionId: `s-${draftId}`,
    workspaceId: REPO,
    providerId: 'claude',
    preview: 'The same id, twice',
    imageCount: 0,
    editedAt: NOW.getTime(),
  })

  it('lists the same session and draft ids from two environments as two rows, each its own', () => {
    const deskDiscard = vi.fn()
    const laptopDiscard = vi.fn()
    const deskSlice = slice(
      { [REPO]: [entry({ externalId: 'shared', status: 'running' })] },
      { drafts: [draft('d1')], discardDraft: deskDiscard },
    )
    const laptopSlice = slice(
      { [REPO]: [entry({ externalId: 'shared', status: 'done' })] },
      {
        environmentId: LAPTOP.environmentId,
        workspaces: [WORKSPACES[0]!],
        drafts: [draft('d1')],
        discardDraft: laptopDiscard,
      },
    )
    // Slices in any order: the rows follow the saved order of environments.
    const source = homeSourceOf({
      connection: both(),
      slices: [laptopSlice, deskSlice],
      fixture: false,
    })
    expect(source.sessions.map((row) => [row.externalId, row.status, row.environment])).toEqual([
      ['shared', 'running', ON_DESK],
      ['shared', 'done', ON_LAPTOP],
    ])
    expect(source.drafts.map((card) => [card.draftId, card.environment])).toEqual([
      ['d1', ON_DESK],
      ['d1', ON_LAPTOP],
    ])
    expect(source.workspaces).toEqual([...WORKSPACES, WORKSPACES[0]])

    // Discarding a card reaches only the environment the card is on.
    source.discardDraft!(source.drafts[1]!)
    expect(laptopDiscard.mock.calls).toEqual([['d1']])
    expect(deskDiscard).not.toHaveBeenCalled()
    source.discardDraft!(source.drafts[0]!)
    expect(deskDiscard.mock.calls).toEqual([['d1']])
    expect(laptopDiscard).toHaveBeenCalledTimes(1)
  })

  it('offers no discard until some environment keeps draft cards, and skips one that does not', () => {
    const deskDiscard = vi.fn()
    const rows = homeRowsOf(
      [DESK, LAPTOP],
      [
        slice({}, { drafts: [draft('d1')], discardDraft: deskDiscard }),
        slice(
          {},
          { environmentId: LAPTOP.environmentId, drafts: [draft('d2')], discardDraft: null },
        ),
      ],
    )
    expect(rows.drafts.map((card) => card.environment?.label)).toEqual(['Desk', 'Laptop'])
    // Laptop keeps no drafts of its own to discard: its card's discard goes nowhere.
    rows.discardDraft!(rows.drafts[1]!)
    expect(deskDiscard).not.toHaveBeenCalled()
    rows.discardDraft!(rows.drafts[0]!)
    expect(deskDiscard.mock.calls).toEqual([['d1']])
    expect(
      homeRowsOf([DESK, LAPTOP], [slice({}), slice({}, { environmentId: 'env-2' })]).discardDraft,
    ).toBeUndefined()
  })

  it('passes one environment’s arrays through, and lists only the environments whose providers are up', () => {
    const only = slice({ [REPO]: [entry({ externalId: 'a' })] })
    const one = homeRowsOf([DESK, LAPTOP], [only])
    expect(one.workspaces).toBe(WORKSPACES)
    expect(one.sessions.map((row) => row.environment)).toEqual([ON_DESK])
    // A slice of an environment that is not saved any more is not listed.
    const gone = homeRowsOf(
      [DESK],
      [only, slice({ [REPO]: [entry({ externalId: 'b' })] }, { environmentId: 'env-9' })],
    )
    expect(gone.sessions.map((row) => row.externalId)).toEqual(['a'])
  })

  it('marks only the environment nothing reaches as offline, and keeps the other connected', () => {
    const reading = both({
      links: {
        [DESK.environmentId]: link(DESK.environmentId),
        [LAPTOP.environmentId]: link(LAPTOP.environmentId, 'waiting', LAPTOP_TUNNEL, {
          attempt: 1,
          retryAt: NOW.getTime() + 4000,
          routeFailure: { reason: 'route_down', endpoint: LAPTOP_TUNNEL, local: false, tried: 1 },
        }),
      },
    })
    const states = homeEnvironmentsOf(reading, [slice({}), slice({}, { environmentId: 'env-2' })])
    expect(states.map((state) => [state.environmentId, state.selected, state.offline])).toEqual([
      ['env-1', true, false],
      ['env-2', false, true],
    ])
    expect(states[0]).toMatchObject({
      label: 'Desk',
      connection: 'ready',
      tone: 'ok',
      words: null,
      needsPairing: false,
      route: { kind: 'local', address: DESK_LAN },
      workspaces: WORKSPACES,
    })
    expect(states[1]).toMatchObject({
      label: 'Laptop',
      connection: 'unreachable',
      tone: 'warn',
      needsPairing: false,
      route: null,
    })
    expect(states[1]!.words).toContain('laptop.cletus.xyz')

    const source = homeSourceOf({ connection: reading, slices: [slice({})], fixture: false })
    expect(source.connected).toBe(true)
    expect(source.environments).toEqual(
      states.map((state) => ({ ...state, workspaces: expect.anything() })),
    )
    // New sessions going to the one that is down: the home is not connected.
    expect(
      homeSourceOf({ connection: { ...reading, selectedId: 'env-2' }, slices: [], fixture: false })
        .connected,
    ).toBe(false)
  })

  it('marks an environment whose token is gone as needing pairing, on its own', () => {
    const reading = both({
      environments: [DESK, { ...LAPTOP, paired: false }],
      links: {
        [DESK.environmentId]: link(DESK.environmentId),
        [LAPTOP.environmentId]: link(LAPTOP.environmentId, 'unauthorized', LAPTOP_TUNNEL),
      },
    })
    const [desk, laptop] = homeEnvironmentsOf(reading, [])
    expect(desk).toMatchObject({ needsPairing: false, tone: 'ok', offline: false })
    expect(laptop).toMatchObject({
      needsPairing: true,
      tone: 'error',
      words: 'Needs pairing again',
      offline: false,
      connection: 'unauthorized',
    })
    // One environment still holds a token: the home does not offer pairing.
    expect(homeSourceOf({ connection: reading, slices: [], fixture: false }).needsPairing).toBe(
      false,
    )
  })
})

describe('which source the home reads', () => {
  it('reads the environment once one is paired, fixture flag or not', () => {
    const source = homeSourceOf(
      inputs({ [REPO]: [entry({ externalId: 'real' })] }, { fixture: true }),
    )
    expect(source.kind).toBe('environment')
    expect(source.sessions.map((session) => session.externalId)).toEqual(['real'])
  })

  it('shows the fixture only with nothing paired and the dev flag set', () => {
    const fixture = homeSourceOf(inputs(null, { connection: NONE, fixture: true }))
    expect(fixture.kind).toBe('fixture')
    expect(fixture.sessions).toBe(FIXTURE_SESSIONS)

    const empty = homeSourceOf(inputs(null, { connection: NONE }))
    expect(empty).toMatchObject({
      kind: 'environment',
      environment: null,
      environments: [],
      connected: false,
      sessions: [],
      workspaces: [],
      drafts: [],
    })
  })

  it('does not show the fixture while the phone is still reading what it saved', () => {
    expect(homeSourceOf(inputs(null, { connection: STARTING, fixture: true })).kind).toBe(
      'environment',
    )
  })

  it('shows the fixture for an environment whose token was refused, when asked for', () => {
    const refused = connection({
      status: 'unauthorized',
      environments: [{ ...DESK, paired: false }],
    })
    expect(homeSourceOf(inputs(null, { connection: refused, fixture: true })).kind).toBe('fixture')
    expect(homeSourceOf(inputs(null, { connection: refused })).environment?.label).toBe('Desk')
  })
})

describe('offering pairing', () => {
  it('offers it with nothing saved, and with no token for any saved environment', () => {
    expect(homeSourceOf(inputs(null, { connection: NONE })).needsPairing).toBe(true)
    const refused = connection({
      status: 'unauthorized',
      environments: [{ ...DESK, paired: false }],
    })
    expect(homeSourceOf(inputs(null, { connection: refused })).needsPairing).toBe(true)
  })

  it('does not while connected, or while the phone is still reading what it saved', () => {
    expect(homeSourceOf(inputs(null)).needsPairing).toBe(false)
    expect(homeSourceOf(inputs(null, { connection: STARTING })).needsPairing).toBe(false)
  })
})

describe('the environment line', () => {
  it("is the controller's label, the route in use and whether it is connected", () => {
    expect(homeEnvironmentOf(connection())).toEqual({
      environmentId: 'env-1',
      label: 'Desk',
      route: { kind: 'local', address: DESK_LAN },
    })
    expect(homeEnvironmentOf(connection({ endpoint: DESK_TUNNEL }))?.route.kind).toBe('tunnel')
    expect(homeEnvironmentOf(connection({ endpoint: 'http://127.0.0.1:43120' }))?.route.kind).toBe(
      'local',
    )
    // Before any route was used, the first saved one.
    expect(homeEnvironmentOf(connection({ endpoint: null }))?.route.address).toBe(DESK_LAN)
    expect(homeSourceOf(inputs({}, { connection: connection({ status: 'held' }) })).connected).toBe(
      false,
    )
    expect(homeSourceOf(inputs({})).connected).toBe(true)
    expect(homeEnvironmentOf(connection({ selectedId: null }))).toBeNull()
  })

  it('names the environment new sessions go to, not the first saved', () => {
    const reading = connection({
      environments: [DESK, LAPTOP],
      selectedId: LAPTOP.environmentId,
      links: {
        [DESK.environmentId]: link(DESK.environmentId),
        [LAPTOP.environmentId]: link(LAPTOP.environmentId, 'connected', LAPTOP_TUNNEL),
      },
    })
    expect(homeEnvironmentOf(reading)).toEqual({
      environmentId: 'env-2',
      label: 'Laptop',
      route: { kind: 'tunnel', address: LAPTOP_TUNNEL },
    })
  })
})
