// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type ThreadState,
} from '@openmanager/environment-client'
import {
  EnvironmentClientProvider,
  useActiveSession,
  useActiveThread,
  useActiveTurn,
  useConnectionState,
  useEnvironmentCommands,
  usePendingInteractions,
  useSessionsByWorkspace,
} from '../src/providers/environment-client'
import { WorkspaceSidebarView } from '../src/components/sidebar/WorkspaceSidebarView'
import { MessageInputView } from '../src/components/chat/MessageInputView'
import { AssistantMessage, ChatViewPanel, UserMessage } from '../src/components/chat/ChatViewPrimitives'
import { ThemeProvider } from '../src/providers/theme-provider'

const WORKSPACE = { workspaceId: 'C:/repo', name: 'repo' }
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'First' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }

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
const settle = (client: MockEnvironmentClient) => act(() => client.settle())

const textOf = (message: ThreadState['messages'][number]) =>
  message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')

function Sidebar() {
  const groups = useSessionsByWorkspace()
  const active = useActiveSession()
  const commands = useEnvironmentCommands()
  return (
    <WorkspaceSidebarView
      collapsed={false}
      workspaces={groups.map(({ workspace, sessions }) => ({
        path: workspace.workspaceId,
        name: workspace.name,
        sessions: sessions.map((session) => ({
          externalId: session.sessionId,
          title: session.title ?? undefined,
          status: session.status,
        })),
      }))}
      activeWorkspacePath={active?.workspaceId ?? null}
      activeSessionId={active?.sessionId ?? null}
      collapsedWorkspacePaths={[]}
      onToggleWorkspaceCollapse={() => undefined}
      onCreateSession={(workspaceId) => void commands.createSession({ workspaceId })}
      onSelectSession={(_workspace, sessionId) => void commands.openSession(sessionId)}
      onDeleteSession={(_workspace, sessionId) => void commands.deleteSession(sessionId)}
      onAddWorkspace={() => undefined}
    />
  )
}

function Chat() {
  const thread = useActiveThread()
  const turn = useActiveTurn()
  return (
    <ChatViewPanel>
      <div data-testid="messages">
        {thread?.messages.map((message) =>
          message.role === 'user' ? (
            <UserMessage key={message.messageId} content={textOf(message)} />
          ) : (
            <AssistantMessage
              key={message.messageId}
              content={textOf(message)}
              isFinal={turn?.turnId !== message.turnId}
            />
          ),
        )}
      </div>
      <output data-testid="pending">{usePendingInteractions().length}</output>
    </ChatViewPanel>
  )
}

function Composer() {
  const commands = useEnvironmentCommands()
  const session = useActiveSession()
  const thread = useActiveThread()
  const turn = useActiveTurn()
  const connection = useConnectionState()
  return (
    <MessageInputView
      disabled={!thread || connection.phase !== 'connected'}
      pendingDraftSessionStart={false}
      activeWorkspacePath={session?.workspaceId ?? null}
      activeSessionId={session?.sessionId ?? null}
      isSessionDraftOpen={false}
      providerReady={connection.phase === 'connected'}
      currentProviderId="opencode"
      providerModelGroups={[]}
      currentModelId=""
      configOptions={[]}
      modeOptions={[]}
      effortLevels={[]}
      currentEffort=""
      currentModeId=""
      canChangeSettings={false}
      canChangeProvider={false}
      showModeControl={false}
      showModelControl={false}
      isStreaming={turn !== null}
      draftKey={thread?.thread.threadId ?? 'none'}
      imageUploadEnabled={false}
      imageSupportMessage={null}
      onModeChange={() => undefined}
      onProviderModelChange={() => undefined}
      onConfigOptionChange={() => undefined}
      onSend={async (text) => {
        if (!thread) return
        await commands.sendTurn({ ...thread.thread, text })
      }}
      onAbort={() => {
        if (thread && turn) void commands.interruptTurn({ ...thread.thread, turnId: turn.turnId })
      }}
    />
  )
}

function App({ client }: { client: MockEnvironmentClient }) {
  return (
    <ThemeProvider>
      <EnvironmentClientProvider client={client}>
        <Sidebar />
        <Chat />
        <Composer />
      </EnvironmentClientProvider>
    </ThemeProvider>
  )
}

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const sessionButtons = () =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].filter((node) =>
    node.textContent?.includes('session') || node.textContent?.includes('First'),
  )
const type = async (text: string) => {
  const textarea = container.querySelector('textarea')!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(() => {
    setter.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('mock environment client drives the shared UI', () => {
  it('renders sessions in the sidebar and opens one from the mock state', async () => {
    const client = createMockEnvironmentClient({
      seed: { workspaces: [WORKSPACE], sessions: [{ session: SESSION, threads: [THREAD] }] },
    })
    await render(<App client={client} />)
    expect(container.textContent).toContain('repo')
    expect(container.textContent).toContain('First')

    const row = [...container.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('First'),
    )!
    await act(() => row.click())
    await settle(client)
    expect(client.getState().activeSessionId).toBe(SESSION.sessionId)
    expect(client.calls.map((call) => call.command)).toContain('openSession')
  })

  it('creates a session from the sidebar and streams a reply through the composer', async () => {
    const client = createMockEnvironmentClient({ seed: { workspaces: [WORKSPACE] } })
    await render(<App client={client} />)
    expect(sessionButtons()).toHaveLength(0)

    await act(() => button('New Agent')!.click())
    await settle(client)
    const created = client.getState().sessionOrder[0]!
    await act(() => client.commands.openSession(created))
    await settle(client)
    expect(container.querySelector('textarea')).not.toBeNull()

    await type('hello there')
    await act(() => button('Send')!.click())
    await settle(client)

    const messages = container.querySelector('[data-testid="messages"]')!
    expect(messages.textContent).toContain('hello there')
    expect(messages.textContent).toContain('You said: hello there')
    expect(client.getState().sessions[created]?.status).toBe('idle')
    expect(button('Stop')).toBeNull()
  })

  it('shows Stop while streaming and interrupts through the client', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        workspaces: [WORKSPACE],
        sessions: [{ session: SESSION, threads: [THREAD] }],
        activeSessionId: SESSION.sessionId,
      },
      respond: () => null,
    })
    await render(<App client={client} />)
    await type('slow')
    await act(() => button('Send')!.click())
    await settle(client)
    expect(button('Stop')).not.toBeNull()
    expect(container.textContent).toContain('slow')

    await act(() => button('Stop')!.click())
    await settle(client)
    expect(button('Stop')).toBeNull()
    expect(client.getState().threads[THREAD.threadId]?.turns[0]?.state).toBe('interrupted')
  })

  it('surfaces pending interactions and clears them when resolved', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        workspaces: [WORKSPACE],
        sessions: [{ session: SESSION, threads: [THREAD] }],
        activeSessionId: SESSION.sessionId,
      },
      respond: () => null,
    })
    await render(<App client={client} />)
    const { turn } = await act(() => client.commands.sendTurn({ ...THREAD, text: 'run tests' }))
    const pending = () => container.querySelector('[data-testid="pending"]')!.textContent
    expect(pending()).toBe('0')

    await act(() =>
      client.requestInteraction(
        { ...THREAD, turnId: turn.turnId },
        {
          kind: 'permission',
          interactionId: 'perm-1',
          toolCall: { toolCallId: 'tool-1', title: 'pnpm test' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      ),
    )
    expect(pending()).toBe('1')
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('waiting')

    await act(() =>
      client.commands.respondToInteraction({
        ...THREAD,
        response: {
          kind: 'permission',
          interactionId: 'perm-1',
          outcome: { outcome: 'selected', optionId: 'allow' },
        },
      }),
    )
    expect(pending()).toBe('0')
    expect(client.getState().sessions[SESSION.sessionId]?.status).toBe('running')
  })

  it('disables the composer when the connection drops and re-enables on reconnect', async () => {
    const client = createMockEnvironmentClient({
      seed: {
        workspaces: [WORKSPACE],
        sessions: [{ session: SESSION, threads: [THREAD] }],
        activeSessionId: SESSION.sessionId,
      },
    })
    await render(<App client={client} />)
    expect(container.querySelector('textarea')?.disabled).toBe(false)
    await act(() => client.setConnection({ phase: 'reconnecting' }))
    expect(container.querySelector('textarea')?.disabled).toBe(true)
    await act(() => client.setConnection({ phase: 'connected' }))
    expect(container.querySelector('textarea')?.disabled).toBe(false)
  })
})
