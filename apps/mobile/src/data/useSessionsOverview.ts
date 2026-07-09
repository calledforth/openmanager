import { api } from '@openmanager/convex/_generated/api'
import { useQuery } from 'convex/react'
import { useMemo } from 'react'

// Sessions-first overview: all workspaces + their sessions (sorted newest
// first by the Convex query), decorated with an `isActive` flag derived from
// the same status set the desktop sidebar treats as live.

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

export function useSessionsOverview() {
  const workspaces = useQuery(api.workspaces.list, {})

  const workspacePaths = useMemo(
    () => (workspaces ?? []).map((workspace) => workspace.path),
    [workspaces],
  )

  const sessions = useQuery(
    api.sessions.listForSidebar,
    workspaces === undefined ? 'skip' : { workspacePaths },
  )

  const decorated = useMemo<SessionOverview[]>(
    () =>
      (sessions ?? []).map((session) => ({
        ...session,
        isActive: isActiveStatus(session.status),
      })),
    [sessions],
  )

  return {
    sessions: decorated,
    workspaces: (workspaces ?? []) as WorkspaceOverview[],
    isLoading: workspaces === undefined || sessions === undefined,
  }
}
