// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'

/** Tool rows replaced by a counting stub: one entry per render, by tool call. */
const toolRenders: string[] = []
vi.mock('../src/components/parts/ToolCallPart', () => ({
  ToolCallPart: ({ part }: { part: { id: string } }) => {
    toolRenders.push(part.id)
    return <div data-tool={part.id} />
  },
}))

const { MessageParts } = await import('../src/components/parts/MessageParts')
const { useActiveThreadState } = await import('../src/providers/active-thread-provider')
const { EnvironmentApplicationProviders } = await import('../src/providers/environment-application')
const { EnvironmentClientProvider } = await import('../src/providers/environment-client')
const { ThemeProvider } = await import('../src/providers/theme-provider')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  toolRenders.length = 0
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
const SEED: MockSeed = {
  workspaces: [WORKSPACE],
  activeSessionId: SESSION.sessionId,
  sessions: [{ session: SESSION, threads: [THREAD] }],
}

const flush = async () => {
  for (let round = 0; round < 6; round += 1) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  }
}

describe('the thread contract while a turn streams', () => {
  /** Stands in for the composer: it reads the contract for its commands. */
  let threadRenders = 0
  function ThreadReader() {
    useActiveThreadState()
    threadRenders += 1
    return null
  }

  const toolUpdated = (
    client: MockEnvironmentClient,
    turnId: string,
    toolCallId: string,
    status: 'in_progress' | 'completed',
  ) =>
    client.emit({
      type: 'event',
      eventId: `${toolCallId}:${status}`,
      timestamp: new Date().toISOString(),
      name: 'tool.updated',
      scope: {
        type: 'thread',
        environmentId: client.getState().environment!.environmentId,
        ...THREAD,
      },
      payload: { toolCallId, turnId, title: 'Read', kind: 'read', status },
    })

  it('is not handed to its readers again for tokens and tool calls', async () => {
    const client = createMockEnvironmentClient({ seed: SEED, respond: () => null })
    await act(() =>
      root.render(
        <ThemeProvider>
          <EnvironmentClientProvider client={client}>
            <EnvironmentApplicationProviders collapsedWorkspaceStorage={null}>
              <ThreadReader />
            </EnvironmentApplicationProviders>
          </EnvironmentClientProvider>
        </ThemeProvider>,
      ),
    )
    await flush()
    await act(() => client.commands.sendTurn({ ...THREAD, text: 'go' }))
    await flush()
    const turnId = client.getState().threads[THREAD.threadId]!.turns.at(-1)!.turnId

    // The first token names the reply's row; from there the list of rows is settled.
    let messageId = ''
    await act(() => {
      messageId = client.streamAssistantText({ ...THREAD, turnId }, 'one ')
    })
    await flush()

    threadRenders = 0
    await act(() => {
      client.streamAssistantText({ ...THREAD, turnId }, 'two ', messageId)
    })
    await act(() => toolUpdated(client, turnId, 'tool-1', 'in_progress'))
    await act(() => toolUpdated(client, turnId, 'tool-1', 'completed'))
    await act(() => toolUpdated(client, turnId, 'tool-2', 'in_progress'))
    await flush()
    expect(client.getState().threads[THREAD.threadId]!.tools).toHaveLength(2)
    expect(threadRenders).toBe(0)

    // The end of the turn is the contract's business: the composer frees up.
    await act(() => client.completeTurn({ ...THREAD, turnId }))
    await flush()
    expect(threadRenders).toBeGreaterThan(0)
  })
})

describe('the parts of a live turn', () => {
  const tool = (id: string, status: string) => ({
    type: 'tool',
    id,
    callID: id,
    tool: 'Fetch docs',
    state: { status },
  })

  it('renders only the part an event changed', async () => {
    const first = tool('tool-1', 'completed')
    const second = tool('tool-2', 'running')
    await act(() => root.render(<MessageParts parts={[first, second]} isStreaming />))
    expect(toolRenders).toEqual(['tool-1', 'tool-2'])

    // The next event finishes the second call and starts a third. The first
    // call is the object it was, as the projection keeps it.
    toolRenders.length = 0
    await act(() =>
      root.render(
        <MessageParts
          parts={[first, tool('tool-2', 'completed'), tool('tool-3', 'running')]}
          isStreaming
        />,
      ),
    )
    expect(toolRenders).toEqual(['tool-2', 'tool-3'])
  })

  it('leaves a whole run alone when the event lands outside it', async () => {
    const run = [tool('tool-1', 'completed'), tool('tool-2', 'completed')]
    const text = (value: string) => ({ type: 'text', id: 'text-1', text: value })
    await act(() => root.render(<MessageParts parts={[...run, text('Do')]} isStreaming />))
    toolRenders.length = 0
    await act(() => root.render(<MessageParts parts={[...run, text('Done')]} isStreaming />))
    expect(toolRenders).toEqual([])
    expect(container.textContent).toContain('Done')
  })
})
