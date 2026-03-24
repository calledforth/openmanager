import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api } from '@convex/_generated/api'
import {
  recordRendererTelemetry,
  trackedConvexQuery,
  useTrackedMutation,
} from '../lib/convex-telemetry'

type SidecarStatus = 'disconnected' | 'connecting' | 'connected'

export interface AcpModelOption {
  modelId: string
  name: string
}

export interface AcpModeOption {
  id: string
  name: string
  description?: string
}

export interface AcpCommandOption {
  name: string
  description?: string
}

export interface AcpSessionRuntimeState {
  sessionId: string
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
  sidecarStatuses: Record<string, SidecarStatus>
  acpAgentInfo: { name?: string; version?: string } | null
  acpSessionState: AcpSessionRuntimeState | null
  draftSessionState: AcpSessionRuntimeState | null
  error: string | null
  setActiveWorkspacePath: (path: string | null) => void
  setActiveSessionId: (sessionId: string | null) => void
  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  selectSession: (workspacePath: string, externalId: string) => void
  createSession: (workspacePath: string) => Promise<void>
  deleteSession: (workspacePath: string, externalId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  abortSession: (externalId: string) => Promise<void>
  resolvePermission: (
    sessionExternalId: string,
    permissionId: string,
    approved: boolean,
  ) => Promise<void>
  setDraftModel: (modelId: string) => void
  setDraftMode: (modeId: string) => void
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
  const [sidecarStatuses, setSidecarStatuses] = useState<Record<string, SidecarStatus>>({})
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [isSessionDraftOpen, setIsSessionDraftOpen] = useState(false)
  const [pendingDraftSessionStart, setPendingDraftSessionStart] = useState(false)
  const [currentClientId, setCurrentClientId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acpAgentInfo, setAcpAgentInfo] = useState<{ name?: string; version?: string } | null>(null)
  const [acpSessionStateById, setAcpSessionStateById] = useState<Record<string, AcpSessionRuntimeState>>(
    {},
  )
  const [draftSessionStateByWorkspace, setDraftSessionStateByWorkspace] = useState<
    Record<string, Omit<AcpSessionRuntimeState, 'sessionId'>>
  >({})
  const [draftSelectionByWorkspace, setDraftSelectionByWorkspace] = useState<
    Record<string, { modelId?: string; modeId?: string }>
  >({})

  const telemetryContext = useCallback(
    () => ({
      sessionExternalId: activeSessionId ?? undefined,
      workspacePath: activeWorkspacePath ?? undefined,
    }),
    [activeSessionId, activeWorkspacePath],
  )

  const submitJob = useTrackedMutation('jobs.submit', api.jobs.submit, telemetryContext)
  const submitMessage = useTrackedMutation('jobs.submitMessage', api.jobs.submitMessage, telemetryContext)
  const ensureWorkspace = useTrackedMutation('workspaces.ensureByPath', api.workspaces.ensureByPath)
  const removeWorkspaceMutation = useTrackedMutation('workspaces.remove', api.workspaces.remove)

  const ensureSidecar = useCallback(
    async (path: string): Promise<boolean> => {
      const current = sidecarStatuses[path]
      if (current === 'connected') return true
      if (current === 'connecting') return false

      setSidecarStatuses((prev) => ({ ...prev, [path]: 'connecting' }))
      try {
        const handshake = await window.electronAPI.spawnSidecar(path)
        if (!handshake.ready) {
          setSidecarStatuses((prev) => ({ ...prev, [path]: 'disconnected' }))
          return false
        }
        setSidecarStatuses((prev) => ({ ...prev, [path]: 'connected' }))
        return true
      } catch {
        setSidecarStatuses((prev) => ({ ...prev, [path]: 'disconnected' }))
        return false
      }
    },
    [sidecarStatuses],
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
      ensureSidecar(folder).catch(console.error)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [ensureWorkspace, ensureSidecar])

  const removeWorkspace = useCallback(
    async (path: string) => {
      setError(null)
      try {
        const workspace = await trackedConvexQuery('workspaces.getByPath', api.workspaces.getByPath, { path })
        if (workspace?._id) {
          await removeWorkspaceMutation({ id: workspace._id })
        }

        if (sidecarStatuses[path] === 'connected') {
          await window.electronAPI.shutdownSidecar(path)
        }
        setSidecarStatuses((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })

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
    [activeWorkspacePath, removeWorkspaceMutation, sidecarStatuses],
  )

  const selectSession = useCallback(
    (workspacePath: string, externalId: string) => {
      setActiveWorkspacePath(workspacePath)
      setActiveSessionId(externalId)
      setIsSessionDraftOpen(false)
      setPendingDraftSessionStart(false)
      if (sidecarStatuses[workspacePath] !== 'connected') {
        ensureSidecar(workspacePath).catch(console.error)
      }
      if (typeof window.electronAPI.loadAcpSession === 'function') {
        window.electronAPI.loadAcpSession(workspacePath, externalId).catch(() => undefined)
      }
    },
    [sidecarStatuses, ensureSidecar],
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
        setDraftSessionStateByWorkspace((prev) => ({
          ...prev,
          [workspacePath]: {
            ...(prev[workspacePath] ?? {}),
            ...(fallbackSessionState.models ? { models: fallbackSessionState.models } : {}),
            ...(fallbackSessionState.modes ? { modes: fallbackSessionState.modes } : {}),
            ...(fallbackSessionState.availableCommands
              ? { availableCommands: fallbackSessionState.availableCommands }
              : {}),
          },
        }))
      }
      if (sidecarStatuses[workspacePath] !== 'connected') {
        ensureSidecar(workspacePath).catch(console.error)
      }
    },
    [acpSessionStateById, activeSessionId, activeWorkspacePath, ensureSidecar, sidecarStatuses],
  )

  const deleteSession = useCallback(
    async (workspacePath: string, externalId: string) => {
      setError(null)
      if (!currentClientId) {
        setError('Client identity unavailable')
        return
      }
      try {
        await submitJob({
          workspacePath,
          type: 'delete_session',
          payload: JSON.stringify({ workspacePath, sessionExternalId: externalId }),
          clientId: currentClientId,
          sessionExternalId: externalId,
        })
        if (activeSessionId === externalId) setActiveSessionId(null)
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeSessionId, currentClientId, submitJob],
  )

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim()
      if (!activeWorkspacePath || !trimmed) return
      setError(null)
      if (!currentClientId) {
        setError('Client identity unavailable')
        return
      }
      if (!activeSessionId) {
        if (!isSessionDraftOpen || pendingDraftSessionStart) return
        const ready = await ensureSidecar(activeWorkspacePath)
        if (!ready) {
          setError('Failed to start workspace sidecar')
          return
        }
        const draftSelection = draftSelectionByWorkspace[activeWorkspacePath] ?? {}
        setPendingDraftSessionStart(true)
        try {
          await submitJob({
            workspacePath: activeWorkspacePath,
            type: 'start_session_with_message',
            payload: JSON.stringify({
              workspacePath: activeWorkspacePath,
              content: trimmed,
              ...(draftSelection.modelId ? { preferredModelId: draftSelection.modelId } : {}),
              ...(draftSelection.modeId ? { preferredModeId: draftSelection.modeId } : {}),
            }),
            clientId: currentClientId,
          })
          return
        } catch (err) {
          setPendingDraftSessionStart(false)
          setError((err as Error).message)
          return
        }
      }
      try {
        await recordRendererTelemetry({
          kind: 'trace',
          phase: 'mark',
          name: 'message.send',
          sessionExternalId: activeSessionId,
          workspacePath: activeWorkspacePath,
          details: trimmed.slice(0, 120),
        })
        await submitMessage({
          workspacePath: activeWorkspacePath,
          sessionExternalId: activeSessionId,
          content: trimmed,
          clientId: currentClientId,
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [
      activeSessionId,
      activeWorkspacePath,
      currentClientId,
      draftSelectionByWorkspace,
      ensureSidecar,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      submitJob,
      submitMessage,
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
          }),
          clientId: currentClientId,
          sessionExternalId: externalId,
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, currentClientId, submitJob],
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
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, currentClientId, submitJob],
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
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
        setAcpSessionStateById((prev) => ({
          ...prev,
          [sessionExternalId]: {
            ...(prev[sessionExternalId] ?? { sessionId: sessionExternalId }),
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
    [activeWorkspacePath, currentClientId, submitJob],
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
          }),
          clientId: currentClientId,
          sessionExternalId,
        })
        setAcpSessionStateById((prev) => ({
          ...prev,
          [sessionExternalId]: {
            ...(prev[sessionExternalId] ?? { sessionId: sessionExternalId }),
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
    [activeWorkspacePath, currentClientId, submitJob],
  )

  useEffect(() => {
    window.electronAPI
      .getClientId()
      .then(setCurrentClientId)
      .catch(() => setCurrentClientId(null))
  }, [])

  useEffect(() => {
    const cleanup = window.electronAPI.onSidecarStatusChanged(({ workspacePath, status }) => {
      if (status === 'crashed' || status === 'stopped') {
        setSidecarStatuses((prev) => ({ ...prev, [workspacePath]: 'disconnected' }))
      } else if (status === 'healthy') {
        setSidecarStatuses((prev) => ({ ...prev, [workspacePath]: 'connected' }))
      }
    })
    return cleanup
  }, [])

  useEffect(() => {
    if (typeof window.electronAPI.onAcpEvent !== 'function') {
      return
    }
    const cleanup = window.electronAPI.onAcpEvent((data) => {
      const event = data as { type?: string; payload?: any }
      if (!event?.type) return

      if (event.type === 'initialize.result') {
        const payload = event.payload as { agentInfo?: { name?: string; version?: string } }
        if (payload?.agentInfo) setAcpAgentInfo(payload.agentInfo)
        return
      }

      if (event.type === 'session.new.result') {
        const payload = event.payload as {
          sessionId?: string
          models?: AcpSessionRuntimeState['models']
          modes?: AcpSessionRuntimeState['modes']
        }
        if (!payload?.sessionId) return
        setAcpSessionStateById((prev) => ({
          ...prev,
          [payload.sessionId!]: {
            ...(prev[payload.sessionId!] ?? { sessionId: payload.sessionId! }),
            ...(payload.models ? { models: payload.models } : {}),
            ...(payload.modes ? { modes: payload.modes } : {}),
          },
        }))
        if (activeWorkspacePath) {
          setDraftSessionStateByWorkspace((prev) => ({
            ...prev,
            [activeWorkspacePath]: {
              ...(prev[activeWorkspacePath] ?? {}),
              ...(payload.models ? { models: payload.models } : {}),
              ...(payload.modes ? { modes: payload.modes } : {}),
            },
          }))
        }
        if (pendingDraftSessionStart && activeWorkspacePath) {
          setActiveSessionId(payload.sessionId)
          setIsSessionDraftOpen(false)
          setPendingDraftSessionStart(false)
        }
        return
      }

      if (event.type === 'session.load.result') {
        const payload = event.payload as {
          sessionId?: string
          models?: AcpSessionRuntimeState['models']
          modes?: AcpSessionRuntimeState['modes']
        }
        if (!payload?.sessionId) return
        setAcpSessionStateById((prev) => ({
          ...prev,
          [payload.sessionId!]: {
            ...(prev[payload.sessionId!] ?? { sessionId: payload.sessionId! }),
            ...(payload.models ? { models: payload.models } : {}),
            ...(payload.modes ? { modes: payload.modes } : {}),
          },
        }))
        if (activeWorkspacePath) {
          setDraftSessionStateByWorkspace((prev) => ({
            ...prev,
            [activeWorkspacePath]: {
              ...(prev[activeWorkspacePath] ?? {}),
              ...(payload.models ? { models: payload.models } : {}),
              ...(payload.modes ? { modes: payload.modes } : {}),
            },
          }))
        }
        return
      }

      if (event.type === 'session.set_model.result') {
        const payload = event.payload as { sessionId?: string; modelId?: string }
        if (!payload?.sessionId || !payload.modelId) return
        setAcpSessionStateById((prev) => ({
          ...prev,
          [payload.sessionId!]: {
            ...(prev[payload.sessionId!] ?? { sessionId: payload.sessionId! }),
            models: {
              ...(prev[payload.sessionId!]?.models ?? {}),
              currentModelId: payload.modelId,
            },
          },
        }))
        return
      }

      if (event.type === 'session.set_mode.result') {
        const payload = event.payload as { sessionId?: string; modeId?: string }
        if (!payload?.sessionId || !payload.modeId) return
        setAcpSessionStateById((prev) => ({
          ...prev,
          [payload.sessionId!]: {
            ...(prev[payload.sessionId!] ?? { sessionId: payload.sessionId! }),
            modes: {
              ...(prev[payload.sessionId!]?.modes ?? {}),
              currentModeId: payload.modeId,
            },
          },
        }))
        return
      }

      if (event.type === 'session/update') {
        const payload = event.payload as {
          sessionId?: string
          update?: { sessionUpdate?: string; availableCommands?: AcpCommandOption[] }
        }
        if (!payload?.sessionId || !payload.update?.sessionUpdate) return
        if (payload.update.sessionUpdate === 'available_commands_update') {
          setAcpSessionStateById((prev) => ({
            ...prev,
            [payload.sessionId!]: {
              ...(prev[payload.sessionId!] ?? { sessionId: payload.sessionId! }),
              availableCommands: payload.update?.availableCommands ?? [],
            },
          }))
          if (activeWorkspacePath) {
            setDraftSessionStateByWorkspace((prev) => ({
              ...prev,
              [activeWorkspacePath]: {
                ...(prev[activeWorkspacePath] ?? {}),
                availableCommands: payload.update?.availableCommands ?? [],
              },
            }))
          }
        }
      }
    })
    return cleanup
  }, [activeWorkspacePath, pendingDraftSessionStart])

  const acpSessionState = useMemo(
    () => (activeSessionId ? acpSessionStateById[activeSessionId] ?? null : null),
    [acpSessionStateById, activeSessionId],
  )

  const draftSessionState = useMemo(() => {
    if (!activeWorkspacePath || !isSessionDraftOpen) return null
    const runtime = draftSessionStateByWorkspace[activeWorkspacePath]
    if (!runtime) return null
    return {
      sessionId: `draft:${activeWorkspacePath}`,
      ...runtime,
    }
  }, [activeWorkspacePath, draftSessionStateByWorkspace, isSessionDraftOpen])

  const value = useMemo<AppUiValue>(
    () => ({
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      currentClientId,
      sidecarStatuses,
      acpAgentInfo,
      acpSessionState,
      draftSessionState,
      error,
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
      setSessionModel,
      setSessionMode,
    }),
    [
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      currentClientId,
      sidecarStatuses,
      acpAgentInfo,
      acpSessionState,
      draftSessionState,
      error,
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
      setSessionModel,
      setSessionMode,
    ],
  )

  return <AppUiContext.Provider value={value}>{children}</AppUiContext.Provider>
}
