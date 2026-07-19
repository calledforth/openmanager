import { useEffect, useState } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import { useAppUi } from '../../providers/app-ui-provider'
import { useActiveSession } from '../../providers/active-session-provider'
import { useQuestionStateOptional } from '../../providers/question-provider'
import { ComposerQuestionPrompt } from '../questions/ComposerQuestionPrompt'
import { MessageInputView } from './MessageInputView'
import { deriveSessionChrome } from '@agentpack/view'
import { useTrackedMutation } from '../../lib/convex-telemetry'
import type { DraftImageAttachment, UploadedImageAttachment } from '../../lib/attachments'

export function MessageInput() {
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    pendingDraftSessionStart,
    localSessionStatus,
    acpSessionState,
    draftSessionState,
    setDraftModel,
    setDraftMode,
    setDraftConfigOption,
    setDraftProvider,
    setSessionModel,
    setSessionMode,
    setSessionConfigOption,
    agentUiStatusByProvider,
    defaultProviderId,
    agentEvents,
    providers,
    providerComposerProfiles,
    currentClientId,
    acpPromptCapabilitiesByProvider,
  } = useAppUi()
  const { sendMessage, abortSession, activeSession } = useActiveSession()
  const questionState = useQuestionStateOptional()
  const pendingQuestion = questionState?.pendingQuestion ?? null
  const generateUploadUrl = useTrackedMutation(
    'attachments.generateUploadUrl',
    (api as any).attachments.generateUploadUrl,
  )
  const registerAttachment = useTrackedMutation(
    'attachments.register',
    (api as any).attachments.register,
  )
  const removeAttachments = useTrackedMutation(
    'attachments.removeMany',
    (api as any).attachments.removeMany,
  )
  const [modelImageSupport, setModelImageSupport] = useState<boolean | null | undefined>(undefined)

  const disabled =
    !activeWorkspacePath || pendingDraftSessionStart || (!activeSessionId && !isSessionDraftOpen)
  const runtimeState = activeSessionId || !isSessionDraftOpen ? acpSessionState : draftSessionState
  const chrome = deriveSessionChrome(agentEvents, {
    providers,
    selectedProviderId: runtimeState?.providerId ?? defaultProviderId,
    sessionId: activeSessionId ?? undefined,
  })
  const providerOptions = chrome.providerPicker.options.map((provider) => ({
    id: provider.id,
    name: provider.label,
  }))
  const currentProviderId = chrome.providerPicker.currentProviderId ?? defaultProviderId
  const providerReady = agentUiStatusByProvider[currentProviderId] === 'connected'
  const currentProviderName =
    providerOptions.find((provider) => provider.id === currentProviderId)?.name ?? currentProviderId
  const chromeModeOptions = (chrome.modePicker?.options ?? []).map((mode) => ({
    id: mode.id,
    name: mode.label,
  }))
  const runtimeModeOptions = runtimeState?.modes?.availableModes ?? []
  const modeOptions = runtimeModeOptions.length > 0 ? runtimeModeOptions : chromeModeOptions
  const currentModeId =
    runtimeState?.modes?.currentModeId ??
    chrome.modePicker?.currentModeId ??
    modeOptions[0]?.id ??
    ''
  const chromeModelOptions = (chrome.modelPicker?.options ?? []).map((model) => ({
    id: model.id,
    name: model.label,
  }))
  const runtimeModelOptions = (runtimeState?.models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    name: model.name,
  }))
  const modelOptions = runtimeModelOptions.length > 0 ? runtimeModelOptions : chromeModelOptions
  const currentModelId =
    runtimeState?.models?.currentModelId ??
    chrome.modelPicker?.currentModelId ??
    modelOptions[0]?.id ??
    ''
  const providerModelGroups = providerOptions.map((provider) => {
    const models =
      provider.id === currentProviderId
        ? modelOptions
        : (providerComposerProfiles[provider.id]?.availableModels ?? []).map((model) => ({
            id: model.modelId,
            name: model.name,
          }))
    return {
      providerId: provider.id,
      providerName: provider.name,
      models,
    }
  })
  const canChangeSettings = !!activeSessionId || isSessionDraftOpen
  const effectiveStatus = localSessionStatus ?? activeSession?.status
  const isStreaming = effectiveStatus === 'running' || effectiveStatus === 'busy'
  const providerImageSupport = acpPromptCapabilitiesByProvider[currentProviderId]?.image
  const providerSupportsImages = providerImageSupport === true

  useEffect(() => {
    let cancelled = false
    setModelImageSupport(undefined)
    if (!currentModelId) {
      setModelImageSupport(null)
      return
    }
    window.electronAPI
      .getModelImageSupport(currentProviderId, currentModelId)
      .then((supported) => {
        if (!cancelled) setModelImageSupport(supported)
      })
      .catch(() => {
        if (!cancelled) setModelImageSupport(null)
      })
    return () => {
      cancelled = true
    }
  }, [currentModelId, currentProviderId])

  const uploadAndSend = async (text: string, drafts: DraftImageAttachment[]) => {
    // A pending single question claims the composer: sent text answers it as
    // the user's own free-text option instead of becoming a prompt.
    if (
      pendingQuestion?.questions.length === 1 &&
      pendingQuestion.questions[0].allowFreeText &&
      questionState &&
      text.trim()
    ) {
      await questionState.resolveQuestion({
        outcome: 'answered',
        answers: [{ questionId: pendingQuestion.questions[0].questionId, text: text.trim() }],
      })
      return
    }
    if (!currentClientId) throw new Error('Client identity unavailable')
    const uploaded: UploadedImageAttachment[] = []
    try {
      for (const draft of drafts) {
        const uploadUrl = (await generateUploadUrl({ clientId: currentClientId })) as string
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': draft.file.type },
          body: draft.file,
        })
        if (!response.ok) throw new Error(`Failed to upload ${draft.file.name}`)
        const result = (await response.json()) as { storageId?: string }
        if (!result.storageId)
          throw new Error(`Upload did not return storage for ${draft.file.name}`)
        const attachmentId = (await registerAttachment({
          storageId: result.storageId,
          clientId: currentClientId,
          name: draft.file.name,
          mimeType: draft.file.type,
          size: draft.file.size,
        })) as string
        uploaded.push({
          id: attachmentId,
          name: draft.file.name,
          mimeType: draft.file.type,
          size: draft.file.size,
          previewUrl: draft.previewUrl,
        })
      }
      await sendMessage(text, uploaded)
    } catch (error) {
      if (uploaded.length) {
        await removeAttachments({
          ids: uploaded.map((attachment) => attachment.id),
          clientId: currentClientId,
        }).catch(() => undefined)
      }
      throw error
    }
  }

  const draftKey = activeSessionId
    ? `session:${activeSessionId}`
    : activeWorkspacePath
      ? `draft:${activeWorkspacePath}`
      : 'no-workspace'
  const imageSupportMessage =
    providerImageSupport === undefined
      ? 'Checking whether the provider accepts image prompts…'
      : !providerSupportsImages
        ? `${currentProviderName} does not advertise image prompt support.`
        : modelImageSupport === undefined
          ? 'Checking whether the selected model can read images…'
          : modelImageSupport === false
            ? `${modelOptions.find((model) => model.id === currentModelId)?.name ?? currentModelId} cannot read images. Choose a vision-capable model.`
            : null

  return (
    <div className="flex w-full flex-col">
      <ComposerQuestionPrompt />
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
        canChangeSettings={canChangeSettings}
        canChangeProvider={isSessionDraftOpen && !activeSessionId}
        showModeControl={chrome.modePicker !== null || modeOptions.length > 0}
        showModelControl={
          chrome.modelPicker !== null ||
          modelOptions.length > 0 ||
          providerModelGroups.some((group) => group.models.length > 0)
        }
        isStreaming={isStreaming}
        draftKey={draftKey}
        imageUploadEnabled={
          providerSupportsImages && modelImageSupport !== false && modelImageSupport !== undefined
        }
        imageSupportMessage={imageSupportMessage}
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
        onAbort={() => {
          if (activeSessionId) {
            void abortSession(activeSessionId)
          }
        }}
      />
    </div>
  )
}
