import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePlatformCapabilities } from '../../providers/platform-provider'
import { useSessionState } from '../../providers/session-provider'
import { useComposerState } from '../../providers/composer-provider'
import { useActiveThreadState } from '../../providers/active-thread-provider'
import { useQuestionStateOptional } from '../../providers/question-provider'
import { usePlanStateOptional } from '../../providers/plan-provider'
import { useViewActions } from '../../providers/view-actions'
import { QuestionCard } from '../questions/ComposerQuestionPrompt'
import { useQuestionFlow } from '../questions/useQuestionFlow'
import { ComposerPlanPrompt } from '../plans/ComposerPlanPrompt'
import { ComposerTodos, useSessionPlanEntries } from '../plans/ComposerTodos'
import { cn } from '../../lib/utils'
import { composerFrame } from './chatComposerStyles'
import { MessageInputView } from './MessageInputView'
import { composerImageSupportMessage, deriveComposerControls } from './composerControls'
import type {
  DraftImageAttachment,
  KeptImage,
  UploadedImageAttachment,
} from '../../lib/attachments'

/**
 * A kept image as a send names it. Only its id reaches the environment; it
 * carries no upload scope, as it is the draft's wherever the draft goes.
 */
const keptAttachment = (image: KeptImage): UploadedImageAttachment => ({
  id: image.artifactId,
  name: image.name,
  mimeType: '',
  size: 0,
  previewUrl: image.previewUrl ?? '',
})

/**
 * The composer bound to the application providers: session navigation for
 * what is on screen, composer state for the model/mode/config selection,
 * platform capabilities for provider readiness, the active thread for
 * sending, and the question/plan panels when one is pending. Image uploads
 * and model vision checks come from the host through `ViewActions`.
 */
export function MessageInput() {
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    newSessionDraftId,
    pendingDraftSessionStart,
    localSessionStatus,
    defaultProviderId,
    launchingMessage,
    beginDraftTurn,
    failTurn,
  } = useSessionState()
  const {
    acpSessionState,
    draftSessionState,
    setDraftModel,
    setDraftMode,
    setDraftConfigOption,
    setDraftProvider,
    setSessionModel,
    setSessionMode,
    setSessionConfigOption,
    agentEvents,
    providerComposerProfiles,
    composerConfigValues,
    error: composerError,
  } = useComposerState()
  const { agentUiStatusByProvider, providers, acpPromptCapabilitiesByProvider } =
    usePlatformCapabilities()
  const {
    sendMessage,
    abortSession,
    activeThread,
    buildPlan: submitBuildPlan,
  } = useActiveThreadState()
  const { uploadAttachments, discardAttachments, getModelImageSupport } = useViewActions()
  const questionState = useQuestionStateOptional()
  const pendingQuestion = questionState?.pendingQuestion ?? null
  // Slide state lives here because both the card above and the composer below
  // it are views onto the same answer draft.
  const questionFlow = useQuestionFlow(pendingQuestion, questionState?.resolveQuestion)
  const planState = usePlanStateOptional()
  const pendingPlan = planState?.pendingPlan ?? null
  const planEntries = useSessionPlanEntries()
  const [hostModelImageSupport, setHostModelImageSupport] = useState<boolean | null | undefined>(
    undefined,
  )

  // A launching draft is not disabled: the view holds it still (no edits, no
  // second send) without dimming it, so the box does not flicker while the
  // session is created.
  const disabled = !activeWorkspacePath || (!activeSessionId && !isSessionDraftOpen)
  const {
    runtimeState,
    currentProviderId,
    currentProviderName,
    providerReady,
    providerModelGroups,
    modelOptions,
    currentModelId,
    modeOptions,
    currentModeId,
    effortLevels,
    effortOptions,
    effortConfigId,
    currentEffort,
    slashCommands,
    usage,
    canChangeSettings,
    canChangeProvider,
    showModeControl,
    showModelControl,
    isStreaming,
    providerImageSupport,
    catalogImageSupport,
    sendBlockedReason,
    planBuildModeId,
    draftKey,
  } = deriveComposerControls({
    session: {
      activeSessionId,
      activeWorkspacePath,
      isSessionDraftOpen,
      newSessionDraftId,
      defaultProviderId,
      localSessionStatus,
    },
    composer: {
      acpSessionState,
      draftSessionState,
      agentEvents,
      providerComposerProfiles,
      composerConfigValues,
    },
    platform: { providers, agentUiStatusByProvider, acpPromptCapabilitiesByProvider },
    activeThreadStatus: activeThread?.status,
  })
  // Without an uploader there is nowhere for an image to go, whatever the model says.
  const canUploadImages = !!uploadAttachments

  // The catalog answers first (see `deriveComposerControls`). Only when the
  // row is silent is the host's own lookup asked — desktop's IPC — and only a
  // host that has one; without either, the model is unknown and lets images through.
  const askHost = catalogImageSupport === undefined && !!currentModelId && !!getModelImageSupport
  useEffect(() => {
    if (!askHost) return
    let cancelled = false
    setHostModelImageSupport(undefined)
    getModelImageSupport!(currentProviderId, currentModelId)
      .then((supported) => {
        if (!cancelled) setHostModelImageSupport(supported)
      })
      .catch(() => {
        if (!cancelled) setHostModelImageSupport(null)
      })
    return () => {
      cancelled = true
    }
  }, [askHost, currentModelId, currentProviderId, getModelImageSupport])
  const modelImageSupport = catalogImageSupport ?? (askHost ? hostModelImageSupport : null)

  // Where the draft keeps its images, each is stored as it is attached.
  const uploadImage = useMemo(
    () =>
      uploadAttachments
        ? async (image: DraftImageAttachment) => {
            const [stored] = await uploadAttachments([image])
            if (!stored) throw new Error('The image was not stored.')
            return stored
          }
        : undefined,
    [uploadAttachments],
  )

  const uploadAndSend = async (
    text: string,
    drafts: DraftImageAttachment[],
    kept: KeptImage[] = [],
  ) => {
    // Questions never reach here: while one is pending the composer is replaced
    // by the question prompt, which resolves it through its own submit.
    // A pending plan turns composer text into rejection feedback rather than a
    // prompt. Question interception above keeps priority when both are pending.
    if (pendingPlan && planState && text.trim()) {
      await planState.resolvePlan({ outcome: 'rejected', reason: text.trim() })
      return
    }
    // A draft's first message is in the transcript from here, ahead of its
    // image uploads and the session's creation, with the local previews. Only
    // a host that shows the launching message is told this early.
    const launching = !activeSessionId && isSessionDraftOpen && launchingMessage !== undefined
    if (launching) {
      beginDraftTurn({
        text: text.trim(),
        images: [
          ...kept.map((image) => ({
            id: image.artifactId,
            name: image.name,
            ...(image.previewUrl ? { previewUrl: image.previewUrl } : {}),
          })),
          ...drafts.map((draft) => ({
            id: draft.id,
            name: draft.file.name,
            previewUrl: draft.previewUrl,
          })),
        ],
      })
    }
    let uploaded: UploadedImageAttachment[] = []
    if (drafts.length > 0) {
      try {
        if (!uploadAttachments) throw new Error('This host cannot upload images')
        uploaded = await uploadAttachments(drafts)
      } catch (error) {
        if (launching) failTurn()
        throw error
      }
    }
    try {
      // A kept image is already the environment's, held for this draft: it
      // goes by its id, wherever the draft has moved since it was attached.
      await sendMessage(text, [...kept.map(keptAttachment), ...uploaded])
    } catch (error) {
      if (uploaded.length && discardAttachments) {
        await discardAttachments(uploaded).catch(() => undefined)
      }
      throw error
    }
  }

  const imageSupportMessage = composerImageSupportMessage({
    canUploadImages,
    providerImageSupport,
    modelImageSupport,
    currentProviderName,
    currentModelName:
      modelOptions.find((model) => model.id === currentModelId)?.name ?? currentModelId,
  })

  // Plan execution is submitted as one ordered job: accept the review, wait
  // for the planning prompt to settle, switch mode, then start the build.
  const buildPlan = useCallback(async () => {
    if (!activeSessionId || !pendingPlan) return
    await submitBuildPlan(activeSessionId, pendingPlan.requestId, planBuildModeId)
  }, [activeSessionId, pendingPlan, planBuildModeId, submitBuildPlan])

  useEffect(() => {
    if (!planState) return
    planState.setBuildHandler(buildPlan)
    return () => planState.setBuildHandler(null)
  }, [buildPlan, planState])

  // A question card or the todo list sits on top of the composer, and the
  // three share one floating card.
  const attachedTop = planEntries.length > 0 || !!questionFlow

  return (
    <div className="flex w-full flex-col">
      {questionFlow ? null : <ComposerPlanPrompt />}
      <div className={cn('flex w-full flex-col', attachedTop && composerFrame)}>
        {questionFlow ? <QuestionCard flow={questionFlow} /> : null}
        <ComposerTodos entries={planEntries} />
        <MessageInputView
          disabled={disabled}
          pendingDraftSessionStart={pendingDraftSessionStart}
          activeWorkspacePath={activeWorkspacePath}
          activeSessionId={activeSessionId}
          isSessionDraftOpen={isSessionDraftOpen}
          providerReady={providerReady}
          currentProviderId={currentProviderId}
          providerModelGroups={providerModelGroups}
          currentModelId={currentModelId}
          configOptions={runtimeState?.configOptions ?? []}
          modeOptions={modeOptions}
          currentModeId={currentModeId}
          effortLevels={effortLevels}
          {...(effortOptions ? { effortOptions } : {})}
          effortConfigId={effortConfigId}
          currentEffort={currentEffort}
          canChangeSettings={canChangeSettings}
          canChangeProvider={canChangeProvider}
          showModeControl={showModeControl}
          showModelControl={showModelControl}
          isStreaming={isStreaming}
          isAwaitingPlanReview={!!pendingPlan}
          textOverride={
            questionFlow
              ? {
                  value: questionFlow.text,
                  onChange: questionFlow.setText,
                  placeholder: questionFlow.onReview
                    ? 'Press Enter to submit your answers'
                    : 'Describe another answer…',
                  onSubmit: questionFlow.advance,
                  canSubmit: questionFlow.canAdvance,
                  // Nothing on the review slide owns free text.
                  readOnly: questionFlow.onReview,
                }
              : undefined
          }
          attachedTop={attachedTop}
          draftKey={draftKey}
          imageUploadEnabled={
            canUploadImages &&
            providerImageSupport === true &&
            modelImageSupport !== false &&
            modelImageSupport !== undefined
          }
          imageSupportMessage={imageSupportMessage}
          settingsError={composerError}
          sendBlockedReason={sendBlockedReason}
          slashCommands={slashCommands}
          usage={usage}
          onModeChange={(id) => {
            if (activeSessionId) {
              void setSessionMode(activeSessionId, id)
              return
            }
            setDraftMode(id)
          }}
          onProviderModelChange={(providerId, modelId) => {
            if (activeSessionId) {
              if (providerId === currentProviderId) {
                void setSessionModel(activeSessionId, modelId)
              }
              return
            }
            if (providerId !== currentProviderId) {
              setDraftProvider(providerId, modelId)
              return
            }
            setDraftModel(modelId)
          }}
          onConfigOptionChange={(configId, value) => {
            if (activeSessionId) {
              void setSessionConfigOption(activeSessionId, configId, value)
              return
            }
            setDraftConfigOption(configId, value)
          }}
          onSend={uploadAndSend}
          {...(uploadImage ? { uploadImage } : {})}
          onAbort={() => {
            if (activeSessionId) {
              void abortSession(activeSessionId)
            }
          }}
        />
      </div>
    </div>
  )
}
