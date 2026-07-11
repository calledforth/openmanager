import type { ProviderConfig } from './index.js'
const noop = () => undefined
export const cursor: ProviderConfig = {
  id: 'cursor',
  displayName: 'Cursor',
  command: {
    bin: 'agent',
    args: ['acp'],
    envOverride: 'ACP_CURSOR_BIN',
    fallbackEnvOverride: 'ACP_AGENT_BIN',
  },
  auth: {
    methodHints: ['cursor_login', 'cursor'],
    tolerateAuthenticateFailure: false,
    loginInstruction: 'Sign in to Cursor and retry.',
  },
  quirks: {},
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canCancelPrompt: true,
    supportsPlans: true,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: true,
    supportsThoughtStreaming: true,
    supportsSubtasks: false,
    supportsExtensions: true,
  },
  extensions: {
    requests: {
      'cursor/ask_question': () => ({
        outcome: { outcome: 'skipped', reason: 'No UI handler registered' },
      }),
      'cursor/create_plan': () => ({ outcome: { outcome: 'cancelled' } }),
    },
    notifications: {
      'cursor/update_todos': noop,
      'cursor/task': noop,
      'cursor/generate_image': noop,
    },
  },
}
