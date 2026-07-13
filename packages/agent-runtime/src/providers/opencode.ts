import type { ProviderConfig } from './index.js'
export const opencode: ProviderConfig = {
  id: 'opencode',
  displayName: 'OpenCode',
  command: { bin: 'opencode', args: ['acp'], envOverride: 'ACP_OPENCODE_BIN' },
  auth: {
    methodHints: ['opencode-login', 'opencode', 'login'],
    tolerateAuthenticateFailure: true,
    loginInstruction: 'Run `opencode auth login` and retry.',
  },
  quirks: { suppressPlanUpdates: true },
  capabilities: {
    canSetModel: true,
    canSetMode: true,
    canSetConfigOption: true,
    canDeleteSession: false,
    canLoadSession: true,
    canCancelPrompt: true,
    supportsPlans: false,
    supportsAvailableCommands: true,
    supportsUsage: true,
    supportsPermissionRequests: true,
    supportsAuthentication: true,
    supportsThoughtStreaming: true,
    supportsSubtasks: false,
    supportsExtensions: false,
  },
  extensions: {},
}
