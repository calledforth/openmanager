import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ProviderId } from '@agentpack/contract'
import { ThemeProvider } from '../../providers/theme-provider'
import { SidebarInset, SidebarProvider } from '../../components/fluid/ui/sidebar'
import { WorkspaceSidebarView } from '../../components/sidebar/WorkspaceSidebarView'
import type { SidebarWorkspace } from '../../components/sidebar/sidebar-sessions'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const PROVIDER_NAMES: Record<string, string> = {
  opencode: 'OpenCode',
  cursor: 'Cursor',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

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
        providerId: 'claude-code' as ProviderId,
        updatedAt: ago(1),
      },
      {
        externalId: 'sess-001-a',
        title: 'Explore t3code settle mechanism',
        status: 'ready',
        providerId: 'claude-code' as ProviderId,
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
        status: 'ready',
        providerId: 'opencode' as ProviderId,
        updatedAt: ago(60 * 20),
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
        providerId: 'claude-code' as ProviderId,
        workspaceUnavailable: true,
        updatedAt: ago(60 * 24 * 3),
      },
    ],
  },
]

function Demo() {
  const [workspaces, setWorkspaces] = useState(initial)
  const [activeSessionId, setActiveSessionId] = useState<string | null>('sess-001')
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
          onCreateSession={() => undefined}
          onSelectSession={(_, id) => setActiveSessionId(id)}
          onRenameSession={(_, id, title) => patch(id, { title: title ?? undefined })}
          onSettleSession={(_, id, settled) =>
            patch(id, { settledAt: settled ? new Date().toISOString() : null })
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
          providerLabel={(providerId) => PROVIDER_NAMES[providerId] ?? providerId}
        />
        <SidebarInset />
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
