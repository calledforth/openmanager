/** Stable names for provider features on which applications may gate UI. */
export type ProviderCapabilities = {
  canSetModel: boolean
  canSetMode: boolean
  canSetConfigOption: boolean
  canDeleteSession: boolean
  canLoadSession: boolean
  canCancelPrompt: boolean
  supportsPlans: boolean
  supportsAvailableCommands: boolean
  supportsUsage: boolean
  supportsPermissionRequests: boolean
  supportsAuthentication: boolean
  supportsThoughtStreaming: boolean
  supportsSubtasks: boolean
  supportsExtensions: boolean
  supportsQuestions: boolean
}

/** A capability name usable in typed `capability_missing` events. */
export type CapabilityKey =
  | 'canSetModel'
  | 'canSetMode'
  | 'canSetConfigOption'
  | 'canDeleteSession'
  | 'canLoadSession'
  | 'canCancelPrompt'
  | 'supportsPlans'
  | 'supportsAvailableCommands'
  | 'supportsUsage'
  | 'supportsPermissionRequests'
  | 'supportsAuthentication'
  | 'supportsThoughtStreaming'
  | 'supportsSubtasks'
  | 'supportsExtensions'
  | 'supportsQuestions'
