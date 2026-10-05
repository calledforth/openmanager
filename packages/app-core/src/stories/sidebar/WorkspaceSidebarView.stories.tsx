import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ProviderId } from '@agentpack/contract'
import { ThemeProvider } from '../../providers/theme-provider'
import type { PendingDraftDiscard } from '../../providers/sidebar-provider'
import { SidebarInset, SidebarProvider } from '../../components/fluid/ui/sidebar'
import { DraftDiscardToast } from '../../components/sidebar/DraftDiscardToast'
import { WorkspaceSidebarView } from '../../components/sidebar/WorkspaceSidebarView'
import type { SidebarDraft, SidebarWorkspace } from '../../components/sidebar/sidebar-sessions'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const PROVIDER_NAMES: Record<string, string> = {
  opencode: 'OpenCode',
  cursor: 'Cursor',
  claude: 'Claude Code',
  codex: 'Codex',
}
// Kept outside the render, as a host's would be, so unchanged rows skip it.
const providerLabel = (providerId: string) => PROVIDER_NAMES[providerId] ?? providerId

const initial: SidebarWorkspace[] = [
  {
    path: '/workspace/openmanager',
    name: 'openmanager',
    git: { branch: 't3code/revamp-chat-typography', worktree: true },
    sessions: [
      {
        externalId: 'sess-001',
        title: 'Status-based sidebar with settle',
        status: 'running',
        providerId: 'claude' as ProviderId,
        updatedAt: ago(1),
      },
      {
        externalId: 'sess-001-a',
        title: 'Explore t3code settle mechanism',
        status: 'ready',
        providerId: 'claude' as ProviderId,
        parentExternalId: 'sess-001',
        updatedAt: ago(3),
      },
      {
        externalId: 'sess-002',
        title: 'Composer image capabilities',
        status: 'waiting',
        providerId: 'codex' as ProviderId,
        updatedAt: ago(12),
      },
      {
        externalId: 'sess-003',
        title: 'Theme token audit',
        status: 'ready',
        providerId: 'cursor' as ProviderId,
        updatedAt: ago(60 * 5),
        settledAt: ago(60 * 4),
      },
      {
        externalId: 'sess-004',
        title: 'Streaming re-render cascade',
        status: 'ready',
        providerId: 'opencode' as ProviderId,
        updatedAt: ago(60 * 30),
        settledAt: ago(60 * 26),
      },
    ],
  },
  {
    path: '/workspace/tend',
    name: 'tend',
    git: { branch: 'main', worktree: false },
    sessions: [
      {
        externalId: 'sess-101',
        title: 'Port Graphite scheme',
        status: 'error',
        providerId: 'cursor' as ProviderId,
        updatedAt: ago(40),
      },
      {
        externalId: 'sess-102',
        title: 'Connect screen inputs',
        // Finished while the user was elsewhere: done until it is opened.
        status: 'done',
        providerId: 'opencode' as ProviderId,
        updatedAt: ago(60 * 20),
      },
      {
        externalId: 'sess-103',
        title: 'Tighten the theme picker',
        status: 'ready',
        providerId: 'cursor' as ProviderId,
        updatedAt: ago(60 * 26),
      },
    ],
  },
  {
    path: '/workspace/notes',
    name: 'notes',
    missing: true,
    availability: 'missing',
    sessions: [
      {
        externalId: 'sess-201',
        title: 'Weekly review',
        status: 'ready',
        providerId: 'claude' as ProviderId,
        workspaceUnavailable: true,
        updatedAt: ago(60 * 24 * 3),
      },
    ],
  },
]

const draft = (
  draftId: string,
  workspaceId: string | null,
  preview: string,
  minutesAgo: number,
  extra: Partial<SidebarDraft> = {},
): SidebarDraft => ({
  draftId,
  sessionId: `${draftId}-session`,
  workspaceId,
  providerId: 'claude' as ProviderId,
  preview,
  imageCount: 0,
  editedAt: Date.now() - minutesAgo * 60_000,
  ...extra,
})

const DRAFT = draft(
  'draft-1',
  '/workspace/openmanager',
  'Sidebar draft cards: park, reopen and discard a draft, with an undo',
  2,
)
const DRAFT_NO_PROJECT = draft('draft-2', null, 'Try the notes importer again', 30)
const DRAFT_PROJECT_MISSING = draft('draft-3', '/workspace/notes', 'Weekly review outline', 90)
const DRAFT_NOT_SYNCED = draft('draft-4', '/workspace/tend', 'Port the Graphite scheme', 8, {
  providerId: 'cursor' as ProviderId,
  unsynced: 'offline',
})
const DRAFT_IMAGES = draft('draft-5', '/workspace/tend', '', 12, { imageCount: 2 })

/** The sessions with one composer holding unsent text. */
const withUnsent = (externalId: string): SidebarWorkspace[] =>
  initial.map((workspace) => ({
    ...workspace,
    sessions: workspace.sessions.map((session) =>
      session.externalId === externalId ? { ...session, hasUnsentDraft: true } : session,
    ),
  }))

function Demo({
  workspaces: initialWorkspaces = initial,
  drafts: initialDrafts = [],
  activeSessionId: initialSessionId = 'sess-001',
  activeDraftId: initialDraftId = null,
}: {
  workspaces?: SidebarWorkspace[]
  drafts?: SidebarDraft[]
  activeSessionId?: string | null
  activeDraftId?: string | null
}) {
  const [workspaces, setWorkspaces] = useState(initialWorkspaces)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId)
  const [activeDraftId, setActiveDraftId] = useState<string | null>(initialDraftId)
  const [drafts, setDrafts] = useState(initialDrafts)
  // The host's discard, in miniature: the card hides at once, and the draft
  // goes only when the notice does.
  const [pending, setPending] = useState<PendingDraftDiscard | null>(null)
  const pendingRef = useRef<PendingDraftDiscard | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const settle = (keep: boolean) => {
    clearTimeout(timer.current)
    const current = pendingRef.current
    pendingRef.current = null
    setPending(null)
    if (current && !keep) {
      setDrafts((all) => all.filter((shown) => shown.draftId !== current.draftId))
    }
  }
  const arm = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => settle(false), 6_000)
  }
  const discard = (draftId: string, options?: { fromKeyboard?: boolean }) => {
    settle(false)
    const next = { draftId, key: Date.now(), fromKeyboard: options?.fromKeyboard ?? false }
    pendingRef.current = next
    setPending(next)
    if (draftId === activeDraftId) setActiveDraftId(null)
    arm()
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const shownDrafts = pending ? drafts.filter((shown) => shown.draftId !== pending.draftId) : drafts
  const patch = (externalId: string, change: Record<string, unknown>) =>
    setWorkspaces((current) =>
      current.map((workspace) => ({
        ...workspace,
        sessions: workspace.sessions.map((session) =>
          session.externalId === externalId ? { ...session, ...change } : session,
        ),
      })),
    )

  return (
    <ThemeProvider>
      <SidebarProvider className="h-svh min-h-0 overflow-hidden bg-background text-foreground">
        <WorkspaceSidebarView
          environmentLabel="studio-workstation"
          workspaces={workspaces}
          activeWorkspacePath="/workspace/openmanager"
          activeSessionId={activeSessionId}
          drafts={shownDrafts}
          activeDraftId={activeDraftId}
          onOpenDraft={(draftId) => {
            setActiveSessionId(null)
            setActiveDraftId(draftId)
          }}
          onDiscardDraft={discard}
          onCreateSession={() => undefined}
          onSelectSession={(_, id) => {
            setActiveDraftId(null)
            setActiveSessionId(id)
          }}
          onRenameSession={(_, id, title) => patch(id, { title: title ?? undefined })}
          // A round trip's worth of wait, as the environment would take: the
          // row should move on the click, not when this lands.
          onSettleSession={(_, id, settled) =>
            new Promise((resolve) => setTimeout(resolve, 250)).then(() =>
              patch(id, { settledAt: settled ? new Date().toISOString() : null }),
            )
          }
          onDeleteSession={(_, id) =>
            setWorkspaces((current) =>
              current.map((workspace) => ({
                ...workspace,
                sessions: workspace.sessions.filter((session) => session.externalId !== id),
              })),
            )
          }
          onAddWorkspace={() => undefined}
          providerLabel={providerLabel}
        />
        <SidebarInset />
        <DraftDiscardToast
          pending={pending}
          onUndo={() => settle(true)}
          onDismiss={() => settle(false)}
          onHold={(held) => (held ? clearTimeout(timer.current) : arm())}
        />
      </SidebarProvider>
    </ThemeProvider>
  )
}

const meta = {
  title: 'App/WorkspaceSidebarView',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj

export const ActiveAndSettled: Story = {
  render: () => <Demo />,
}

/** Every draft card state at once, above the sessions. ✕ (or right click) discards with an undo. */
export const DraftCards: Story = {
  render: () => (
    <Demo
      workspaces={withUnsent('sess-103')}
      drafts={[DRAFT, DRAFT_NOT_SYNCED, DRAFT_IMAGES, DRAFT_NO_PROJECT, DRAFT_PROJECT_MISSING]}
    />
  ),
}

/** A draft parked in its project. */
export const Draft: Story = {
  render: () => <Demo drafts={[DRAFT]} />,
}

/** The draft on screen: its card shows selected, a step deeper in the tint. */
export const DraftOpen: Story = {
  render: () => (
    <Demo drafts={[DRAFT, DRAFT_NOT_SYNCED]} activeSessionId={null} activeDraftId="draft-1" />
  ),
}

/** Its project was removed, or its folder is missing: the draft is kept and says so. */
export const DraftProjectUnavailable: Story = {
  render: () => <Demo drafts={[DRAFT_NO_PROJECT, DRAFT_PROJECT_MISSING]} />,
}

/** Its latest edit has not reached the environment: the quiet cloud mark, reason on hover. */
export const DraftNotSynced: Story = {
  render: () => <Demo drafts={[DRAFT_NOT_SYNCED]} />,
}

/** A session whose composer holds unsent text: a quieter step of the draft tint, and a pen. */
export const SessionWithUnsentDraft: Story = {
  render: () => <Demo workspaces={withUnsent('sess-103')} activeSessionId="sess-002" />,
}
