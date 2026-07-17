import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { ProviderId } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'
import { resolveSessionProviderId } from './session-provider'

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
  isDriven: boolean
}

interface SidebarDataValue {
  workspaces: WorkspaceEntry[]
  isWorkspacesLoading: boolean
  sessionsByWorkspace: Record<string, SidebarSessionEntry[]>
  activeWorkspacePath: string | null
  activeSessionId: string | null
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  selectSession: (workspacePath: string, externalId: string, providerId: ProviderId) => void
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (
    workspacePath: string,
    externalId: string,
    providerId: ProviderId,
  ) => Promise<void>
}

const SidebarDataContext = createContext<SidebarDataValue | null>(null)

const EMPTY_WORKSPACES: Array<{ path: string; name: string }> = []
const EMPTY_SIDEBAR_ROWS: Array<{
  workspacePath: string
  externalId: string
  title?: string
  status: string
  providerId?: unknown
  clientId?: string
}> = []

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

export function useSidebarData() {
  const ctx = useContext(SidebarDataContext)
  if (!ctx) throw new Error('useSidebarData must be used within SidebarDataProvider')
  return ctx
}

export function SidebarDataProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const activeWorkspacePath = ui.activeWorkspacePath
  const createSession = ui.createSession
  const didRestoreWorkspaceRef = useRef(false)

  const rawWorkspacesQuery = useTrackedQuery('workspaces.list', api.workspaces.list, {}) as
    typeof EMPTY_WORKSPACES | undefined
  const isWorkspacesLoading = rawWorkspacesQuery === undefined
  const rawWorkspaces = rawWorkspacesQuery ?? EMPTY_WORKSPACES

  const workspacePaths = rawWorkspaces.map((workspace) => workspace.path)
  const rawSidebarRows =
    (useTrackedQuery('sessions.listForSidebar', (api as any).sessions.listForSidebar, {
      workspacePaths,
    }) as typeof EMPTY_SIDEBAR_ROWS | undefined) ?? EMPTY_SIDEBAR_ROWS

  const workspaces: WorkspaceEntry[] = rawWorkspaces.map((workspace) => ({
    path: workspace.path,
    name: workspace.name,
  }))

  useEffect(() => {
    if (didRestoreWorkspaceRef.current || isWorkspacesLoading) return
    if (activeWorkspacePath) {
      didRestoreWorkspaceRef.current = true
      return
    }

    let cancelled = false
    window.electronAPI
      .getLastActiveWorkspacePath()
      .then((lastActiveWorkspacePath) => {
        if (cancelled) return
        didRestoreWorkspaceRef.current = true
        const workspacePath = resolveInitialWorkspacePath(workspaces, lastActiveWorkspacePath)
        if (workspacePath) void createSession(workspacePath)
      })
      .catch(() => {
        if (cancelled) return
        didRestoreWorkspaceRef.current = true
        const workspacePath = resolveInitialWorkspacePath(workspaces, '')
        if (workspacePath) void createSession(workspacePath)
      })

    return () => {
      cancelled = true
    }
  }, [activeWorkspacePath, createSession, isWorkspacesLoading, workspaces])

  const sessionsByWorkspace = useMemo(() => {
    const grouped: Record<string, SidebarSessionEntry[]> = {}
    for (const row of rawSidebarRows) {
      const current = grouped[row.workspacePath] ?? []
      current.push({
        externalId: row.externalId,
        title: row.title,
        status: row.status,
        providerId: resolveSessionProviderId(row.providerId),
        clientId: row.clientId,
        isDriven: !!ui.currentClientId && row.clientId === ui.currentClientId,
      })
      grouped[row.workspacePath] = current
    }
    return grouped
  }, [rawSidebarRows, ui.currentClientId])

  const value = useMemo<SidebarDataValue>(
    () => ({
      workspaces,
      isWorkspacesLoading,
      sessionsByWorkspace,
      activeWorkspacePath: ui.activeWorkspacePath,
      activeSessionId: ui.activeSessionId,
      addWorkspace: ui.addWorkspace,
      removeWorkspace: ui.removeWorkspace,
      selectSession: ui.selectSession,
      createSession: ui.createSession,
      deleteSession: ui.deleteSession,
    }),
    [
      workspaces,
      isWorkspacesLoading,
      sessionsByWorkspace,
      ui.activeWorkspacePath,
      ui.activeSessionId,
      ui.addWorkspace,
      ui.removeWorkspace,
      ui.selectSession,
      ui.createSession,
      ui.deleteSession,
    ],
  )

  return <SidebarDataContext.Provider value={value}>{children}</SidebarDataContext.Provider>
}
