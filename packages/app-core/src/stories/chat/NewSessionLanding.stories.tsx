import type { Meta, StoryObj } from '@storybook/react-vite'
import { EnvironmentPicker } from '../../components/chat/EnvironmentPicker'
import { NewSessionLandingView } from '../../components/chat/NewSessionLanding'
import { ThemeProvider } from '../../providers/theme-provider'

const meta = {
  title: 'App/NewSessionLanding',
  component: NewSessionLandingView,
  parameters: { layout: 'fullscreen' },
  args: {
    environmentLabel: 'studio-workstation',
    environmentPlatform: 'wsl',
    environmentDistro: { id: 'ubuntu', name: 'Ubuntu', like: ['debian'] },
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
      <ThemeProvider>
        <div className="flex h-screen w-screen bg-[var(--basis-canvas-bg)] text-[var(--basis-text)]">
          <Story />
        </div>
      </ThemeProvider>
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

/** A host that has not learned the environment's name shows no environment copy. */
export const UnnamedEnvironment: Story = {
  args: { environmentLabel: undefined },
}

/** With more than one environment saved, the label becomes the picker. */
export const SeveralEnvironments: Story = {
  args: {
    environmentPicker: (
      <EnvironmentPicker
        environments={[
          {
            environmentId: 'studio',
            label: 'studio-workstation',
            platform: 'windows',
            reachable: true,
          },
          { environmentId: 'laptop', label: 'travel-laptop', platform: 'macos', reachable: true },
          {
            environmentId: 'studio-wsl',
            label: 'studio-workstation',
            platform: 'wsl',
            distro: { id: 'ubuntu', name: 'Ubuntu' },
            reachable: true,
          },
          {
            environmentId: 'studio-arch',
            label: 'studio-workstation',
            platform: 'wsl',
            distro: { id: 'arch', name: 'Arch Linux' },
            reachable: true,
          },
          {
            environmentId: 'homelab',
            label: 'homelab',
            platform: 'linux',
            distro: { id: 'fedora', name: 'Fedora Linux' },
            reachable: true,
          },
          {
            environmentId: 'pi',
            label: 'pi',
            platform: 'linux',
            distro: { id: 'debian' },
            reachable: true,
          },
          { environmentId: 'nas', label: 'nas', platform: 'linux', reachable: false },
        ]}
        selectedId="studio"
        onSelect={() => undefined}
      />
    ),
  },
}

export const NoProjects: Story = {
  args: {
    workspaces: [],
    activeWorkspacePath: null,
  },
}
