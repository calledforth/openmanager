import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { api } from '@convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'

export interface WorkspaceEntry {
  path: string
  name: string
}

export interface SidebarSessionEntry {
  externalId: string
  title?: string
  status: string
  clientId?: string
  isDriven: boolean
}

interface SidebarDataValue {
  workspaces: WorkspaceEntry[]
  sessionsByWorkspace: Record<string, SidebarSessionEntry[]>
  activeWorkspacePath: string | null
  activeSessionId: string | null
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  selectSession: (workspacePath: string, externalId: string) => void
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (workspacePath: string, externalId: string) => Promise<void>
}

const SidebarDataContext = createContext<SidebarDataValue | null>(null)

const EMPTY_WORKSPACES: Array<{ path: string; name: string }> = []
const EMPTY_SIDEBAR_ROWS: Array<{
  workspacePath: string
  externalId: string
  title?: string
  status: string
  clientId?: string
}> = []

export function useSidebarData() {
  const ctx = useContext(SidebarDataContext)
  if (!ctx) throw new Error('useSidebarData must be used within SidebarDataProvider')
  return ctx
}

export function SidebarDataProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()

  const rawWorkspaces =
    (useTrackedQuery('workspaces.list', api.workspaces.list, {}) as typeof EMPTY_WORKSPACES) ??
    EMPTY_WORKSPACES

  const workspacePaths = rawWorkspaces.map((workspace) => workspace.path)
  const rawSidebarRows =
    (useTrackedQuery('sessions.listForSidebar', (api as any).sessions.listForSidebar, {
      workspacePaths,
    }) as typeof EMPTY_SIDEBAR_ROWS | undefined) ?? EMPTY_SIDEBAR_ROWS

  const workspaces: WorkspaceEntry[] = rawWorkspaces.map((workspace) => ({
    path: workspace.path,
    name: workspace.name,
  }))

  const sessionsByWorkspace = useMemo(() => {
    const grouped: Record<string, SidebarSessionEntry[]> = {}
    for (const row of rawSidebarRows) {
      const current = grouped[row.workspacePath] ?? []
      current.push({
        externalId: row.externalId,
        title: row.title,
        status: row.status,
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
