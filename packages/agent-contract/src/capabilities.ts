/** Stable names for provider features on which applications may gate UI. */
export type ProviderCapabilities = {
  canSetModel: boolean
  canSetMode: boolean
  canSetConfigOption: boolean
  canDeleteSession: boolean
  canLoadSession: boolean
  canListSessions: boolean
  canCancelPrompt: boolean
  /** A message sent mid-turn can join the running turn at the agent's next step. */
  canSteer: boolean
  supportsPlans: boolean
  supportsAvailableCommands: boolean
  supportsUsage: boolean
  supportsPermissionRequests: boolean
  supportsAuthentication: boolean
  supportsThoughtStreaming: boolean
  supportsSubtasks: boolean
  supportsExtensions: boolean
  supportsQuestions: boolean
  /** Work outlives the turn that started it and is reported as background
   * tasks (`background_tasks_update`), each of which can be stopped
   * (`SessionRuntime.stopBackgroundTasks`): Claude Code's backgrounded tools,
   * Codex's background terminals. Host-side only: not sent to clients, which
   * show the tasks a session reports and gate Stop on the protocol's
   * `session.background.stop`, so capabilities read off the wire leave it
   * out. Absent means false. */
  supportsBackgroundTasks?: boolean
}

/** A capability name usable in typed `capability_missing` events. */
export type CapabilityKey =
  | 'canSetModel'
  | 'canSetMode'
  | 'canSetConfigOption'
  | 'canDeleteSession'
  | 'canLoadSession'
  | 'canListSessions'
  | 'canCancelPrompt'
  | 'canSteer'
  | 'supportsPlans'
  | 'supportsAvailableCommands'
  | 'supportsUsage'
  | 'supportsPermissionRequests'
  | 'supportsAuthentication'
  | 'supportsThoughtStreaming'
  | 'supportsSubtasks'
  | 'supportsExtensions'
  | 'supportsQuestions'
  | 'supportsBackgroundTasks'
