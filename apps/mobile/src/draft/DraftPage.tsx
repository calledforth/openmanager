import { useCallback, useContext, useMemo, useState } from 'react'
import {
  SidebarDataContext,
  useActiveThreadState,
  useSessionState,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'

import { LiveComposer } from '../composer/LiveComposer'
import { createComposerUi } from '../composer/ui-state'
import { draftSendBlocked } from '../composer/useLiveComposerModel'
import { SessionThread } from '../session/SessionThread'
import { NewSessionLanding } from './NewSessionLanding'
import { useProjectSource } from './useProjectSource'

const NO_WORKSPACES: WorkspaceEntry[] = []

/**
 * A new session's page: the draft the shared session state holds for the
 * new-session page in front (blank at `/draft/new`, a draft's own at
 * `/draft/<id>`), written in the composer, its project picked from the
 * landing or the composer's tray. Sending creates the session
 * (`session.create`) with the draft's project and picks; its first message
 * shows here from the send, as web's landing shows it, and the page then
 * gives way to the session's own.
 */
export function DraftPage() {
  const session = useSessionState()
  const { activeWorkspacePath, isDraftLoading, pendingDraftSessionStart } = session
  const sidebar = useContext(SidebarDataContext)
  const workspaces = sidebar?.workspaces ?? NO_WORKSPACES
  const workspace = workspaces.find((entry) => entry.path === activeWorkspacePath)
  // The launch row while the session is created, then the session's own
  // first message for the moment before its page takes this one's place.
  const { messages } = useActiveThreadState()
  const projects = useProjectSource()
  const [ui] = useState(() => createComposerUi())
  const openPicker = useCallback(() => ui.open({ kind: 'project' }), [ui])
  const openAdd = useCallback(() => ui.open({ kind: 'project', browse: true }), [ui])
  const projectName = workspace?.name ?? null

  const composer = useMemo(
    () => <LiveComposer sessionId={null} ui={ui} contextName={projectName} projects={projects} />,
    [projectName, projects, ui],
  )
  const empty = (
    <NewSessionLanding
      environmentLabel={sidebar?.environment?.label ?? null}
      workspace={workspace}
      hasProjects={workspaces.length > 0}
      loading={!!sidebar?.isWorkspacesLoading || !!isDraftLoading}
      note={pendingDraftSessionStart ? 'Starting session…' : draftSendBlocked(session, workspace)}
      onPick={openPicker}
      {...(projects.add && projects.browse ? { onAdd: openAdd } : {})}
    />
  )

  return (
    <SessionThread
      title="New session"
      project={messages.length > 0 ? (projectName ?? undefined) : undefined}
      status={null}
      messages={messages}
      phase="ready"
      empty={empty}
      composer={composer}
    />
  )
}
