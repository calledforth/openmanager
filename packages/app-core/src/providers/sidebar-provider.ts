import { createContext, useContext } from 'react'
import type { ProviderId } from '@agentpack/contract'

/** Cheap facts about a workspace the host already knows; nothing is probed here. */
export interface WorkspaceCapabilitySummary {
  /** The root is a git checkout. */
  git: boolean
  /** Provider IDs a session could start with right now. */
  providers: string[]
}

export interface WorkspaceEntry {
  path: string
  name: string
  /** The folder is registered but not on disk right now (moved or deleted). */
  missing?: boolean
  availability?: 'available' | 'missing' | 'inaccessible'
  /** ISO timestamp of the latest session activity; orders the recents list. */
  lastActivityAt?: string | null
  capabilities?: WorkspaceCapabilitySummary
}

/** Where the listed projects live and their sessions run. */
export interface SidebarEnvironment {
  environmentId: string
  /** The name the environment reports for itself (its host name by default). */
  label: string
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
  /**
   * The environment every listed project and session belongs to. Hosts that
   * do not know one (or have not heard its name yet) leave it out and views
   * show no environment copy.
   */
  environment?: SidebarEnvironment
  workspaces: WorkspaceEntry[]
  /**
   * Workspaces with session activity, most recent first, for the new-chat
   * surface. Hosts without activity data leave it out and get no recents row.
   */
  recentWorkspaces?: WorkspaceEntry[]
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
  renameSession?: (workspacePath: string, externalId: string, title: string | null) => Promise<void>
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
