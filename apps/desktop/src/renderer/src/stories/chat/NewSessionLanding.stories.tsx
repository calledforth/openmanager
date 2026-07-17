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

export const Starting: Story = {
  args: { isStarting: true },
}

export const NoRepositories: Story = {
  args: {
    workspaces: [],
    activeWorkspacePath: null,
  },
}
