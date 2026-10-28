import { TrashIcon } from 'phosphor-react-native'
import { useCallback, useContext, useMemo, useState } from 'react'
import {
  SidebarDataContext,
  useActiveThreadState,
  useEnvironmentState,
  useSessionState,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'
import { useSidebarDrafts } from '@openmanager/app-core/providers/sidebar-provider'
import type { EnvironmentState } from '@openmanager/environment-client'

import { LiveComposer } from '../composer/LiveComposer'
import { createComposerUi } from '../composer/ui-state'
import { draftSendBlocked } from '../composer/useLiveComposerModel'
import { SessionThread } from '../session/SessionThread'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { discardHandoff, draftDiscardable } from './discard-handoff'
import { NewSessionLanding } from './NewSessionLanding'
import { useProjectSource } from './useProjectSource'

const NO_WORKSPACES: WorkspaceEntry[] = []

/**
 * Discard, in the header's corner: back to the sessions home, where the
 * draft's row is gone with an Undo beside the Drafts tab.
 */
function DiscardButton({ draftId }: { draftId: string }) {
  const theme = usePhoneTheme()
  const goBack = useGoBack()
  return (
    <IconButton
      label="Discard draft"
      onPress={() => {
        discardHandoff.request(draftId)
        goBack()
      }}
    >
      <TrashIcon size={18} color={theme.fg} />
    </IconButton>
  )
}

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
  const draftId = session.newSessionDraftId ?? null
  const canDiscard = useEnvironmentState(
    useCallback((state: EnvironmentState) => draftDiscardable(state, draftId), [draftId]),
  )
  const discardable = !!useSidebarDrafts() && canDiscard && !pendingDraftSessionStart

  // The pulled-up composer names no project in its bar: the tray's project
  // pick does, and picks another from there.
  const composer = useMemo(
    () => <LiveComposer sessionId={null} ui={ui} contextName={null} projects={projects} />,
    [projects, ui],
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
      headerAction={discardable && draftId ? <DiscardButton draftId={draftId} /> : undefined}
      composer={composer}
    />
  )
}
