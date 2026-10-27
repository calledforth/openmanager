import { useCallback, useContext, useMemo, useRef, useState } from 'react'
import {
  composerImageSupportMessage,
  SidebarDataContext,
  configurableSessionOptions,
  readFavoriteModels,
  toggleFavoriteModel,
  useDeviceStorage,
  useEnvironmentClient,
  useEnvironmentState,
  usePlanStateOptional,
  useSessionState,
  useViewActions,
  writeFavoriteModels,
  type DraftImageAttachment,
  type FavoriteModelKey,
  type SessionStateValue,
  type UploadedImageAttachment,
  type WorkspaceEntry,
} from '@openmanager/app-core/logic'
import { selectActiveTurn, type EnvironmentState } from '@openmanager/environment-client'

import { usePhoneConnection } from '../environment/PhoneEnvironmentProvider'
import { choiceLabel, primaryAction, type ComposerModel } from './model'
import { effortChoicesOf, modeChoicesOf, picksOf } from './controls-view'
import { useThreadPort, type ThreadPort } from './thread-port'
import { useComposerControls } from './useComposerControls'
import { useComposerDraft } from './useComposerDraft'
import { useComposerPrompt } from './useComposerPrompt'

const selectActiveTurnId = (state: EnvironmentState) => selectActiveTurn(state)?.turnId ?? null

const reasonOf = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

const NO_WORKSPACES: WorkspaceEntry[] = []

/**
 * Why a new session's draft cannot be written in at all right now: it is
 * still being found, or its session has just been created. Null when it can.
 */
export function draftUnavailable(
  session: Pick<SessionStateValue, 'activeSessionId' | 'isSessionDraftOpen' | 'isDraftLoading'>,
): string | null {
  if (session.activeSessionId !== null) return 'Opening the session…'
  if (session.isDraftLoading || !session.isSessionDraftOpen) return 'Opening the draft…'
  return null
}

/**
 * Why a new session's draft cannot be sent as it stands, though it can be
 * written and its picks changed: it has no project, or its project is gone.
 * As web's landing says it.
 */
export function draftSendBlocked(
  session: Pick<SessionStateValue, 'activeWorkspacePath' | 'isDraftProjectRemoved'>,
  workspace: WorkspaceEntry | undefined,
): string | null {
  if (session.isDraftProjectRemoved) {
    return 'This draft’s project was removed. Pick another to send it.'
  }
  if (!session.activeWorkspacePath) return 'Pick a project to start the session'
  if (workspace && (workspace.missing || (workspace.availability ?? 'available') !== 'available')) {
    return `${workspace.name} is unavailable. Pick another project to send this draft.`
  }
  return null
}

/**
 * The live composer's model, for `LiveComposer` and the tests. `port` must be
 * kept current by a `ThreadBridge` rendered beside whatever reads this.
 *
 * `sessionId` is the page's session; null is a new session's draft, the one
 * the shared session state holds for the new-session page in front: its
 * picks are the draft's, its send creates the session (`session.create`),
 * and its project is picked from the composer.
 */
export function useLiveComposerModel(sessionId: string | null): {
  model: ComposerModel
  port: ThreadPort
} {
  const client = useEnvironmentClient()
  const { status: connection } = usePhoneConnection()
  const session = useSessionState()
  const { activeSessionId, activeWorkspacePath, beginDraftTurn, failTurn } = session
  const isDraft = sessionId === null
  const workspaces = useContext(SidebarDataContext)?.workspaces ?? NO_WORKSPACES
  const workspace = isDraft
    ? workspaces.find((entry) => entry.path === activeWorkspacePath)
    : undefined
  // Where the shared uploader stores, as of this render (it reads its own the
  // same way): the session, or for a draft the project it is held for.
  const owner = isDraft
    ? activeSessionId === null && activeWorkspacePath
      ? `draft:${activeWorkspacePath}`
      : null
    : activeSessionId
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const { port, status: threadStatus } = useThreadPort()
  const binding = useComposerControls(threadStatus)
  const { controls } = binding
  const { uploadAttachments } = useViewActions()
  const planState = usePlanStateOptional()
  const pendingPlan = planState?.pendingPlan ?? null
  const activeTurnId = useEnvironmentState(selectActiveTurnId)
  const storage = useDeviceStorage()
  const [favorites, setFavorites] = useState<FavoriteModelKey[]>(() =>
    readFavoriteModels(undefined, storage),
  )

  const unavailable =
    connection !== 'connected'
      ? 'Not connected to its environment'
      : isDraft
        ? draftUnavailable(session)
        : activeSessionId !== sessionId
          ? 'Opening the session…'
          : null
  const sendBlocked = isDraft
    ? (draftSendBlocked(session, workspace) ?? controls.sendBlockedReason)
    : controls.sendBlockedReason
  const modes = modeChoicesOf(controls)
  const buildModeLabel = controls.planBuildModeId
    ? choiceLabel(controls.modeOptions, controls.planBuildModeId)
    : null

  const planBuildModeId = controls.planBuildModeId
  const build = useCallback(
    (requestId: string) =>
      activeSessionId
        ? port.buildPlan(activeSessionId, requestId, planBuildModeId)
        : Promise.resolve(),
    [activeSessionId, planBuildModeId, port],
  )
  const prompt = useComposerPrompt({ build: activeSessionId ? build : null, buildModeLabel })

  // The catalog's answer, when it has one; the phone has no lookup of its own.
  const modelImageSupport = controls.catalogImageSupport ?? null
  const canUploadImages = !!uploadAttachments
  const imageSupportMessage = composerImageSupportMessage({
    canUploadImages,
    providerImageSupport: controls.providerImageSupport,
    modelImageSupport,
    currentProviderName: controls.currentProviderName,
    currentModelName:
      controls.modelOptions.find((model) => model.id === controls.currentModelId)?.name ??
      controls.currentModelId,
  })
  const imageUploadEnabled =
    canUploadImages && controls.providerImageSupport === true && modelImageSupport !== false
  // A draft's images are held for its project until the launch claims them.
  const attachBlocked = isDraft && !activeWorkspacePath ? 'Pick a project to attach images' : null

  // As web's composer: a draft's first message is on screen from the send,
  // ahead of its uploads and its session's creation (the shared launch row).
  const launching = isDraft && session.launchingMessage !== undefined

  const send = useCallback(
    async (text: string, attachments: UploadedImageAttachment[]) => {
      // A pending plan turns the field into a change request, as on web.
      if (pendingPlan && planState && text.trim()) {
        await planState.resolvePlan({ outcome: 'rejected', reason: text.trim() })
        return
      }
      if (!launching) {
        await port.send(text, attachments)
        return
      }
      beginDraftTurn({
        text: text.trim(),
        images: attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
        })),
      })
      try {
        await port.send(text, attachments)
      } catch (error) {
        // Refused before the shared send ran (no thread state yet): the echo goes.
        failTurn()
        throw error
      }
    },
    [beginDraftTurn, failTurn, launching, pendingPlan, planState, port],
  )
  const draft = useComposerDraft({
    // The page's own session, whatever the client has open: text typed
    // while it opens (or after the page lets it go) stays in its draft. A
    // new session's draft is the shared one (`new:<draftId>`), synced with
    // the environment's drafts as web's is.
    draftKey: isDraft ? controls.draftKey : `session:${sessionId}`,
    imageUploadEnabled,
    imageSupportMessage,
    ports: useMemo(
      () => ({
        uploadAttachments,
        send,
        uploadOwner: () => ownerRef.current,
        // The environment's uploader, with the session named: the one the
        // photo was attached in, not whatever is open when it runs. A
        // draft's go through the shared uploader, held for its project.
        ...(!isDraft && uploadAttachments && client.uploadArtifact
          ? {
              uploadFor: async (owner: string, drafts: DraftImageAttachment[]) => {
                const stored: UploadedImageAttachment[] = []
                for (const draft of drafts) {
                  const artifact = await client.uploadArtifact!({
                    sessionId: owner,
                    name: draft.file.name,
                    mimeType: draft.file.type,
                    bytes: draft.file,
                  })
                  stored.push({
                    id: artifact.artifactId,
                    name: artifact.name,
                    mimeType: artifact.mimeType,
                    size: artifact.sizeBytes,
                    previewUrl: draft.previewUrl,
                    sessionId: owner,
                  })
                }
                return stored
              },
            }
          : {}),
      }),
      [client, isDraft, send, uploadAttachments],
    ),
  })

  const [stopError, setStopError] = useState<string | null>(null)
  const interrupt = useCallback(() => {
    if (!activeSessionId) return
    setStopError(null)
    port.abort(activeSessionId).catch((error: unknown) => {
      setStopError(reasonOf(error, 'The turn was not stopped'))
    })
  }, [activeSessionId, port])

  const toggleFavorite = useCallback(
    (key: FavoriteModelKey) => {
      setFavorites((current) => {
        const next = toggleFavoriteModel(current, key)
        writeFavoriteModels(next, undefined, storage)
        return next
      })
    },
    [storage],
  )

  const hasContent = draft.text.trim().length > 0 || draft.images.length > 0
  const planReview = !!pendingPlan
  const primary = primaryAction({
    isStreaming: controls.isStreaming,
    canInterrupt: activeTurnId !== null && client.supports('interruptTurn'),
    hasContent: planReview ? draft.text.trim().length > 0 : hasContent,
    sending: draft.sending,
    uploading: draft.uploading,
    unavailable,
    sendBlockedReason: sendBlocked,
    imageProblem: imageUploadEnabled ? null : imageSupportMessage,
    planReview,
    hasImages: draft.images.length > 0,
  })

  const placeholder = !controls.providerReady
    ? `Connecting to ${controls.currentProviderName}…`
    : planReview
      ? 'Describe what should change in the plan…'
      : isDraft
        ? 'What should we build?'
        : 'Ask anything…'

  const model: ComposerModel = {
    picks: picksOf(controls, unavailable),
    groups: controls.providerModelGroups,
    currentModelId: controls.currentModelId,
    canChangeProvider: controls.canChangeProvider,
    modeChoices: modes.choices,
    effortChoices: effortChoicesOf(controls),
    settings: configurableSessionOptions(controls.runtimeState?.configOptions),
    slashCommands: controls.slashCommands,
    favorites,
    text: draft.text,
    placeholder,
    images: draft.images,
    attach: {
      enabled: imageUploadEnabled && !planReview && !unavailable && !attachBlocked,
      reason:
        unavailable ??
        attachBlocked ??
        (planReview ? 'Change requests for a plan take text only' : null) ??
        (imageUploadEnabled ? null : imageSupportMessage),
    },
    primary,
    isStreaming: controls.isStreaming,
    notice: draft.error ?? stopError ?? binding.error,
    prompt,
    project: isDraft
      ? {
          name: workspace?.name ?? 'Pick a project',
          workspaceId: workspace?.path ?? null,
          pickable: true,
        }
      : null,
    setText: draft.setText,
    send: () => void draft.send(),
    interrupt,
    attachPhoto: (photo) => void draft.attachPhoto(photo),
    removeImage: draft.removeImage,
    pickModel: binding.pickModel,
    pickMode: binding.pickMode,
    pickEffort: (value) => binding.setSetting(controls.effortConfigId, value),
    setSetting: binding.setSetting,
    toggleFavorite,
  }

  return { model, port }
}
