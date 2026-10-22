import { useCallback, useMemo, useState } from 'react'
import {
  composerImageSupportMessage,
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
  type FavoriteModelKey,
  type UploadedImageAttachment,
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

/**
 * The live composer's model, for `LiveComposer` and the tests. `port` must be
 * kept current by a `ThreadBridge` rendered beside whatever reads this.
 */
export function useLiveComposerModel(sessionId: string): {
  model: ComposerModel
  port: ThreadPort
} {
  const client = useEnvironmentClient()
  const { status: connection } = usePhoneConnection()
  const { activeSessionId } = useSessionState()
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
      : activeSessionId !== sessionId
        ? 'Opening the session…'
        : null
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

  const send = useCallback(
    async (text: string, attachments: UploadedImageAttachment[]) => {
      // A pending plan turns the field into a change request, as on web.
      if (pendingPlan && planState && text.trim()) {
        await planState.resolvePlan({ outcome: 'rejected', reason: text.trim() })
        return
      }
      await port.send(text, attachments)
    },
    [pendingPlan, planState, port],
  )
  const draft = useComposerDraft({
    // The page's own session, whatever the client has open: text typed
    // while it opens (or after the page lets it go) stays in its draft.
    draftKey: `session:${sessionId}`,
    imageUploadEnabled,
    imageSupportMessage,
    ports: useMemo(() => ({ uploadAttachments, send }), [send, uploadAttachments]),
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
    sendBlockedReason: controls.sendBlockedReason,
    imageProblem: imageUploadEnabled ? null : imageSupportMessage,
    planReview,
    hasImages: draft.images.length > 0,
  })

  const placeholder = !controls.providerReady
    ? `Connecting to ${controls.currentProviderName}…`
    : planReview
      ? 'Describe what should change in the plan…'
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
      enabled: imageUploadEnabled && !planReview && !unavailable,
      reason:
        unavailable ??
        (planReview ? 'Change requests for a plan take text only' : null) ??
        (imageUploadEnabled ? null : imageSupportMessage),
    },
    primary,
    isStreaming: controls.isStreaming,
    notice: draft.error ?? stopError ?? binding.error,
    prompt,
    project: null,
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
