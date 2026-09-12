import { useEffect, type ReactNode } from 'react'
import { useSidebarData } from '../../providers/sidebar-provider'
import { WorkspaceSidebarView } from './WorkspaceSidebarView'

/**
 * The sidebar bound to `useSidebarData`. Hosts pass their own settings menu
 * as a slot and the shortcut label for their platform; everything else comes
 * from the sidebar contract.
 */
export function WorkspaceSidebar({
  collapsed,
  onCollapse,
  settingsMenu,
  sidebarToggleShortcut,
}: {
  collapsed: boolean
  onCollapse?: () => void
  settingsMenu?: ReactNode
  sidebarToggleShortcut?: string
}) {
  const {
    workspaces,
    sessionsByWorkspace,
    activeWorkspacePath,
    activeSessionId,
    collapsedWorkspacePaths,
    toggleWorkspaceCollapsed,
    addWorkspace,
    selectSession,
    createSession,
    deleteSession,
    acknowledgeSessionDone,
  } = useSidebarData()

  // Opening a finished session (or finishing while focused) clears the green
  // ready glyph — it only means "done and waiting to be opened".
  useEffect(() => {
    if (!acknowledgeSessionDone || !activeWorkspacePath || !activeSessionId) return
    const session = sessionsByWorkspace[activeWorkspacePath]?.find(
      (row) => row.externalId === activeSessionId,
    )
    if (!session || session.status !== 'done') return
    void acknowledgeSessionDone(activeWorkspacePath, activeSessionId, session.providerId)
  }, [acknowledgeSessionDone, activeSessionId, activeWorkspacePath, sessionsByWorkspace])

  return (
    <WorkspaceSidebarView
      collapsed={collapsed}
      workspaces={workspaces.map((workspace) => ({
        path: workspace.path,
        name: workspace.name,
        sessions: sessionsByWorkspace[workspace.path] ?? [],
      }))}
      activeWorkspacePath={activeWorkspacePath}
      activeSessionId={activeSessionId}
      collapsedWorkspacePaths={collapsedWorkspacePaths}
      onToggleWorkspaceCollapse={toggleWorkspaceCollapsed}
      onCollapse={onCollapse}
      onCreateSession={(workspacePath) => void createSession(workspacePath)}
      onSelectSession={selectSession}
      onDeleteSession={(workspacePath, externalId, providerId) =>
        void deleteSession(workspacePath, externalId, providerId)
      }
      onAddWorkspace={() => void addWorkspace()}
      settingsMenu={settingsMenu}
      sidebarToggleShortcut={sidebarToggleShortcut}
    />
  )
}
