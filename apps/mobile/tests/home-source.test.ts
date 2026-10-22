import { describe, expect, it, vi } from 'vitest'
import type {
  SidebarDraft,
  SidebarSessionEntry,
  SidebarSessionsByWorkspace,
  WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

import type { PhoneConnectionState } from '../src/environment/controller'
import { FIXTURE_SESSIONS } from '../src/home/fixture'
import { selectDraftRows, selectHomeRows, statusMarkOf, tabCounts } from '../src/home/rows'

// The hook reads the controller through the provider, which needs React
// Native's runtime; the pure parts are what is tested here.
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({ usePhoneConnection: () => null }))
const { homeEnvironmentOf, homeSessionsOf, homeSourceOf } = await import('../src/home/source')

const NOW = new Date(2026, 9, 21, 12, 0, 0)
const REPO = 'C:/repo'
const OTHER = 'C:/other'
const GONE = 'C:/gone'

const WORKSPACES: WorkspaceEntry[] = [
  { path: REPO, name: 'repo', availability: 'available' },
  { path: OTHER, name: 'other', availability: 'available' },
  { path: GONE, name: 'gone', missing: true, availability: 'missing' },
]

const entry = (overrides: Partial<SidebarSessionEntry>): SidebarSessionEntry => ({
  externalId: 'x',
  status: 'ready',
  providerId: 'claude',
  isDriven: true,
  settledAt: null,
  ...overrides,
})

type Connection = Parameters<typeof homeEnvironmentOf>[0]
const connection = (overrides: Partial<PhoneConnectionState> = {}): Connection => ({
  status: 'connected',
  selectedId: 'env-1',
  endpoint: 'http://192.168.1.4:43120',
  environments: [
    {
      environmentId: 'env-1',
      label: 'Desk',
      routes: [
        {
          type: 'lan',
          endpoint: 'http://192.168.1.4:43120',
          priority: 0,
          health: { status: 'available' },
        },
        {
          type: 'cloudflare',
          endpoint: 'https://desk.cletus.xyz',
          priority: 1,
          health: { status: 'unknown' },
        },
      ],
      paired: true,
      appOrigin: 'https://app.example.test',
    },
  ],
  ...overrides,
})

const inputs = (
  sessionsByWorkspace: SidebarSessionsByWorkspace | null,
  overrides: Partial<Parameters<typeof homeSourceOf>[0]> = {},
): Parameters<typeof homeSourceOf>[0] => ({
  connection: connection(),
  sidebar: { workspaces: WORKSPACES },
  sessionsByWorkspace,
  drafts: [],
  fixture: false,
  ...overrides,
})

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
    // Every other field is the entry's own; the row only learns its workspace.
    expect(source.sessions[0]).toEqual({ ...byWorkspace[REPO]![0], workspacePath: REPO })
  })

  it('flattens the workspace groups and keeps each row the same object while its entry is', () => {
    const a = entry({ externalId: 'a' })
    const b = entry({ externalId: 'b' })
    const first = homeSessionsOf({ [REPO]: [a], [OTHER]: [b] })
    expect(first.map((row) => [row.externalId, row.workspacePath])).toEqual([
      ['a', REPO],
      ['b', OTHER],
    ])
    const b2 = entry({ externalId: 'b', status: 'running' })
    const second = homeSessionsOf({ [REPO]: [a], [OTHER]: [b2] })
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1]!.status).toBe('running')
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
    const active = selectHomeRows({ sessions, workspaces, tab: 'active', now: NOW })
    // The waiting child ranks its whole tree under Needs you.
    expect(active[0]!.label).toBe('Needs you')
    expect(active[0]!.rows.map((row) => [row.session.externalId, row.depth])).toEqual([
      ['parent', 0],
      ['child', 1],
    ])
    // A child whose parent is not listed stands on its own.
    const all = selectHomeRows({ sessions, workspaces, tab: 'all', now: NOW })
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
    const [group] = selectHomeRows({ sessions, workspaces, tab: 'all', now: NOW })
    expect(group!.rows[0]!.workspace).toMatchObject({ name: 'gone', availability: 'missing' })
  })

  it('leaves a missing title and a missing time missing', () => {
    const byWorkspace = { [REPO]: [entry({ externalId: 'bare' })] }
    const { sessions, workspaces } = homeSourceOf(inputs(byWorkspace))
    expect(sessions[0]!.title).toBeUndefined()
    expect(sessions[0]!.updatedAt).toBeUndefined()
    const groups = selectHomeRows({ sessions, workspaces, tab: 'all', now: NOW })
    expect(groups.map((group) => group.label)).toEqual(['Earlier'])
  })

  it('serves the shared draft cards as they are', () => {
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
    expect(source.drafts).toBe(drafts)
    expect(tabCounts(source.sessions, source.drafts)).toEqual({ all: 0, active: 0, drafts: 2 })
    const [group] = selectDraftRows({
      drafts: source.drafts,
      workspaces: source.workspaces,
      now: NOW,
    })
    expect(group!.rows.map((row) => row.workspace?.name ?? null)).toEqual(['repo', null])
  })

  it('has no drafts on a host that serves none', () => {
    expect(homeSourceOf(inputs({}, { drafts: null })).drafts).toEqual([])
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
    const unpaired = connection({ status: 'no_environment', selectedId: null, environments: [] })
    const fixture = homeSourceOf(
      inputs(null, { connection: unpaired, sidebar: null, fixture: true }),
    )
    expect(fixture.kind).toBe('fixture')
    expect(fixture.sessions).toBe(FIXTURE_SESSIONS)

    const empty = homeSourceOf(inputs(null, { connection: unpaired, sidebar: null, drafts: null }))
    expect(empty).toMatchObject({
      kind: 'environment',
      environment: null,
      connected: false,
      sessions: [],
      workspaces: [],
      drafts: [],
    })
  })

  it('does not show the fixture while the phone is still reading what it saved', () => {
    const starting = connection({ status: 'starting', selectedId: null, environments: [] })
    expect(homeSourceOf(inputs(null, { connection: starting, fixture: true })).kind).toBe(
      'environment',
    )
  })

  it('shows the fixture for an environment whose token was refused, when asked for', () => {
    const base = connection()
    const refused = connection({
      status: 'unauthorized',
      environments: base.environments.map((item) => ({ ...item, paired: false })),
    })
    expect(homeSourceOf(inputs(null, { connection: refused, fixture: true })).kind).toBe('fixture')
    expect(homeSourceOf(inputs(null, { connection: refused })).environment?.label).toBe('Desk')
  })
})

describe('the environment line', () => {
  it("is the controller's label, the route in use and whether it is connected", () => {
    expect(homeEnvironmentOf(connection())).toEqual({
      environmentId: 'env-1',
      label: 'Desk',
      route: { kind: 'local', address: 'http://192.168.1.4:43120' },
    })
    expect(homeEnvironmentOf(connection({ endpoint: 'https://desk.cletus.xyz' }))?.route.kind).toBe(
      'tunnel',
    )
    expect(homeEnvironmentOf(connection({ endpoint: 'http://127.0.0.1:43120' }))?.route.kind).toBe(
      'local',
    )
    // Before any route was used, the first saved one.
    expect(homeEnvironmentOf(connection({ endpoint: null }))?.route.address).toBe(
      'http://192.168.1.4:43120',
    )
    expect(homeSourceOf(inputs({}, { connection: connection({ status: 'held' }) })).connected).toBe(
      false,
    )
    expect(homeSourceOf(inputs({})).connected).toBe(true)
    expect(homeEnvironmentOf(connection({ selectedId: null }))).toBeNull()
  })
})
