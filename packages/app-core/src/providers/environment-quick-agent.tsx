import { useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  selectDraftContent,
  selectDraftTarget,
  type EnvironmentState,
} from '@openmanager/environment-client'
import type { UploadedImageAttachment } from '../lib/attachments'
import { ActiveThreadStateContext, type ActiveThreadStateValue } from './active-thread-provider'
import {
  DraftPageContext,
  rememberSentDraft,
  type DraftPageInternals,
  type DraftPageTarget,
} from './draft-pages'
import { EnvironmentViewActions } from './environment-application'
import { useEnvironmentClient, useEnvironmentState } from './environment-client'
import { DraftLaunchContext, EnvironmentComposerStateProvider } from './environment-composer'
import { EnvironmentComposerDraftProvider } from './environment-drafts'
import { PlanStateContext } from './plan-provider'
import { PlatformCapabilitiesContext } from './platform-provider'
import { QuestionStateContext } from './question-provider'
import { SessionStateContext, type SessionStateValue } from './session-provider'
import { useViewActions } from './view-actions'

/**
 * A new-session draft written outside the page: the quick New agent palette's.
 * Its ids are minted when the palette opens; like a blank page's, nothing is
 * saved until it gets text or an image.
 */
export interface QuickAgentDraft {
  draftId: string
  /** The id its session will get. */
  sessionId: string
  /** The project picked for it; null when there is none to pick. */
  workspaceId: string | null
}

/** What a quick draft became once sent. */
export interface QuickAgentStarted {
  draftId: string
  sessionId: string
  workspaceId: string
}

export const mintQuickAgentDraft = (workspaceId: string | null): QuickAgentDraft => ({
  draftId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  workspaceId,
})

const noop = () => undefined
const resolved = async () => undefined
const NO_MESSAGES: ActiveThreadStateValue['messages'] = []

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Serves the composer a draft of its own, apart from whatever page is on
 * screen: session state names this draft as the open one, the composer's
 * picks and draft store are scoped to it, and sending it starts its session
 * in the background, leaving the page (and its address) where they are.
 *
 * Everything else is the page's: the drafts are the environment's, so a draft
 * written here is saved, synced and listed in the sidebar like any other, and
 * the sidebar's card opens it as a page. Render inside the environment
 * providers, where `client.drafts` is served.
 */
export function QuickAgentScope({
  draft,
  onWorkspaceChange,
  onStarted,
  children,
}: {
  draft: QuickAgentDraft
  /** A project was picked for the draft. */
  onWorkspaceChange: (workspaceId: string) => void
  /** The draft was sent: its session exists and is running its first turn. */
  onStarted: (started: QuickAgentStarted) => void
  children: ReactNode
}) {
  const client = useEnvironmentClient()
  const sync = client.drafts
  const parent = useContext(SessionStateContext)!
  const parentPage = useContext(DraftPageContext)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The environment's word on where the draft goes, once it has it (another
  // device may have moved it); the palette's own pick before then.
  const environmentTarget = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) => {
        const target = selectDraftTarget(state, draft.draftId)
        return target?.type === 'new_session' ? target : undefined
      },
      [draft.draftId],
    ),
  )
  const pickedWorkspaceId = environmentTarget ? environmentTarget.workspaceId : draft.workspaceId
  const sessionId = environmentTarget?.sessionId ?? draft.sessionId
  // A project that is no longer listed is gone: the draft waits for another.
  const workspaceId = useEnvironmentState(
    useCallback(
      (state: EnvironmentState) =>
        pickedWorkspaceId && state.workspaces[pickedWorkspaceId] ? pickedWorkspaceId : null,
      [pickedWorkspaceId],
    ),
  )

  // Read by callbacks the draft store holds past this render.
  const live = useRef({ workspaceId, sessionId })
  live.current = { workspaceId, sessionId }

  const setDraftWorkspace = useCallback(
    (next: string) => {
      setError(null)
      // The draft keeps its text, images and picks; only its project changes.
      const state = client.getState()
      const target = selectDraftTarget(state, draft.draftId)
      const content = selectDraftContent(state, draft.draftId)
      if (sync && target?.type === 'new_session' && content && target.workspaceId !== next) {
        sync.edit(draft.draftId, { ...target, workspaceId: next }, content)
      }
      onWorkspaceChange(next)
    },
    [client, draft.draftId, onWorkspaceChange, sync],
  )

  const failTurn = useCallback((reason?: string) => {
    setStarting(false)
    if (reason) setError(reason)
  }, [])

  const session = useMemo<SessionStateValue>(
    () => ({
      ...parent,
      activeWorkspacePath: workspaceId,
      activeSessionId: null,
      isSessionDraftOpen: true,
      newSessionDraftId: sync ? draft.draftId : null,
      isDraftLoading: false,
      isDraftProjectRemoved: workspaceId === null,
      setDraftWorkspace,
      pendingDraftSessionStart: starting,
      // Nothing here shows a transcript, so the composer announces no launch.
      launchingMessage: undefined,
      localSessionStatus: starting ? 'starting' : null,
      adoptedDraftSessionId: null,
      draftRequest: null,
      error,
      beginDraftTurn: () => {
        setError(null)
        setStarting(true)
      },
      beginSessionTurn: noop,
      attachTurnJob: noop,
      failTurn,
    }),
    [draft.draftId, error, failTurn, parent, setDraftWorkspace, starting, sync, workspaceId],
  )

  const page = useMemo<DraftPageInternals>(
    () => ({
      pageDraftId: draft.draftId,
      pageTarget: (id: string): DraftPageTarget | undefined =>
        id === draft.draftId
          ? {
              type: 'new_session',
              workspaceId: live.current.workspaceId,
              sessionId: live.current.sessionId,
            }
          : parentPage?.pageTarget(id),
      // A quick draft has no address to take: the palette is not a page.
      claim: noop,
    }),
    [draft.draftId, parentPage],
  )

  return (
    <SessionStateContext.Provider value={session}>
      <DraftPageContext.Provider value={page}>
        <EnvironmentComposerStateProvider>
          <EnvironmentComposerDraftProvider importLocal={false}>
            <QuickAgentViewActions>
              <QuickAgentThread
                draftId={draft.draftId}
                workspaceId={workspaceId}
                error={error}
                setStarting={setStarting}
                setError={setError}
                onStarted={onStarted}
              >
                {/* The page's pending question or plan is not this composer's. */}
                <QuestionStateContext.Provider value={null}>
                  <PlanStateContext.Provider value={null}>{children}</PlanStateContext.Provider>
                </QuestionStateContext.Provider>
              </QuickAgentThread>
            </QuickAgentViewActions>
          </EnvironmentComposerDraftProvider>
        </EnvironmentComposerStateProvider>
      </DraftPageContext.Provider>
    </SessionStateContext.Provider>
  )
}

/**
 * Image uploads held for the quick draft's project rather than the page's
 * session; the host's own extras (releasing uploads, vision checks) carry over.
 */
function QuickAgentViewActions({ children }: { children: ReactNode }) {
  const { discardAttachments, getModelImageSupport } = useViewActions()
  const actions = useMemo(
    () => ({
      ...(discardAttachments ? { discardAttachments } : {}),
      ...(getModelImageSupport ? { getModelImageSupport } : {}),
    }),
    [discardAttachments, getModelImageSupport],
  )
  return <EnvironmentViewActions actions={actions}>{children}</EnvironmentViewActions>
}

/**
 * The composer's thread commands for the quick draft: sending starts its
 * session and stops there. No thread is on screen here, so nothing is
 * opened, selected or navigated to.
 */
function QuickAgentThread({
  draftId,
  workspaceId,
  error,
  setStarting,
  setError,
  onStarted,
  children,
}: {
  draftId: string
  workspaceId: string | null
  error: string | null
  setStarting: (starting: boolean) => void
  setError: (error: string | null) => void
  onStarted: (started: QuickAgentStarted) => void
  children: ReactNode
}) {
  const client = useEnvironmentClient()
  const { commands } = client
  const parent = useContext(ActiveThreadStateContext)!
  const { ensureProvider, providerDisplayName } = useContext(PlatformCapabilitiesContext)!
  const { draftLaunch, draftLaunched } = useContext(DraftLaunchContext)!
  const onStartedRef = useRef(onStarted)
  onStartedRef.current = onStarted

  const sendMessage = useCallback(
    async (content: string, attachments?: UploadedImageAttachment[]) => {
      const text = content.trim()
      // An image with no caption is still a turn.
      if (!text && !attachments?.length) {
        setStarting(false)
        return
      }
      setError(null)
      setStarting(true)
      try {
        if (!workspaceId) throw new Error('Pick a project for this agent to start it.')
        // An upload is held for the project it was stored under; one made
        // before the project was changed would be refused with the launch.
        if (
          attachments?.some(
            (attachment) =>
              attachment.sessionId !== undefined ||
              (attachment.workspaceId !== undefined && attachment.workspaceId !== workspaceId),
          )
        ) {
          throw new Error('These images were uploaded for another project. Attach them again.')
        }
        const launch = draftLaunch(workspaceId)
        const launchWorkspaceId =
          launch.workspaceId !== undefined ? launch.workspaceId : workspaceId
        if (!launchWorkspaceId) throw new Error('Pick a project for this agent to start it.')
        if (!(await ensureProvider(launch.providerId, launchWorkspaceId))) {
          throw new Error(
            `${providerDisplayName(launch.providerId)} is unavailable. Retry it from Settings.`,
          )
        }
        const environmentId = client.getState().environment?.environmentId
        if (!environmentId) throw new Error('No environment is connected')
        const kept = launch.draft
        const artifactIds = attachments?.map((attachment) => attachment.id)
        // The same command the page's send runs: the environment starts the
        // session with the draft's picks and images and deletes the draft in
        // the write that announces the session, or refuses and keeps it.
        if (kept) client.drafts?.beginLaunch(kept.draftId)
        let created: Awaited<ReturnType<typeof commands.createSession>>
        try {
          created = await commands.createSession({
            environmentId,
            workspaceId: launchWorkspaceId,
            providerId: launch.providerId,
            firstMessage: text,
            ...(launch.preference ? { preference: launch.preference } : {}),
            ...(launch.modeId !== undefined ? { modeId: launch.modeId } : {}),
            ...(artifactIds?.length ? { artifactIds } : {}),
            ...(kept ? { draftId: kept.draftId, sessionId: kept.sessionId } : {}),
          })
        } catch (err) {
          if (kept) client.drafts?.endLaunch(kept.draftId, 'refused')
          throw err
        }
        if (kept) {
          client.drafts?.endLaunch(kept.draftId, 'sent')
          // Its address, if it was ever opened as a page, leads to the session.
          rememberSentDraft(kept.draftId, created.session.sessionId)
        }
        draftLaunched(launch)
        setStarting(false)
        onStartedRef.current({
          draftId: kept?.draftId ?? draftId,
          sessionId: created.session.sessionId,
          workspaceId: launchWorkspaceId,
        })
      } catch (err) {
        setStarting(false)
        setError(message(err))
        throw err
      }
    },
    [
      client,
      commands,
      draftId,
      draftLaunch,
      draftLaunched,
      ensureProvider,
      providerDisplayName,
      setError,
      setStarting,
      workspaceId,
    ],
  )

  const value = useMemo<ActiveThreadStateValue>(
    () => ({
      ...parent,
      activeSessionId: null,
      activeThread: null,
      activeThreadDriven: false,
      isMessagesLoading: false,
      history: undefined,
      messages: NO_MESSAGES,
      error,
      sendMessage,
      retrySend: undefined,
      abortSession: resolved,
      buildPlan: resolved,
    }),
    [error, parent, sendMessage],
  )
  return (
    <ActiveThreadStateContext.Provider value={value}>{children}</ActiveThreadStateContext.Provider>
  )
}
