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
let home: ReturnType<typeof useHomeSource> | null = null
function HomeProbe() {
  home = useHomeSource()
  return null
}
const everything = <T,>(state: T) => state
function Probe({ sessionId }: { sessionId: string }) {
  const view = useReadOnlySession(sessionId)
  const stores = useActiveThreadStores()
  // Rows on screen each subscribe to the stores; the list itself is not
  // re-rendered by a token. The probe reads every row, so it follows every
  // update.
  useEnvironmentState(everything)
  seen = {
    phase: view.phase,
    title: view.session?.title ?? view.title,
    status: view.session?.status,
    rows: threadRowsOf(stores, view.messages).map((row) => ({
      role: row.role,
      content: row.content,
      isFinal: row.isFinal,
    })),
  }
  return null
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  seen = null
  home = null
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

function mount(client: MockEnvironmentClient, sessionId: string | null) {
  return act(() =>
    root.render(
      <EnvironmentClientProvider client={client}>
        {/* As the phone mounts them: draft pages are what turn the draft cards on. */}
        <EnvironmentApplicationProviders storage={null} navigateDraft={navigateDraft}>
          <HomeProbe />
          {sessionId ? <Probe key={sessionId} sessionId={sessionId} /> : null}
        </EnvironmentApplicationProviders>
      </EnvironmentClientProvider>,
    ),
  )
}

const navigateDraft = async () => undefined

const commandsOf = (client: MockEnvironmentClient) => client.calls.map((call) => call.command)

describe('a session opened read-only on the phone', () => {
  it('opens with session.open and shows the snapshot, never asking for history', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
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
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
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
    const client = createMockEnvironmentClient({
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

  it('opens a child session read-only on its own', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
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
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
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
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
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

  it('says the session is gone when the environment deletes it while on screen', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
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
