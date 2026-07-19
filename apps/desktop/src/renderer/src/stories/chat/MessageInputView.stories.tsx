import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessageInputView } from '../../components/chat/MessageInputView'
import { ThemeProvider } from '../../providers/theme-provider'

const meta = {
  title: 'App/MessageInputView',
  component: MessageInputView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="flex min-h-screen items-end bg-[var(--basis-canvas-bg)] p-6">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  args: {
    disabled: false,
    pendingDraftSessionStart: false,
    activeWorkspacePath: '/workspace/openmanager',
    activeSessionId: 'sess-001',
    isSessionDraftOpen: false,
    providerReady: true,
    currentProviderId: 'opencode',
    providerModelGroups: [
      {
        providerId: 'opencode',
        providerName: 'OpenCode',
        models: [
          { id: 'gpt-5.1', name: 'GPT-5.1' },
          { id: 'claude-sonnet', name: 'Claude Sonnet' },
        ],
      },
      {
        providerId: 'cursor',
        providerName: 'Cursor',
        models: [
          { id: 'cursor/default', name: 'Default' },
          { id: 'cursor/fast', name: 'Fast' },
        ],
      },
    ],
    currentModelId: 'gpt-5.1',
    configOptions: [
      {
        type: 'select',
        id: 'thought_level',
        name: 'Reasoning effort',
        category: 'thought_level',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        type: 'select',
        id: 'fast',
        name: 'Fast',
        currentValue: 'false',
        options: [
          { value: 'false', name: 'Off' },
          { value: 'true', name: 'On' },
        ],
      },
    ],
    modeOptions: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
      { id: 'debug', name: 'Debug' },
    ],
    currentModeId: 'default',
    canChangeSettings: true,
    canChangeProvider: true,
    showModeControl: true,
    showModelControl: true,
    isStreaming: false,
    draftKey: 'session:sess-001',
    imageUploadEnabled: true,
    imageSupportMessage: null,
    onModeChange: () => undefined,
    onProviderModelChange: () => undefined,
    onConfigOptionChange: () => undefined,
    onSend: async () => undefined,
    onAbort: () => undefined,
  },
} satisfies Meta<typeof MessageInputView>

export default meta
type Story = StoryObj<typeof meta>

export const Connected: Story = {}

export const DraftStarting: Story = {
  args: {
    activeSessionId: null,
    isSessionDraftOpen: true,
    pendingDraftSessionStart: true,
    disabled: true,
  },
}

export const Disconnected: Story = {
  args: {
    providerReady: false,
  },
}

export const PlanMode: Story = {
  args: {
    currentModeId: 'plan',
  },
}
