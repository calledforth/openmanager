import { useCallback, useContext, useMemo, useRef } from 'react'
import {
  SidebarDataContext,
  useConnectionState,
  useEnvironmentClient,
  useSessionState,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'

import type { ProjectSource } from '../composer/ProjectSheet'

const NO_WORKSPACES: WorkspaceEntry[] = []

/**
 * The new-session page's project picker over the shared state, as web's
 * landing and Add project dialog read it: the environment's projects and its
 * recents from the sidebar data, the draft's project from session state.
 *
 * Picking moves the open draft, with everything in it, to that project
 * (`setDraftWorkspace`); with no draft open it opens one there. Adding a
 * project registers the browsed folder (`workspace.add`) and picks it: the
 * environment announces the project to every client before it answers, so it
 * is in the list here, and on web's sidebar, by then.
 */
export function useProjectSource(): ProjectSource {
  const client = useEnvironmentClient()
  const { capabilities } = useConnectionState()
  const { activeWorkspacePath, isSessionDraftOpen, newSessionDraftId, setDraftWorkspace } =
    useSessionState()
  const sidebar = useContext(SidebarDataContext)
  const workspaces = sidebar?.workspaces ?? NO_WORKSPACES
  const recents = sidebar?.recentWorkspaces ?? NO_WORKSPACES
  const createSession = sidebar?.createSession
  const environmentLabel = sidebar?.environment?.label ?? 'This environment'

  const pick = useCallback(
    (path: string) => {
      if (isSessionDraftOpen && setDraftWorkspace) setDraftWorkspace(path)
      else void createSession?.(path)
    },
    [createSession, isSessionDraftOpen, setDraftWorkspace],
  )
  // The draft and its project as they are now, for an add that answers later.
  const latest = useRef({ draftId: newSessionDraftId, workspace: activeWorkspacePath, pick })
  latest.current = { draftId: newSessionDraftId, workspace: activeWorkspacePath, pick }

  // Re-read with the handshake's capabilities: an environment that has not
  // said yet offers neither.
  const canBrowse = capabilities.length > 0 && client.supports('browseFolders')
  const canAdd = capabilities.length > 0 && client.supports('addWorkspace')
  const browse = useMemo(
    () =>
      canBrowse
        ? (path?: string, prefix?: string) => client.commands.browseFolders(path, prefix)
        : undefined,
    [canBrowse, client],
  )
  const add = useMemo(
    () =>
      canAdd
        ? async (path: string) => {
            const before = latest.current
            const workspace = await client.commands.addWorkspace({ path })
            // Picked only for the draft it was added from, and only if nothing
            // was picked since: a later choice, or another draft, stands. The
            // project is added either way.
            const now = latest.current
            if (now.draftId !== before.draftId || now.workspace !== before.workspace) return
            now.pick(workspace.workspaceId)
          }
        : undefined,
    [canAdd, client],
  )

  return useMemo(
    () => ({
      environmentLabel,
      recents,
      workspaces,
      current: activeWorkspacePath,
      pick,
      ...(browse ? { browse } : {}),
      ...(add ? { add } : {}),
    }),
    [activeWorkspacePath, add, browse, environmentLabel, pick, recents, workspaces],
  )
}
