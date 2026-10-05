import { useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { PlatformCapabilitiesContext } from '../../providers/platform-provider'
import {
  useSidebarData,
  useSidebarDrafts,
  useSidebarSessions,
  type SidebarSessionEntry,
} from '../../providers/sidebar-provider'
import { WorkspaceSidebarView } from './WorkspaceSidebarView'

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/** Whether the user can actually see the window; a hidden tab has not seen anything. */
function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true,
  )
}

const NO_SESSIONS: SidebarSessionEntry[] = []

/** The view's props, read from the sidebar contract. */
function useWorkspaceSidebarModel() {
  const {
    environment,
    workspaces: catalog,
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
  const sessionsByWorkspace = useSidebarSessions()
  const drafts = useSidebarDrafts()
  const providerLabel = useContext(PlatformCapabilitiesContext)?.providerDisplayName
  const visible = useDocumentVisible()

  // Done only means "finished and not looked at yet". Opening the session, or
  // having it on screen while it finishes, clears it. A hidden window waits
  // until the user comes back, so work that finished while away still shows.
  useEffect(() => {
    if (!visible || !acknowledgeSessionDone || !activeWorkspacePath || !activeSessionId) return
    const session = sessionsByWorkspace[activeWorkspacePath]?.find(
      (row) => row.externalId === activeSessionId,
    )
    if (!session || session.status !== 'done') return
    // Best effort: a failed clear leaves the marker, and the next open retries.
    acknowledgeSessionDone(activeWorkspacePath, activeSessionId, session.providerId).catch(
      () => undefined,
    )
  }, [acknowledgeSessionDone, activeSessionId, activeWorkspacePath, sessionsByWorkspace, visible])

  const workspaces = useMemo(
    () =>
      catalog.map((workspace) => ({
        path: workspace.path,
        name: workspace.name,
        missing: workspace.missing,
        availability: workspace.availability,
        ...(workspace.git ? { git: workspace.git } : {}),
        sessions: sessionsByWorkspace[workspace.path] ?? NO_SESSIONS,
      })),
    [catalog, sessionsByWorkspace],
  )

  return {
    environmentLabel: environment?.label,
    workspaces,
    activeWorkspacePath,
    activeSessionId,
    onCreateSession: (workspacePath: string) => void createSession(workspacePath),
    onSelectSession: selectSession,
    onRenameSession: renameSession
      ? (path: string, id: string, title: string | null) => void renameSession(path, id, title)
      : undefined,
    // The host shows the move at once and puts it back if this rejects.
    onSettleSession: settleSession
      ? (path: string, id: string, settled: boolean) => settleSession(path, id, settled)
      : undefined,
    onDeleteSession: (...args: Parameters<typeof deleteSession>) => void deleteSession(...args),
    ...(drafts
      ? {
          drafts: drafts.drafts,
          activeDraftId: drafts.openDraftId,
          onOpenDraft: drafts.openDraft,
          onDiscardDraft: drafts.discardDraft,
        }
      : {}),
    onAddWorkspace: () => void addWorkspace(),
    providerLabel,
  }
}

/**
 * The session sidebar bound to `useSidebarData`; render inside a Fluid
 * `SidebarProvider`. Hosts add their own rows through the slots. Hosts with
 * draft cards also mount `DraftDiscardNotice` (`DraftDiscardToast.tsx`)
 * beside it, outside the sidebar, for the undo of a discarded draft.
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
