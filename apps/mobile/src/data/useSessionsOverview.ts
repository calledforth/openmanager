// Inert until the sessions list reads from the environment client.

const ACTIVE_STATUSES = new Set(['running', 'busy', 'waiting'])

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status)
}

export interface SessionOverview {
  workspacePath: string
  externalId: string
  title?: string
  status: string
  clientId?: string
  updatedAt: number
  isActive: boolean
}

export interface WorkspaceOverview {
  _id: string
  name: string
  path: string
  machineId: string
}

const NO_SESSIONS: SessionOverview[] = []
const NO_WORKSPACES: WorkspaceOverview[] = []

export function useSessionsOverview() {
  return { sessions: NO_SESSIONS, workspaces: NO_WORKSPACES, isLoading: false }
}
