import type { AgentEvent } from '@agentpack/contract'

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
}
