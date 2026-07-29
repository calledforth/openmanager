import type { AgentEvent, ProviderId } from '@agentpack/contract'
import type { DesiredSessionConfig } from './session/lifecycle.js'

export type HostLogEntry = {
  scope: 'agent-runtime' | 'acp'
  level: 'info' | 'warn' | 'error'
  message: string
  data?: unknown
}

export type HostDeps = {
  emitEvent: (event: AgentEvent) => void
  log: (entry: HostLogEntry) => void
  onSessionTitle?: (args: { threadId: string; workspaceId?: string; title: string }) => void
  /** What the composer shows for this workspace and provider, read from the
   * host's durable preferences at the moment it is asked.
   *
   * This is deliberately a *pull* and not a value the runtime caches. Desired
   * config is per workspace + provider and persisted (design doc §3); a second
   * copy held per thread is a second source of truth, and the two disagree the
   * instant the user changes the model — after which a respawn re-applies the
   * selection the user moved away from. Asking the owner of the durable state
   * is the only way an answer is current by construction.
   *
   * Optional: a host with no persisted preferences (and every test that does
   * not care) simply supplies nothing, and callers pass an explicit
   * `desiredConfig` where they have one. */
  desiredSessionConfig?: (args: {
    providerId: ProviderId
    workspacePath: string
  }) => DesiredSessionConfig | undefined
}
