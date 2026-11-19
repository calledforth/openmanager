import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { MockEnvironmentClient } from '@openmanager/environment-client'
import type { Subagent } from '@openmanager/protocol'
import { MockEnvironmentApp } from '../../testing/mock-environment-app'
import { ChatViewPanel, AssistantMessage } from '../../components/chat/ChatViewPrimitives'
import { DelegatedPrompt, SubagentsFinishedNotice } from '../../components/chat/TurnOriginRows'
import { SessionTrail } from '../../components/chat/SessionTrail'
import { SubagentReadOnlyFooter, subagentIdentity } from '../../components/chat/SubagentSession'
import { SidebarInsetTopbar } from '../../components/fluid/sidebar-app/inset-topbar'
import { SubagentCard, SubagentGroup } from '../../components/parts/SubagentCard'
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

/**
 * The whole app (sidebar, title bar trail, chat, composer) over the subagents
 * environment, `sessionId` open.
 */
function App({ scheme, sessionId }: { scheme: Scheme; sessionId: string }) {
  useScheme(scheme)
  const client = useStoryClient(() => createSubagentsClient(sessionId))
  return (
    <div className="relative h-screen w-screen">
      <MockEnvironmentApp
        client={client}
        header={
          <SidebarInsetTopbar>
            <SessionTrail />
          </SidebarInsetTopbar>
        }
      />
    </div>
  )
}

const app = (sessionId: string): Story => ({
  render: ({ scheme }) => <App scheme={scheme} sessionId={sessionId} />,
})

/**
 * The parent chat: native subagents done and failed, three spawned on other
 * providers in the background folded into one group, the notice that woke the
 * agent when two finished, and a live turn with one subagent running and one
 * waiting on a permission. In the sidebar the parent has one card, with its
 * subagents counted beside its provider.
 */
export const ParentChat: Story = { name: 'Parent chat', ...app(PARENT) }

/**
 * A Claude subagent's page: the title bar trail runs project / parent /
 * subagent, the parent a link back; the footer says only the parent agent
 * can reach it, and what it ran on and for how long.
 */
export const ChildReadOnly: Story = { name: 'Child: read-only', ...app(CHILD.callers) }

/** A subagent spawned on Cursor: an ordinary session the user can prompt. */
export const ChildPromptable: Story = { name: 'Child: promptable', ...app(CHILD.rotate) }

/** A subagent waiting on a permission: asked and answered on its own page. */
export const ChildWaiting: Story = { name: 'Child: waiting', ...app(CHILD.staging) }

/** A subagent that started its own: its card in the child page. */
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

function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 mb-1.5 text-ui-xs tracking-wide text-[var(--basis-text-faint)] uppercase first:mt-0">
      {children}
    </div>
  )
}

const byId = (id: string) => PARENT_SUBAGENTS.find((item) => item.subagentId === id)!
const card = (subagent: Subagent) => subagentPart(subagent)

/** Every state one card takes, alone: a single row each. */
const LONE: Subagent[] = [
  byId('sa-mobile'),
  byId('sa-staging'),
  {
    ...byId('sa-staging'),
    subagentId: 'sa-question',
    title: 'Pick the cookie domain for staging',
    waitingOn: 'question',
  },
  byId('sa-callers'),
  byId('sa-tests'),
  {
    ...byId('sa-rotate'),
    subagentId: 'sa-stopped',
    status: 'cancelled',
    finishedAt: new Date(Date.now() - 600_000).toISOString(),
    stats: { toolCalls: 5, durationMs: 41_000 },
    statusReason: 'Stopped by you',
  },
]

/** Three spawned on other providers, back to back: folded by default. */
const SPAWNED = [byId('sa-rotate'), byId('sa-scrub'), byId('sa-cookie')]

/** A group with one waiting and one failed: the header leads with what needs someone. */
const MIXED = [byId('sa-staging'), byId('sa-mobile'), byId('sa-tests'), byId('sa-callers')]

/**
 * Lone cards in every state, then groups folded and unfolded. A group folds
 * to one card, "3 subagents · 1 running, 2 done" over a line of what each
 * runs on; opened, it stacks a card per subagent.
 */
export const Cards: Story = {
  render: ({ scheme }) => (
    <Frame scheme={scheme}>
      <Caption>Lone cards</Caption>
      <div className="flex flex-col gap-1.5">
        {LONE.map((subagent) => (
          <SubagentCard key={subagent.subagentId} part={card(subagent)} />
        ))}
      </div>
      <Caption>Group, folded</Caption>
      <SubagentGroup parts={SPAWNED.map(card)} />
      <SubagentGroup parts={MIXED.map(card)} />
      <Caption>Group, opened</Caption>
      <SubagentGroup parts={SPAWNED.map(card)} defaultOpen />
      <Caption>In a turn</Caption>
      <AssistantMessage
        content=""
        isFinal={false}
        parts={[
          {
            type: 'text',
            id: 't1',
            text: 'Splitting this three ways, each on the agent that suits it.',
          },
          ...SPAWNED.map(card),
          {
            type: 'text',
            id: 't2',
            text: 'All three are running in the background. I’ll pick up their results as they land.',
          },
        ]}
      />
    </Frame>
  ),
}

/** The notice row that opens a turn the environment began, the delegated prompt, and the read-only footer. */
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
      <div className="mt-10 flex flex-col gap-3">
        <SubagentReadOnlyFooter
          parentTitle="Harden session authentication"
          identity={subagentIdentity(
            { title: 'Map every caller', providerId: 'claude', status: 'idle' },
            byId('sa-callers'),
            'completed',
          )}
          onOpenParent={() => undefined}
        />
        <SubagentReadOnlyFooter
          parentTitle="Harden session authentication"
          identity={subagentIdentity(
            { title: 'Audit token storage', providerId: 'claude', status: 'running' },
            byId('sa-mobile'),
          )}
          onOpenParent={() => undefined}
        />
        <SubagentReadOnlyFooter
          parentTitle="Harden session authentication"
          identity={subagentIdentity(
            { title: 'Run the auth suite', providerId: 'claude', status: 'error' },
            byId('sa-tests'),
            'failed',
          )}
          onOpenParent={() => undefined}
        />
      </div>
    </Frame>
  ),
}
