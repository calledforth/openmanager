// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  createEnvironmentStore,
  applySessionHistory,
  type SessionHistoryPage,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import { EnvironmentClientProvider } from '../src/providers/environment-client'
import { EnvironmentApplicationProviders } from '../src/providers/environment-application'
import {
  useActiveThreadState,
  useActiveThreadStores,
} from '../src/providers/active-thread-provider'
import { ThemeProvider } from '../src/providers/theme-provider'
import { ChatWorkspace } from '../src/components/chat/ChatWorkspace'
import { MockEnvironmentApp } from '../src/testing/mock-environment-app'

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

/** A session with one settled turn, so opening it shows a mocked history. */
const SEEDED_HISTORY: MockSeed = {
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
  ],
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(() => root.unmount())
  container.remove()
  globalThis.localStorage?.clear()
  vi.unstubAllGlobals()
})
const render = (node: ReactNode) => act(() => root.render(node))
/** Drain the mock, then yield so a command chained after the last one gets
 * scheduled, and drain again; a draft send is three commands deep. */
const settle = async (client: MockEnvironmentClient) => {
  for (let round = 0; round < 6; round += 1) {
    await act(() => client.settle())
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

function App({
  client,
  addWorkspace,
}: {
  client: MockEnvironmentClient
  addWorkspace?: () => Promise<void>
}) {
  return <MockEnvironmentApp client={client} addWorkspace={addWorkspace} />
}

const occurrences = (text: string) => (container.textContent?.split(text).length ?? 1) - 1

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const buttonWithText = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.includes(text),
  )
const type = async (text: string) => {
  const textarea = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the shared application over the environment client', () => {
  it('updates sidebar glyphs from server status without opening the session', async () => {
    const client = createMockEnvironmentClient({
      seed: { workspaces: [WORKSPACE] },
    })
    client.emit({
      type: 'event',
      name: 'session.created',
      eventId: 'created',
      timestamp: new Date().toISOString(),
      scope: { type: 'environment', environmentId: client.getState().environment!.environmentId },
      payload: { session: SESSION },
    })
    await render(<App client={client} />)
    const labels = {
      idle: 'Session ready to open',
      running: 'Session in progress',
      waiting: 'Session needs your attention',
      error: 'Session failed',
    } as const
    for (const status of ['idle', 'running', 'waiting', 'error', 'idle'] as const) {
      await act(() =>
        client.emit({
          type: 'event',
          name: 'session.updated',
          eventId: `status-${status}`,
          timestamp: new Date().toISOString(),
          scope: {
            type: 'environment',
            environmentId: client.getState().environment!.environmentId,
          },
          payload: { sessionId: SESSION.sessionId, status },
        }),
      )
      expect(container.querySelector(`[role="img"][aria-label="${labels[status]}"]`)).not.toBeNull()
      expect(client.getState().activeSessionId).toBeNull()
      expect(Object.keys(client.getState().threads)).toHaveLength(0)
    }
  })

  it('marks sessions in an unavailable project without touching their status', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        ...SEEDED_HISTORY,
        workspaces: [{ ...WORKSPACE, exists: false, availability: 'missing' }],
      },
    })
    await render(<App client={client} />)
    // The row keeps the status the environment owns and gains the folder
    // warning; the badge on the project header is the only other change.
    expect(container.querySelector('[aria-label="Project folder unavailable"]')).not.toBeNull()
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('idle')
  })

  it('renders the sidebar, the empty-chat landing and a disabled composer', async () => {
    const client = createMockEnvironmentClient({ seed: SEEDED_HISTORY })
    await render(<App client={client} />)
    expect(container.textContent).toContain('repo')
    expect(container.textContent).toContain('First')
    // No session and no draft: the landing invites a workspace pick.
    expect(container.textContent).toContain("Let's build in")
    expect(container.querySelector('textarea')?.disabled).toBe(true)
  })

  it('names the environment on the sidebar, its session rows, the landing and the project picker', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, environment: { environmentId: 'env-1', name: 'devbox' } },
    })
    await render(<App client={client} />)
    const labels = () =>
      [...container.querySelectorAll('span.sr-only')].filter(
        (node) => node.textContent === 'Sessions run on ',
      )
    // Beside the Projects heading and under the landing headline.
    expect(labels()).toHaveLength(2)
    expect(labels()[0]!.nextElementSibling?.textContent).toBe('devbox')
    expect(buttonWithText('First')!.textContent).toContain('First on devbox')

    await act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!.click(),
    )
    // The picker menu portals to the body; its footer names the environment too.
    const menu = document.body.querySelector('[role="listbox"][aria-label="Choose a project"]')
    expect(menu?.textContent).toContain('Sessions run on devbox')
  })

  it('shows the workspace icon the environment resolves and falls back when it has none', async () => {
    const other = { ...WORKSPACE, workspaceId: 'C:/other', path: 'C:/other', name: 'other' }
    const icon = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
    const client = createMockEnvironmentClient({
      seed: { workspaces: [WORKSPACE, other], workspaceIcons: { [WORKSPACE.workspaceId]: icon } },
    })
    await render(<App client={client} />)
    await settle(client)
    // The sidebar row and the landing's workspace pick both show it; the
    // workspace without one keeps its folder glyph instead of a broken image.
    const images = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(images.length).toBeGreaterThan(0)
    expect(new Set(images)).toEqual(new Set([icon]))
    const asked = client.calls
      .filter((call) => call.command === 'resolveWorkspaceIcon')
      .map((call) => call.input)
    expect(new Set(asked)).toEqual(new Set([WORKSPACE.workspaceId, other.workspaceId]))
  })

  it('renders folder icons when the environment cannot resolve workspace icons', async () => {
    const client = createMockEnvironmentClient({
      seed: SEEDED_HISTORY,
      capabilities: ['listWorkspaces', 'listSessions', 'createSession', 'openSession'],
    })
    await render(<App client={client} />)
    await settle(client)
    expect(container.textContent).toContain('repo')
    expect(container.querySelector('img')).toBeNull()
    expect(client.calls.some((call) => call.command === 'resolveWorkspaceIcon')).toBe(false)
  })

  it('nests a session that names a parent under it in the sidebar', async () => {
    const child = {
      sessionId: 'session-2',
      workspaceId: WORKSPACE.workspaceId,
      title: 'Subagent run',
      parentSessionId: SESSION.sessionId,
    }
    const client = createMockEnvironmentClient({
      seed: {
        ...SEEDED_HISTORY,
        sessions: [
          ...SEEDED_HISTORY.sessions!,
          { session: child, threads: [{ threadId: 'thread-2', sessionId: child.sessionId }] },
        ],
      },
    })
    await render(<App client={client} />)
    await settle(client)
    // `parentSessionId` reaches the sidebar as `parentExternalId`, which is what
    // indents the row and marks it as a subagent transcript.
    expect(container.textContent).toContain('SUBAGENT')
    const row = buttonWithText('Subagent run')!.closest('div[style]') as HTMLElement
    expect(row.style.paddingLeft).toBe('20px')
    expect((buttonWithText('First')!.closest('div[style]') as HTMLElement).style.paddingLeft).toBe(
      '8px',
    )
  })

  it('opens a session from the sidebar and shows its mocked message list', async () => {
    const client = createMockEnvironmentClient({ seed: SEEDED_HISTORY })
    await render(<App client={client} />)
    await act(() => buttonWithText('First')!.click())
    await settle(client)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(container.textContent).toContain('What changed?')
    expect(container.textContent).toContain('Two files were edited.')
    expect(container.querySelector('textarea')?.disabled).toBe(false)
  })

  it('shows the context meter once the session reports usage, and not before', async () => {
    const client = createMockEnvironmentClient({ seed: SEEDED_HISTORY })
    await render(<App client={client} />)
    await act(() => buttonWithText('First')!.click())
    await settle(client)
    const meter = () => container.querySelector('[aria-label^="Context window"]')
    // A provider that reports no usage (Cursor) stays here: no meter at all.
    expect(meter()).toBeNull()

    client.emit({
      type: 'event',
      eventId: 'session-usage',
      timestamp: new Date().toISOString(),
      name: 'session.composer.updated',
      scope: { type: 'environment', environmentId: 'mock-environment' },
      payload: {
        sessionId: SESSION.sessionId,
        composer: { usage: { used: 50_000, size: 200_000 } },
      },
    })
    await settle(client)
    expect(meter()?.getAttribute('aria-label')).toBe('Context window 25% full')
  })

  it('loads an older history page through the chat and prevents duplicate clicks', async () => {
    const mock = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
    })
    const initial = mock.getState()
    const store = createEnvironmentStore({
      ...initial,
      threads: {
        ...initial.threads,
        [THREAD.threadId]: { ...initial.threads[THREAD.threadId]!, historyCursor: { ordinal: 2 } },
      },
    })
    let release: ((page: SessionHistoryPage) => void) | undefined
    const load = vi.fn(async () => {
      const page = await new Promise<SessionHistoryPage>((resolve) => {
        release = resolve
      })
      store.update((state) => applySessionHistory(state, THREAD, page, true))
      return page
    })
    const client = {
      ...mock,
      getState: store.getState,
      subscribe: store.subscribe,
      commands: { ...mock.commands, loadSessionHistory: load },
    }
    await render(<App client={client} />)
    await act(() => {
      buttonWithText('Load older messages')!.click()
      buttonWithText('Load older messages')!.click()
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith({ ...THREAD, cursor: { ordinal: 2 } })
    expect(buttonWithText('Loading older messages')?.disabled).toBe(true)
    await act(() =>
      release!({
        messages: [
          {
            messageId: 'older-user',
            threadId: THREAD.threadId,
            turnId: 'older-turn',
            role: 'user',
            content: [{ type: 'text', text: 'An earlier question' }],
          },
        ],
        turns: [{ turnId: 'older-turn', threadId: THREAD.threadId, state: 'completed' }],
        interactions: [],
        nextCursor: null,
      }),
    )
    expect(container.textContent).toContain('An earlier question')
    expect(occurrences('What changed?')).toBe(1)
    expect(occurrences('Two files were edited.')).toBe(1)
    expect(buttonWithText('Load older messages')).toBeUndefined()
    mock.dispose()
  })

  it('starts a session from a draft and streams the reply through the composer', async () => {
    const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    await render(<App client={client} />)
    await act(() => button('New Agent')!.click())
    expect(container.textContent).toContain('Start with a message below')
    expect(container.querySelector('textarea')?.disabled).toBe(false)

    await type('hello there')
    await act(() => button('Send')!.click())
    await settle(client)

    const commands = client.calls.map((call) => call.command)
    expect(commands).toEqual(expect.arrayContaining(['createSession', 'openSession']))
    expect(commands).not.toContain('sendTurn')
    expect(client.calls.find((call) => call.command === 'createSession')?.input).toEqual({
      environmentId: 'mock-environment',
      workspaceId: WORKSPACE.workspaceId,
      providerId: 'opencode',
      firstMessage: 'hello there',
    })
    expect(client.getState().activeSessionId).not.toBeNull()
    expect(container.textContent).toContain('hello there')
    expect(container.textContent).toContain('You said: hello there')
    expect(button('Stop')).toBeNull()
  })

  it('shows Stop while a turn runs and interrupts it through the client', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    await type('slow')
    await act(() => button('Send')!.click())
    await settle(client)
    expect(button('Stop')).not.toBeNull()
    await act(() => button('Stop')!.click())
    await settle(client)
    expect(button('Stop')).toBeNull()
    expect(client.getState().threads[THREAD.threadId]?.turns.at(-1)?.state).toBe('interrupted')
  })

  it('answers a permission request from the fallback card', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text: 'run tests' }))
    await act(() =>
      client.requestInteraction(
        { ...THREAD, turnId: turn.turnId },
        {
          kind: 'permission',
          interactionId: 'perm-1',
          toolCall: { toolCallId: 'tool-1', title: 'pnpm test' },
          options: [
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          ],
        },
      ),
    )
    expect(container.textContent).toContain('pnpm test')
    await act(() => buttonWithText('Allow')!.click())
    await settle(client)
    const response = client.calls.find((call) => call.command === 'respondToInteraction')
    expect(response?.input).toMatchObject({
      response: { kind: 'permission', interactionId: 'perm-1', outcome: { optionId: 'allow' } },
    })
    expect(client.getState().threads[THREAD.threadId]?.interactions).toEqual([])
  })

  it('shows a pending question in the composer and a plan review chip', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text: 'decide' }))
    const target = { ...THREAD, turnId: turn.turnId }
    await act(() =>
      client.requestInteraction(target, {
        kind: 'question',
        interactionId: 'q-1',
        questions: [
          {
            questionId: 'framework',
            prompt: 'Which framework?',
            options: [{ optionId: 'react', label: 'React' }],
          },
        ],
      }),
    )
    expect(container.textContent).toContain('Which framework?')

    await act(() =>
      client.commands.respondToInteraction({
        ...THREAD,
        response: {
          kind: 'question',
          interactionId: 'q-1',
          outcome: {
            outcome: 'answered',
            answers: [{ questionId: 'framework', selectedOptionIds: ['react'] }],
          },
        },
      }),
    )
    await settle(client)
    await act(() =>
      client.requestInteraction(target, {
        kind: 'plan',
        interactionId: 'plan-1',
        name: 'Migrate the sidebar',
        markdown: 'Move it.',
        todos: [{ id: 'todo-1', content: 'Move the sidebar', status: 'pending' }],
        continuation: 'follow_up_turn',
      }),
    )
    expect(container.textContent).toContain('Migrate the sidebar')
    await act(() => buttonWithText('Build')!.click())
    await settle(client)
    const accepted = client.calls.filter((call) => call.command === 'respondToInteraction').at(-1)
    expect(accepted?.input).toMatchObject({
      response: { kind: 'plan', interactionId: 'plan-1', outcome: { outcome: 'accepted' } },
    })
  })

  it('echoes the sent prompt before any assistant tokens arrive', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      respond: () => null,
    })
    await render(<App client={client} />)
    await type('echo me')
    await act(() => button('Send')!.click())
    await settle(client)
    expect(container.textContent).toContain('echo me')
    expect(occurrences('echo me')).toBe(1)
    expect(container.textContent).not.toContain('You said:')
    expect(client.getState().threads[THREAD.threadId]?.messages).toHaveLength(3)
  })

  it('keeps a refused prompt on screen with its reason and retries it under one id', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
      capabilities: ['listWorkspaces', 'listSessions', 'openSession', 'createSession'],
    })
    await render(<App client={client} />)
    await type('echo me')
    await act(() => button('Send')!.click())
    await settle(client)
    expect(occurrences('echo me')).toBe(1)
    expect(container.textContent).toContain('Not sent: This environment does not support sendTurn.')

    await act(() => buttonWithText('Try again')!.click())
    await settle(client)
    const sends = client.calls.filter((call) => call.command === 'sendTurn')
    expect(sends).toHaveLength(2)
    expect(sends[1]!.input).toEqual(sends[0]!.input)
    // One row, one echo: the retry reused it instead of adding a second.
    expect(occurrences('echo me')).toBe(1)
    expect(client.getState().threads[THREAD.threadId]?.outbox).toHaveLength(1)
  })

  it.each(['completed', 'interrupted'] as const)(
    'streams one assistant message and stops its live indicators on %s',
    async (outcome) => {
      const client = createMockEnvironmentClient({
        seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
        respond: () => null,
      })
      await render(<App client={client} />)
      const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text: 'stream me' }))
      await settle(client)
      expect(container.textContent).toContain('stream me')
      expect(container.textContent).not.toContain('Tokens')

      const target = { ...THREAD, turnId: turn.turnId }
      await act(() => {
        client.streamAssistantText(target, 'Tok', 'assistant-stream')
      })
      expect(container.textContent).toContain('Tok')
      expect(container.textContent).not.toContain('Tokens')

      await act(() => {
        client.streamAssistantText(target, 'ens', 'assistant-stream')
      })
      expect(container.textContent).toContain('Tokens')
      expect(occurrences('Tokens')).toBe(1)
      expect(button('Stop')).not.toBeNull()
      expect(container.querySelector('[data-chat-view] .opacity-90')).not.toBeNull()
      await act(() => {
        if (outcome === 'completed') client.completeTurn(target)
        else button('Stop')!.click()
      })
      await settle(client)
      expect(button('Stop')).toBeNull()
      expect(container.querySelector('[data-chat-view] .opacity-90')).toBeNull()
      expect(occurrences('Tokens')).toBe(1)
      expect(
        client
          .getState()
          .threads[THREAD.threadId]?.messages.filter((message) => message.role === 'assistant'),
      ).toHaveLength(2)
    },
  )

  it('reconnects without duplicating the open session transcript', async () => {
    const client = createMockEnvironmentClient({
      seed: { ...SEEDED_HISTORY, activeSessionId: SESSION.sessionId },
    })
    await render(<App client={client} />)
    expect(occurrences('What changed?')).toBe(1)
    expect(occurrences('Two files were edited.')).toBe(1)

    await act(() => client.reconnect())
    expect(client.getState().connection.phase).toBe('connected')
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(occurrences('What changed?')).toBe(1)
    expect(occurrences('Two files were edited.')).toBe(1)
    expect(container.querySelectorAll('[data-chat-view]').length).toBe(1)

    await act(() =>
      client.emit({
        type: 'event',
        eventId: 'replay-started',
        timestamp: '2026-09-12T00:00:00.000Z',
        name: 'turn.started',
        scope: {
          type: 'thread',
          environmentId: 'mock-environment',
          sessionId: SESSION.sessionId,
          threadId: THREAD.threadId,
        },
        payload: {
          turn: { turnId: 'turn-1', threadId: THREAD.threadId, state: 'completed' },
          userMessage: {
            messageId: 'user-1',
            threadId: THREAD.threadId,
            turnId: 'turn-1',
            role: 'user',
            content: [{ type: 'text', text: 'What changed?' }],
          },
        },
      }),
    )
    expect(occurrences('What changed?')).toBe(1)
    expect(client.getState().threads[THREAD.threadId]?.messages).toHaveLength(2)
  })

  it('sends uploaded images by artifact id and previews them from the environment', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:attached')
    URL.revokeObjectURL = vi.fn()
    const client = createMockEnvironmentClient({
      seed: {
        ...SEEDED_HISTORY,
        activeSessionId: SESSION.sessionId,
        artifacts: { 'artifact-1': new Blob(['png'], { type: 'image/png' }) },
      },
      respond: () => null,
    })
    let send: ReturnType<typeof useActiveThreadState>['sendMessage'] | undefined
    function Probe() {
      send = useActiveThreadState().sendMessage
      return null
    }
    await render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <EnvironmentApplicationProviders collapsedWorkspaceStorage={null}>
            <ChatWorkspace />
            <Probe />
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>
      </ThemeProvider>,
    )
    await settle(client)
    await act(() =>
      send!('what is this?', [
        {
          id: 'artifact-1',
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: 3,
          previewUrl: 'blob:composer-draft',
        },
      ]),
    )
    await settle(client)

    expect(client.calls.find((call) => call.command === 'sendTurn')?.input).toMatchObject({
      text: 'what is this?',
      artifactIds: ['artifact-1'],
    })
    // The durable message names the artifact; the bubble reads its bytes
    // through the client instead of keeping the composer's local preview.
    expect(client.getState().threads[THREAD.threadId]?.messages.at(-1)?.content).toEqual([
      { type: 'text', text: 'what is this?' },
      expect.objectContaining({ type: 'artifact', artifactId: 'artifact-1' }),
    ])
    expect(
      container
        .querySelector('[data-chat-view] button[aria-label^="Preview"] img')
        ?.getAttribute('src'),
    ).toBe('blob:attached')
  })

  it('sends an image with no caption as its own turn', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:attached')
    URL.revokeObjectURL = vi.fn()
    const client = createMockEnvironmentClient({
      seed: {
        ...SEEDED_HISTORY,
        activeSessionId: SESSION.sessionId,
        artifacts: { 'artifact-1': new Blob(['png'], { type: 'image/png' }) },
      },
      respond: () => null,
    })
    let send: ReturnType<typeof useActiveThreadState>['sendMessage'] | undefined
    function Probe() {
      send = useActiveThreadState().sendMessage
      return null
    }
    await render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <EnvironmentApplicationProviders collapsedWorkspaceStorage={null}>
            <ChatWorkspace />
            <Probe />
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>
      </ThemeProvider>,
    )
    await settle(client)
    await act(() =>
      send!('   ', [
        {
          id: 'artifact-1',
          name: 'screenshot.png',
          mimeType: 'image/png',
          size: 3,
          previewUrl: 'blob:composer-draft',
        },
      ]),
    )
    await settle(client)

    expect(client.calls.find((call) => call.command === 'sendTurn')?.input).toMatchObject({
      text: '',
      artifactIds: ['artifact-1'],
    })
    // The message is the image; no empty text block travels with it.
    expect(client.getState().threads[THREAD.threadId]?.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ type: 'artifact', artifactId: 'artifact-1' }),
    ])
    expect(
      container
        .querySelector('[data-chat-view] button[aria-label^="Preview"] img')
        ?.getAttribute('src'),
    ).toBe('blob:attached')
  })

  it('does not wire a remote stream_chunks store or ownership-driven split', async () => {
    function Probe() {
      const stores = useActiveThreadStores()
      const { activeThreadDriven, remoteStreamingStore } = useActiveThreadState()
      return (
        <pre data-testid="overlay-probe">
          {JSON.stringify({
            activeThreadDriven,
            hasRemoteOnState: remoteStreamingStore != null,
            hasRemoteOnStores: stores.remoteStreamingStore != null,
          })}
        </pre>
      )
    }
    const client = createMockEnvironmentClient()
    await render(
      <ThemeProvider>
        <EnvironmentClientProvider client={client}>
          <EnvironmentApplicationProviders collapsedWorkspaceStorage={null}>
            <Probe />
          </EnvironmentApplicationProviders>
        </EnvironmentClientProvider>
      </ThemeProvider>,
    )
    expect(
      JSON.parse(container.querySelector('[data-testid="overlay-probe"]')!.textContent!),
    ).toEqual({
      activeThreadDriven: true,
      hasRemoteOnState: false,
      hasRemoteOnStores: false,
    })
  })

  it('routes Add project through the host callback', async () => {
    const addWorkspace = vi.fn(async () => undefined)
    const client = createMockEnvironmentClient()
    await render(<App client={client} addWorkspace={addWorkspace} />)
    await act(() => button('Add project')!.click())
    expect(addWorkspace).toHaveBeenCalledOnce()
  })
})
