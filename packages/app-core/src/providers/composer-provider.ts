import { createContext, useContext } from 'react'
import type {
  AgentEvent,
  AvailableCommand,
  ProviderId,
  SessionConfigOption,
} from '@agentpack/contract'
import {
  resolveComposerChoice,
  type ComposerModeOption,
  type ComposerModelOption,
  type ProviderComposerProfile,
  type ProviderComposerProfiles,
  type WorkspaceComposerPreference,
} from '@openmanager/shared/contracts/composer-profile'
import { applySessionConfigValues, type SessionConfigValue } from '../components/chat/modelConfig'

export type AcpModelOption = ComposerModelOption
export type AcpModeOption = ComposerModeOption
export type AcpCommandOption = AvailableCommand

/** The live composer surface of one session: what the agent reports it can
 * do and what is currently selected. */
export interface AcpSessionRuntimeState {
  sessionId: string
  providerId: ProviderId
  configOptions?: SessionConfigOption[]
  models?: {
    currentModelId?: string
    availableModels?: AcpModelOption[]
  }
  modes?: {
    currentModeId?: string
    availableModes?: AcpModeOption[]
  }
  availableCommands?: AcpCommandOption[]
}

export type DraftComposerSelection = {
  providerId?: ProviderId
  modelId?: string
  modeId?: string
}

type SessionModels = Extract<AgentEvent, { event: 'session_created' }>['data']['models']
type SessionModes = Extract<AgentEvent, { event: 'session_created' }>['data']['modes']

/** Map the wire shape of a session's model catalog to the composer's. */
export function toAcpModels(models: SessionModels): AcpSessionRuntimeState['models'] {
  if (!models) return undefined
  return {
    currentModelId: models.currentModelId,
    availableModels: models.availableModels?.map((model) => ({
      modelId: model.id,
      name: model.displayName,
      description: model.description,
      contextWindowTokens: model.contextWindowTokens,
      // Capability flags have to survive this hop: a live session's catalog
      // wins over provider metadata in the composer's ladder, so dropping them
      // here hides the effort pill for exactly the sessions that can use it.
      ...(model.effortLevels?.length ? { effortLevels: model.effortLevels } : {}),
      ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
      ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
    })),
  }
}

export function toAcpModes(modes: SessionModes): AcpSessionRuntimeState['modes'] {
  if (!modes) return undefined
  return {
    currentModeId: modes.currentModeId,
    availableModes: modes.availableModes?.map((mode) => ({
      id: mode.id,
      name: mode.displayName,
      description: mode.description,
    })),
  }
}

export function resolveDraftComposerRuntime({
  workspacePath,
  providerId,
  runtime,
  selection,
  preference,
  profile,
}: {
  workspacePath: string
  providerId: ProviderId
  runtime?: Partial<Omit<AcpSessionRuntimeState, 'sessionId'>>
  selection?: DraftComposerSelection
  preference?: WorkspaceComposerPreference
  profile?: ProviderComposerProfile
}): AcpSessionRuntimeState {
  const availableModels = runtime?.models?.availableModels?.length
    ? runtime.models.availableModels
    : profile?.availableModels
  const availableModes = runtime?.modes?.availableModes?.length
    ? runtime.modes.availableModes
    : profile?.availableModes
  const currentModelId = resolveComposerChoice(
    [
      preference?.modelId,
      selection?.modelId,
      runtime?.models?.currentModelId,
      profile?.defaultModelId,
    ],
    availableModels?.map((model) => ({ id: model.modelId })),
  )
  const currentModeId = resolveComposerChoice(
    [preference?.modeId, selection?.modeId, runtime?.modes?.currentModeId, profile?.defaultModeId],
    availableModes,
  )
  const configOptions = applySessionConfigValues(runtime?.configOptions, preference?.configValues)

  return {
    sessionId: `draft:${workspacePath}`,
    providerId,
    ...(configOptions ? { configOptions } : {}),
    ...(availableModels?.length || currentModelId
      ? {
          models: {
            ...(availableModels?.length ? { availableModels } : {}),
            ...(currentModelId ? { currentModelId } : {}),
          },
        }
      : {}),
    ...(availableModes?.length || currentModeId
      ? {
          modes: {
            ...(availableModes?.length ? { availableModes } : {}),
            ...(currentModeId ? { currentModeId } : {}),
          },
        }
      : {}),
    ...(runtime?.availableCommands ? { availableCommands: runtime.availableCommands } : {}),
  }
}

// Resolve what the composer should display for an active session. Model
// selection is provider-global agent state (not per session), so the workspace
// preference — the single selection the job worker re-applies before every
// prompt — is what the composer must show; live runtime and profile defaults
// are fallbacks. Modes can be switched by the agent itself mid-session, so the
// live runtime wins there. Catalogs fall back to the persisted provider
// profile so controls render instantly, before any live session round-trip.
export function resolveSessionComposerRuntime(
  runtime: AcpSessionRuntimeState,
  preference?: WorkspaceComposerPreference,
  profile?: ProviderComposerProfile,
): AcpSessionRuntimeState {
  const availableModels = runtime.models?.availableModels?.length
    ? runtime.models.availableModels
    : profile?.availableModels
  const availableModes = runtime.modes?.availableModes?.length
    ? runtime.modes.availableModes
    : profile?.availableModes
  const currentModelId =
    resolveComposerChoice(
      [preference?.modelId, runtime.models?.currentModelId, profile?.defaultModelId],
      availableModels?.map((model) => ({ id: model.modelId })),
    ) ??
    preference?.modelId ??
    runtime.models?.currentModelId
  const currentModeId =
    resolveComposerChoice(
      [runtime.modes?.currentModeId, preference?.modeId, profile?.defaultModeId],
      availableModes,
    ) ??
    runtime.modes?.currentModeId ??
    preference?.modeId
  const configOptions = applySessionConfigValues(runtime.configOptions, preference?.configValues)
  if (
    availableModels === runtime.models?.availableModels &&
    availableModes === runtime.modes?.availableModes &&
    currentModelId === runtime.models?.currentModelId &&
    currentModeId === runtime.modes?.currentModeId &&
    configOptions === runtime.configOptions
  ) {
    return runtime
  }
  return {
    ...runtime,
    ...(configOptions ? { configOptions } : {}),
    ...(availableModels?.length || currentModelId
      ? {
          models: {
            ...(availableModels?.length ? { availableModels } : {}),
            ...(currentModelId ? { currentModelId } : {}),
          },
        }
      : {}),
    ...(availableModes?.length || currentModeId
      ? {
          modes: {
            ...(availableModes?.length ? { availableModes } : {}),
            ...(currentModeId ? { currentModeId } : {}),
          },
        }
      : {}),
  }
}

// Only the low-frequency lifecycle/config events feed deriveSessionChrome.
// High-frequency stream events (message/thought chunks, tool updates) must stay
// out of React state: storing them invalidates the composer context on every
// token, which re-renders every consumer for the whole duration of a response.
export const CHROME_EVENT_TYPES: ReadonlySet<AgentEvent['event']> = new Set<AgentEvent['event']>([
  'initialized',
  'authenticated',
  'auth_required',
  'process_spawned',
  'process_exited',
  'session_created',
  'session_loaded',
  'session_deleted',
  'prompt_started',
  'prompt_completed',
  'current_model_update',
  'current_mode_update',
  'config_option_update',
  'available_commands_update',
  'usage_update',
  'rpc_error',
  'runtime_error',
])

/** The selection a draft launches with, resolved from preference, runtime
 * and profile at submit time. */
export interface DraftLaunchPreferences {
  providerId: ProviderId
  preferredModelId?: string
  preferredModeId?: string
  preferredConfigValues?: Record<string, SessionConfigValue>
}

/**
 * Composer selection: model, mode, config options and slash commands for the
 * active session or the open draft, backed by per-provider catalogs and
 * per-workspace preferences.
 */
export interface ComposerStateValue {
  /** Resolved composer surface for the active session, or `null` without one. */
  acpSessionState: AcpSessionRuntimeState | null
  /** Resolved composer surface for the open draft, or `null` when no draft is open. */
  draftSessionState: AcpSessionRuntimeState | null
  /** Remembered per-workspace config values for the provider in the composer.
   *
   * The composer needs these to render a setting it has not applied yet: a
   * fresh draft has no session and therefore no published `configOptions`, so
   * a control reading only those would show nothing until the first prompt —
   * even though the value is remembered and *will* be sent at launch. */
  composerConfigValues: Record<string, SessionConfigValue>
  /** Persisted per-provider catalogs and defaults. */
  providerComposerProfiles: ProviderComposerProfiles
  /** Low-frequency lifecycle/config events (see `CHROME_EVENT_TYPES`) for
   * `deriveSessionChrome`. */
  agentEvents: AgentEvent[]
  /** Last failure from a composer operation. */
  error: string | null
  setDraftModel: (modelId: string) => void
  setDraftMode: (modeId: string) => void
  setDraftProvider: (providerId: ProviderId, modelId?: string) => void
  setDraftConfigOption: (configId: string, value: SessionConfigValue) => void
  setSessionModel: (sessionExternalId: string, modelId: string) => Promise<void>
  setSessionMode: (sessionExternalId: string, modeId: string) => Promise<void>
  setSessionConfigOption: (
    sessionExternalId: string,
    configId: string,
    value: SessionConfigValue,
  ) => Promise<void>
  /** Record a mode the host switched a session into without a `set_mode`
   * round trip (a plan build that starts in a given mode). */
  recordSessionMode: (sessionExternalId: string, modeId: string) => void
  /** What a draft in `workspacePath` should launch with right now. */
  draftLaunchPreferences: (workspacePath: string) => DraftLaunchPreferences
  /** Remembered config values to re-apply before a prompt in an existing session. */
  sessionLaunchPreferences: (
    workspacePath: string,
    providerId: ProviderId,
  ) => Pick<DraftLaunchPreferences, 'preferredConfigValues'>
}

export const ComposerStateContext = createContext<ComposerStateValue | null>(null)

export function useComposerState(): ComposerStateValue {
  const ctx = useContext(ComposerStateContext)
  if (!ctx) throw new Error('useComposerState must be used within ComposerStateProvider')
  return ctx
}
