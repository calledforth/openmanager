import type { Meta, StoryObj } from '@storybook/react-vite'
import type { PlanEntry } from '@agentpack/contract'
import { ThemeProvider } from '../../providers/theme-provider'
import { ComposerTodos } from '../../components/plans/ComposerTodos'
import { MessageInputView } from '../../components/chat/MessageInputView'
import { chatInputShell } from '../../components/chat/chatComposerStyles'
import { cn } from '../../lib/utils'

const SAMPLE_ENTRIES: PlanEntry[] = [
  {
    content: 'Inspect current plan checklist rendering in chat',
    status: 'completed',
    priority: 'high',
  },
  { content: 'Attach todos strip to the composer shell', status: 'completed', priority: 'high' },
  {
    content: 'Collapse by default with Todos N/M header',
    status: 'in_progress',
    priority: 'medium',
  },
  { content: 'Scroll long lists inside the expanded panel', status: 'pending', priority: 'medium' },
  { content: 'Hide in-transcript plan checklist cards', status: 'pending', priority: 'low' },
  { content: 'Verify dark styling against the composer', status: 'pending', priority: 'low' },
]

const meta = {
  title: 'App/ComposerTodos',
  component: ComposerTodos,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="flex min-h-screen items-end bg-[var(--basis-canvas-bg)] p-6">
          <div className="mx-auto w-full max-w-[52rem]">
            <Story />
          </div>
        </div>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof ComposerTodos>

export default meta
type Story = StoryObj<typeof ComposerTodos>

export const Collapsed: Story = {
  args: {
    entries: SAMPLE_ENTRIES,
    defaultOpen: false,
  },
  render: (args) => (
    <div className="flex w-full flex-col">
      <ComposerTodos {...args} />
      <div
        className={cn(
          chatInputShell,
          'rounded-t-none p-3 text-11-regular text-[var(--basis-text-muted)]',
        )}
      >
        Composer shell
      </div>
    </div>
  ),
}

export const Expanded: Story = {
  args: {
    entries: SAMPLE_ENTRIES,
    defaultOpen: true,
  },
  render: (args) => (
    <div className="flex w-full flex-col">
      <ComposerTodos {...args} />
      <div
        className={cn(
          chatInputShell,
          'rounded-t-none p-3 text-11-regular text-[var(--basis-text-muted)]',
        )}
      >
        Composer shell
      </div>
    </div>
  ),
}

export const WithRealComposer: Story = {
  render: () => (
    <div className="flex w-full flex-col">
      <ComposerTodos entries={SAMPLE_ENTRIES} defaultOpen={false} />
      <MessageInputView
        disabled={false}
        pendingDraftSessionStart={false}
        activeWorkspacePath="/workspace/openmanager"
        activeSessionId="sess-todos"
        isSessionDraftOpen={false}
        providerReady
        currentProviderId="opencode"
        providerModelGroups={[
          {
            providerId: 'opencode',
            providerName: 'OpenCode',
            models: [{ id: 'default', name: 'Default', description: 'Default model' }],
          },
        ]}
        currentModelId="default"
        configOptions={[]}
        modeOptions={[{ id: 'agent', name: 'Agent' }]}
        currentModeId="agent"
        effortLevels={[]}
        currentEffort=""
        canChangeSettings
        canChangeProvider={false}
        showModeControl
        showModelControl
        isStreaming={false}
        attachedTop
        draftKey="todos-story"
        imageUploadEnabled={false}
        imageSupportMessage={null}
        onModeChange={() => undefined}
        onProviderModelChange={() => undefined}
        onConfigOptionChange={() => undefined}
        onSend={async () => undefined}
        onAbort={() => undefined}
      />
    </div>
  ),
}
