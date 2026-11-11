// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageSearchHit } from '@openmanager/protocol'
import {
  createMockEnvironmentClient,
  type EnvironmentClient,
} from '@openmanager/environment-client'
import {
  chatSearchStatus,
  useChatSearch,
  type ChatSearchSource,
  type PlacedSearchHit,
} from '@openmanager/app-core/lib/chat-search'
import type {
  SidebarSessionEntry,
  WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

import type { PhoneConnectionState, PhoneEnvironment } from '../src/environment/controller'
import { homeSessionKey, type HomeSession } from '../src/home/rows'

// The hook reads the controller through the provider, which needs React
// Native's runtime: a stand-in controller serves it here.
type Listener = () => void
const fake = {
  state: { environments: [], links: {} } as unknown as PhoneConnectionState,
  listeners: new Set<Listener>(),
  set(state: Pick<PhoneConnectionState, 'environments' | 'links'>) {
    fake.state = state as PhoneConnectionState
    for (const listener of [...fake.listeners]) listener()
  },
}
const controller = {
  getState: () => fake.state,
  subscribe: (listener: Listener) => {
    fake.listeners.add(listener)
    return () => fake.listeners.delete(listener)
  },
}
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnectionController: () => controller,
}))
const { chatSearchSourcesOf, messageHitRowsOf, searchableEnvironmentIds, useChatSearchSources } =
  await import('../src/home/message-search')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const environment = (environmentId: string, label: string): PhoneEnvironment => ({
  environmentId,
  label,
  routes: [],
  paired: true,
  appOrigin: null,
})
const DESK = environment('env-desk', 'Desk')
const LAPTOP = environment('env-laptop', 'Laptop')
const OLD = environment('env-old', 'Old server')

const ALL_BUT_SEARCH = (['sendTurn', 'openSession'] as const).slice()

/** A link holding `client`; nothing else of the link is read. */
const link = (client: EnvironmentClient | null) =>
  ({ client }) as PhoneConnectionState['links'][string]

const hit = (sessionId: string, patch: Partial<MessageSearchHit> = {}): MessageSearchHit => ({
  sessionId,
  workspaceId: 'w',
  title: sessionId,
  messageId: `${sessionId}-m`,
  role: 'assistant',
  at: '2026-11-10T10:00:00.000Z',
  snippet: `… about the ${sessionId} loop`,
  highlights: [[12, 12 + sessionId.length]],
  matches: 1,
  ...patch,
})
const placed = (environmentId: string, sessionId: string, patch: Partial<MessageSearchHit> = {}) =>
  ({ ...hit(sessionId, patch), environmentId }) as PlacedSearchHit

const entry = (overrides: Partial<SidebarSessionEntry>): SidebarSessionEntry => ({
  externalId: 'x',
  status: 'ready',
  providerId: 'claude',
  isDriven: true,
  settledAt: null,
  ...overrides,
})
const session = (environmentId: string, externalId: string, title = externalId): HomeSession => ({
  ...entry({ externalId, title }),
  workspacePath: 'C:/repo',
  environment: { environmentId, label: environmentId },
})
const REPO: WorkspaceEntry = { path: 'C:/repo', name: 'repo', availability: 'available' }

describe('which environments are searched', () => {
  it('only those whose client can search messages, in the saved order', () => {
    const state = {
      environments: [LAPTOP, OLD, DESK, environment('env-down', 'Down')],
      links: {
        [DESK.environmentId]: link(createMockEnvironmentClient()),
        [LAPTOP.environmentId]: link(createMockEnvironmentClient()),
        // A server from before `search.messages`.
        [OLD.environmentId]: link(createMockEnvironmentClient({ capabilities: ALL_BUT_SEARCH })),
        // Saved, but no client: not connected yet, or refused.
        'env-down': link(null),
      },
    }
    expect(searchableEnvironmentIds(state)).toEqual(['env-laptop', 'env-desk'])
  })

  it('asks the client the environment holds when the search runs', async () => {
    const first = createMockEnvironmentClient({ searchMessages: () => [hit('first')] })
    const second = createMockEnvironmentClient({ searchMessages: () => [hit('second')] })
    let current: EnvironmentClient | null = first
    const [source] = chatSearchSourcesOf(['env-desk'], () => current)
    expect((await source!.search('loop', 20)).map((h) => h.sessionId)).toEqual(['first'])
    current = second
    expect((await source!.search('loop', 20)).map((h) => h.sessionId)).toEqual(['second'])
    current = null
    await expect(source!.search('loop', 20)).rejects.toThrow()
  })

  it('passes the query and limit through', async () => {
    const asked = vi.fn((_query: string, _limit: number) => [] as MessageSearchHit[])
    const client = createMockEnvironmentClient({ searchMessages: asked })
    const [source] = chatSearchSourcesOf(['env-desk'], () => client)
    await source!.search('reconnect loop', 7)
    expect(asked).toHaveBeenCalledWith('reconnect loop', 7)
  })
})

describe('hits as the phone’s rows', () => {
  const sessions = [
    session('env-desk', 's1', 'Fix the reconnect loop'),
    session('env-desk', 's2', 'Backoff'),
    session('env-laptop', 's1', 'Same id, another environment'),
  ]
  const workspaceOf = () => REPO

  it('maps each hit to its own environment’s session, in the hits’ order', () => {
    const rows = messageHitRowsOf({
      hits: [placed('env-laptop', 's1'), placed('env-desk', 's2')],
      sessions,
      listed: new Set(),
      workspaceOf,
    })
    expect(rows.map((row) => row.row.session.title)).toEqual([
      'Same id, another environment',
      'Backoff',
    ])
    expect(rows[0]!.key).toBe(homeSessionKey(sessions[2]!))
    expect(rows[0]!.row).toMatchObject({ kind: 'session', workspace: REPO, mark: 'idle', depth: 0 })
  })

  it('does not repeat a session already listed by its title', () => {
    const rows = messageHitRowsOf({
      hits: [placed('env-desk', 's1'), placed('env-desk', 's2')],
      sessions,
      listed: new Set([homeSessionKey(sessions[0]!)]),
      workspaceOf,
    })
    expect(rows.map((row) => row.hit.sessionId)).toEqual(['s2'])
  })

  it('skips a session the phone does not hold', () => {
    const rows = messageHitRowsOf({
      hits: [placed('env-desk', 'unknown'), placed('env-other', 's2'), placed('env-desk', 's2')],
      sessions,
      listed: new Set(),
      workspaceOf,
    })
    expect(rows.map((row) => `${row.hit.environmentId}/${row.hit.sessionId}`)).toEqual([
      'env-desk/s2',
    ])
  })

  it('drops the leading ellipsis and shifts the matched runs with it', () => {
    const [row] = messageHitRowsOf({
      hits: [placed('env-desk', 's2')],
      sessions,
      listed: new Set(),
      workspaceOf,
    })
    expect(row!.snippet.text).toBe('about the s2 loop')
    const [[start, end]] = row!.snippet.highlights as [[number, number]]
    expect(row!.snippet.text.slice(start, end)).toBe('s2')
  })
})

describe('the status line', () => {
  const name = (id: string) => ({ 'env-desk': 'Desk', 'env-laptop': 'Laptop' })[id]

  it('names the environment that could not be searched', () => {
    expect(chatSearchStatus('loop', { failed: ['env-laptop'] }, 2, name)).toBe(
      'Couldn’t search Laptop.',
    )
  })

  it('says nothing once every environment answered', () => {
    expect(chatSearchStatus('loop', { failed: [] }, 2, name)).toBeNull()
  })
})

describe('searching from the screen’s sources', () => {
  let container: HTMLDivElement
  let root: Root
  let seen: { sources: readonly ChatSearchSource[]; hits: string[]; failed: string[] }[]

  function Probe({ query }: { query: string }) {
    const sources = useChatSearchSources()
    const search = useChatSearch(query, sources, { debounceMs: 0, timeoutMs: 1_000 })
    seen.push({
      sources,
      hits: search.hits.map((h) => `${h.environmentId}/${h.sessionId}`),
      failed: search.failed,
    })
    return null
  }
  const last = () => seen[seen.length - 1]!
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  beforeEach(() => {
    seen = []
    container = document.createElement('div')
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
  })

  it('asks every capable environment, names one that fails, and keeps its sources across a reconnect', async () => {
    const desk = createMockEnvironmentClient({ searchMessages: () => [hit('d1')] })
    const laptop = createMockEnvironmentClient({ searchMessages: () => [hit('l1')] })
    vi.spyOn(laptop.commands, 'searchMessages').mockRejectedValue(new Error('gone'))
    const old = createMockEnvironmentClient({ capabilities: ALL_BUT_SEARCH })
    fake.set({
      environments: [DESK, LAPTOP, OLD],
      links: {
        [DESK.environmentId]: link(desk),
        [LAPTOP.environmentId]: link(laptop),
        [OLD.environmentId]: link(old),
      },
    })

    await act(async () => root.render(createElement(Probe, { query: 'loop' })))
    await settle()
    expect(last().sources.map((s) => s.environmentId)).toEqual(['env-desk', 'env-laptop'])
    expect(last().hits).toEqual(['env-desk/d1'])
    expect(last().failed).toEqual(['env-laptop'])

    // Another report of the same connections: the same sources, nothing asked again.
    const sources = last().sources
    fake.set({ ...fake.state, links: { ...fake.state.links } })
    await settle()
    expect(last().sources).toBe(sources)

    // An environment that stops answering searches drops out, and the rest are asked again.
    fake.set({ ...fake.state, links: { ...fake.state.links, [LAPTOP.environmentId]: link(null) } })
    await settle()
    expect(last().sources.map((s) => s.environmentId)).toEqual(['env-desk'])
    expect(last().failed).toEqual([])
    expect(last().hits).toEqual(['env-desk/d1'])
  })

  it('has no sources, and asks nothing, with nothing that can search', async () => {
    fake.set({ environments: [OLD], links: { [OLD.environmentId]: link(null) } })
    await act(async () => root.render(createElement(Probe, { query: 'loop' })))
    await settle()
    expect(last().sources).toEqual([])
    expect(last().hits).toEqual([])
  })
})
