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
} from '../lib/convex-telemetry'
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

export interface AcpModelOption {
  modelId: string
  name: string
}

export interface AcpModeOption {
  id: string
  name: string
  description?: string
}

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

interface AppUiValue {
  activeWorkspacePath: string | null
  activeSessionId: string | null
  isSessionDraftOpen: boolean
  pendingDraftSessionStart: boolean
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
  const connectingRef = useRef<Set<ProviderId>>(new Set())
  const [defaultProviderId, setDefaultProviderId] = useState<ProviderId>('opencode')
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [isSessionDraftOpen, setIsSessionDraftOpen] = useState(false)
  const [pendingDraftSessionStart, setPendingDraftSessionStart] = useState(false)
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

  const telemetryContext = useCallback(
    () => ({
      sessionExternalId: activeSessionId ?? undefined,
      workspacePath: activeWorkspacePath ?? undefined,
    }),
    [activeSessionId, activeWorkspacePath],
  )

  const submitJob = useTrackedMutation('jobs.submit', api.jobs.submit, telemetryContext)
  const ensureWorkspace = useTrackedMutation('workspaces.ensureByPath', api.workspaces.ensureByPath)
  const removeWorkspaceMutation = useTrackedMutation('workspaces.remove', api.workspaces.remove)

  const applyProviderStatus = useCallback((providerId: ProviderId, status: SidecarStatus) => {
    setAgentStatusByProvider((prev) => ({ ...prev, [providerId]: status }))
  }, [])

  const setProviderConnecting = useCallback((providerId: ProviderId, connecting: boolean) => {
    if (connecting) connectingRef.current.add(providerId)
    else connectingRef.current.delete(providerId)
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
      if (connectingRef.current.has(providerId)) return false
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
    [setProviderConnecting],
  )

  const retryProvider = useCallback(
    async (providerId: ProviderId) => {
      if (connectingRef.current.has(providerId)) return
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
      setActiveWorkspacePath(folder)
      setActiveSessionId(null)
      setIsSessionDraftOpen(false)
      setPendingDraftSessionStart(false)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [ensureWorkspace])

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
          setActiveWorkspacePath(null)
          setActiveSessionId(null)
          setIsSessionDraftOpen(false)
          setPendingDraftSessionStart(false)
        }
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, removeWorkspaceMutation],
  )

  const selectSession = useCallback(
    (workspacePath: string, externalId: string, persistedProviderId?: ProviderId) => {
      setActiveWorkspacePath(workspacePath)
      setActiveSessionId(externalId)
      setIsSessionDraftOpen(false)
      setPendingDraftSessionStart(false)
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
    [acpSessionStateById, ensureProvider],
  )

  const createSession = useCallback(
    async (workspacePath: string) => {
      setError(null)
      setActiveWorkspacePath(workspacePath)
      setActiveSessionId(null)
      setIsSessionDraftOpen(true)
      setPendingDraftSessionStart(false)
      const fallbackSessionState =
        activeWorkspacePath === workspacePath && activeSessionId
          ? acpSessionStateById[activeSessionId]
          : null
      if (fallbackSessionState) {
        mergeDraftRuntimeForWorkspace(workspacePath, {
          providerId: fallbackSessionState.providerId,
          ...(fallbackSessionState.models ? { models: fallbackSessionState.models } : {}),
          ...(fallbackSessionState.modes ? { modes: fallbackSessionState.modes } : {}),
          ...(fallbackSessionState.availableCommands
            ? { availableCommands: fallbackSessionState.availableCommands }
            : {}),
        })
        setDraftSelectionByWorkspace((prev) => ({
          ...prev,
          [workspacePath]: {
            ...(prev[workspacePath] ?? {}),
            providerId: fallbackSessionState.providerId,
            ...(fallbackSessionState.models?.currentModelId
              ? { modelId: fallbackSessionState.models.currentModelId }
              : {}),
            ...(fallbackSessionState.modes?.currentModeId
              ? { modeId: fallbackSessionState.modes.currentModeId }
              : {}),
          },
        }))
      }
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [workspacePath]: {
          providerId:
            prev[workspacePath]?.providerId ??
            fallbackSessionState?.providerId ??
            defaultProviderId,
          ...(prev[workspacePath]?.modelId ? { modelId: prev[workspacePath].modelId } : {}),
          ...(prev[workspacePath]?.modeId ? { modeId: prev[workspacePath].modeId } : {}),
        },
      }))
      const draftProviderId =
        fallbackSessionState?.providerId ??
        draftSelectionByWorkspace[workspacePath]?.providerId ??
        defaultProviderId
      mergeDraftRuntimeForWorkspace(workspacePath, { providerId: draftProviderId })
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
      ensureProvider,
      draftSelectionByWorkspace,
      mergeDraftRuntimeForWorkspace,
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
        if (activeSessionId === externalId) setActiveSessionId(null)
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
        const ready = await ensureProvider(draftProviderId, activeWorkspacePath)
        if (!ready) {
          const error = new Error(
            `${providerDisplayName(draftProviderId)} is unavailable. Retry connection from the sidebar.`,
          )
          setError(error.message)
          throw error
        }
        setPendingDraftSessionStart(true)
        try {
          return (await submitJob({
            workspacePath: activeWorkspacePath,
            type: 'start_session_with_message',
            payload: JSON.stringify({
              workspacePath: activeWorkspacePath,
              content: trimmed,
              attachments,
              userMessageId,
              providerId: draftProviderId,
              ...(draftSelection.modelId ? { preferredModelId: draftSelection.modelId } : {}),
              ...(draftSelection.modeId ? { preferredModeId: draftSelection.modeId } : {}),
            }),
            clientId: currentClientId,
          })) as string
        } catch (err) {
          setPendingDraftSessionStart(false)
          setError((err as Error).message)
          throw err
        }
      }
      try {
        await recordRendererTelemetry({
          kind: 'trace',
          phase: 'mark',
          name: 'message.send',
          sessionExternalId: activeSessionId,
          workspacePath: activeWorkspacePath,
          details: trimmed.slice(0, 120) || `${attachments.length} image attachment(s)`,
        })
        return (await submitJob({
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
        })) as string
      } catch (err) {
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
    [activeWorkspacePath],
  )

  const setDraftMode = useCallback(
    (modeId: string) => {
      if (!activeWorkspacePath) return
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
    [activeWorkspacePath],
  )

  const setDraftProvider = useCallback(
    (providerId: ProviderId) => {
      if (!activeWorkspacePath) return
      setDefaultProviderId(providerId)
      // Preference persistence is best-effort.
      window.electronAPI.setLastProviderId(providerId).catch(() => undefined)
      const matchingRuntime = Object.values(acpSessionStateById).find(
        (state) => state.providerId === providerId,
      )
      setDraftSelectionByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          providerId,
          ...(matchingRuntime?.models?.currentModelId
            ? { modelId: matchingRuntime.models.currentModelId }
            : {}),
          ...(matchingRuntime?.modes?.currentModeId
            ? { modeId: matchingRuntime.modes.currentModeId }
            : {}),
        },
      }))
      setDraftSessionStateByWorkspace((prev) => ({
        ...prev,
        [activeWorkspacePath]: {
          providerId,
          ...(matchingRuntime?.models ? { models: matchingRuntime.models } : {}),
          ...(matchingRuntime?.modes ? { modes: matchingRuntime.modes } : {}),
          ...(matchingRuntime?.availableCommands
            ? { availableCommands: matchingRuntime.availableCommands }
            : {}),
        },
      }))
    },
    [acpSessionStateById, activeWorkspacePath],
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
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'set_model',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            modelId,
            providerId: acpSessionStateById[sessionExternalId]?.providerId ?? defaultProviderId,
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
    [acpSessionStateById, activeWorkspacePath, currentClientId, defaultProviderId, submitJob],
  )

  const setSessionMode = useCallback(
    async (sessionExternalId: string, modeId: string) => {
      if (!activeWorkspacePath || !currentClientId) return
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'set_mode',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId,
            modeId,
            providerId: acpSessionStateById[sessionExternalId]?.providerId ?? defaultProviderId,
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
    [acpSessionStateById, activeWorkspacePath, currentClientId, defaultProviderId, submitJob],
  )

  useEffect(() => {
    window.electronAPI
      .getAgentProviders()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [])

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
      setAgentEvents((prev) =>
        prev.some((candidate) => candidate.id === event.id) ? prev : [...prev, event],
      )
      const eventWorkspacePath = event.workspaceId ?? activeWorkspacePath

      switch (event.event) {
        case 'initialized':
          if (event.data.agentInfo) {
            const agentInfo = event.data.agentInfo
            setAcpAgentInfoByProvider((prev) => ({ ...prev, [event.providerId]: agentInfo }))
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
          }
          if (
            event.event === 'session_created' &&
            pendingDraftSessionStart &&
            activeWorkspacePath === eventWorkspacePath
          ) {
            setActiveSessionId(event.sessionId)
            setIsSessionDraftOpen(false)
            setPendingDraftSessionStart(false)
          }
          return
        }
        case 'current_model_update':
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              models: toAcpModels(event.data),
            },
          }))
          return
        case 'current_mode_update':
          setAcpSessionStateById((prev) => ({
            ...prev,
            [event.sessionId]: {
              ...(prev[event.sessionId] ?? {
                sessionId: event.sessionId,
                providerId: event.providerId,
              }),
              providerId: event.providerId,
              modes: toAcpModes(event.data),
            },
          }))
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
        case 'process_spawned':
        case 'process_exited':
        case 'authenticated':
        case 'prompt_started':
        case 'prompt_completed':
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
        case 'rpc_error':
        case 'runtime_error':
        case 'auth_required':
        case 'capability_missing':
          return
        default:
          event satisfies never
      }
    })
    return cleanup
  }, [activeWorkspacePath, mergeDraftRuntimeForWorkspace, pendingDraftSessionStart])

  const acpSessionState = useMemo(
    () => (activeSessionId ? (acpSessionStateById[activeSessionId] ?? null) : null),
    [acpSessionStateById, activeSessionId],
  )

  const draftSessionState = useMemo(() => {
    if (!activeWorkspacePath || !isSessionDraftOpen) return null
    const runtime = draftSessionStateByWorkspace[activeWorkspacePath]
    if (!runtime?.providerId) return null
    return {
      sessionId: `draft:${activeWorkspacePath}`,
      ...runtime,
      providerId: runtime.providerId,
    }
  }, [activeWorkspacePath, draftSessionStateByWorkspace, isSessionDraftOpen])

  const value = useMemo<AppUiValue>(
    () => ({
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
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
