import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  WorkspaceSidebarView,
  type SidebarWorkspace,
} from '../../components/sidebar/WorkspaceSidebarView'

const data: SidebarWorkspace[] = [
  {
    path: '/workspace/openmanager',
    name: 'openmanager',
    sessions: [
      { externalId: 'sess-001', title: 'UI polish for timeline', status: 'idle' },
      { externalId: 'sess-002', title: 'Streaming bug fix', status: 'running' },
      { externalId: 'sess-003', title: 'Permission flow QA', status: 'busy' },
    ],
  },
  {
    path: '/workspace/opencode.ref',
    name: 'opencode.ref',
    sessions: [{ externalId: 'sess-101', title: 'Storybook docs', status: 'waiting' }],
  },
]

const meta = {
  title: 'App/WorkspaceSidebarView',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj

function Demo({
  collapsed,
  openCodeUiStatus,
}: {
  collapsed: boolean
  openCodeUiStatus: 'connected' | 'connecting' | 'disconnected'
}) {
  const [isCollapsed, setIsCollapsed] = useState(collapsed)
  const [activeSessionId, setActiveSessionId] = useState<string | null>('sess-002')
  const [collapsedPaths, setCollapsedPaths] = useState<string[]>(['/workspace/opencode.ref'])

  return (
    <div className="h-screen w-screen bg-background">
      <WorkspaceSidebarView
        collapsed={isCollapsed}
        onToggle={() => setIsCollapsed((v) => !v)}
        workspaces={data}
        activeWorkspacePath="/workspace/openmanager"
        activeSessionId={activeSessionId}
        collapsedWorkspacePaths={collapsedPaths}
        onToggleWorkspaceCollapse={(path) =>
          setCollapsedPaths((prev) =>
            prev.includes(path) ? prev.filter((x) => x !== path) : [...prev, path],
          )
        }
        onCreateSession={() => undefined}
        onSelectSession={(_, id) => setActiveSessionId(id)}
        onDeleteSession={() => undefined}
        onRemoveWorkspace={() => undefined}
        onAddWorkspace={() => undefined}
        openCodeStatus="healthy"
        openCodeUiStatus={openCodeUiStatus}
        onRetryOpenCode={() => undefined}
      />
    </div>
  )
}

export const Connected: Story = {
  render: () => <Demo collapsed={false} openCodeUiStatus="connected" />,
}

export const Connecting: Story = {
  render: () => <Demo collapsed={false} openCodeUiStatus="connecting" />,
}

export const DisconnectedCollapsed: Story = {
  render: () => <Demo collapsed={true} openCodeUiStatus="disconnected" />,
}
