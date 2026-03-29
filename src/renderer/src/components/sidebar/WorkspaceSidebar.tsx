import { useState, useEffect, useCallback } from 'react'
import { useSidebarData } from '../../providers/sidebar-data-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import { WorkspaceSidebarView } from './WorkspaceSidebarView'

export function WorkspaceSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const {
    workspaces,
    sessionsByWorkspace,
    activeWorkspacePath,
    activeSessionId,
    addWorkspace,
    removeWorkspace,
    selectSession,
    createSession,
    deleteSession,
  } = useSidebarData()
  const { openCodeStatus, openCodeUiStatus, retryOpenCode } = useAppUi()
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.electronAPI
      .getCollapsedWorkspaces()
      .then((paths) => {
        setCollapsedSet(new Set(paths))
      })
      .catch(() => {})
  }, [])

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
      onToggle={onToggle}
      workspaces={workspaces.map((ws) => ({
        path: ws.path,
        name: ws.name,
        sessions: sessionsByWorkspace[ws.path] ?? [],
      }))}
      activeWorkspacePath={activeWorkspacePath}
      activeSessionId={activeSessionId}
      collapsedWorkspacePaths={[...collapsedSet]}
      onToggleWorkspaceCollapse={toggleWorkspaceCollapse}
      onCreateSession={(workspacePath) => void createSession(workspacePath)}
      onSelectSession={selectSession}
      onDeleteSession={(workspacePath, externalId) => void deleteSession(workspacePath, externalId)}
      onRemoveWorkspace={(path) => void removeWorkspace(path)}
      onAddWorkspace={() => void addWorkspace()}
      openCodeStatus={openCodeStatus}
      openCodeUiStatus={openCodeUiStatus}
      onRetryOpenCode={() => void retryOpenCode()}
    />
  )
}
