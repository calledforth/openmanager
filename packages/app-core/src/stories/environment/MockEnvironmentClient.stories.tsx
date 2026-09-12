import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  createMockEnvironmentClient,
  type MockEnvironmentClient,
  type MockSeed,
} from '@openmanager/environment-client'
import { MockEnvironmentApp } from '../../testing/mock-environment-app'

const WORKSPACE = { workspaceId: '/workspace/openmanager', name: 'openmanager' }
const SECOND = { workspaceId: '/workspace/opencode.ref', name: 'opencode.ref' }
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
  return (
    <div className="relative h-screen w-screen">
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
