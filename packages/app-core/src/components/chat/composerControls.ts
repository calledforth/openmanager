import type { ProviderId, ProviderMetadata, PromptCapabilities } from '@agentpack/contract'
import { deriveSessionChrome } from '@agentpack/view'
import { providerBlocksComposer, type ProviderUiStatus } from '../../providers/platform-provider'
import type {
  AcpCommandOption,
  AcpSessionRuntimeState,
  ComposerStateValue,
} from '../../providers/composer-provider'
import type { LocalSessionStatus } from '../../providers/session-provider'
import { effortConfigOption } from './modelConfig'
import {
  buildProviderModelGroups,
  metadataModeOptions,
  metadataModelOptions,
  modelFacts,
  type ComposerModelChoice,
  type ProviderModelGroup,
} from './providerModelGroups'
import type { SlashCommandItem } from './slashCommands'

/** Context-window occupancy, as the composer's meter shows it (web's `ContextMeter`). */
export type ComposerControlsUsage = {
  used: number
  size: number
  percent: number
  cost?: { amount: number; currency: string }
}

/** A pick the composer offers: a mode, or an effort level. */
export type ComposerChoice = { id: string; name: string; description?: string }

/** What the composer is derived from: the session, composer and platform state it sits on. */
export interface ComposerControlsInput {
  session: {
    activeSessionId: string | null
    activeWorkspacePath: string | null
    isSessionDraftOpen: boolean
    newSessionDraftId?: string | null
    defaultProviderId: ProviderId
    localSessionStatus: LocalSessionStatus | null
  }
  composer: Pick<
    ComposerStateValue,
    | 'acpSessionState'
    | 'draftSessionState'
    | 'agentEvents'
    | 'providerComposerProfiles'
    | 'composerConfigValues'
  >
  platform: {
    providers: readonly ProviderMetadata[]
    agentUiStatusByProvider: Partial<Record<ProviderId, ProviderUiStatus>>
    acpPromptCapabilitiesByProvider: Partial<Record<ProviderId, PromptCapabilities>>
  }
  /** The active thread's listed status (`running`, `busy`, `idle`, …), if there is one. */
  activeThreadStatus?: string
}

/**
 * Everything the composer shows and gates, derived once from the providers
 * it sits on. Web's `MessageInput` and the phone's composer both render from
 * this, so the model, mode and effort a session shows are the same on both.
 */
export interface ComposerControls {
  /** The resolved surface the composer reads: the session's, or the open draft's. */
  runtimeState: AcpSessionRuntimeState | null
  currentProviderId: ProviderId
  currentProviderName: string
  /** The provider is not known to be down: the composer may offer to send. */
  providerReady: boolean
  providerModelGroups: ProviderModelGroup[]
  modelOptions: ComposerModelChoice[]
  currentModelId: string
  modeOptions: ComposerChoice[]
  currentModeId: string
  /** Claude's level list on the model row: the effort fallback for a catalog with no settings. */
  effortLevels: string[]
  /** The provider's own effort setting, with its labels, when it lists one. */
  effortOptions?: ComposerChoice[]
  effortConfigId: string
  /** Blank until the session or the workspace says otherwise. */
  currentEffort: string
  slashCommands: SlashCommandItem[]
  usage: ComposerControlsUsage | null
  /** A session is open, or a draft is: picks can be made. */
  canChangeSettings: boolean
  /** Only a draft can move to another provider. */
  canChangeProvider: boolean
  showModeControl: boolean
  showModelControl: boolean
  /** A turn is running: the send button stops it. */
  isStreaming: boolean
  /** Whether the provider advertises image prompts; undefined before it says. */
  providerImageSupport: boolean | undefined
  /** What the catalog says the selected model reads, when it says. */
  catalogImageSupport: boolean | undefined
  /** Why this draft cannot be sent as it stands; null when it can. */
  sendBlockedReason: string | null
  /** The mode a plan's Build switches to. */
  planBuildModeId: string | undefined
  /** Where the composer keeps its unsent text and images. */
  draftKey: string
}

/** The command listing as the composer's slash popup takes it. */
const slashItemCache = new WeakMap<readonly AcpCommandOption[], SlashCommandItem[]>()
const slashItems = (commands: readonly AcpCommandOption[]): SlashCommandItem[] => {
  let items = slashItemCache.get(commands)
  if (!items) {
    items = commands.map((command) => ({ name: command.name, description: command.description }))
    slashItemCache.set(commands, items)
  }
  return items
}

/**
 * The composer's controls from the session, composer and platform state.
 * Pure: the same inputs give the same picks on every client.
 */
export function deriveComposerControls({
  session,
  composer,
  platform,
  activeThreadStatus,
}: ComposerControlsInput): ComposerControls {
  const { activeSessionId, isSessionDraftOpen, defaultProviderId } = session
  const { acpSessionState, draftSessionState, agentEvents, providerComposerProfiles } = composer
  const { providers, agentUiStatusByProvider, acpPromptCapabilitiesByProvider } = platform
  const runtimeState = activeSessionId || !isSessionDraftOpen ? acpSessionState : draftSessionState
  const chrome = deriveSessionChrome(agentEvents, {
    providers: [...providers],
    selectedProviderId: runtimeState?.providerId ?? defaultProviderId,
    sessionId: activeSessionId ?? undefined,
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
    ...(model.supportsImageInput !== undefined
      ? { supportsImageInput: model.supportsImageInput }
      : {}),
    ...modelFacts(model),
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
  const allModeOptions: ComposerChoice[] =
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

  // The effort pill draws the provider's own effort setting when there is one
  // (a live session's, or the selected model's catalog row in a draft), under
  // whatever id the provider gives it. Claude's level list on the model row is
  // the fallback, for a draft whose catalog carries no settings.
  const effortLevels = selectedModel?.effortLevels ?? []
  const effortOption = effortConfigOption(runtimeState?.configOptions)
  const effortConfigId = effortOption?.id ?? 'effort'
  const effortOptions = effortOption?.options.map((option) => ({
    id: option.value,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
  }))
  // Live session state first, then what the workspace remembers — a draft has
  // no published options yet, but the value it will launch with is already
  // decided and the pill has to show it.
  const rememberedEffort = composer.composerConfigValues[effortConfigId]
  const currentEffort =
    typeof effortOption?.currentValue === 'string' && effortOption.currentValue
      ? effortOption.currentValue
      : typeof rememberedEffort === 'string'
        ? rememberedEffort
        : ''

  // A provider known to be broken cannot be switched to: the draft would only
  // fail at send. Unknown health does not count; see `providerBlocksComposer`.
  const unavailableProviders: Partial<Record<ProviderId, string>> = {}
  for (const provider of providerOptions) {
    const status = agentUiStatusByProvider[provider.id]
    if (!providerBlocksComposer(status)) continue
    unavailableProviders[provider.id] =
      status === 'probing'
        ? `Checking ${provider.name}…`
        : `${provider.name} is unavailable. Retry it from Settings.`
  }
  const providerModelGroups = buildProviderModelGroups({
    providerOptions,
    currentProviderId,
    currentModels: modelOptions,
    composerProfiles: providerComposerProfiles,
    providers: [...providers],
    unavailableProviders,
  })
  // Runtime state first, chrome as fallback — mirrors the model/mode resolution
  // above. Runtime state also carries the per-workspace draft copy, so the picker
  // works in a fresh draft before the session's own events have replayed.
  const slashCommands = runtimeState?.availableCommands?.length
    ? slashItems(runtimeState.availableCommands)
    : chrome.slashCommands
  // An environment reports usage on the session itself; desktop folds it out
  // of the agent events. A draft has no context window to measure yet.
  const sessionUsage = activeSessionId ? acpSessionState?.usage : undefined
  const usage =
    sessionUsage && sessionUsage.size > 0
      ? {
          ...sessionUsage,
          percent: Math.max(0, Math.min(100, (sessionUsage.used / sessionUsage.size) * 100)),
        }
      : (chrome.usage ?? null)
  const canChangeSettings = !!activeSessionId || isSessionDraftOpen
  const effectiveStatus = session.localSessionStatus ?? activeThreadStatus
  const isStreaming = effectiveStatus === 'running' || effectiveStatus === 'busy'
  const providerImageSupport = acpPromptCapabilitiesByProvider[currentProviderId]?.image

  // The catalog answers first: an environment that has asked the provider's
  // CLI puts the answer on the model row, where it is reactive by construction.
  const catalogImageSupport = [
    modelOptions.find((model) => model.id === currentModelId),
    capabilityCatalog.find((model) => model.id === currentModelId),
  ]
    .map((model) => model?.supportsImageInput)
    .find((support) => support !== undefined)

  // A draft with an id keeps it as its key while it moves between projects,
  // so what was typed and attached stays put; elsewhere a project has one.
  const draftKey = activeSessionId
    ? `session:${activeSessionId}`
    : session.newSessionDraftId
      ? `new:${session.newSessionDraftId}`
      : session.activeWorkspacePath
        ? `draft:${session.activeWorkspacePath}`
        : 'no-workspace'
  // A draft keeps a provider it was given even once that provider breaks:
  // the pick stands, and the send waits for it or for another pick. Only a
  // provider known to be down holds it; one being checked does not.
  const draftProviderStatus = agentUiStatusByProvider[currentProviderId]
  const sendBlockedReason =
    activeSessionId || !isSessionDraftOpen
      ? null
      : draftProviderStatus !== 'probing' && providerBlocksComposer(draftProviderStatus)
        ? `${currentProviderName} is unavailable. Pick another model, or retry it from Settings.`
        : null

  const planBuildModeId =
    modeOptions.find((mode) => mode.id === 'agent')?.id ??
    modeOptions.find((mode) => mode.id !== 'plan')?.id

  return {
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
    ...(effortOptions ? { effortOptions } : {}),
    effortConfigId,
    currentEffort,
    slashCommands,
    usage,
    canChangeSettings,
    canChangeProvider: isSessionDraftOpen && !activeSessionId,
    showModeControl: chrome.modePicker !== null || modeOptions.length > 0,
    showModelControl:
      chrome.modelPicker !== null ||
      modelOptions.length > 0 ||
      providerModelGroups.some((group) => group.models.length > 0),
    isStreaming,
    providerImageSupport,
    catalogImageSupport,
    sendBlockedReason,
    planBuildModeId,
    draftKey,
  }
}

/**
 * Why an image cannot be attached right now, or null when it can.
 * `modelImageSupport` is the catalog's answer, else the host's own lookup
 * (`undefined` while it is asked, `null` when nobody can tell).
 */
export function composerImageSupportMessage({
  canUploadImages,
  providerImageSupport,
  modelImageSupport,
  currentProviderName,
  currentModelName,
}: {
  canUploadImages: boolean
  providerImageSupport: boolean | undefined
  modelImageSupport: boolean | null | undefined
  currentProviderName: string
  currentModelName: string
}): string | null {
  return !canUploadImages
    ? 'Image prompts are not available on this host.'
    : providerImageSupport === undefined
      ? 'Checking whether the provider accepts image prompts…'
      : providerImageSupport !== true
        ? `${currentProviderName} does not advertise image prompt support.`
        : modelImageSupport === undefined
          ? 'Checking whether the selected model can read images…'
          : modelImageSupport === false
            ? `${currentModelName} cannot read images. Choose a vision-capable model.`
            : null
}
