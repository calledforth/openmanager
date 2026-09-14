import type { Meta, StoryObj } from '@storybook/react-vite'
import { NewSessionLandingView } from '../../components/chat/NewSessionLanding'

const meta = {
  title: 'App/NewSessionLanding',
  component: NewSessionLandingView,
  parameters: { layout: 'fullscreen' },
  args: {
    workspaces: [
      { path: 'C:\\repos\\openmanager', name: 'openmanager' },
      { path: 'C:\\repos\\agentpack', name: 'agentpack' },
      { path: 'C:\\repos\\design-system', name: 'design-system' },
    ],
    activeWorkspacePath: 'C:\\repos\\openmanager',
    isWorkspacesLoading: false,
    isStarting: false,
    onSelectWorkspace: () => undefined,
    onAddWorkspace: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="flex h-screen w-screen bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NewSessionLandingView>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}

export const WithRecents: Story = {
  args: {
    recentWorkspaces: [
      {
        path: 'C:\\repos\\agentpack',
        name: 'agentpack',
        lastActivityAt: '2026-09-14T09:30:00.000Z',
        capabilities: { git: true, providers: ['cursor', 'codex'] },
      },
      {
        path: 'C:\\repos\\openmanager',
        name: 'openmanager',
        lastActivityAt: '2026-09-13T18:00:00.000Z',
        capabilities: { git: true, providers: ['cursor'] },
      },
      {
        path: 'C:\\repos\\design-system',
        name: 'design-system',
        lastActivityAt: '2026-09-10T12:00:00.000Z',
        capabilities: { git: false, providers: [] },
      },
    ],
  },
}

export const Starting: Story = {
  args: { isStarting: true },
}

export const NoProjects: Story = {
  args: {
    workspaces: [],
    activeWorkspacePath: null,
  },
}
