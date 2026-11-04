import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { PlatformCapabilitiesContext } from '../../providers/platform-provider'
import {
  useSidebarData,
  useSidebarDrafts,
  useSidebarEnvironments,
  useSidebarSessions,
  type SidebarSessionEntry,
  type SidebarSessionsByWorkspace,
  type WorkspaceEntry,
} from '../../providers/sidebar-provider'
import { useSidebar } from '../fluid/ui/sidebar'
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

function sidebarWorkspace(
  workspace: WorkspaceEntry,
  sessions: SidebarSessionsByWorkspace,
  environmentId: string | undefined,
) {
  return {
    path: workspace.path,
    name: workspace.name,
    ...(environmentId ? { environmentId } : {}),
    missing: workspace.missing,
    availability: workspace.availability,
    ...(workspace.git ? { git: workspace.git } : {}),
    sessions: sessions[workspace.path] ?? NO_SESSIONS,
  }
}

/** The view's props, read from the sidebar contract. */
function useWorkspaceSidebarModel(closeSheet: MutableRefObject<() => void>) {
  const {
    environment,
    activeEnvironmentId,
    workspaces: catalog,
    activeWorkspacePath,
    activeSessionId,
    addWorkspace,
    addWorkspaceDisabled,
    selectSession,
    createSession,
    renameSession,
    settleSession,
    pinSession,
    deleteSession,
    acknowledgeSessionDone,
  } = useSidebarData()
  const sessionsByWorkspace = useSidebarSessions()
  const drafts = useSidebarDrafts()
  const listed = useSidebarEnvironments()
  const others = listed?.others
  const providerLabel =
    useContext(PlatformCapabilitiesContext)?.providerDisplayName ?? listed?.providerDisplayName
  const visible = useDocumentVisible()
  // On a phone the sidebar is a sheet over the page: going somewhere from it
  // (a session, a draft, a new agent, Add project) closes it, so what was
  // picked is on screen rather than behind the sheet. `SheetCloser` keeps the
  // closer current, so this hook never reads the sidebar's own state (width,
  // peek, a rail drag) and renders for it.
  const away =
    <A extends unknown[], R>(go: (...args: A) => R) =>
    (...args: A): R => {
      closeSheet.current()
      return go(...args)
    }

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
    () => [
      ...catalog.map((workspace) =>
        sidebarWorkspace(workspace, sessionsByWorkspace, activeEnvironmentId),
      ),
      ...(others ?? []).flatMap(({ environmentId, sessions, workspaces: their }) =>
        their.map((workspace) => sidebarWorkspace(workspace, sessions, environmentId)),
      ),
    ],
    [activeEnvironmentId, catalog, others, sessionsByWorkspace],
  )

  return {
    environmentLabel: environment?.label,
    rowEnvironments: listed?.rowEnvironments,
    rowsFilling: listed?.filling,
    workspaces,
    activeEnvironmentId,
    activeWorkspacePath,
    activeSessionId,
    onCreateSession: away(
      (workspacePath: string, environmentId?: string) =>
        void createSession(workspacePath, environmentId),
    ),
    onSelectSession: away(selectSession),
    onRenameSession: renameSession
      ? (path: string, id: string, title: string | null, environmentId?: string) =>
          void renameSession(path, id, title, environmentId)
      : undefined,
    // The host shows the move at once and puts it back if this rejects.
    onSettleSession: settleSession
      ? (path: string, id: string, settled: boolean, environmentId?: string) =>
          settleSession(path, id, settled, environmentId)
      : undefined,
    // Likewise.
    onPinSession: pinSession
      ? (path: string, id: string, pinned: boolean, environmentId?: string) =>
          pinSession(path, id, pinned, environmentId)
      : undefined,
    onDeleteSession: (...args: Parameters<typeof deleteSession>) => void deleteSession(...args),
    ...(drafts
      ? {
          drafts: drafts.drafts,
          activeDraftId: drafts.openDraftId,
          onOpenDraft: away(drafts.openDraft),
          onDiscardDraft: drafts.discardDraft,
        }
      : {}),
    onAddWorkspace: away(() => void addWorkspace()),
    addWorkspaceDisabled,
    providerLabel,
  }
}

/**
 * Keeps `closeSheet` closing the phone sheet, and doing nothing on a wider
 * window. Its own piece, so a rail drag or a peek renders only this.
 */
function SheetCloser({ closeSheet }: { closeSheet: MutableRefObject<() => void> }) {
  const { isMobile, setOpenMobile } = useSidebar()
  useEffect(() => {
    closeSheet.current = isMobile ? () => setOpenMobile(false) : () => undefined
  }, [closeSheet, isMobile, setOpenMobile])
  return null
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
  const closeSheet = useRef<() => void>(() => undefined)
  const model = useWorkspaceSidebarModel(closeSheet)
  return (
    <>
      <SheetCloser closeSheet={closeSheet} />
      <WorkspaceSidebarView {...model} titlebar={titlebar} footer={footer} />
    </>
  )
}
