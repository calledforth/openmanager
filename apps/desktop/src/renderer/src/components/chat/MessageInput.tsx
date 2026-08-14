import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import { providerBlocksComposer, useAppUi } from '../../providers/app-ui-provider'
import { useActiveSession } from '../../providers/active-session-provider'
import { useSidebarData } from '../../providers/sidebar-data-provider'
import { QuickLaunchBar } from './QuickLaunchBar'
import { resolveComposerTarget } from './composerTarget'
import { useQuestionStateOptional } from '../../providers/question-provider'
import { usePlanStateOptional } from '../../providers/plan-provider'
import { QuestionCard } from '../questions/ComposerQuestionPrompt'
import { useQuestionFlow } from '../questions/useQuestionFlow'
import { ComposerPlanPrompt } from '../plans/ComposerPlanPrompt'
import { ComposerTodos, useSessionPlanEntries } from '../plans/ComposerTodos'
import { MessageInputView } from './MessageInputView'
import { deriveSessionChrome } from '@agentpack/view'
import { useTrackedMutation } from '../../lib/convex-telemetry'
import {
  buildProviderModelGroups,
  metadataModeOptions,
  metadataModelOptions,
  type ComposerModelChoice,
} from './providerModelGroups'
import {
  promptAttachment,
  type DraftImageAttachment,
  type UploadedImageAttachment,
} from '../../lib/attachments'

export function MessageInput() {
  const {
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    quickLaunchWorkspacePath,
    openQuickLaunch,
    closeQuickLaunch,
    launchSession,
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
    buildPlan: submitBuildPlan,
    agentUiStatusByProvider,
    defaultProviderId,
    agentEvents,
    providers,
    providerComposerProfiles,
    currentClientId,
    acpPromptCapabilitiesByProvider,
    composerConfigValues,
  } = useAppUi()
  const { sendMessage, abortSession, activeSession } = useActiveSession()
  const questionState = useQuestionStateOptional()
  const pendingQuestion = questionState?.pendingQuestion ?? null
  // Slide state lives here because both the card above and the composer below
  // it are views onto the same answer draft.
  const questionFlow = useQuestionFlow(pendingQuestion, questionState?.resolveQuestion)
  const planState = usePlanStateOptional()
  const pendingPlan = planState?.pendingPlan ?? null
  const planEntries = useSessionPlanEntries()
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
  const { workspaces } = useSidebarData()
  /** Name of the project a session was just launched into, shown briefly in the
   * quick-launch strip. The launch is silent by design — nothing navigates —
   * so this is the only acknowledgement the user gets. */
  const [launchedInto, setLaunchedInto] = useState<string | null>(null)
  const launchedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Quick launch aims the composer at another project. Everything below reads
  // the resolved target rather than the active session directly, so one flag
  // flips the whole surface — settings, draft, send target — without needing a
  // second composer.
  const {
    quickLaunch: quickLaunchOpen,
    workspacePath: composerWorkspacePath,
    sessionId: composerSessionId,
    draftOpen: composerDraftOpen,
    draftKey,
  } = resolveComposerTarget({
    activeSessionId,
    activeWorkspacePath,
    isSessionDraftOpen,
    quickLaunchWorkspacePath,
  })

  const disabled = quickLaunchOpen
    ? !composerWorkspacePath
    : !activeWorkspacePath || pendingDraftSessionStart || (!activeSessionId && !isSessionDraftOpen)
  const runtimeState = composerSessionId || !composerDraftOpen ? acpSessionState : draftSessionState
  const chrome = deriveSessionChrome(agentEvents, {
    providers,
    selectedProviderId: runtimeState?.providerId ?? defaultProviderId,
    sessionId: composerSessionId ?? undefined,
  })
  const providerOptions = chrome.providerPicker.options.map((provider) => ({
    id: provider.id,
    name: provider.label,
  }))
  const currentProviderId = chrome.providerPicker.currentProviderId ?? defaultProviderId
  const providerReady = !providerBlocksComposer(agentUiStatusByProvider[currentProviderId])
  const currentProviderName =
    providerOptions.find((provider) => provider.id === currentProviderId)?.name ?? currentProviderId
  const chromeModelOptions = (chrome.modelPicker?.options ?? []).map((model) => ({
    id: model.id,
    name: model.label,
    ...(model.description ? { description: model.description } : {}),
  }))
  const runtimeModelOptions = (runtimeState?.models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    ...(model.effortLevels?.length ? { effortLevels: model.effortLevels } : {}),
    ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
    ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
  }))
  // Provider metadata is the last resort behind runtime state and chrome, and
  // the only one that does not require the provider to have been used already.
  // Annotated rather than inferred: the three sources carry different fields
  // (only the runtime one knows capabilities), and the inferred union would
  // narrow them away just where the effort pill and mode filter read them.
  const modelOptions: ComposerModelChoice[] =
    runtimeModelOptions.length > 0
      ? runtimeModelOptions
      : chromeModelOptions.length > 0
        ? chromeModelOptions
        : metadataModelOptions(providers, currentProviderId)
  const currentModelId =
    runtimeState?.models?.currentModelId ??
    chrome.modelPicker?.currentModelId ??
    modelOptions[0]?.id ??
    ''
  // Models resolve before modes on purpose: what a model supports decides
  // which modes are even offerable, and how much of the settings row renders.
  //
  // Capabilities are looked up separately from the row that supplies the
  // *label*, and deliberately so. The display list can come from three places
  // and two of them (chrome's picker projection, and any older persisted
  // profile) carry only id/name/description — so binding capabilities to
  // whichever list happened to win would make the effort pill blink out
  // whenever a different source took over. The provider's own catalog is the
  // stable answer: these flags describe the model, not the session.
  const capabilityCatalog = metadataModelOptions(providers, currentProviderId)
  const selectedModel =
    [
      modelOptions.find((model) => model.id === currentModelId),
      capabilityCatalog.find((model) => model.id === currentModelId),
    ].find((model) => model?.effortLevels?.length || model?.supportsAutoMode) ??
    modelOptions.find((model) => model.id === currentModelId)

  const chromeModeOptions = (chrome.modePicker?.options ?? []).map((mode) => ({
    id: mode.id,
    name: mode.label,
    ...(mode.description ? { description: mode.description } : {}),
  }))
  const runtimeModeOptions = runtimeState?.modes?.availableModes ?? []
  // Same three-source ladder the models use, and for the same reason: chrome
  // and runtime state both require the provider to have been run, so a
  // provider that answers its modes at handshake time would otherwise render
  // no mode control at all until its first session.
  const allModeOptions =
    runtimeModeOptions.length > 0
      ? runtimeModeOptions
      : chromeModeOptions.length > 0
        ? chromeModeOptions
        : metadataModeOptions(providers, currentProviderId)
  // Claude Code rejects `setPermissionMode('auto')` outright on a model
  // without classifier support, so offering it would turn a mode switch into
  // an error toast.
  //
  // The guard is doing real work. An absent `supportsAutoMode` means two
  // different things — "this model cannot" and "nobody told us" — and the
  // model that most needs filtering (Haiku) carries no capability fields at
  // all, so the row itself cannot distinguish them. What can: whether *any*
  // model in this list reports capabilities. If one does, the provider
  // publishes them and silence on the selected model is a real "no". If none
  // does, this is an ACP provider that has never reported any, and filtering
  // would hide a mode that works.
  const capabilitiesKnown = modelOptions.some(
    (model) => model.supportsAutoMode || model.effortLevels?.length,
  )
  const modeOptions =
    capabilitiesKnown && selectedModel && !selectedModel.supportsAutoMode
      ? allModeOptions.filter((mode) => mode.id !== 'auto')
      : allModeOptions
  const rawModeId =
    runtimeState?.modes?.currentModeId ??
    chrome.modePicker?.currentModeId ??
    modeOptions[0]?.id ??
    ''
  // A remembered `auto` on a model that cannot serve it must not be shown as
  // current; the session will have been stepped off it anyway.
  const currentModeId = modeOptions.some((mode) => mode.id === rawModeId)
    ? rawModeId
    : (modeOptions[0]?.id ?? '')

  // The effort pill reads its levels off the selected model rather than off a
  // config option, so it renders in a fresh draft too — config options only
  // exist once a session has published them.
  const effortLevels = selectedModel?.effortLevels ?? []
  const effortOption = (runtimeState?.configOptions ?? []).find(
    (option) => option.id === 'effort' && option.type === 'select',
  )
  // Live session state first, then what the workspace remembers — a draft has
  // no published options yet, but the value it will launch with is already
  // decided and the pill has to show it.
  const rememberedEffort = composerConfigValues['effort']
  const currentEffort =
    typeof effortOption?.currentValue === 'string' && effortOption.currentValue
      ? effortOption.currentValue
      : typeof rememberedEffort === 'string'
        ? rememberedEffort
        : ''

  const providerModelGroups = buildProviderModelGroups({
    providerOptions,
    currentProviderId,
    currentModels: modelOptions,
    composerProfiles: providerComposerProfiles,
    providers,
  })
  // Runtime state first, chrome as fallback — mirrors the model/mode resolution
  // above. Runtime state also carries the per-workspace draft copy, so the picker
  // works in a fresh draft before the session's own events have replayed.
  const slashCommands = runtimeState?.availableCommands?.length
    ? runtimeState.availableCommands
    : chrome.slashCommands
  const canChangeSettings = !!composerSessionId || composerDraftOpen
  const effectiveStatus = localSessionStatus ?? activeSession?.status
  // The session behind the overlay may well be streaming, but the send button
  // in front of it must stay a send button — stopping it is not what Enter or
  // that control means while you are composing for somewhere else.
  const isStreaming =
    !quickLaunchOpen && (effectiveStatus === 'running' || effectiveStatus === 'busy')
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
    // Questions never reach here: while one is pending the composer is replaced
    // by the question prompt, which resolves it through its own submit.
    // A pending plan turns composer text into rejection feedback rather than a
    // prompt. Question interception above keeps priority when both are pending.
    if (pendingPlan && planState && text.trim()) {
      await planState.resolvePlan({ outcome: 'rejected', reason: text.trim() })
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
      if (quickLaunchOpen && composerWorkspacePath) {
        // Deliberately not `useActiveSession().sendMessage`: that one pushes an
        // optimistic user bubble into the transcript on screen, which belongs
        // to a different session than the one being started here.
        await launchSession(composerWorkspacePath, text, uploaded.map(promptAttachment))
        setLaunchedInto(
          workspaces.find((workspace) => workspace.path === composerWorkspacePath)?.name ??
            composerWorkspacePath,
        )
        return
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

  const planBuildModeId =
    modeOptions.find((mode) => mode.id === 'agent')?.id ??
    modeOptions.find((mode) => mode.id !== 'plan')?.id

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

  // The acknowledgement is about one launch, so it must not outlive the
  // overlay or survive a change of target.
  useEffect(() => {
    if (!launchedInto) return
    launchedTimerRef.current = setTimeout(() => setLaunchedInto(null), 4000)
    return () => {
      if (launchedTimerRef.current) clearTimeout(launchedTimerRef.current)
    }
  }, [launchedInto])

  useEffect(() => {
    setLaunchedInto(null)
  }, [quickLaunchWorkspacePath])

  return (
    <div className="flex w-full flex-col">
      {questionFlow ? null : <ComposerPlanPrompt />}
      <div className="flex w-full flex-col">
        {questionFlow ? <QuestionCard flow={questionFlow} /> : null}
        <ComposerTodos entries={planEntries} />
        {quickLaunchOpen ? (
          <QuickLaunchBar
            workspaces={workspaces}
            workspacePath={quickLaunchWorkspacePath}
            onWorkspaceChange={(path) => openQuickLaunch(path)}
            onCancel={closeQuickLaunch}
            launchedInto={launchedInto}
          />
        ) : null}
        <MessageInputView
          disabled={disabled}
          pendingDraftSessionStart={!quickLaunchOpen && pendingDraftSessionStart}
          activeWorkspacePath={composerWorkspacePath}
          activeSessionId={composerSessionId}
          isSessionDraftOpen={composerDraftOpen}
          providerReady={providerReady}
          currentProviderId={currentProviderId}
          providerModelGroups={providerModelGroups}
          currentModelId={currentModelId}
          configOptions={runtimeState?.configOptions ?? []}
          modeOptions={modeOptions}
          currentModeId={currentModeId}
          effortLevels={effortLevels}
          currentEffort={currentEffort}
          canChangeSettings={canChangeSettings}
          canChangeProvider={composerDraftOpen && !composerSessionId}
          showModeControl={chrome.modePicker !== null || modeOptions.length > 0}
          showModelControl={
            chrome.modelPicker !== null ||
            modelOptions.length > 0 ||
            providerModelGroups.some((group) => group.models.length > 0)
          }
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
          attachedTop={planEntries.length > 0 || !!questionFlow}
          draftKey={draftKey}
          imageUploadEnabled={
            providerSupportsImages && modelImageSupport !== false && modelImageSupport !== undefined
          }
          imageSupportMessage={imageSupportMessage}
          slashCommands={slashCommands}
          // The meter measures the session on screen; while the composer is
          // aimed elsewhere it would be reporting on the wrong conversation.
          usage={quickLaunchOpen ? null : (chrome.usage ?? null)}
          onModeChange={(id) => {
            if (composerSessionId) {
              void setSessionMode(composerSessionId, id)
              return
            }
            setDraftMode(id)
          }}
          onProviderModelChange={(providerId, modelId) => {
            if (composerSessionId) {
              if (providerId === currentProviderId) {
                void setSessionModel(composerSessionId, modelId)
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
            if (composerSessionId) {
              void setSessionConfigOption(composerSessionId, configId, value)
              return
            }
            setDraftConfigOption(configId, value)
          }}
          onSend={uploadAndSend}
          onAbort={() => {
            if (composerSessionId) {
              void abortSession(composerSessionId)
            }
          }}
        />
      </div>
    </div>
  )
}
