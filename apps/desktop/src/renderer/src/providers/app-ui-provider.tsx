import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '@openmanager/convex/_generated/api'
import type { Id } from '@openmanager/convex/_generated/dataModel'
import type { SidecarStatus } from '@openmanager/shared/contracts/sidecar'
import {
  isProviderId,
  type AgentEvent,
  type AvailableCommand,
  type ProviderId,
  type ProviderMetadata,
  type PromptAttachment,
  type PromptCapabilities,
} from '@agentpack/contract'
import {
  recordRendererTelemetry,
  trackedConvexQuery,
  useTrackedMutation,
  useTrackedQuery,
} from '../lib/convex-telemetry'
import {
  composerPreferencesFromDocs,
  composerProfilesFromDocs,
  mergeProviderComposerProfiles,
  mergeWorkspaceComposerPreferences,
  resolveComposerChoice,
  workspaceComposerPreferenceKey,
  type ComposerModeOption,
  type ComposerModelOption,
  type ProviderComposerProfile,
  type ProviderComposerProfiles,
  type ProviderComposerProfileDoc,
  type WorkspaceComposerPreference,
  type WorkspaceComposerPreferences,
  type WorkspaceComposerPreferenceDoc,
} from '../../../shared/composer-profile'
import { resolveSessionProviderId, sessionsForProvider } from './session-provider'

export type ProviderUiStatus = 'disconnected' | 'connecting' | 'connected'

export type AgentInfo = { name?: string; version?: string }

function toAcpModels(models: Extract<AgentEvent, { event: 'session_created' }>['data']['models']) {
  if (!models) return undefined
  return {
    currentModelId: models.currentModelId,
    availableModels: models.availableModels?.map((model) => ({
      modelId: model.id,
      name: model.displayName,
      description: model.description,
      contextWindowTokens: model.contextWindowTokens,
    })),
  }
}

function toAcpModes(modes: Extract<AgentEvent, { event: 'session_created' }>['data']['modes']) {
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

export type AcpModelOption = ComposerModelOption

export type AcpModeOption = ComposerModeOption

export type AcpCommandOption = AvailableCommand

export interface AcpSessionRuntimeState {
  sessionId: string
  providerId: ProviderId
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

type DraftComposerSelection = {
  providerId?: ProviderId
  modelId?: string
  modeId?: string
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

  return {
    sessionId: `draft:${workspacePath}`,
    providerId,
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
  if (
    availableModels === runtime.models?.availableModels &&
    availableModes === runtime.modes?.availableModes &&
    currentModelId === runtime.models?.currentModelId &&
    currentModeId === runtime.modes?.currentModeId
  ) {
    return runtime
  }
  return {
    ...runtime,
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

export function coordinateProviderConnection(
  connections: Map<ProviderId, Promise<boolean>>,
  providerId: ProviderId,
  start: () => Promise<boolean>,
): Promise<boolean> {
  const existing = connections.get(providerId)
  if (existing) return existing
  const connection = start()
  connections.set(providerId, connection)
  const cleanup = () => {
    if (connections.get(providerId) === connection) connections.delete(providerId)
  }
  void connection.then(cleanup, cleanup)
  return connection
}

export type LocalSessionStatus = 'starting' | 'running'

interface AppUiValue {
  activeWorkspacePath: string | null
  activeSessionId: string | null
  isSessionDraftOpen: boolean
  pendingDraftSessionStart: boolean
  localSessionStatus: LocalSessionStatus | null
  adoptedDraftSessionId: string | null
  currentClientId: string | null
  agentStatusByProvider: Partial<Record<ProviderId, SidecarStatus>>
  agentUiStatusByProvider: Partial<Record<ProviderId, ProviderUiStatus>>
  acpAgentInfoByProvider: Partial<Record<ProviderId, AgentInfo>>
  acpPromptCapabilitiesByProvider: Partial<Record<ProviderId, PromptCapabilities>>
  defaultProviderId: ProviderId
  agentEvents: AgentEvent[]
  providers: ProviderMetadata[]
  acpSessionState: AcpSessionRuntimeState | null
  draftSessionState: AcpSessionRuntimeState | null
  error: string | null
  retryProvider: (providerId: ProviderId) => Promise<void>
  setActiveWorkspacePath: (path: string | null) => void
  setActiveSessionId: (sessionId: string | null) => void
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  selectSession: (workspacePath: string, externalId: string, providerId?: ProviderId) => void
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (
    workspacePath: string,
    externalId: string,
    providerId?: ProviderId,
  ) => Promise<void>
  sendMessage: (
    content: string,
    userMessageId?: string,
    attachments?: PromptAttachment[],
  ) => Promise<string | null>
  abortSession: (externalId: string) => Promise<void>
  resolvePermission: (
    sessionExternalId: string,
    permissionId: string,
    approved: boolean,
  ) => Promise<void>
  setDraftModel: (modelId: string) => void
  setDraftMode: (modeId: string) => void
  setDraftProvider: (providerId: ProviderId) => void
  setSessionModel: (sessionExternalId: string, modelId: string) => Promise<void>
  setSessionMode: (sessionExternalId: string, modeId: string) => Promise<void>
}

// Only the low-frequency lifecycle/config events feed deriveSessionChrome.
// High-frequency stream events (message/thought chunks, tool updates) must stay
// out of React state: storing them invalidates the AppUi context on every token,
// which re-renders every consumer for the whole duration of a streaming response.
const CHROME_EVENT_TYPES = new Set<AgentEvent['event']>([
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

const AppUiContext = createContext<AppUiValue | null>(null)

export function useAppUi() {
  const ctx = useContext(AppUiContext)
  if (!ctx) throw new Error('useAppUi must be used within AppUiProvider')
  return ctx
}

export function AppUiProvider({ children }: { children: ReactNode }) {
  const [agentStatusByProvider, setAgentStatusByProvider] = useState<
    Partial<Record<ProviderId, SidecarStatus>>
  >({})
  const [connectingProviders, setConnectingProviders] = useState<
    Partial<Record<ProviderId, boolean>>
  >({})
  const providerConnectionPromisesRef = useRef<Map<ProviderId, Promise<boolean>>>(new Map())
  const [defaultProviderId, setDefaultProviderId] = useState<ProviderId>('opencode')
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [isSessionDraftOpen, setIsSessionDraftOpen] = useState(false)
  const [pendingDraftSessionStart, setPendingDraftSessionStart] = useState(false)
  const [localSessionStatus, setLocalSessionStatus] = useState<LocalSessionStatus | null>(null)
  const [adoptedDraftSessionId, setAdoptedDraftSessionId] = useState<string | null>(null)
  const [localSessionJobId, setLocalSessionJobId] = useState<Id<'pending_jobs'> | null>(null)
  const [currentClientId, setCurrentClientId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acpAgentInfoByProvider, setAcpAgentInfoByProvider] = useState<
    Partial<Record<ProviderId, AgentInfo>>
  >({})
  const [acpPromptCapabilitiesByProvider, setAcpPromptCapabilitiesByProvider] = useState<
    Partial<Record<ProviderId, PromptCapabilities>>
  >({})
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([])
  const [providers, setProviders] = useState<ProviderMetadata[]>([])
  const [acpSessionStateById, setAcpSessionStateById] = useState<
    Record<string, AcpSessionRuntimeState>
  >({})
  const [draftSessionStateByWorkspace, setDraftSessionStateByWorkspace] = useState<
    Record<string, Partial<Omit<AcpSessionRuntimeState, 'sessionId'>>>
  >({})
  const [draftSelectionByWorkspace, setDraftSelectionByWorkspace] = useState<
    Record<string, { providerId?: ProviderId; modelId?: string; modeId?: string }>
  >({})
  const [providerComposerProfiles, setProviderComposerProfiles] =
    useState<ProviderComposerProfiles>({})
  const [workspaceComposerPreferences, setWorkspaceComposerPreferences] =
    useState<WorkspaceComposerPreferences>({})
  const providerComposerProfilesRef = useRef<ProviderComposerProfiles>({})
  const workspaceComposerPreferencesRef = useRef<WorkspaceComposerPreferences>({})

  const mergeDraftRuntimeForWorkspace = useCallback(
    (
      workspacePath: string,
      patch: {
        providerId?: ProviderId
        models?: AcpSessionRuntimeState['models']
        modes?: AcpSessionRuntimeState['modes']
        availableCommands?: AcpCommandOption[]
      },
    ) => {
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [workspacePath]: {
          ...(prev[workspacePath] ?? {}),
          ...(patch.providerId ? { providerId: patch.providerId } : {}),
          ...(patch.models ? { models: patch.models } : {}),
          ...(patch.modes ? { modes: patch.modes } : {}),
          ...(patch.availableCommands ? { availableCommands: patch.availableCommands } : {}),
        },
      }))
    },
    [],
  )

  const upsertComposerPreference = useTrackedMutation(
    'composer.upsertPreference',
    (api as any).composer.upsertPreference,
  )

  const rememberWorkspaceComposerPreference = useCallback(
    (
      workspacePath: string,
      providerId: ProviderId,
      patch: WorkspaceComposerPreference,
      overwrite = true,
    ) => {
      const key = workspaceComposerPreferenceKey(workspacePath, providerId)
      const current = workspaceComposerPreferencesRef.current[key] ?? {}
      const preference = overwrite ? { ...current, ...patch } : { ...patch, ...current }
      const next = {
        ...workspaceComposerPreferencesRef.current,
        [key]: preference,
      }
      workspaceComposerPreferencesRef.current = next
      setWorkspaceComposerPreferences(next)
      window.electronAPI
        .setWorkspaceComposerPreference(workspacePath, providerId, preference)
        .catch(() => undefined)
      // Mirror to Convex so other devices (mobile) can read composer prefs.
      void upsertComposerPreference({
        workspacePath,
        providerId,
        ...(preference.modelId !== undefined ? { modelId: preference.modelId } : {}),
        ...(preference.modeId !== undefined ? { modeId: preference.modeId } : {}),
      }).catch(() => undefined)
    },
    [upsertComposerPreference],
  )

  const updateProviderComposerProfile = useCallback(
    (providerId: ProviderId, patch: Omit<Partial<ProviderComposerProfile>, 'updatedAt'>) => {
      const current = providerComposerProfilesRef.current[providerId]
      const profile: ProviderComposerProfile = {
        ...(current ?? { updatedAt: Date.now() }),
        ...patch,
        updatedAt: Date.now(),
      }
      const next = {
        ...providerComposerProfilesRef.current,
        [providerId]: profile,
      }
      providerComposerProfilesRef.current = next
      setProviderComposerProfiles(next)
      window.electronAPI.setProviderComposerProfile(providerId, profile).catch(() => undefined)
    },
    [],
  )

  const telemetryContext = useCallback(
    () => ({
      sessionExternalId: activeSessionId ?? undefined,
      workspacePath: activeWorkspacePath ?? undefined,
    }),
    [activeSessionId, activeWorkspacePath],
  )

  const rememberActiveWorkspacePath = useCallback((workspacePath: string | null) => {
    setActiveWorkspacePath(workspacePath)
    window.electronAPI.setLastActiveWorkspacePath(workspacePath ?? '').catch(() => undefined)
  }, [])

  const submitJob = useTrackedMutation('jobs.submit', api.jobs.submit, telemetryContext)
  const ensureWorkspace = useTrackedMutation('workspaces.ensureByPath', api.workspaces.ensureByPath)
  const removeWorkspaceMutation = useTrackedMutation('workspaces.remove', api.workspaces.remove)
  const localSessionJob = useTrackedQuery(
    'jobs.getStatus.local-session',
    api.jobs.getStatus,
    localSessionJobId ? { jobId: localSessionJobId } : 'skip',
  ) as { status: string; lastError?: string } | null | undefined

  useEffect(() => {
    if (
      !localSessionJob ||
      (localSessionJob.status !== 'done' && localSessionJob.status !== 'failed')
    )
      return
    setLocalSessionStatus(null)
    setPendingDraftSessionStart(false)
    setLocalSessionJobId(null)
    if (localSessionJob.status === 'failed') {
      setError(localSessionJob.lastError ?? 'Failed to run the session')
    }
  }, [localSessionJob])

  const applyProviderStatus = useCallback((providerId: ProviderId, status: SidecarStatus) => {
    setAgentStatusByProvider((prev) => ({ ...prev, [providerId]: status }))
  }, [])

  const setProviderConnecting = useCallback((providerId: ProviderId, connecting: boolean) => {
    setConnectingProviders((prev) => ({ ...prev, [providerId]: connecting }))
  }, [])

  // Pushed sidecar statuses are the source of truth; the local connecting flag
  // only bridges the gap while an ensure IPC round-trip is in flight.
  const agentUiStatusByProvider = useMemo(() => {
    const result: Partial<Record<ProviderId, ProviderUiStatus>> = {}
    const providerIds = new Set([
      ...Object.keys(agentStatusByProvider),
      ...Object.keys(connectingProviders),
    ])
    for (const providerId of providerIds) {
      if (!isProviderId(providerId)) continue
      const status = agentStatusByProvider[providerId]
      result[providerId] =
        status === 'healthy'
          ? 'connected'
          : connectingProviders[providerId] || status === 'starting'
            ? 'connecting'
            : 'disconnected'
    }
    return result
  }, [agentStatusByProvider, connectingProviders])

  const providerDisplayName = useCallback(
    (providerId: ProviderId) =>
      providers.find((provider) => provider.id === providerId)?.displayName ?? providerId,
    [providers],
  )

  const ensureProvider = useCallback(
    async (providerId: ProviderId, cwd: string): Promise<boolean> => {
      return coordinateProviderConnection(
        providerConnectionPromisesRef.current,
        providerId,
        async () => {
          setProviderConnecting(providerId, true)
          try {
            const handshake = await window.electronAPI.ensureAgentProvider(providerId, cwd)
            return handshake.ready
          } catch {
            return false
          } finally {
            setProviderConnecting(providerId, false)
          }
        },
      )
    },
    [setProviderConnecting],
  )

  const retryProvider = useCallback(
    async (providerId: ProviderId) => {
      setError(null)
      const ready = await ensureProvider(providerId, activeWorkspacePath ?? '')
      if (!ready) setError(`Failed to connect to ${providerDisplayName(providerId)}.`)
    },
    [activeWorkspacePath, ensureProvider, providerDisplayName],
  )

  const addWorkspace = useCallback(async () => {
    setError(null)
    const folder = await window.electronAPI.selectFolder()
    if (!folder) return
    try {
      await ensureWorkspace({ path: folder, machineId: 'desktop' })
      rememberActiveWorkspacePath(folder)
      setActiveSessionId(null)
      setIsSessionDraftOpen(true)
      setPendingDraftSessionStart(false)
      setLocalSessionStatus(null)
      setLocalSessionJobId(null)
      setAdoptedDraftSessionId(null)
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [folder]: {
          ...(prev[folder] ?? {}),
          providerId: prev[folder]?.providerId ?? defaultProviderId,
        },
      }))
      mergeDraftRuntimeForWorkspace(folder, {
        providerId: draftSelectionByWorkspace[folder]?.providerId ?? defaultProviderId,
      })
      void ensureProvider(
        draftSelectionByWorkspace[folder]?.providerId ?? defaultProviderId,
        folder,
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }, [
    defaultProviderId,
    draftSelectionByWorkspace,
    ensureProvider,
    ensureWorkspace,
    mergeDraftRuntimeForWorkspace,
    rememberActiveWorkspacePath,
  ])

  const removeWorkspace = useCallback(
    async (path: string) => {
      setError(null)
      try {
        const workspace = await trackedConvexQuery(
          'workspaces.getByPath',
          api.workspaces.getByPath,
          { path },
        )
        if (workspace?._id) {
          await removeWorkspaceMutation({ id: workspace._id })
        }

        if (activeWorkspacePath === path) {
          rememberActiveWorkspacePath(null)
          setActiveSessionId(null)
          setIsSessionDraftOpen(false)
          setPendingDraftSessionStart(false)
          setLocalSessionStatus(null)
          setLocalSessionJobId(null)
          setAdoptedDraftSessionId(null)
        }
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, rememberActiveWorkspacePath, removeWorkspaceMutation],
  )

  const selectSession = useCallback(
    (workspacePath: string, externalId: string, persistedProviderId?: ProviderId) => {
      rememberActiveWorkspacePath(workspacePath)
      setActiveSessionId(externalId)
      setIsSessionDraftOpen(false)
      setPendingDraftSessionStart(false)
      setLocalSessionStatus(null)
      setLocalSessionJobId(null)
      setAdoptedDraftSessionId(null)
      const providerId =
        acpSessionStateById[externalId]?.providerId ?? persistedProviderId ?? 'opencode'
      setAcpSessionStateById((prev) => ({
        ...prev,
        [externalId]: prev[externalId] ?? { sessionId: externalId, providerId },
      }))
      ensureProvider(providerId, workspacePath).catch(console.error)
      if (typeof window.electronAPI.loadAcpSession === 'function') {
        window.electronAPI
          .loadAcpSession(providerId, workspacePath, externalId)
          .catch(() => undefined)
      }
    },
    [acpSessionStateById, ensureProvider, rememberActiveWorkspacePath],
  )

  const createSession = useCallback(
    async (workspacePath: string) => {
      setError(null)
      rememberActiveWorkspacePath(workspacePath)
      setActiveSessionId(null)
      setIsSessionDraftOpen(true)
      setPendingDraftSessionStart(false)
      setLocalSessionStatus(null)
      setLocalSessionJobId(null)
      setAdoptedDraftSessionId(null)
      const fallbackSessionState =
        activeWorkspacePath === workspacePath && activeSessionId
          ? acpSessionStateById[activeSessionId]
          : null
      const draftProviderId =
        fallbackSessionState?.providerId ??
        draftSelectionByWorkspace[workspacePath]?.providerId ??
        defaultProviderId
      const preference =
        workspaceComposerPreferencesRef.current[
          workspaceComposerPreferenceKey(workspacePath, draftProviderId)
        ]
      const resolvedDraft = resolveDraftComposerRuntime({
        workspacePath,
        providerId: draftProviderId,
        runtime: fallbackSessionState ?? draftSessionStateByWorkspace[workspacePath],
        selection: {
          ...draftSelectionByWorkspace[workspacePath],
          ...(fallbackSessionState?.models?.currentModelId
            ? { modelId: fallbackSessionState.models.currentModelId }
            : {}),
          ...(fallbackSessionState?.modes?.currentModeId
            ? { modeId: fallbackSessionState.modes.currentModeId }
            : {}),
        },
        preference,
        profile: providerComposerProfilesRef.current[draftProviderId],
      })
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [workspacePath]: {
          providerId: draftProviderId,
          ...(resolvedDraft.models?.currentModelId
            ? { modelId: resolvedDraft.models.currentModelId }
            : {}),
          ...(resolvedDraft.modes?.currentModeId
            ? { modeId: resolvedDraft.modes.currentModeId }
            : {}),
        },
      }))
      mergeDraftRuntimeForWorkspace(workspacePath, {
        providerId: draftProviderId,
        ...(resolvedDraft.models ? { models: resolvedDraft.models } : {}),
        ...(resolvedDraft.modes ? { modes: resolvedDraft.modes } : {}),
        ...(resolvedDraft.availableCommands
          ? { availableCommands: resolvedDraft.availableCommands }
          : {}),
      })
      const providerReady = await ensureProvider(draftProviderId, workspacePath)

      const hasRuntime =
        !!fallbackSessionState?.models?.availableModels?.length ||
        !!fallbackSessionState?.modes?.availableModes?.length ||
        !!fallbackSessionState?.availableCommands?.length
      if (hasRuntime || typeof window.electronAPI.loadAcpSession !== 'function') return

      try {
        const sessions = (await trackedConvexQuery(
          'sessions.listByWorkspace',
          api.sessions.listByWorkspace,
          {
            workspacePath,
          },
        )) as Array<{ externalId: string; updatedAt: number; providerId?: unknown }>
        const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
        const providerSessions = sessionsForProvider(sorted, draftProviderId)
        const hydrated = providerSessions.find((row) => !!acpSessionStateById[row.externalId])
        if (hydrated) {
          const runtime = acpSessionStateById[hydrated.externalId]
          if (runtime) {
            mergeDraftRuntimeForWorkspace(workspacePath, {
              ...(runtime.models ? { models: runtime.models } : {}),
              ...(runtime.modes ? { modes: runtime.modes } : {}),
              ...(runtime.availableCommands
                ? { availableCommands: runtime.availableCommands }
                : {}),
            })
          }
          return
        }
        if (providerReady && providerSessions[0]?.externalId) {
          const sessionId = providerSessions[0].externalId
          const providerId = resolveSessionProviderId(providerSessions[0].providerId)
          await window.electronAPI.loadAcpSession(providerId, workspacePath, sessionId)
        }
      } catch {
        // Best-effort hydration; draft can still proceed without metadata.
      }
    },
    [
      acpSessionStateById,
      activeSessionId,
      activeWorkspacePath,
      defaultProviderId,
      draftSessionStateByWorkspace,
      ensureProvider,
      draftSelectionByWorkspace,
      mergeDraftRuntimeForWorkspace,
      rememberActiveWorkspacePath,
    ],
  )

  const deleteSession = useCallback(
    async (workspacePath: string, externalId: string, persistedProviderId?: ProviderId) => {
      setError(null)
      if (!currentClientId) {
        setError('Client identity unavailable')
        return
      }
      try {
        await submitJob({
          workspacePath,
          type: 'delete_session',
          payload: JSON.stringify({
            workspacePath,
            sessionExternalId: externalId,
            providerId:
              acpSessionStateById[externalId]?.providerId ?? persistedProviderId ?? 'opencode',
          }),
          clientId: currentClientId,
          sessionExternalId: externalId,
        })
        if (activeSessionId === externalId) {
          setActiveSessionId(null)
          setLocalSessionStatus(null)
          setLocalSessionJobId(null)
          setAdoptedDraftSessionId(null)
        }
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [acpSessionStateById, activeSessionId, currentClientId, submitJob],
  )

  const sendMessage = useCallback(
    async (content: string, userMessageId?: string, attachments: PromptAttachment[] = []) => {
      const trimmed = content.trim()
      if (!activeWorkspacePath || (!trimmed && attachments.length === 0)) return null
      setError(null)
      if (!currentClientId) {
        const error = new Error('Client identity unavailable')
        setError(error.message)
        throw error
      }
      if (!activeSessionId) {
        if (!isSessionDraftOpen || pendingDraftSessionStart) return null
        const draftSelection = draftSelectionByWorkspace[activeWorkspacePath] ?? {}
        const draftProviderId = draftSelection.providerId ?? defaultProviderId
        const resolvedDraft = resolveDraftComposerRuntime({
          workspacePath: activeWorkspacePath,
          providerId: draftProviderId,
          runtime: draftSessionStateByWorkspace[activeWorkspacePath],
          selection: draftSelection,
          preference:
            workspaceComposerPreferencesRef.current[
              workspaceComposerPreferenceKey(activeWorkspacePath, draftProviderId)
            ],
          profile: providerComposerProfilesRef.current[draftProviderId],
        })
        const preferredModelId = resolvedDraft.models?.currentModelId
        const preferredModeId = resolvedDraft.modes?.currentModeId
        setPendingDraftSessionStart(true)
        setLocalSessionStatus('starting')
        setAdoptedDraftSessionId(null)
        const ready = await ensureProvider(draftProviderId, activeWorkspacePath)
        if (!ready) {
          const error = new Error(
            `${providerDisplayName(draftProviderId)} is unavailable. Retry connection from the sidebar.`,
          )
          setPendingDraftSessionStart(false)
          setLocalSessionStatus(null)
          setError(error.message)
          throw error
        }
        try {
          const jobId = (await submitJob({
            workspacePath: activeWorkspacePath,
            type: 'start_session_with_message',
            payload: JSON.stringify({
              workspacePath: activeWorkspacePath,
              content: trimmed,
              attachments,
              userMessageId,
              providerId: draftProviderId,
              ...(preferredModelId ? { preferredModelId } : {}),
              ...(preferredModeId ? { preferredModeId } : {}),
            }),
            clientId: currentClientId,
          })) as Id<'pending_jobs'>
          setLocalSessionJobId(jobId)
          return jobId
        } catch (err) {
          setPendingDraftSessionStart(false)
          setLocalSessionStatus(null)
          setLocalSessionJobId(null)
          setError((err as Error).message)
          throw err
        }
      }
      setLocalSessionStatus('running')
      setAdoptedDraftSessionId(null)
      try {
        await recordRendererTelemetry({
          kind: 'trace',
          phase: 'mark',
          name: 'message.send',
          sessionExternalId: activeSessionId,
          workspacePath: activeWorkspacePath,
          details: trimmed.slice(0, 120) || `${attachments.length} image attachment(s)`,
        })
        const jobId = (await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'send_message',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId: activeSessionId,
            content: trimmed,
            attachments,
            userMessageId,
            providerId: acpSessionStateById[activeSessionId]?.providerId ?? defaultProviderId,
          }),
          clientId: currentClientId,
          sessionExternalId: activeSessionId,
        })) as Id<'pending_jobs'>
        setLocalSessionJobId(jobId)
        return jobId
      } catch (err) {
        setLocalSessionStatus(null)
        setLocalSessionJobId(null)
        setError((err as Error).message)
        throw err
      }
    },
    [
      activeSessionId,
      activeWorkspacePath,
      acpSessionStateById,
      currentClientId,
      defaultProviderId,
      draftSelectionByWorkspace,
      draftSessionStateByWorkspace,
      ensureProvider,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      providerDisplayName,
      submitJob,
    ],
  )

  const setDraftModel = useCallback(
    (modelId: string) => {
      if (!activeWorkspacePath) return
      const providerId =
        draftSelectionByWorkspace[activeWorkspacePath]?.providerId ?? defaultProviderId
      rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modelId })
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          ...(prev[activeWorkspacePath] ?? {}),
          modelId,
        },
      }))
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          ...(prev[activeWorkspacePath] ?? {}),
          models: {
            ...(prev[activeWorkspacePath]?.models ?? {}),
            currentModelId: modelId,
          },
        },
      }))
    },
    [
      activeWorkspacePath,
      defaultProviderId,
      draftSelectionByWorkspace,
      rememberWorkspaceComposerPreference,
    ],
  )

  const setDraftMode = useCallback(
    (modeId: string) => {
      if (!activeWorkspacePath) return
      const providerId =
        draftSelectionByWorkspace[activeWorkspacePath]?.providerId ?? defaultProviderId
      rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modeId })
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          ...(prev[activeWorkspacePath] ?? {}),
          modeId,
        },
      }))
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          ...(prev[activeWorkspacePath] ?? {}),
          modes: {
            ...(prev[activeWorkspacePath]?.modes ?? {}),
            currentModeId: modeId,
          },
        },
      }))
    },
    [
      activeWorkspacePath,
      defaultProviderId,
      draftSelectionByWorkspace,
      rememberWorkspaceComposerPreference,
    ],
  )

  const setDraftProvider = useCallback(
    (providerId: ProviderId) => {
      if (!activeWorkspacePath) return
      setDefaultProviderId(providerId)
      // Preference persistence is best-effort.
      window.electronAPI.setLastProviderId(providerId).catch(() => undefined)
      const workspaceRuntime = draftSessionStateByWorkspace[activeWorkspacePath]
      const resolvedDraft = resolveDraftComposerRuntime({
        workspacePath: activeWorkspacePath,
        providerId,
        runtime: workspaceRuntime?.providerId === providerId ? workspaceRuntime : undefined,
        preference:
          workspaceComposerPreferencesRef.current[
            workspaceComposerPreferenceKey(activeWorkspacePath, providerId)
          ],
        profile: providerComposerProfilesRef.current[providerId],
      })
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          providerId,
          ...(resolvedDraft.models?.currentModelId
            ? { modelId: resolvedDraft.models.currentModelId }
            : {}),
          ...(resolvedDraft.modes?.currentModeId
            ? { modeId: resolvedDraft.modes.currentModeId }
            : {}),
        },
      }))
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          providerId,
          ...(resolvedDraft.models ? { models: resolvedDraft.models } : {}),
          ...(resolvedDraft.modes ? { modes: resolvedDraft.modes } : {}),
          ...(resolvedDraft.availableCommands
            ? { availableCommands: resolvedDraft.availableCommands }
            : {}),
        },
      }))
      void ensureProvider(providerId, activeWorkspacePath)
    },
    [activeWorkspacePath, draftSessionStateByWorkspace, ensureProvider],
  )

  const abortSession = useCallback(
    async (externalId: string) => {
      if (!activeWorkspacePath) return
      if (!currentClientId) {
        setError('Client identity unavailable')
        return
      }
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'abort',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId: externalId,
            providerId: acpSessionStateById[externalId]?.providerId ?? defaultProviderId,
          }),
          clientId: currentClientId,
          sessionExternalId: externalId,
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [acpSessionStateById, activeWorkspacePath, currentClientId, defaultProviderId, submitJob],
  )

  const resolvePermission = useCallback(
    async (sessionExternalId: string, permissionId: string, approved: boolean) => {
      if (!activeWorkspacePath) return
      if (!currentClientId) {
        setError('Client identity unavailable')
        return
      }
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'resolve_permission',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            permissionId,
            approved,
            providerId: acpSessionStateById[sessionExternalId]?.providerId ?? defaultProviderId,
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [acpSessionStateById, activeWorkspacePath, currentClientId, defaultProviderId, submitJob],
  )

  const setSessionModel = useCallback(
    async (sessionExternalId: string, modelId: string) => {
      if (!activeWorkspacePath || !currentClientId) return
      const providerId = acpSessionStateById[sessionExternalId]?.providerId ?? defaultProviderId
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'set_model',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            modelId,
            providerId,
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
        setAcpSessionStateById((prev) => ({
          ...prev,
          [sessionExternalId]: {
            ...(prev[sessionExternalId] ?? {
              sessionId: sessionExternalId,
              providerId: defaultProviderId,
            }),
            models: {
              ...(prev[sessionExternalId]?.models ?? {}),
              currentModelId: modelId,
            },
          },
        }))
        setDraftSelectionByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: {
            ...(prev[activeWorkspacePath] ?? {}),
            modelId,
          },
        }))
        rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modelId })
        setDraftSessionStateByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: {
            ...(prev[activeWorkspacePath] ?? {}),
            models: {
              ...(prev[activeWorkspacePath]?.models ?? {}),
              currentModelId: modelId,
            },
          },
        }))
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [
      acpSessionStateById,
      activeWorkspacePath,
      currentClientId,
      defaultProviderId,
      rememberWorkspaceComposerPreference,
      submitJob,
    ],
  )

  const setSessionMode = useCallback(
    async (sessionExternalId: string, modeId: string) => {
      if (!activeWorkspacePath || !currentClientId) return
      const providerId = acpSessionStateById[sessionExternalId]?.providerId ?? defaultProviderId
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'set_mode',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            modeId,
            providerId,
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
        setAcpSessionStateById((prev) => ({
          ...prev,
          [sessionExternalId]: {
            ...(prev[sessionExternalId] ?? {
              sessionId: sessionExternalId,
              providerId: defaultProviderId,
            }),
            modes: {
              ...(prev[sessionExternalId]?.modes ?? {}),
              currentModeId: modeId,
            },
          },
        }))
        setDraftSelectionByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: {
            ...(prev[activeWorkspacePath] ?? {}),
            modeId,
          },
        }))
        rememberWorkspaceComposerPreference(activeWorkspacePath, providerId, { modeId })
        setDraftSessionStateByWorkspace((prev) => ({
          ...prev,
          [activeWorkspacePath]: {
            ...(prev[activeWorkspacePath] ?? {}),
            modes: {
              ...(prev[activeWorkspacePath]?.modes ?? {}),
              currentModeId: modeId,
            },
          },
        }))
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [
      acpSessionStateById,
      activeWorkspacePath,
      currentClientId,
      defaultProviderId,
      rememberWorkspaceComposerPreference,
      submitJob,
    ],
  )

  useEffect(() => {
    window.electronAPI
      .getAgentProviders()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

  useEffect(() => {
    window.electronAPI
      .getProviderComposerProfiles()
      .then((stored) => {
        const next = mergeProviderComposerProfiles(stored, providerComposerProfilesRef.current)
        providerComposerProfilesRef.current = next
        setProviderComposerProfiles(next)
        setAcpAgentInfoByProvider((current) => {
          const restored = { ...current }
          for (const [providerId, profile] of Object.entries(stored)) {
            if (isProviderId(providerId) && profile?.agentInfo) {
              restored[providerId] = profile.agentInfo
            }
          }
          return restored
        })
      })
      .catch(() => undefined)
    window.electronAPI
      .getWorkspaceComposerPreferences()
      .then((stored) => {
        const next = mergeWorkspaceComposerPreferences(
          stored,
          workspaceComposerPreferencesRef.current,
        )
        workspaceComposerPreferencesRef.current = next
        setWorkspaceComposerPreferences(next)
      })
      .catch(() => undefined)
  }, [])

  // Convex is the durable, cross-device source for composer profiles and
  // preferences (the electron-store copy above is a machine-local fast path).
  // Both subscriptions are tiny and only push when the projector actually
  // learns something new; merges keep live in-memory state authoritative and
  // bail out before setState when nothing changed, so no extra re-renders.
  const composerProfileDocs = useTrackedQuery(
    'composer.listProfiles',
    (api as any).composer.listProfiles,
    {},
  ) as ProviderComposerProfileDoc[] | undefined
  const composerPreferenceDocs = useTrackedQuery(
    'composer.listPreferences',
    (api as any).composer.listPreferences,
    {},
  ) as WorkspaceComposerPreferenceDoc[] | undefined

  useEffect(() => {
    if (!composerProfileDocs) return
    const stored = composerProfilesFromDocs(composerProfileDocs)
    const next = mergeProviderComposerProfiles(stored, providerComposerProfilesRef.current)
    if (JSON.stringify(next) !== JSON.stringify(providerComposerProfilesRef.current)) {
      providerComposerProfilesRef.current = next
      setProviderComposerProfiles(next)
    }
    setAcpAgentInfoByProvider((current) => {
      let changed = false
      const restored = { ...current }
      for (const [providerId, profile] of Object.entries(stored)) {
        if (isProviderId(providerId) && profile?.agentInfo && !current[providerId]) {
          restored[providerId] = profile.agentInfo
          changed = true
        }
      }
      return changed ? restored : current
    })
  }, [composerProfileDocs])

  useEffect(() => {
    if (!composerPreferenceDocs) return
    const stored = composerPreferencesFromDocs(composerPreferenceDocs)
    const next = mergeWorkspaceComposerPreferences(stored, workspaceComposerPreferencesRef.current)
    if (JSON.stringify(next) === JSON.stringify(workspaceComposerPreferencesRef.current)) return
    workspaceComposerPreferencesRef.current = next
    setWorkspaceComposerPreferences(next)
  }, [composerPreferenceDocs])

  useEffect(() => {
    window.electronAPI
      .getLastProviderId()
      .then((providerId) => {
        if (isProviderId(providerId)) setDefaultProviderId(providerId)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    window.electronAPI
      .getClientId()
      .then(setCurrentClientId)
      .catch(() => setCurrentClientId(null))
  }, [])

  useEffect(() => {
    window.electronAPI
      .getAgentPromptCapabilities()
      .then(setAcpPromptCapabilitiesByProvider)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    window.electronAPI
      .getAgentStatuses()
      .then((statuses) => {
        for (const [providerId, status] of Object.entries(statuses)) {
          if (isProviderId(providerId) && status) applyProviderStatus(providerId, status)
        }
      })
      .catch(() => undefined)
    const cleanup = window.electronAPI.onAgentStatusChanged(({ providerId, status }) => {
      applyProviderStatus(providerId, status as SidecarStatus)
    })
    return cleanup
  }, [applyProviderStatus])

  useEffect(() => {
    const cleanup = window.electronAPI.onAcpEvent((event) => {
      if (CHROME_EVENT_TYPES.has(event.event)) {
        setAgentEvents((prev) =>
          prev.some((candidate) => candidate.id === event.id) ? prev : [...prev, event],
        )
      }
      const eventWorkspacePath = event.workspaceId ?? activeWorkspacePath

      switch (event.event) {
        case 'initialized':
          if (event.data.agentInfo) {
            const agentInfo = event.data.agentInfo
            setAcpAgentInfoByProvider((prev) => ({ ...prev, [event.providerId]: agentInfo }))
            updateProviderComposerProfile(event.providerId, { agentInfo })
          }
          if (event.data.promptCapabilities) {
            setAcpPromptCapabilitiesByProvider((prev) => ({
              ...prev,
              [event.providerId]: event.data.promptCapabilities,
            }))
          }
          return
        case 'session_created':
        case 'session_loaded': {
          const models = toAcpModels(event.data.models)
          const modes = toAcpModes(event.data.modes)
          updateProviderComposerProfile(event.providerId, {
            ...(models?.availableModels?.length ? { availableModels: models.availableModels } : {}),
            ...(modes?.availableModes?.length ? { availableModes: modes.availableModes } : {}),
            ...(event.event === 'session_created' && models?.currentModelId
              ? { defaultModelId: models.currentModelId }
              : {}),
            ...(event.event === 'session_created' && modes?.currentModeId
              ? { defaultModeId: modes.currentModeId }
              : {}),
          })
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              ...(models ? { models } : {}),
              ...(modes ? { modes } : {}),
            },
          }))
          if (eventWorkspacePath) {
            mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
              providerId: event.providerId,
              ...(models ? { models } : {}),
              ...(modes ? { modes } : {}),
            })
            if (event.event === 'session_loaded') {
              rememberWorkspaceComposerPreference(
                eventWorkspacePath,
                event.providerId,
                {
                  ...(models?.currentModelId ? { modelId: models.currentModelId } : {}),
                  ...(modes?.currentModeId ? { modeId: modes.currentModeId } : {}),
                },
                false,
              )
            }
          }
          if (
            event.event === 'session_created' &&
            pendingDraftSessionStart &&
            activeWorkspacePath === eventWorkspacePath
          ) {
            setAdoptedDraftSessionId(event.sessionId)
            setActiveSessionId(event.sessionId)
            setIsSessionDraftOpen(false)
            setPendingDraftSessionStart(false)
            setLocalSessionStatus('running')
          }
          return
        }
        case 'current_model_update':
          {
            const models = toAcpModels(event.data)
            updateProviderComposerProfile(event.providerId, {
              ...(models?.availableModels?.length
                ? { availableModels: models.availableModels }
                : {}),
            })
            setAcpSessionStateById((prev) => ({
              ...prev,
              [event.sessionId]: {
                ...(prev[event.sessionId] ?? {
                  sessionId: event.sessionId,
                  providerId: event.providerId,
                }),
                providerId: event.providerId,
                models,
              },
            }))
            if (eventWorkspacePath && models) {
              mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
                providerId: event.providerId,
                models,
              })
              if (models.currentModelId) {
                // Fill-only: model updates also fire when the main process
                // restores a reopened session's own model, and that must not
                // overwrite the workspace's last-chosen preference. Explicit
                // user picks persist via setDraftModel/setSessionModel.
                rememberWorkspaceComposerPreference(
                  eventWorkspacePath,
                  event.providerId,
                  {
                    modelId: models.currentModelId,
                  },
                  false,
                )
              }
            }
          }
          return
        case 'current_mode_update':
          {
            const modes = toAcpModes(event.data)
            updateProviderComposerProfile(event.providerId, {
              ...(modes?.availableModes?.length ? { availableModes: modes.availableModes } : {}),
            })
            setAcpSessionStateById((prev) => ({
              ...prev,
              [event.sessionId]: {
                ...(prev[event.sessionId] ?? {
                  sessionId: event.sessionId,
                  providerId: event.providerId,
                }),
                providerId: event.providerId,
                modes,
              },
            }))
            if (eventWorkspacePath && modes) {
              mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
                providerId: event.providerId,
                modes,
              })
              if (modes.currentModeId) {
                // Fill-only, matching the model update handling above.
                rememberWorkspaceComposerPreference(
                  eventWorkspacePath,
                  event.providerId,
                  {
                    modeId: modes.currentModeId,
                  },
                  false,
                )
              }
            }
          }
          return
        case 'available_commands_update':
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              availableCommands: event.data.availableCommands,
            },
          }))
          if (eventWorkspacePath) {
            mergeDraftRuntimeForWorkspace(eventWorkspacePath, {
              providerId: event.providerId,
              availableCommands: event.data.availableCommands,
            })
          }
          return
        case 'session_deleted':
          setAcpSessionStateById((prev) => {
            const next = { ...prev }
            delete next[event.sessionId]
            return next
          })
          return
        case 'prompt_started':
          if (
            event.sessionId === activeSessionId ||
            event.sessionId === adoptedDraftSessionId ||
            pendingDraftSessionStart
          ) {
            setLocalSessionStatus('running')
          }
          return
        case 'prompt_completed':
          if (event.sessionId === activeSessionId || event.sessionId === adoptedDraftSessionId) {
            setLocalSessionStatus(null)
            setLocalSessionJobId(null)
          }
          return
        case 'rpc_error':
        case 'runtime_error':
        case 'process_exited':
          if (
            !event.sessionId ||
            event.sessionId === activeSessionId ||
            event.sessionId === adoptedDraftSessionId
          ) {
            setLocalSessionStatus(null)
            setLocalSessionJobId(null)
            setPendingDraftSessionStart(false)
          }
          return
        case 'process_spawned':
        case 'authenticated':
        case 'user_message_chunk':
        case 'agent_message_chunk':
        case 'agent_thought_chunk':
        case 'tool_call':
        case 'tool_call_update':
        case 'tool_call_content':
        case 'plan_update':
        case 'permission_request':
        case 'config_option_update':
        case 'session_info_update':
        case 'usage_update':
        case 'extension_request':
        case 'extension_notification':
        case 'auth_required':
        case 'capability_missing':
          return
        default:
          event satisfies never
      }
    })
    return cleanup
  }, [
    activeSessionId,
    activeWorkspacePath,
    adoptedDraftSessionId,
    mergeDraftRuntimeForWorkspace,
    pendingDraftSessionStart,
    rememberWorkspaceComposerPreference,
    updateProviderComposerProfile,
  ])

  const acpSessionState = useMemo(() => {
    if (!activeSessionId) return null
    const runtime = acpSessionStateById[activeSessionId]
    if (!runtime) return null
    const preference = activeWorkspacePath
      ? workspaceComposerPreferences[
          workspaceComposerPreferenceKey(activeWorkspacePath, runtime.providerId)
        ]
      : undefined
    return resolveSessionComposerRuntime(
      runtime,
      preference,
      providerComposerProfiles[runtime.providerId],
    )
  }, [
    acpSessionStateById,
    activeSessionId,
    activeWorkspacePath,
    providerComposerProfiles,
    workspaceComposerPreferences,
  ])

  const draftSessionState = useMemo(() => {
    if (!activeWorkspacePath || !isSessionDraftOpen) return null
    const runtime = draftSessionStateByWorkspace[activeWorkspacePath]
    const selection = draftSelectionByWorkspace[activeWorkspacePath]
    const providerId = runtime?.providerId ?? selection?.providerId ?? defaultProviderId
    return resolveDraftComposerRuntime({
      workspacePath: activeWorkspacePath,
      providerId,
      runtime,
      selection,
      preference:
        workspaceComposerPreferences[
          workspaceComposerPreferenceKey(activeWorkspacePath, providerId)
        ],
      profile: providerComposerProfiles[providerId],
    })
  }, [
    activeWorkspacePath,
    defaultProviderId,
    draftSelectionByWorkspace,
    draftSessionStateByWorkspace,
    isSessionDraftOpen,
    providerComposerProfiles,
    workspaceComposerPreferences,
  ])

  const value = useMemo<AppUiValue>(
    () => ({
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      localSessionStatus,
      adoptedDraftSessionId,
      currentClientId,
      agentStatusByProvider,
      agentUiStatusByProvider,
      acpAgentInfoByProvider,
      acpPromptCapabilitiesByProvider,
      defaultProviderId,
      agentEvents,
      providers,
      acpSessionState,
      draftSessionState,
      error,
      retryProvider,
      setActiveWorkspacePath,
      setActiveSessionId,
      addWorkspace,
      removeWorkspace,
      selectSession,
      createSession,
      deleteSession,
      sendMessage,
      abortSession,
      resolvePermission,
      setDraftModel,
      setDraftMode,
      setDraftProvider,
      setSessionModel,
      setSessionMode,
    }),
    [
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      localSessionStatus,
      adoptedDraftSessionId,
      currentClientId,
      agentStatusByProvider,
      agentUiStatusByProvider,
      acpAgentInfoByProvider,
      acpPromptCapabilitiesByProvider,
      defaultProviderId,
      agentEvents,
      providers,
      acpSessionState,
      draftSessionState,
      error,
      retryProvider,
      addWorkspace,
      removeWorkspace,
      selectSession,
      createSession,
      deleteSession,
      sendMessage,
      abortSession,
      resolvePermission,
      setDraftModel,
      setDraftMode,
      setDraftProvider,
      setSessionModel,
      setSessionMode,
    ],
  )

  return <AppUiContext.Provider value={value}>{children}</AppUiContext.Provider>
}
