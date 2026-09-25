import { useContext, useEffect, type ReactNode } from 'react'
import { PlatformCapabilitiesContext } from '../../providers/platform-provider'
import { useSidebarData } from '../../providers/sidebar-provider'
import { FluidWorkspaceSidebarView } from './FluidWorkspaceSidebar'
import { WorkspaceSidebarView } from './WorkspaceSidebarView'

/** The view props both sidebars share, read from the sidebar contract. */
function useWorkspaceSidebarModel() {
  const {
    environment,
    workspaces,
    sessionsByWorkspace,
    activeWorkspacePath,
    activeSessionId,
    collapsedWorkspacePaths,
    toggleWorkspaceCollapsed,
    addWorkspace,
    selectSession,
    createSession,
    renameSession,
    settleSession,
    deleteSession,
    acknowledgeSessionDone,
  } = useSidebarData()
  const providerLabel = useContext(PlatformCapabilitiesContext)?.providerDisplayName

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

  return {
    environmentLabel: environment?.label,
    workspaces: workspaces.map((workspace) => ({
      path: workspace.path,
      name: workspace.name,
      missing: workspace.missing,
      availability: workspace.availability,
      ...(workspace.git ? { git: workspace.git } : {}),
      sessions: sessionsByWorkspace[workspace.path] ?? [],
    })),
    activeWorkspacePath,
    activeSessionId,
    collapsedWorkspacePaths,
    onToggleWorkspaceCollapse: toggleWorkspaceCollapsed,
    onCreateSession: (workspacePath: string) => void createSession(workspacePath),
    onSelectSession: selectSession,
    onRenameSession: renameSession
      ? (path: string, id: string, title: string | null) => void renameSession(path, id, title)
      : undefined,
    onSettleSession: settleSession
      ? (path: string, id: string, settled: boolean) => void settleSession(path, id, settled)
      : undefined,
    onDeleteSession: (...args: Parameters<typeof deleteSession>) => void deleteSession(...args),
    onAddWorkspace: () => void addWorkspace(),
    providerLabel,
  }
}

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
  const model = useWorkspaceSidebarModel()
  return (
    <WorkspaceSidebarView
      {...model}
      collapsed={collapsed}
      onCollapse={onCollapse}
      settingsMenu={settingsMenu}
      sidebarToggleShortcut={sidebarToggleShortcut}
    />
  )
}

/** The same sidebar on Fluid's inset layout; render inside a Fluid `SidebarProvider`. */
export function FluidWorkspaceSidebar({ footer }: { footer?: ReactNode }) {
  // Projects are not groups on this layout, so the folding props go unused.
  const model = useWorkspaceSidebarModel()
  return <FluidWorkspaceSidebarView {...model} footer={footer} />
}
