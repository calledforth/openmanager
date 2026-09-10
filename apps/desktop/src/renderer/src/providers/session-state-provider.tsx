import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import type { Id } from '@openmanager/convex/_generated/dataModel'
import { isProviderId, isRecoverableError, type ProviderId } from '@agentpack/contract'
import {
  SessionStateContext,
  type DraftRequest,
  type LocalSessionStatus,
  type SessionStateValue,
} from '@openmanager/app-core/providers/session-provider'
import { usePlatformCapabilities } from '@openmanager/app-core/providers/platform-provider'
import { trackedConvexQuery, useTrackedMutation, useTrackedQuery } from '../lib/convex-telemetry'
export * from '@openmanager/app-core/providers/session-provider'

/** Host-backed session navigation: active workspace/session, draft state and
 * the local turn lifecycle, with the provider each known session runs on. */
export function SessionStateProvider({ children }: { children: ReactNode }) {
  const { currentClientId, ensureProvider, providerDisplayName } = usePlatformCapabilities()
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [isSessionDraftOpen, setIsSessionDraftOpen] = useState(false)
  const [pendingDraftSessionStart, setPendingDraftSessionStart] = useState(false)
  const [localSessionStatus, setLocalSessionStatus] = useState<LocalSessionStatus | null>(null)
  const [adoptedDraftSessionId, setAdoptedDraftSessionId] = useState<string | null>(null)
  const [localSessionJobId, setLocalSessionJobId] = useState<Id<'pending_jobs'> | null>(null)
  const [defaultProviderId, setDefaultProviderIdState] = useState<ProviderId>('opencode')
  const [draftRequest, setDraftRequest] = useState<DraftRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Provider per session this renderer has seen, from navigation and ACP
   * events. A ref twin serves callbacks that run from IPC and job submission. */
  const [sessionProviderById, setSessionProviderById] = useState<Record<string, ProviderId>>({})
  const sessionProviderByIdRef = useRef<Record<string, ProviderId>>({})
  useEffect(() => {
    sessionProviderByIdRef.current = sessionProviderById
  }, [sessionProviderById])

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
  const registerChildSession = useTrackedMutation(
    'sessions.registerChild',
    (api as any).sessions.registerChild,
  )
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

  const providerIdForSession = useCallback(
    (sessionExternalId: string, fallback?: ProviderId) =>
      sessionProviderById[sessionExternalId] ?? fallback ?? defaultProviderId,
    [defaultProviderId, sessionProviderById],
  )

  const rememberSessionProvider = useCallback(
    (sessionExternalId: string, providerId: ProviderId) => {
      setSessionProviderById((prev) =>
        prev[sessionExternalId] === providerId
          ? prev
          : { ...prev, [sessionExternalId]: providerId },
      )
    },
    [],
  )

  const setDefaultProviderId = useCallback((providerId: ProviderId) => {
    setDefaultProviderIdState(providerId)
    // Preference persistence is best-effort.
    window.electronAPI.setLastProviderId(providerId).catch(() => undefined)
  }, [])

  const rememberActiveWorkspacePath = useCallback((workspacePath: string | null) => {
    setActiveWorkspacePath(workspacePath)
    window.electronAPI.setLastActiveWorkspacePath(workspacePath ?? '').catch(() => undefined)
  }, [])

  const resetTurn = useCallback(() => {
    setPendingDraftSessionStart(false)
    setLocalSessionStatus(null)
    setLocalSessionJobId(null)
    setAdoptedDraftSessionId(null)
  }, [])

  const openDraft = useCallback(
    (workspacePath: string) => {
      const previousSessionId = activeWorkspacePath === workspacePath ? activeSessionId : null
      rememberActiveWorkspacePath(workspacePath)
      setActiveSessionId(null)
      setIsSessionDraftOpen(true)
      resetTurn()
      setDraftRequest((prev) => ({
        workspacePath,
        previousSessionId,
        revision: (prev?.revision ?? 0) + 1,
      }))
    },
    [activeSessionId, activeWorkspacePath, rememberActiveWorkspacePath, resetTurn],
  )

  const addWorkspace = useCallback(async () => {
    setError(null)
    const folder = await window.electronAPI.selectFolder()
    if (!folder) return
    try {
      await ensureWorkspace({ path: folder, machineId: 'desktop' })
      openDraft(folder)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [ensureWorkspace, openDraft])

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
          resetTurn()
        }
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, rememberActiveWorkspacePath, removeWorkspaceMutation, resetTurn],
  )

  const activateSession = useCallback(
    (workspacePath: string, externalId: string, providerId: ProviderId) => {
      rememberActiveWorkspacePath(workspacePath)
      setActiveSessionId(externalId)
      setIsSessionDraftOpen(false)
      resetTurn()
      rememberSessionProvider(externalId, providerId)
    },
    [rememberActiveWorkspacePath, rememberSessionProvider, resetTurn],
  )

  const selectSession = useCallback(
    (workspacePath: string, externalId: string, persistedProviderId?: ProviderId) => {
      const providerId =
        sessionProviderByIdRef.current[externalId] ?? persistedProviderId ?? 'opencode'
      activateSession(workspacePath, externalId, providerId)
      void ensureProvider(providerId, workspacePath)
      if (typeof window.electronAPI.loadAcpSession === 'function') {
        void window.electronAPI
          .loadAcpSession(providerId, workspacePath, externalId)
          .catch(() => undefined)
      }
    },
    [activateSession, ensureProvider],
  )

  const openChildSession = useCallback(
    async (childExternalId: string, parentExternalId: string) => {
      if (!activeWorkspacePath) return
      const workspacePath = activeWorkspacePath
      const providerId = providerIdForSession(parentExternalId)
      setError(null)
      try {
        // Persist ancestry before replay starts so read-only state and sidebar
        // nesting come from the session record, not transient navigation state.
        await registerChildSession({
          workspacePath,
          externalId: childExternalId,
          parentExternalId,
          providerId,
          ...(currentClientId ? { clientId: currentClientId } : {}),
        })
        const ready = await ensureProvider(providerId, workspacePath)
        if (!ready) throw new Error(`Failed to connect to ${providerDisplayName(providerId)}.`)
        if (typeof window.electronAPI.loadAcpSession === 'function') {
          await window.electronAPI.loadAcpSession(providerId, workspacePath, childExternalId)
        }
        activateSession(workspacePath, childExternalId, providerId)
      } catch (err) {
        const message = `Unable to open subagent transcript: ${(err as Error).message}`
        setError(message)
        throw new Error(message, { cause: err })
      }
    },
    [
      activateSession,
      activeWorkspacePath,
      currentClientId,
      ensureProvider,
      providerDisplayName,
      providerIdForSession,
      registerChildSession,
    ],
  )

  const closeChildSession = useCallback(
    (parentExternalId: string) => {
      if (!activeWorkspacePath) return
      selectSession(activeWorkspacePath, parentExternalId, providerIdForSession(parentExternalId))
    },
    [activeWorkspacePath, providerIdForSession, selectSession],
  )

  const createSession = useCallback(
    async (workspacePath: string) => {
      setError(null)
      openDraft(workspacePath)
    },
    [openDraft],
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
              sessionProviderByIdRef.current[externalId] ?? persistedProviderId ?? 'opencode',
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
    [activeSessionId, currentClientId, submitJob],
  )

  const beginDraftTurn = useCallback(() => {
    setError(null)
    setPendingDraftSessionStart(true)
    setLocalSessionStatus('starting')
    setAdoptedDraftSessionId(null)
  }, [])

  const beginSessionTurn = useCallback(() => {
    setError(null)
    setLocalSessionStatus('running')
    setAdoptedDraftSessionId(null)
  }, [])

  const attachTurnJob = useCallback((jobId: string) => {
    setLocalSessionJobId(jobId as Id<'pending_jobs'>)
  }, [])

  const failTurn = useCallback((message?: string) => {
    setPendingDraftSessionStart(false)
    setLocalSessionStatus(null)
    setLocalSessionJobId(null)
    if (message) setError(message)
  }, [])

  useEffect(() => {
    window.electronAPI
      .getLastProviderId()
      .then((providerId) => {
        if (isProviderId(providerId)) setDefaultProviderIdState(providerId)
      })
      .catch(() => undefined)
  }, [])

  // Clicking a desktop notification should land on the session that raised it,
  // which is usually not the one on screen — that is why it was notified.
  useEffect(() => {
    if (typeof window.electronAPI.onNotificationActivate !== 'function') return
    return window.electronAPI.onNotificationActivate(({ workspacePath, sessionId, providerId }) => {
      // Without a workspace there is nothing to open the session against; the
      // window has still been focused by the time this arrives.
      if (!workspacePath) return
      selectSession(workspacePath, sessionId, providerId)
    })
  }, [selectSession])

  useEffect(() => {
    return window.electronAPI.onAcpEvent((event) => {
      switch (event.event) {
        case 'session_created':
        case 'session_loaded':
        case 'current_model_update':
        case 'current_mode_update':
        case 'available_commands_update':
        case 'config_option_update':
          rememberSessionProvider(event.sessionId, event.providerId)
          if (
            event.event === 'session_created' &&
            pendingDraftSessionStart &&
            activeWorkspacePath === (event.workspaceId ?? activeWorkspacePath)
          ) {
            setAdoptedDraftSessionId(event.sessionId)
            setActiveSessionId(event.sessionId)
            setIsSessionDraftOpen(false)
            setPendingDraftSessionStart(false)
            setLocalSessionStatus('running')
          }
          return
        case 'session_deleted':
          setSessionProviderById((prev) => {
            if (!(event.sessionId in prev)) return prev
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
          // See `isRecoverableError`: the turn is still running, so the
          // composer must stay in its running state rather than unlocking and
          // dropping the job id it still needs to cancel with.
          if (isRecoverableError(event)) return
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
        default:
          return
      }
    })
  }, [
    activeSessionId,
    activeWorkspacePath,
    adoptedDraftSessionId,
    pendingDraftSessionStart,
    rememberSessionProvider,
  ])

  const value = useMemo<SessionStateValue>(
    () => ({
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      localSessionStatus,
      adoptedDraftSessionId,
      defaultProviderId,
      draftRequest,
      error,
      providerIdForSession,
      setDefaultProviderId,
      addWorkspace,
      removeWorkspace,
      selectSession,
      openChildSession,
      closeChildSession,
      createSession,
      deleteSession,
      beginDraftTurn,
      beginSessionTurn,
      attachTurnJob,
      failTurn,
    }),
    [
      activeWorkspacePath,
      activeSessionId,
      isSessionDraftOpen,
      pendingDraftSessionStart,
      localSessionStatus,
      adoptedDraftSessionId,
      defaultProviderId,
      draftRequest,
      error,
      providerIdForSession,
      setDefaultProviderId,
      addWorkspace,
      removeWorkspace,
      selectSession,
      openChildSession,
      closeChildSession,
      createSession,
      deleteSession,
      beginDraftTurn,
      beginSessionTurn,
      attachTurnJob,
      failTurn,
    ],
  )

  return <SessionStateContext.Provider value={value}>{children}</SessionStateContext.Provider>
}
