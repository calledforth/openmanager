import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessageInputView } from '../../components/chat/MessageInputView'

const meta = {
  title: 'App/MessageInputView',
  component: MessageInputView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  args: {
    disabled: false,
    pendingDraftSessionStart: false,
    activeWorkspacePath: '/workspace/openmanager',
    activeSessionId: 'sess-001',
    isSessionDraftOpen: false,
    openCodeReady: true,
    modeOptions: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
      { id: 'debug', name: 'Debug' },
    ],
    currentModeId: 'default',
    modelOptions: [
      { id: 'gpt-5.1', name: 'GPT-5.1' },
      { id: 'claude-sonnet', name: 'Claude Sonnet' },
    ],
    currentModelId: 'gpt-5.1',
    canChangeSettings: true,
    agent: { name: 'OpenCode', version: '1.7.0' },
    isStreaming: false,
    onModeChange: () => undefined,
    onModelChange: () => undefined,
    onSend: () => undefined,
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
    openCodeReady: false,
  },
}

export const PlanMode: Story = {
  args: {
    currentModeId: 'plan',
  },
}
