import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
  type SessionHistoryPage,
  type SessionListPage,
} from '@openmanager/environment-client'
import { MockEnvironmentApp } from '../../testing/mock-environment-app'

const WORKSPACE = {
  workspaceId: '/workspace/openmanager',
  name: 'openmanager',
  path: '/workspace/openmanager',
  lastUsedAt: null,
  exists: true,
}
const SECOND = {
  workspaceId: '/workspace/opencode.ref',
  name: 'opencode.ref',
  path: '/workspace/opencode.ref',
  lastUsedAt: null,
  exists: true,
}
const SESSION = { sessionId: 'session-1', workspaceId: WORKSPACE.workspaceId, title: 'Typography system' }
const THREAD = { threadId: 'thread-1', sessionId: SESSION.sessionId }
const OTHER = { sessionId: 'session-2', workspaceId: WORKSPACE.workspaceId, title: 'Storybook view setup' }

const CANNED_HISTORY: MockSeed = {
  workspaces: [WORKSPACE, SECOND],
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
          content: [{ type: 'text', text: 'Why does the font look generic?' }],
        },
        {
          messageId: 'assistant-1',
          threadId: THREAD.threadId,
          turnId: 'turn-1',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Self-host the variable Inter file and enable ss03. Those two changes stop the browser-default look.',
            },
          ],
        },
      ],
    },
    {
      session: OTHER,
      threads: [{ threadId: 'thread-2', sessionId: OTHER.sessionId }],
    },
    {
      session: { sessionId: 'session-101', workspaceId: SECOND.workspaceId, title: 'Reference audit' },
      threads: [{ threadId: 'thread-101', sessionId: 'session-101' }],
    },
  ],
}

const meta = {
  title: 'App/MockEnvironmentClient',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

function useStoryClient(create: () => MockEnvironmentClient): MockEnvironmentClient {
  const ref = useRef<MockEnvironmentClient | null>(null)
  if (ref.current === null) ref.current = create()
  useEffect(() => () => ref.current?.dispose(), [])
  return ref.current
}

function StoryShell({
  client,
  children,
}: {
  client: MockEnvironmentClient
  children?: ReactNode
}) {
  useEffect(() => {
    const root = document.documentElement
    const previous = root.dataset.uiFont
    root.dataset.uiFont = 'system'
    return () => {
      if (previous === undefined) delete root.dataset.uiFont
      else root.dataset.uiFont = previous
    }
  }, [])
  return (
    <div
      className="relative h-screen w-screen"
      style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
    >
      <MockEnvironmentApp client={client} />
      {children}
    </div>
  )
}

function ReconnectChip({ client }: { client: MockEnvironmentClient }) {
  const [phase, setPhase] = useState(client.getState().connection.phase)
  useEffect(() => client.subscribe(() => setPhase(client.getState().connection.phase)), [client])
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-30 flex items-center gap-2">
      <span className="pointer-events-none rounded border border-border bg-card px-2 py-1 text-11-regular text-muted-foreground">
        {phase}
      </span>
      <button
        type="button"
        className="pointer-events-auto rounded border border-border bg-card px-2 py-1 text-11-regular text-muted-foreground hover:bg-surface-hover"
        onClick={() => client.reconnect()}
      >
        Reconnect
      </button>
    </div>
  )
}

function SessionListStory() {
  const client = useStoryClient(() => createMockEnvironmentClient({ seed: CANNED_HISTORY }))
  return <StoryShell client={client} />
}

function OpenSessionStory() {
  const client = useStoryClient(() =>
    createMockEnvironmentClient({ seed: { ...CANNED_HISTORY, activeSessionId: SESSION.sessionId } }),
  )
  return <StoryShell client={client} />
}

function StreamingTurnStory() {
  const client = useStoryClient(() =>
    createMockEnvironmentClient({
      seed: { ...CANNED_HISTORY, activeSessionId: SESSION.sessionId },
      chunkDelayMs: 80,
      respond: () => [
        'Tokens ',
        'arrive ',
        'one ',
        'chunk ',
        'at a time, ',
        'then the turn completes.',
      ],
    }),
  )
  useEffect(() => {
    void client.commands.sendTurn({ ...THREAD, text: 'Stream a short reply.' })
  }, [client])
  return <StoryShell client={client} />
}

function InteractiveStory() {
  const client = useStoryClient(() =>
    createMockEnvironmentClient({
      seed: { ...CANNED_HISTORY, activeSessionId: SESSION.sessionId },
      chunkDelayMs: 50,
    }),
  )
  return (
    <StoryShell client={client}>
      <ReconnectChip client={client} />
    </StoryShell>
  )
}

const PAGINATED_SEED: MockSeed = {
  workspaces: [WORKSPACE],
  sessions: [
    {
      session: { sessionId: 'session-alpha', workspaceId: WORKSPACE.workspaceId, title: 'Typography system' },
      providerId: 'opencode',
      updatedAt: '2026-09-14T04:05:00.000Z',
      threads: [{ threadId: 'thread-alpha', sessionId: 'session-alpha' }],
      turns: [{ turnId: 'turn-alpha', threadId: 'thread-alpha', state: 'completed' }],
      messages: [
        {
          messageId: 'alpha-user',
          threadId: 'thread-alpha',
          turnId: 'turn-alpha',
          role: 'user',
          content: [{ type: 'text', text: 'Why does the font look generic?' }],
        },
        {
          messageId: 'alpha-assistant',
          threadId: 'thread-alpha',
          turnId: 'turn-alpha',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Self-host the variable Inter file and enable ss03.',
            },
          ],
        },
      ],
    },
    {
      session: { sessionId: 'session-beta', workspaceId: WORKSPACE.workspaceId, title: 'Streaming bug fix' },
      providerId: 'cursor',
      status: 'idle',
      updatedAt: '2026-09-14T04:04:00.000Z',
      threads: [{ threadId: 'thread-beta', sessionId: 'session-beta' }],
    },
    {
      session: { sessionId: 'session-gamma', workspaceId: WORKSPACE.workspaceId, title: 'Permission flow QA' },
      providerId: 'opencode',
      updatedAt: '2026-09-14T04:03:00.000Z',
      threads: [{ threadId: 'thread-gamma', sessionId: 'session-gamma' }],
    },
    {
      session: { sessionId: 'session-delta', workspaceId: WORKSPACE.workspaceId, title: 'Composer toolbar' },
      providerId: 'cursor',
      updatedAt: '2026-09-14T04:02:00.000Z',
      threads: [{ threadId: 'thread-delta', sessionId: 'session-delta' }],
    },
    {
      session: { sessionId: 'session-epsilon', workspaceId: WORKSPACE.workspaceId, title: 'Theme token audit' },
      providerId: 'opencode',
      updatedAt: '2026-09-14T04:01:00.000Z',
      threads: [{ threadId: 'thread-epsilon', sessionId: 'session-epsilon' }],
    },
  ],
}

function stripSummary(session: SessionListPage['sessions'][number]) {
  return {
    sessionId: session.sessionId,
    title: session.title,
    status: session.status,
    workspaceId: session.workspaceId,
    providerId: session.providerId,
    updatedAt: session.updatedAt,
  }
}

function PaginatedCatalogStory() {
  const client = useStoryClient(() => createMockEnvironmentClient({ seed: PAGINATED_SEED }))
  const [listPage, setListPage] = useState<SessionListPage | null>(null)
  const [historyPage, setHistoryPage] = useState<SessionHistoryPage | null>(null)
  const [opened, setOpened] = useState<{ sessionId: string; threads: string[] } | null>(null)

  const loadListPage = async (cursor?: SessionListPage['nextCursor']) => {
    const page = await client.commands.listSessions({ limit: 2, cursor: cursor ?? undefined })
    setListPage(page)
    setHistoryPage(null)
  }

  const openSelected = async (sessionId: string) => {
    await client.commands.openSession(sessionId)
    const session = client.getState().sessions[sessionId]
    const threadId = session?.threadIds[0]
    setOpened({ sessionId, threads: session?.threadIds ?? [] })
    if (threadId) {
      setHistoryPage(await client.commands.loadSessionHistory({ sessionId, threadId, limit: 10 }))
    }
  }

  return (
    <StoryShell client={client}>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 p-3">
        <div
          className="pointer-events-auto mx-auto max-w-5xl rounded-lg border border-border bg-card/95 p-3 shadow-lg backdrop-blur"
          style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
        >
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-12-medium text-foreground">CAL-56 catalog</p>
            <button
              type="button"
              className="rounded border border-border bg-background px-2 py-1 text-11-regular hover:bg-surface-hover"
              onClick={() => void loadListPage()}
            >
              Load page 1 (limit 2)
            </button>
            <button
              type="button"
              className="rounded border border-border bg-background px-2 py-1 text-11-regular hover:bg-surface-hover disabled:opacity-40"
              disabled={!listPage?.nextCursor}
              onClick={() => void loadListPage(listPage?.nextCursor)}
            >
              Load next page
            </button>
            <button
              type="button"
              className="rounded border border-border bg-background px-2 py-1 text-11-regular hover:bg-surface-hover"
              onClick={() => void openSelected('session-alpha')}
            >
              Open Typography system
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <pre
              className="max-h-44 overflow-auto rounded bg-background p-2 text-11-regular text-muted-foreground"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
            >
              {listPage
                ? `session.list\n${JSON.stringify(
                    {
                      sessions: listPage.sessions.map(stripSummary),
                      nextCursor: listPage.nextCursor,
                    },
                    null,
                    2,
                  )}`
                : 'session.list — sidebar rows are summaries only. Fetch a page to inspect the payload.'}
            </pre>
            <pre
              className="max-h-44 overflow-auto rounded bg-background p-2 text-11-regular text-muted-foreground"
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
            >
              {opened
                ? `session.open ${JSON.stringify({ session: opened.sessionId, threads: opened.threads, messages: undefined })}\n\nsession.history\n${JSON.stringify(
                    historyPage && {
                      messages: historyPage.messages.map((message) => ({
                        role: message.role,
                        text:
                          message.content[0] && 'text' in message.content[0]
                            ? message.content[0].text
                            : '',
                      })),
                      nextCursor: historyPage.nextCursor,
                    },
                    null,
                    2,
                  )}`
                : 'session.open / session.history — open a session to load the transcript separately.'}
            </pre>
          </div>
        </div>
      </div>
    </StoryShell>
  )
}

export const SessionList: Story = {
  name: 'Session list',
  render: () => <SessionListStory />,
}

export const OpenSession: Story = {
  name: 'Open session',
  render: () => <OpenSessionStory />,
}

export const StreamingTurn: Story = {
  name: 'Streaming turn',
  render: () => <StreamingTurnStory />,
}

export const Interactive: Story = {
  name: 'Interactive',
  render: () => <InteractiveStory />,
}

export const PaginatedCatalog: Story = {
  name: 'Paginated catalog',
  render: () => <PaginatedCatalogStory />,
}
