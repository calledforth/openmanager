import { useState, useEffect, useCallback } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedMutation } from '../../lib/convex-telemetry'
import { useSidebarData } from '../../providers/sidebar-data-provider'
import { WorkspaceSidebarView } from './WorkspaceSidebarView'

export function WorkspaceSidebar({
  collapsed,
  onCollapse,
  convexOpen,
  onToggleConvex,
}: {
  collapsed: boolean
  onCollapse: () => void
  convexOpen: boolean
  onToggleConvex: () => void
}) {
  const {
    workspaces,
    sessionsByWorkspace,
    activeWorkspacePath,
    activeSessionId,
    addWorkspace,
    selectSession,
    createSession,
    deleteSession,
  } = useSidebarData()
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set())
  const upsertSessionStatus = useTrackedMutation('sessions.upsertStatus', api.sessions.upsertStatus)

  useEffect(() => {
    window.electronAPI
      .getCollapsedWorkspaces()
      .then((paths) => {
        setCollapsedSet(new Set(paths))
      })
      .catch(() => {})
  }, [])

  // Opening a finished session (or finishing while focused) clears the green
  // ready glyph — it only means "done and waiting to be opened".
  useEffect(() => {
    if (!activeWorkspacePath || !activeSessionId) return
    const session = sessionsByWorkspace[activeWorkspacePath]?.find(
      (row) => row.externalId === activeSessionId,
    )
    if (!session || session.status !== 'done') return
    void upsertSessionStatus({
      workspacePath: activeWorkspacePath,
      externalId: activeSessionId,
      status: 'idle',
      providerId: session.providerId,
    })
  }, [activeSessionId, activeWorkspacePath, sessionsByWorkspace, upsertSessionStatus])

  const toggleWorkspaceCollapse = useCallback((path: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      window.electronAPI.setCollapsedWorkspaces([...next]).catch(() => {})
      return next
    })
  }, [])

  return (
    <WorkspaceSidebarView
      collapsed={collapsed}
      workspaces={workspaces.map((ws) => ({
        path: ws.path,
        name: ws.name,
        sessions: sessionsByWorkspace[ws.path] ?? [],
      }))}
      activeWorkspacePath={activeWorkspacePath}
      activeSessionId={activeSessionId}
      collapsedWorkspacePaths={[...collapsedSet]}
      onToggleWorkspaceCollapse={toggleWorkspaceCollapse}
      onCollapse={onCollapse}
      onCreateSession={(workspacePath) => void createSession(workspacePath)}
      onSelectSession={selectSession}
      onDeleteSession={(workspacePath, externalId, providerId) =>
        void deleteSession(workspacePath, externalId, providerId)
      }
      onAddWorkspace={() => void addWorkspace()}
      convexOpen={convexOpen}
      onToggleConvex={onToggleConvex}
    />
  )
}
