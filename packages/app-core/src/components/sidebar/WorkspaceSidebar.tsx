import { useContext, useEffect, type ReactNode } from 'react'
import { PlatformCapabilitiesContext } from '../../providers/platform-provider'
import { useSidebarData } from '../../providers/sidebar-provider'
import { WorkspaceSidebarView } from './WorkspaceSidebarView'

/** The view's props, read from the sidebar contract. */
function useWorkspaceSidebarModel() {
  const {
    environment,
    workspaces,
    sessionsByWorkspace,
    activeWorkspacePath,
    activeSessionId,
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
 * The session sidebar bound to `useSidebarData`; render inside a Fluid
 * `SidebarProvider`. Hosts add their own rows through the slots.
 */
export function WorkspaceSidebar({
  titlebar,
  footer,
}: {
  titlebar?: ReactNode
  footer?: ReactNode
}) {
  const model = useWorkspaceSidebarModel()
  return <WorkspaceSidebarView {...model} titlebar={titlebar} footer={footer} />
}
