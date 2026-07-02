import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ThemeProvider } from '../../providers/theme-provider'
import { AppUiProvider } from '../../providers/app-ui-provider'
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

function Demo({ collapsed }: { collapsed: boolean }) {
  const [isCollapsed, setIsCollapsed] = useState(collapsed)
  const [activeSessionId, setActiveSessionId] = useState<string | null>('sess-002')
  const [collapsedPaths, setCollapsedPaths] = useState<string[]>(['/workspace/opencode.ref'])

  return (
    <ThemeProvider>
      <AppUiProvider>
        <div className="h-screen w-screen bg-background">
          <WorkspaceSidebarView
            collapsed={isCollapsed}
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
          />
        </div>
      </AppUiProvider>
    </ThemeProvider>
  )
}

export const Connected: Story = {
  render: () => <Demo collapsed={false} />,
}

export const Connecting: Story = {
  render: () => <Demo collapsed={false} />,
}

export const DisconnectedCollapsed: Story = {
  render: () => <Demo collapsed={true} />,
}
