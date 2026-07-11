import type {
  AgentEvent,
  AvailableCommand,
  ModelListing,
  ModeListing,
  ProviderCapabilities,
  ProviderId,
  ProviderMetadata,
  SessionConfigOption,
  SessionCost,
  TokenUsage,
} from '@agentpack/contract'
import { sortAgentEvents } from '../fold/foldEvents.js'

export type PickerOption = {
  id: string
  label: string
  description?: string
}

export type ProviderPickerState = {
  currentProviderId?: ProviderId
  options: Array<PickerOption & { id: ProviderId }>
}

export type ModelPickerState = {
  providerId: ProviderId
  currentModelId?: string
  options: Array<PickerOption & { contextWindowTokens?: number }>
}

export type ModePickerState = {
  currentModeId?: string
  options: PickerOption[]
}

export type ConfigControl =
  | {
      type: 'select'
      id: string
      name: string
      description?: string
      category?: string
      currentValue: string
      options: Array<{ id: string; label: string; description?: string }>
    }
  | {
      type: 'boolean'
      id: string
      name: string
      description?: string
      category?: string
      currentValue: boolean
    }

export type SlashCommand = {
  name: string
  description: string
  placeholder?: string
}

export type UsageMeter = {
  used: number
  size: number
  percent: number
  pct: number
  cost?: SessionCost
}

export type TokenMeter = TokenUsage

export type SessionChromeState = {
  providerPicker: ProviderPickerState
  selectedProvider?: ProviderMetadata
  modelPicker: ModelPickerState | null
  modePicker: ModePickerState | null
  configControls: ConfigControl[]
  slashCommands: SlashCommand[]
  usage?: UsageMeter
  tokenMeter?: TokenMeter
}

export type SessionChromeOptions = {
  providers?: readonly ProviderMetadata[]
  selectedProviderId?: ProviderId
  sessionId?: string
}

const NO_CAPABILITIES: ProviderCapabilities = {
  canSetModel: false,
  canSetMode: false,
  canSetConfigOption: false,
  canDeleteSession: false,
  canLoadSession: false,
  canCancelPrompt: false,
  supportsPlans: false,
  supportsAvailableCommands: false,
  supportsUsage: false,
  supportsPermissionRequests: false,
  supportsAuthentication: false,
  supportsThoughtStreaming: false,
  supportsSubtasks: false,
  supportsExtensions: false,
}

function configControls(options: readonly SessionConfigOption[]): ConfigControl[] {
  return options.map((option): ConfigControl =>
    option.type === 'select'
      ? {
          type: 'select',
          id: option.id,
          name: option.name,
          description: option.description,
          category: option.category,
          currentValue: option.currentValue,
          options: option.options.map((item) => ({
            id: item.value,
            label: item.name,
            description: item.description,
          })),
        }
      : {
          type: 'boolean',
          id: option.id,
          name: option.name,
          description: option.description,
          category: option.category,
          currentValue: option.currentValue,
        },
  )
}

function modelFromConfig(options: readonly SessionConfigOption[]): ModelListing | undefined {
  const control = options.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'model' || option.name.toLowerCase().includes('model')),
  )
  if (!control || control.type !== 'select') return undefined
  return {
    currentModelId: control.currentValue,
    availableModels: control.options.map((option) => ({
      id: option.value,
      displayName: option.name,
      description: option.description,
    })),
  }
}

function modeFromConfig(options: readonly SessionConfigOption[]): ModeListing | undefined {
  const control = options.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'mode' || option.name.toLowerCase().includes('mode')),
  )
  if (!control || control.type !== 'select') return undefined
  return {
    currentModeId: control.currentValue,
    availableModes: control.options.map((option) => ({
      id: option.value,
      displayName: option.name,
      description: option.description,
    })),
  }
}

function commands(items: readonly AvailableCommand[]): SlashCommand[] {
  return items.map((command) => ({
    name: command.name,
    description: command.description,
    placeholder: command.input?.placeholder,
  }))
}

function providerCatalog(
  events: readonly AgentEvent[],
  supplied: readonly ProviderMetadata[],
): ProviderMetadata[] {
  const byId = new Map(supplied.map((provider) => [provider.id, provider]))
  for (const event of events) {
    const current = byId.get(event.providerId)
    if (event.event === 'initialized') {
      byId.set(event.providerId, {
        id: event.providerId,
        displayName: current?.displayName ?? event.data.agentInfo?.name ?? event.providerId,
        description: current?.description,
        capabilities: event.data.capabilities,
        models: current?.models,
        modes: current?.modes,
      })
    } else if (!current) {
      byId.set(event.providerId, {
        id: event.providerId,
        displayName: event.providerId,
        capabilities: NO_CAPABILITIES,
      })
    }
  }
  return [...byId.values()]
}

export function deriveSessionChromeState(
  events: readonly AgentEvent[],
  optionsOrProviders: SessionChromeOptions | readonly ProviderMetadata[] = {},
  selectedProviderId?: ProviderId,
): SessionChromeState {
  const options: SessionChromeOptions = Array.isArray(optionsOrProviders)
    ? { providers: optionsOrProviders, selectedProviderId }
    : (optionsOrProviders as SessionChromeOptions)
  const sorted = sortAgentEvents(events)
  const providers = providerCatalog(sorted, options.providers ?? [])
  const inferredProviderId =
    [...sorted].reverse().find((event) => event.sessionId)?.providerId ??
    sorted[sorted.length - 1]?.providerId
  const currentProviderId = options.selectedProviderId ?? inferredProviderId ?? providers[0]?.id
  const selectedProvider = providers.find((provider) => provider.id === currentProviderId)
  const capabilities = selectedProvider?.capabilities ?? NO_CAPABILITIES
  let models = selectedProvider?.models
  let modes = selectedProvider?.modes
  let latestConfig: SessionConfigOption[] = []
  let slashCommands: SlashCommand[] = []
  let usage: UsageMeter | undefined
  let tokenMeter: TokenMeter | undefined

  for (const event of sorted) {
    if (event.providerId !== currentProviderId) continue
    if (options.sessionId && event.sessionId && event.sessionId !== options.sessionId) continue
    if (event.event === 'session_created' || event.event === 'session_loaded') {
      models = event.data.models ?? models
      modes = event.data.modes ?? modes
      if (event.data.configOptions) latestConfig = event.data.configOptions
    } else if (event.event === 'current_model_update') models = event.data
    else if (event.event === 'current_mode_update') modes = event.data
    else if (event.event === 'config_option_update') latestConfig = event.data.configOptions
    else if (event.event === 'available_commands_update') {
      slashCommands = commands(event.data.availableCommands)
    } else if (event.event === 'usage_update') {
      const percent =
        event.data.size > 0
          ? Math.max(0, Math.min(100, (event.data.used / event.data.size) * 100))
          : 0
      usage = { ...event.data, percent, pct: percent }
    } else if (event.event === 'prompt_completed' && event.data.usage) {
      tokenMeter = event.data.usage
    }
  }

  models ??= modelFromConfig(latestConfig)
  modes ??= modeFromConfig(latestConfig)
  return {
    providerPicker: {
      currentProviderId,
      options: providers.map((provider) => ({
        id: provider.id,
        label: provider.displayName,
        description: provider.description,
      })),
    },
    selectedProvider,
    modelPicker:
      capabilities.canSetModel && currentProviderId
        ? {
            providerId: currentProviderId,
            currentModelId: models?.currentModelId,
            options: (models?.availableModels ?? []).map((model) => ({
              id: model.id,
              label: model.displayName,
              description: model.description,
              contextWindowTokens: model.contextWindowTokens,
            })),
          }
        : null,
    modePicker: capabilities.canSetMode
      ? {
          currentModeId: modes?.currentModeId,
          options: (modes?.availableModes ?? []).map((mode) => ({
            id: mode.id,
            label: mode.displayName,
            description: mode.description,
          })),
        }
      : null,
    configControls: capabilities.canSetConfigOption ? configControls(latestConfig) : [],
    slashCommands: capabilities.supportsAvailableCommands ? slashCommands : [],
    usage: capabilities.supportsUsage ? usage : undefined,
    tokenMeter: capabilities.supportsUsage ? tokenMeter : undefined,
  }
}

export const deriveSessionChrome = deriveSessionChromeState
