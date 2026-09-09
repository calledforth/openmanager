import { useAppUi } from '../../providers/app-ui-provider'
import { useSidebarData } from '../../providers/sidebar-data-provider'
import { NewSessionLandingView } from '@openmanager/app-core/components/chat/NewSessionLanding'
export { NewSessionLandingView } from '@openmanager/app-core/components/chat/NewSessionLanding'

export function NewSessionLanding() {
  const { activeWorkspacePath, pendingDraftSessionStart } = useAppUi()
  const { workspaces, isWorkspacesLoading, createSession, addWorkspace } = useSidebarData()

  return (
    <NewSessionLandingView
      workspaces={workspaces}
      activeWorkspacePath={activeWorkspacePath}
      isWorkspacesLoading={isWorkspacesLoading}
      isStarting={pendingDraftSessionStart}
      onSelectWorkspace={(workspacePath) => void createSession(workspacePath)}
      onAddWorkspace={() => void addWorkspace()}
    />
  )
}
