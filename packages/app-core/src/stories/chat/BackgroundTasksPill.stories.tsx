import type { Meta, StoryObj } from '@storybook/react-vite'
import { BackgroundTasksPill } from '../../components/chat/BackgroundTasksPill'

/** Resolves like the environment does: the request is accepted, and the task
 * leaves the list only when the provider reports it gone. */
const accepted = () => Promise.resolve()

const meta = {
  title: 'App/BackgroundTasksPill',
  component: BackgroundTasksPill,
  args: { onStop: accepted },
  decorators: [
    (Story) => (
      <div className="flex h-64 w-[48rem] flex-col justify-end bg-[var(--basis-canvas-bg)] p-4 text-[var(--basis-text)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BackgroundTasksPill>

export default meta
type Story = StoryObj<typeof meta>

export const Command: Story = {
  args: { tasks: [{ taskId: 'task-1', kind: 'shell', description: 'pnpm test --watch' }] },
}

export const Agent: Story = {
  args: { tasks: [{ taskId: 'task-1', kind: 'agent', description: 'Review the migration' }] },
}

export const Undescribed: Story = {
  args: { tasks: [{ taskId: 'task-1', kind: 'monitor', description: '' }] },
}

export const Several: Story = {
  args: {
    tasks: [
      { taskId: 'task-1', kind: 'shell', description: 'pnpm dev' },
      { taskId: 'task-2', kind: 'agent', description: 'Review the migration' },
      { taskId: 'task-3', kind: 'monitor', description: 'Watch CI for the release branch' },
      { taskId: 'task-4', kind: 'workflow', description: 'spec' },
    ],
  },
}

export const LongDescription: Story = {
  args: {
    tasks: [
      {
        taskId: 'task-1',
        kind: 'shell',
        description:
          'node scripts/prepare-release.mjs --channel alpha --notes docs/release-notes.md --verify && pnpm --filter @openmanager/desktop dist:win',
      },
    ],
  },
}

export const Refused: Story = {
  args: {
    tasks: [{ taskId: 'task-1', kind: 'shell', description: 'pnpm test --watch' }],
    onStop: () => Promise.reject(new Error('unavailable')),
  },
}
