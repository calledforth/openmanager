import { createContext, useContext } from 'react'
import type { ProviderId } from '@agentpack/contract'

export interface WorkspaceEntry {
  path: string
  name: string
}

export interface SidebarSessionEntry {
  externalId: string
  title?: string
  status: string
  providerId: ProviderId
  clientId?: string
  parentExternalId?: string
  isDriven: boolean
}

/**
 * What the sidebar and the new-session landing read: the workspace catalog,
 * sessions grouped by workspace, which workspace rows are folded, and the
 * navigation commands (re-exposed from session state so views need one hook).
 */
export interface SidebarDataValue {
  workspaces: WorkspaceEntry[]
  isWorkspacesLoading: boolean
  sessionsByWorkspace: Record<string, SidebarSessionEntry[]>
  activeWorkspacePath: string | null
  activeSessionId: string | null
  /** Workspace rows the user folded; persisted by the host. */
  collapsedWorkspacePaths: string[]
  toggleWorkspaceCollapsed: (workspacePath: string) => void
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  selectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
  ) => Promise<void>
  /** Clear the "finished, unread" marker once the session is on screen.
   * Hosts that derive status live have nothing to clear and leave it out. */
  acknowledgeSessionDone?: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
  ) => Promise<void>
}

export const SidebarDataContext = createContext<SidebarDataValue | null>(null)

export function useSidebarData(): SidebarDataValue {
  const ctx = useContext(SidebarDataContext)
  if (!ctx) throw new Error('useSidebarData must be used within SidebarDataProvider')
  return ctx
}

export function resolveInitialWorkspacePath(
  workspaces: Array<{ path: string }>,
  lastActiveWorkspacePath: string,
): string | null {
  if (workspaces.length === 0) return null
  if (
    lastActiveWorkspacePath &&
    workspaces.some((workspace) => workspace.path === lastActiveWorkspacePath)
  ) {
    return lastActiveWorkspacePath
  }
  return workspaces[0]?.path ?? null
}

/** Toggle membership; returns a new array either way so state setters notice. */
export function toggleCollapsedWorkspace(paths: readonly string[], path: string): string[] {
  return paths.includes(path) ? paths.filter((item) => item !== path) : [...paths, path]
}
