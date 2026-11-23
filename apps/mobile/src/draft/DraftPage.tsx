import { router, useNavigation } from 'expo-router'
import { TrashIcon } from 'phosphor-react-native'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { TextInput } from 'react-native'
import {
  isNoProject,
  noProjectOf,
  SidebarDataContext,
  useActiveThreadState,
  userProjects,
  useEnvironmentState,
  useSessionState,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'
import { useSidebarDrafts } from '@openmanager/app-core/providers/sidebar-provider'
import type { EnvironmentState } from '@openmanager/environment-client'

import { ComposerPage } from '../composer/ComposerPage'
import { ComposerSurface } from '../composer/ComposerSurface'
import { ThreadBridge } from '../composer/thread-port'
import { createComposerUi, useComposerUiState, type ComposerUi } from '../composer/ui-state'
import { draftSendBlocked, useLiveComposerModel } from '../composer/useLiveComposerModel'
import { BLANK_DRAFT } from '../environment/landing-route'
import {
  usePageEnvironmentId,
  usePhoneConnectionController,
} from '../environment/PhoneEnvironmentProvider'
import { useHomeSource } from '../home/source'
import { SessionThread, type HeaderAction } from '../session/SessionThread'
import { useGoBack } from '../ui/goBack'
import { discardHandoff, draftDiscardable } from './discard-handoff'
import { environmentReachable, useDraftMover, useDraftMoveNotice } from './DraftMoveHost'
import { EnvironmentSheet, type EnvironmentChoice } from './EnvironmentSheet'
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
 * Discard, in the title's menu: back to the sessions home, where the
 * draft's row is gone with an Undo beside the Drafts tab.
 */
function useDiscardAction(draftId: string | null, discardable: boolean): HeaderAction[] {
  const goBack = useGoBack()
  const environmentId = usePageEnvironmentId()
  return useMemo(
    () =>
      discardable && draftId
        ? [
            {
              id: 'discard-draft',
              label: 'Discard draft',
              icon: TrashIcon,
              destructive: true,
              run: () => {
                // Through this page's environment: the same id elsewhere is another draft.
                if (environmentId) discardHandoff.request({ environmentId, draftId })
                goBack()
              },
            },
          ]
        : [],
    [discardable, draftId, environmentId, goBack],
  )
}

/**
 * The environment a new session runs on, picked on its page when several are
 * saved, as web's new-session page picks it. Picking another moves the page
 * there (`environment-move.ts`): what is written starts a new draft in that
 * environment's last picked project, the original goes once the copy is
 * saved, and its images stay where they were uploaded. The pick also becomes
 * where the next new session goes. Not while the draft is being sent.
 */
function useEnvironmentChoice({
  ui,
  draftId,
  hasText,
  starting,
}: {
  ui: ComposerUi
  /** The page's draft, saved or not. */
  draftId: string | null
  hasText: boolean
  starting: boolean
}) {
  const environmentId = usePageEnvironmentId()
  const controller = usePhoneConnectionController()
  const mover = useDraftMover()
  const { environments } = useHomeSource()
  const { overlay } = useComposerUiState(ui)
  const choices = useMemo<EnvironmentChoice[]>(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        tone: environment.tone,
        reachable: environmentReachable(controller, environment.environmentId),
        words: environment.words,
      })),
    [controller, environments],
  )
  const pick = useCallback(
    (next: string) => {
      ui.close()
      if (!environmentId || !mover) return
      const result = mover.choose(next, draftId ? { draftId, environmentId } : null)
      if (result.kind === 'refused') {
        if (result.reason) mover.tell(result.reason)
        return
      }
      controller.selectEnvironment(next)
      router.setParams({ environmentId: next, draftId: result.draftId ?? BLANK_DRAFT })
    },
    [controller, draftId, environmentId, mover, ui],
  )
  const offered = environments.length > 1 && environmentId !== null && !!mover && !starting
  const open = useCallback(() => ui.open({ kind: 'environment' }), [ui])
  return {
    open: offered ? open : undefined,
    sheet:
      offered && overlay?.kind === 'environment' ? (
        <EnvironmentSheet
          environments={choices}
          current={environmentId}
          hasText={hasText}
          onPick={pick}
          onClose={ui.close}
        />
      ) : null,
  }
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
  const source = useProjectSource()
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
  const headerActions = useDiscardAction(draftId, discardable)

  const environmentLabel = sidebar?.environment?.label ?? null
  const choice = useEnvironmentChoice({
    ui,
    draftId,
    hasText: model.text.trim().length > 0,
    starting: pendingDraftSessionStart,
  })
  const moveNotice = useDraftMoveNotice()
  const mover = useDraftMover()
  const dismissNotice = moveNotice ? () => mover?.dismiss(moveNotice.key) : undefined
  // The project sheet names the environment, and offers another where there is one.
  const projects = useMemo(
    () => (choice.open ? { ...source, pickEnvironment: choice.open } : source),
    [choice.open, source],
  )
  const loading = !!sidebar?.isWorkspacesLoading || !!isDraftLoading
  // "No project" is offered beside the user's projects, never counted as one:
  // with none of theirs, the page asks first, unless the draft is already there.
  const noProject = noProjectOf(workspaces)
  const empty =
    loading || userProjects(workspaces).length > 0 || isNoProject(workspace) ? (
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
            recents={source.recents}
            onPick={openPicker}
            onPickRecent={source.pick}
            onPickEnvironment={choice.open}
            notice={moveNotice?.message ?? null}
            onDismissNotice={dismissNotice}
          />
        }
      />
    ) : (
      <StartWithProject
        environmentLabel={environmentLabel}
        {...(projects.add && projects.browse ? { onAdd: openAdd } : {})}
        {...(noProject ? { onStartWithoutProject: () => projects.pick(noProject.path) } : {})}
        onPickEnvironment={choice.open}
        notice={moveNotice?.message ?? null}
        onDismissNotice={dismissNotice}
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
      {choice.sheet}
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
      headerActions={headerActions}
      composer={composer}
    />
  )
}
