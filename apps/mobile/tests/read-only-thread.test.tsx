// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentApplicationProviders,
  EnvironmentClientProvider,
  useActiveThreadStores,
  useEnvironmentState,
} from '@openmanager/app-core/logic'
import {
  EnvironmentClientError,
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'

import type { PhoneConnectionState } from '../src/environment/controller'

// The phone's connection, as the controller would report a paired, connected
// environment; the real one needs React Native's runtime.
const CONNECTION = {
  status: 'connected',
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
      ],
      paired: true,
      appOrigin: 'https://app.example.test',
    },
  ],
  selectedId: 'env-1',
  endpoint: 'http://192.168.1.4:43120',
  activity: 'active',
} as unknown as PhoneConnectionState
vi.mock('../src/environment/PhoneEnvironmentProvider', () => ({
  usePhoneConnection: () => CONNECTION,
}))

const { useReadOnlySession } = await import('../src/session/useReadOnlySession')
const { useHomeSource } = await import('../src/home/source')
const { threadRowsOf } = await import('../src/session/thread-rows')

const WORKSPACE = {
  workspaceId: 'C:/repo',
  name: 'repo',
  path: 'C:/repo',
  lastUsedAt: null,
  lastActivityAt: null,
  capabilities: { git: false, providers: ['opencode'] },
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }
const CHILD = {
  sessionId: 'child-1',
  workspaceId: WORKSPACE.workspaceId,
  title: 'A subagent',
  parentSessionId: SESSION.sessionId,
}
const CHILD_THREAD = { threadId: 'thread-c', sessionId: CHILD.sessionId }

const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  sessions: [
    {
      session: SESSION,
      threads: [THREAD],
      turns: [{ turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' }],
      messages: [
        {
          messageId: 'user-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'user',
          content: [{ type: 'text', text: 'What changed?' }],
        },
        {
          messageId: 'assistant-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Two files were edited.' }],
        },
      ],
    },
    {
      session: CHILD as typeof SESSION,
      threads: [CHILD_THREAD],
      turns: [{ turnId: 'turn-c', threadId: CHILD_THREAD.threadId, state: 'completed' }],
      messages: [
        {
          messageId: 'child-a',
          threadId: CHILD_THREAD.threadId,
          turnId: 'turn-c',
          role: 'assistant',
          content: [{ type: 'text', text: 'Searched the repo.' }],
        },
      ],
    },
  ],
}

type Seen = {
  phase: string
  title: string | undefined
  status: string | undefined
  rows: Array<{ role: string; content: string; isFinal: boolean }>
}

let seen: Seen | null = null
const seenBy: Record<string, Seen> = {}
let home: ReturnType<typeof useHomeSource> | null = null
function HomeProbe() {
  home = useHomeSource()
  return null
}
const everything = <T,>(state: T) => state
function Probe({ sessionId, focused = true }: { sessionId: string; focused?: boolean }) {
  const view = useReadOnlySession(sessionId, { focused })
  const stores = useActiveThreadStores()
  // Rows on screen each subscribe to the stores; the list itself is not
  // re-rendered by a token. The probe reads every row, so it follows every
  // update.
  useEnvironmentState(everything)
  const next: Seen = {
    phase: view.phase,
    title: view.session?.title ?? view.title,
    status: view.session?.status,
    rows: threadRowsOf(stores, view.messages).map((row) => ({
      role: row.role,
      content: row.content,
      isFinal: row.isFinal,
    })),
  }
  seenBy[sessionId] = next
  if (focused) seen = next
  return null
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  seen = null
  home = null
  for (const key of Object.keys(seenBy)) delete seenBy[key]
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async (rounds = 6) => {
  for (let round = 0; round < rounds; round += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

/** The pages on the stack, bottom first; the last one is in front. */
type Pages = string | null | Array<{ id: string; focused: boolean }>

function mount(client: MockEnvironmentClient, pages: Pages) {
  const stack =
    pages === null ? [] : typeof pages === 'string' ? [{ id: pages, focused: true }] : pages
  return act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        {/* As the phone mounts them: draft pages are what turn the draft cards on. */}
        <EnvironmentApplicationProviders storage={null} navigateDraft={navigateDraft}>
          <HomeProbe />
          {stack.map((page) => (
            <Probe key={page.id} sessionId={page.id} focused={page.focused} />
          ))}
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>,
    ),
  )
}

const navigateDraft = async () => undefined

/** The mock, advertising event replay as the environment server does. */
function replayingClient(options: Parameters<typeof createMockEnvironmentClient>[0]) {
  const client = createMockEnvironmentClient(options)
  client.setConnection({
    capabilities: [...client.getState().connection.capabilities, 'subscription.replay'],
  })
  return client
}

const commandsOf = (client: MockEnvironmentClient) => client.calls.map((call) => call.command)

describe('a session opened read-only on the phone', () => {
  it('opens with session.open and shows the snapshot, never asking for history', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, SESSION.sessionId)
    await flush()

    expect(client.calls.filter((call) => call.command === 'openSession')).toEqual([
      { command: 'openSession', input: SESSION.sessionId },
    ])
    expect(seen).toMatchObject({ phase: 'ready', title: 'First' })
    expect(seen!.rows).toEqual([
      { role: 'user', content: 'What changed?', isFinal: true },
      { role: 'assistant', content: 'Two files were edited.', isFinal: true },
    ])
    expect(commandsOf(client)).not.toContain('loadSessionHistory')
  })

  it('streams a turn another device started into the thread as its events arrive', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, SESSION.sessionId)
    await flush()

    // Another device sends: the environment announces the turn and its prompt.
    const turn = { turnId: 'turn-2', threadId: THREAD.threadId, state: 'running' as const }
    await act(() =>
      client.emit({
        type: 'event',
        eventId: 'e-started',
        timestamp: new Date().toISOString(),
        name: 'turn.started',
        scope: {
          type: 'thread',
          environmentId: client.getState().environment!.environmentId,
          ...THREAD,
        },
        payload: {
          turn,
          userMessage: {
            messageId: 'user-2',
            threadId: THREAD.threadId,
            turnId: turn.turnId,
            role: 'user',
            content: [{ type: 'text', text: 'and now?' }],
          },
        },
      }),
    )
    await flush()
    expect(seen!.status).toBe('running')
    expect(seen!.rows.slice(2)).toEqual([
      { role: 'user', content: 'and now?', isFinal: true },
      { role: 'assistant', content: '', isFinal: false },
    ])

    let messageId = ''
    await act(() => {
      messageId = client.streamAssistantText({ ...THREAD, turnId: turn.turnId }, 'one ')
    })
    await flush(2)
    expect(seen!.rows.at(-1)).toEqual({ role: 'assistant', content: 'one ', isFinal: false })
    await act(() => {
      client.streamAssistantText({ ...THREAD, turnId: turn.turnId }, 'two', messageId)
    })
    await flush(2)
    expect(seen!.rows.at(-1)).toEqual({ role: 'assistant', content: 'one two', isFinal: false })

    await act(() => client.completeTurn({ ...THREAD, turnId: turn.turnId }))
    await flush()
    expect(seen!.rows.at(-1)).toEqual({ role: 'assistant', content: 'one two', isFinal: true })
    expect(seen!.rows).toHaveLength(4)
    // The status is the environment's, passed through: no turn in flight, at rest.
    expect(['ready', 'done']).toContain(seen!.status)
    expect(commandsOf(client)).not.toContain('loadSessionHistory')
    expect(commandsOf(client)).not.toContain('sendTurn')
  })

  it('asks the environment to clear "done" once the session is on screen', async () => {
    const client = replayingClient({
      seed: {
        ...SEED,
        sessions: SEED.sessions!.map((entry) =>
          entry.session.sessionId === SESSION.sessionId
            ? { ...entry, session: { ...entry.session, doneAt: new Date().toISOString() } }
            : entry,
        ),
      },
      respond: () => null,
    })
    await mount(client, null)
    await flush()
    expect(client.getState().sessions[SESSION.sessionId]?.doneAt).toBeTruthy()
    expect(commandsOf(client)).not.toContain('acknowledgeSession')

    await mount(client, SESSION.sessionId)
    await flush()
    expect(client.calls.filter((call) => call.command === 'acknowledgeSession')).toEqual([
      { command: 'acknowledgeSession', input: { sessionId: SESSION.sessionId } },
    ])
    // The environment's answer, not the phone, moves it to ready.
    expect(seen!.status).toBe('ready')
  })

  it('asks again to clear "done" when the first ask did not land', async () => {
    const client = replayingClient({
      seed: {
        ...SEED,
        sessions: SEED.sessions!.map((entry) =>
          entry.session.sessionId === SESSION.sessionId
            ? { ...entry, session: { ...entry.session, doneAt: new Date().toISOString() } }
            : entry,
        ),
      },
      respond: () => null,
    })
    const acknowledgeSession = client.commands.acknowledgeSession
    let attempts = 0
    client.commands.acknowledgeSession = (sessionId) => {
      attempts += 1
      if (attempts === 1) {
        client.setConnection({ phase: 'reconnecting' })
        return Promise.reject(new EnvironmentClientError('unavailable', 'The socket closed.'))
      }
      return acknowledgeSession(sessionId)
    }
    await mount(client, SESSION.sessionId)
    await flush()
    expect(attempts).toBe(1)
    expect(seen!.status).toBe('done')

    await act(() => client.setConnection({ phase: 'connected' }))
    await flush()
    expect(attempts).toBe(2)
    expect(seen!.status).toBe('ready')
  })

  it('opens a child session read-only on its own', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, CHILD.sessionId)
    await flush()
    expect(client.calls.filter((call) => call.command === 'openSession')).toEqual([
      { command: 'openSession', input: CHILD.sessionId },
    ])
    expect(seen).toMatchObject({ phase: 'ready', title: 'A subagent' })
    expect(seen!.rows).toEqual([
      { role: 'assistant', content: 'Searched the repo.', isFinal: true },
    ])
  })

  it('releases the session when the page goes, and when it shows another', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, SESSION.sessionId)
    await flush()
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)

    await mount(client, CHILD.sessionId)
    await flush()
    expect(client.getState().activeSessionId).toBe(CHILD.sessionId)

    await mount(client, null)
    await flush()
    expect(client.getState().activeSessionId).toBeNull()
    expect(commandsOf(client)).not.toContain('loadSessionHistory')
  })

  it('lists the environment sessions and its draft cards on the home', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, null)
    await flush()
    expect(home!.kind).toBe('environment')
    expect(home!.sessions.map((session) => [session.externalId, session.parentExternalId])).toEqual(
      expect.arrayContaining([
        [SESSION.sessionId, undefined],
        [CHILD.sessionId, SESSION.sessionId],
      ]),
    )
    const at = new Date().toISOString()
    await act(() =>
      client.emit({
        type: 'event',
        eventId: 'e-draft',
        timestamp: at,
        name: 'draft.saved',
        scope: { type: 'environment', environmentId: client.getState().environment!.environmentId },
        payload: {
          draft: {
            draftId: 'draft-1',
            target: {
              type: 'new_session',
              workspaceId: WORKSPACE.workspaceId,
              sessionId: 'next-1',
            },
            content: { text: 'Written on the computer\nand a second line', providerId: 'claude' },
            revision: 1,
            createdAt: at,
            updatedAt: at,
            updatedByClientId: null,
          },
        },
      }),
    )
    await flush()
    expect(home!.drafts).toEqual([
      expect.objectContaining({
        draftId: 'draft-1',
        sessionId: 'next-1',
        workspaceId: WORKSPACE.workspaceId,
        providerId: 'claude',
        preview: 'Written on the computer',
      }),
    ])
  })

  it('does not open a session on an environment that cannot replay its events', async () => {
    // Without replay the shared client fills a transcript from session.history.
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
    await mount(client, SESSION.sessionId)
    await flush()
    expect(seen!.phase).toBe('unsupported')
    expect(commandsOf(client)).not.toContain('openSession')
    expect(commandsOf(client)).not.toContain('loadSessionHistory')
  })

  it('lets the page in front own the session, and takes it back when it is in front again', async () => {
    const client = replayingClient({
      seed: {
        ...SEED,
        sessions: SEED.sessions!.map((entry) =>
          entry.session.sessionId === SESSION.sessionId
            ? { ...entry, session: { ...entry.session, doneAt: new Date().toISOString() } }
            : entry,
        ),
      },
      respond: () => null,
    })
    // The child is open; then the parent is pushed over it, then popped.
    await mount(client, CHILD.sessionId)
    await flush()
    expect(client.getState().activeSessionId).toBe(CHILD.sessionId)

    await mount(client, [
      { id: CHILD.sessionId, focused: false },
      { id: SESSION.sessionId, focused: true },
    ])
    await flush()
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(seenBy[SESSION.sessionId]!.phase).toBe('ready')

    await mount(client, [{ id: CHILD.sessionId, focused: true }])
    await flush()
    // The parent released only what was its own; the child, in front again, opened again.
    expect(client.getState().activeSessionId).toBe(CHILD.sessionId)
    expect(seen).toMatchObject({ phase: 'ready', title: 'A subagent' })
    expect(
      client.calls.filter((call) => call.command === 'openSession').map((call) => call.input),
    ).toEqual([CHILD.sessionId, SESSION.sessionId, CHILD.sessionId])

    // A done session under another page is not acknowledged: it is not in front.
    await mount(client, [
      { id: SESSION.sessionId, focused: false },
      { id: CHILD.sessionId, focused: true },
    ])
    await flush()
    const acknowledged = client.calls.filter((call) => call.command === 'acknowledgeSession')
    // Only while the parent was in front.
    expect(acknowledged).toEqual([
      { command: 'acknowledgeSession', input: { sessionId: SESSION.sessionId } },
    ])
  })

  it('lets the session go while another page is in front of it', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, SESSION.sessionId)
    await flush()
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    // Covered (a search, say): nothing stays selected or subscribed for it.
    await mount(client, [{ id: SESSION.sessionId, focused: false }])
    await flush()
    expect(client.getState().activeSessionId).toBeNull()
    await mount(client, [{ id: SESSION.sessionId, focused: true }])
    await flush()
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(seen!.phase).toBe('ready')
  })

  it('cancels a second open whose first, cancelled attempt answers late', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    // The wire client, for a session the list has not reached: the reply
    // alone selects it, and a selection made after the request (a release,
    // a later open) lets the reply land nowhere. Each reply is held here
    // until the test lets it through.
    const open = client.commands.openSession
    const select = client.setActiveSession
    let generation = 0
    const held: Array<() => Promise<void>> = []
    client.setActiveSession = (sessionId) => {
      generation += 1
      select(sessionId)
    }
    client.commands.openSession = (sessionId) => {
      const mine = ++generation
      return new Promise<void>((resolve, reject) => {
        held.push(() => (mine === generation ? open(sessionId) : Promise.resolve()).then(resolve, reject))
      })
    }
    const answer = async () => {
      await act(() => held.shift()!())
      await flush()
    }

    // The first open is on its way when a search covers the page; back in
    // front, the page asks again.
    await mount(client, SESSION.sessionId)
    await flush()
    await mount(client, [{ id: SESSION.sessionId, focused: false }])
    await flush()
    await mount(client, [{ id: SESSION.sessionId, focused: true }])
    await flush()
    expect(held).toHaveLength(2)

    // The cancelled first attempt answers now, landing nowhere.
    await answer()
    expect(client.getState().activeSessionId).toBeNull()

    // Covered again before the second attempt answers: that answer must land
    // nowhere too, not select and subscribe a session no page is showing.
    await mount(client, [{ id: SESSION.sessionId, focused: false }])
    await flush()
    await answer()
    expect(client.getState().activeSessionId).toBeNull()
    expect(held).toHaveLength(0)

    // In front once more, it opens, and the answer lands.
    await mount(client, [{ id: SESSION.sessionId, focused: true }])
    await flush()
    await answer()
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(seen!.phase).toBe('ready')
  })

  it('lets the session go when the environment stops replaying events', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, SESSION.sessionId)
    await flush()
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    // A reconnect to an environment without replay: the client's own
    // recovery would reopen its active session through session.history.
    await act(() =>
      client.setConnection({
        capabilities: client
          .getState()
          .connection.capabilities.filter((name) => name !== 'subscription.replay'),
      }),
    )
    await flush()
    expect(client.getState().activeSessionId).toBeNull()
    expect(seen!.phase).toBe('unsupported')
    expect(commandsOf(client)).not.toContain('loadSessionHistory')
  })

  it('opens again after the connection drops under the first open', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    const open = client.commands.openSession
    let dropped = false
    client.commands.openSession = (sessionId) => {
      if (dropped) return open(sessionId)
      dropped = true
      client.setConnection({ phase: 'reconnecting' })
      return Promise.reject(new EnvironmentClientError('unavailable', 'The socket closed.'))
    }
    await mount(client, SESSION.sessionId)
    await flush()
    expect(seen!.phase).toBe('opening')

    await act(() => client.setConnection({ phase: 'connected' }))
    await flush()
    expect(seen!.phase).toBe('ready')
    expect(seen!.rows).toHaveLength(2)
  })

  it('says the session is gone when the environment deletes it while on screen', async () => {
    const client = replayingClient({ seed: SEED, respond: () => null })
    await mount(client, SESSION.sessionId)
    await flush()
    await act(() =>
      client.emit({
        type: 'event',
        eventId: 'e-deleted',
        timestamp: new Date().toISOString(),
        name: 'session.deleted',
        scope: { type: 'environment', environmentId: client.getState().environment!.environmentId },
        payload: { sessionId: SESSION.sessionId },
      }),
    )
    await flush()
    expect(seen!.phase).toBe('gone')
  })
})
