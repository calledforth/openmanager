import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { MockEnvironmentClient } from '@openmanager/environment-client'
import type { Subagent } from '@openmanager/protocol'
import { MockEnvironmentApp } from '../../testing/mock-environment-app'
import { ChatViewPanel, AssistantMessage } from '../../components/chat/ChatViewPrimitives'
import { DelegatedPrompt, SubagentsFinishedNotice } from '../../components/chat/TurnOriginRows'
import {
  SubagentReadOnlyFooter,
  SubagentSessionHeaderView,
  subagentIdentity,
} from '../../components/chat/SubagentSession'
import { subagentPart } from '../../components/parts/subagent-card'
import { ThemeProvider } from '../../providers/theme-provider'
import { TooltipProvider } from '../../components/fluid/ui/tooltip'
import { CHILD, PARENT, PARENT_SUBAGENTS, createSubagentsClient } from './fixtures'

type Scheme = 'dark' | 'light'

const meta = {
  title: 'App/Subagents',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  argTypes: { scheme: { control: 'inline-radio', options: ['dark', 'light'] } },
  args: { scheme: 'dark' as Scheme },
} satisfies Meta<{ scheme: Scheme }>

export default meta
type Story = StoryObj<{ scheme: Scheme }>

/** The appearance the app's own ThemeProvider reads, set before it mounts. */
function useScheme(scheme: Scheme) {
  useState(() => {
    try {
      localStorage.setItem(
        'openmanager-appearance',
        JSON.stringify({ mode: scheme, family: 'default' }),
      )
    } catch {
      /* ignore */
    }
    return null
  })
}

function useStoryClient(create: () => MockEnvironmentClient): MockEnvironmentClient {
  const ref = useRef<MockEnvironmentClient | null>(null)
  if (ref.current === null) ref.current = create()
  useEffect(() => () => ref.current?.dispose(), [])
  return ref.current
}

/** The whole app (sidebar, chat, composer) over the subagents environment, `sessionId` open. */
function App({ scheme, sessionId }: { scheme: Scheme; sessionId: string }) {
  useScheme(scheme)
  const client = useStoryClient(() => createSubagentsClient(sessionId))
  return (
    <div className="relative h-screen w-screen">
      <MockEnvironmentApp client={client} />
    </div>
  )
}

const app = (sessionId: string): Story => ({
  render: ({ scheme }) => <App scheme={scheme} sessionId={sessionId} />,
})

/**
 * The parent chat: native subagents done and failed, three spawned on other
 * providers in the background, the notice that woke the agent when two
 * finished, and a live turn with one subagent running and one waiting on a
 * permission. The queue holds the next wake-up beside a message the user sent.
 */
export const ParentChat: Story = { name: 'Parent chat', ...app(PARENT) }

/** A Claude subagent's page: the parent's prompt, its work, and no composer. */
export const ChildReadOnly: Story = { name: 'Child: read-only', ...app(CHILD.callers) }

/** A subagent spawned on Cursor: an ordinary session the user can prompt. */
export const ChildPromptable: Story = { name: 'Child: promptable', ...app(CHILD.rotate) }

/** A subagent waiting on a permission: asked and answered on its own page. */
export const ChildWaiting: Story = { name: 'Child: waiting', ...app(CHILD.staging) }

/** A subagent that started its own: its card in the child page, nested twice in the sidebar. */
export const ChildNested: Story = { name: 'Child: nested', ...app(CHILD.mobile) }

// ─── Pieces, without an environment ─────────────────────────────────────────

function Frame({ scheme, children }: { scheme: Scheme; children: ReactNode }) {
  useScheme(scheme)
  return (
    <ThemeProvider>
      <TooltipProvider>
        <div className="h-screen w-screen overflow-y-auto bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
          <ChatViewPanel>
            <div className="mx-auto w-full max-w-[48rem] px-4 py-6">{children}</div>
          </ChatViewPanel>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  )
}

const byId = (id: string) => PARENT_SUBAGENTS.find((item) => item.subagentId === id)!
const card = (subagent: Subagent) => subagentPart(subagent)

/** Every state a card takes, one card each, then a group of three. */
export const Cards: Story = {
  render: ({ scheme }) => (
    <Frame scheme={scheme}>
      <AssistantMessage
        content=""
        isFinal={false}
        parts={[
          card(byId('sa-mobile')),
          { type: 'text', id: 't1', text: '' },
          card(byId('sa-staging')),
          { type: 'text', id: 't2', text: '' },
          card(byId('sa-callers')),
          { type: 'text', id: 't3', text: '' },
          card(byId('sa-tests')),
          { type: 'text', id: 't4', text: '' },
          card(byId('sa-rotate')),
          card(byId('sa-scrub')),
          card(byId('sa-cookie')),
        ]}
      />
    </Frame>
  ),
}

/** The notice row that opens a turn the environment began, and the delegated prompt. */
export const OriginRows: Story = {
  name: 'Origin rows',
  render: ({ scheme }) => (
    <Frame scheme={scheme}>
      <SubagentsFinishedNotice
        content={
          'Subagents finished: Scrub tokens from request logs (completed), Set SameSite=Strict on the session cookie (completed).\n\nRequest logs now redact tokens.'
        }
      />
      <DelegatedPrompt
        from={{ providerId: 'claude', sessionTitle: 'Harden session authentication' }}
        content="Find every caller of `verifySession` in apps/server. For each, say where the token comes from (cookie, header, query) and whether it can end up in a log."
      />
      <div className="mt-10">
        <SubagentSessionHeaderView
          parentTitle="Harden session authentication"
          identity={subagentIdentity(
            {
              title: 'Audit token storage',
              providerId: 'claude',
              status: 'running',
            },
            byId('sa-mobile'),
          )}
          onBack={() => undefined}
        />
      </div>
      <div className="mt-6">
        <SubagentReadOnlyFooter
          parentTitle="Harden session authentication"
          onOpenParent={() => undefined}
        />
      </div>
    </Frame>
  ),
}
