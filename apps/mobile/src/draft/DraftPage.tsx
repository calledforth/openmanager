import { useNavigation } from 'expo-router'
import { TrashIcon } from 'phosphor-react-native'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { TextInput } from 'react-native'
import {
  SidebarDataContext,
  useActiveThreadState,
  useEnvironmentState,
  useSessionState,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'
import { useSidebarDrafts } from '@openmanager/app-core/providers/sidebar-provider'
import type { EnvironmentState } from '@openmanager/environment-client'

import { ComposerPage } from '../composer/ComposerPage'
import { ComposerSurface } from '../composer/ComposerSurface'
import { ThreadBridge } from '../composer/thread-port'
import { createComposerUi } from '../composer/ui-state'
import { draftSendBlocked, useLiveComposerModel } from '../composer/useLiveComposerModel'
import { SessionThread } from '../session/SessionThread'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { discardHandoff, draftDiscardable } from './discard-handoff'
import { NewSessionHead, StartWithProject } from './NewSessionLanding'
import { useProjectSource } from './useProjectSource'

const NO_WORKSPACES: WorkspaceEntry[] = []

/** Longer than the stack's slide, for a page that opened without one (a link, a relaunch). */
const ARRIVAL_FALLBACK_MS = 600

/**
 * The page has finished sliding in. Android refuses the keyboard to a field
 * focused mid-transition, leaving it focused with nothing to type on.
 */
function useScreenArrived(): boolean {
  const navigation = useNavigation()
  const [arrived, setArrived] = useState(false)
  useEffect(() => {
    const arrive = () => setArrived(true)
    const timer = setTimeout(arrive, ARRIVAL_FALLBACK_MS)
    const unsubscribe = (
      navigation as unknown as { addListener(event: string, run: () => void): () => void }
    ).addListener('transitionEnd', arrive)
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [navigation])
  return arrived
}

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
 * `/draft/<id>`), written on the page itself under the project it goes to,
 * the keyboard up from the start. Sending creates the session
 * (`session.create`) with the draft's project and picks; its first message
 * shows here from the send over the dock, as web's landing shows it, and the
 * page then gives way to the session's own.
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
  const { model, port } = useLiveComposerModel(null)
  const projects = useProjectSource()
  const input = useRef<TextInput>(null)
  const [trayHeight, setTrayHeight] = useState(0)
  const arrived = useScreenArrived()
  const [ui] = useState(() => createComposerUi())
  const openPicker = useCallback(() => ui.open({ kind: 'project' }), [ui])
  const openAdd = useCallback(() => ui.open({ kind: 'project', browse: true }), [ui])
  const projectName = workspace?.name ?? null
  const draftId = session.newSessionDraftId ?? null
  const canDiscard = useEnvironmentState(
    useCallback((state: EnvironmentState) => draftDiscardable(state, draftId), [draftId]),
  )
  const discardable = !!useSidebarDrafts() && canDiscard && !pendingDraftSessionStart

  const environmentLabel = sidebar?.environment?.label ?? null
  const loading = !!sidebar?.isWorkspacesLoading || !!isDraftLoading
  const empty =
    loading || workspaces.length > 0 ? (
      <ComposerPage
        model={model}
        ui={ui}
        input={input}
        ready={arrived && !!workspace && !loading && model.text.length === 0}
        onTrayHeight={setTrayHeight}
        head={
          <NewSessionHead
            environmentLabel={environmentLabel}
            workspace={workspace}
            loading={loading}
            note={
              pendingDraftSessionStart ? 'Starting session…' : draftSendBlocked(session, workspace)
            }
            onPick={openPicker}
          />
        }
      />
    ) : (
      <StartWithProject
        environmentLabel={environmentLabel}
        {...(projects.add && projects.browse ? { onAdd: openAdd } : {})}
      />
    )
  // Once the first message shows, the page is a session's: the dock takes over.
  const composer = (
    <>
      <ThreadBridge port={port} />
      <ComposerSurface
        model={model}
        ui={ui}
        projects={projects}
        page={messages.length === 0 ? { input, trayHeight } : null}
      />
    </>
  )

  return (
    <SessionThread
      title="New session"
      project={messages.length > 0 ? (projectName ?? undefined) : undefined}
      projectId={messages.length > 0 ? (workspace?.path ?? null) : null}
      status={null}
      messages={messages}
      phase="ready"
      empty={empty}
      headerAction={discardable && draftId ? <DiscardButton draftId={draftId} /> : undefined}
      composer={composer}
    />
  )
}
