import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedMutation, useTrackedQuery } from '../lib/convex-telemetry'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { usePlatformCapabilities } from '@openmanager/app-core/providers/platform-provider'
import {
  SidebarDataContext,
  resolveInitialWorkspacePath,
  toggleCollapsedWorkspace,
  type SidebarDataValue,
  type SidebarSessionEntry,
  type WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'
import { resolveSessionProviderId } from './session-provider'
export {
  resolveInitialWorkspacePath,
  useSidebarData,
  type SidebarSessionEntry,
  type WorkspaceEntry,
} from '@openmanager/app-core/providers/sidebar-provider'

const EMPTY_WORKSPACES: Array<{ path: string; name: string }> = []
const EMPTY_SIDEBAR_ROWS: Array<{
  workspacePath: string
  externalId: string
  title?: string
  status: string
  providerId?: unknown
  clientId?: string
  parentExternalId?: string
}> = []

/** Host-backed sidebar data: the Convex workspace and session catalog, the
 * folded rows persisted through Electron, and the last-active workspace
 * restored on launch. */
export function SidebarDataProvider({ children }: { children: ReactNode }) {
  const ui = useSessionState()
  const { currentClientId } = usePlatformCapabilities()
  const activeWorkspacePath = ui.activeWorkspacePath
  const createSession = ui.createSession
  const didRestoreWorkspaceRef = useRef(false)
  const [collapsedWorkspacePaths, setCollapsedWorkspacePaths] = useState<string[]>([])
  const upsertSessionStatus = useTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus)

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
    window.electronAPI
      .getCollapsedWorkspaces()
      .then((paths) => setCollapsedWorkspacePaths(paths))
      .catch(() => {})
  }, [])

  const toggleWorkspaceCollapsed = useCallback((path: string) => {
    setCollapsedWorkspacePaths((prev) => {
      const next = toggleCollapsedWorkspace(prev, path)
      window.electronAPI.setCollapsedWorkspaces(next).catch(() => {})
      return next
    })
  }, [])

  const acknowledgeSessionDone = useCallback<NonNullable<SidebarDataValue['acknowledgeSessionDone']>>(
    async (workspacePath, externalId, providerId) => {
      await upsertSessionStatus({ workspacePath, externalId, status: 'idle', providerId })
    },
    [upsertSessionStatus],
  )

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
        parentExternalId: row.parentExternalId,
        isDriven: !!currentClientId && row.clientId === currentClientId,
      })
      grouped[row.workspacePath] = current
    }
    return grouped
  }, [rawSidebarRows, currentClientId])

  const value = useMemo<SidebarDataValue>(
    () => ({
      workspaces,
      isWorkspacesLoading,
      sessionsByWorkspace,
      activeWorkspacePath: ui.activeWorkspacePath,
      activeSessionId: ui.activeSessionId,
      collapsedWorkspacePaths,
      toggleWorkspaceCollapsed,
      addWorkspace: ui.addWorkspace,
      removeWorkspace: ui.removeWorkspace,
      selectSession: ui.selectSession,
      createSession: ui.createSession,
      deleteSession: ui.deleteSession,
      acknowledgeSessionDone,
    }),
    [
      workspaces,
      isWorkspacesLoading,
      sessionsByWorkspace,
      ui.activeWorkspacePath,
      ui.activeSessionId,
      collapsedWorkspacePaths,
      toggleWorkspaceCollapsed,
      ui.addWorkspace,
      ui.removeWorkspace,
      ui.selectSession,
      ui.createSession,
      ui.deleteSession,
      acknowledgeSessionDone,
    ],
  )

  return <SidebarDataContext.Provider value={value}>{children}</SidebarDataContext.Provider>
}
