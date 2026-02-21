import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'

type SidecarStatus = 'disconnected' | 'connecting' | 'connected'

interface MessagePart {
  type: string
  id: string
  [key: string]: unknown
}

export interface UIMessage {
  externalId: string
  role: string
  content: string
  isFinal?: boolean
  sequenceNum: number
  parts?: MessagePart[]
}

export interface WorkspaceEntry {
  path: string
  name: string
  sidecarStatus: SidecarStatus
}

interface SessionStoreValue {
  workspaces: WorkspaceEntry[]
  activeWorkspacePath: string | null
  activeSessionId: string | null
  sessions: Array<{ externalId: string; title?: string; status: string }>
  messages: UIMessage[]
  error: string | null

  addWorkspace: () => Promise<void>
  removeWorkspace: (path: string) => Promise<void>
  selectSession: (workspacePath: string, externalId: string) => void
  createSession: (workspacePath: string, title?: string) => Promise<void>
  deleteSession: (workspacePath: string, externalId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  abortSession: (externalId: string) => Promise<void>
  resolvePermission: (
    sessionExternalId: string,
    permissionId: string,
    approved: boolean,
  ) => Promise<void>
}

const SessionContext = createContext<SessionStoreValue | null>(null)

export function useSessionStore(): SessionStoreValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSessionStore must be used within SessionProvider')
  return ctx
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sidecarStatuses, setSidecarStatuses] = useState<Record<string, SidecarStatus>>({})
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submitJob = useMutation(api.jobs.submit)
  const submitMessage = useMutation(api.jobs.submitMessage)
  const ensureWorkspace = useMutation(api.workspaces.ensureByPath)
  const removeWorkspaceMutation = useMutation(api.workspaces.remove)

  const rawWorkspaces = useQuery(api.workspaces.list) ?? []

  const rawSessions = useQuery(
    api.sessions.listByWorkspace,
    activeWorkspacePath ? { workspacePath: activeWorkspacePath } : 'skip',
  )

  const rawMessages = useQuery(
    api.messages.listBySession,
    activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
  )

  const workspaces: WorkspaceEntry[] = rawWorkspaces.map((w) => ({
    path: w.path,
    name: w.name,
    sidecarStatus: sidecarStatuses[w.path] ?? 'disconnected',
  }))

  const sessions = (rawSessions ?? []).map((s) => ({
    externalId: s.externalId,
    title: s.title,
    status: s.status,
  }))

  const messages: UIMessage[] = (rawMessages ?? []).map((m) => ({
    externalId: m.externalId,
    role: m.role,
    content: m.content,
    isFinal: m.isFinal,
    sequenceNum: m.sequenceNum,
    parts: (m.metadata as { parts?: MessagePart[] } | undefined)?.parts,
  }))

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
      ensureSidecar(folder).catch(console.error)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [ensureWorkspace, ensureSidecar])

  const removeWorkspace = useCallback(
    async (path: string) => {
      setError(null)
      try {
        const ws = rawWorkspaces.find((w) => w.path === path)
        if (ws) await removeWorkspaceMutation({ id: ws._id })

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
        }
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [rawWorkspaces, removeWorkspaceMutation, sidecarStatuses, activeWorkspacePath],
  )

  const selectSession = useCallback(
    (workspacePath: string, externalId: string) => {
      setActiveWorkspacePath(workspacePath)
      setActiveSessionId(externalId)
      if (sidecarStatuses[workspacePath] !== 'connected') {
        ensureSidecar(workspacePath).catch(console.error)
      }
    },
    [sidecarStatuses, ensureSidecar],
  )

  const createSession = useCallback(
    async (workspacePath: string, title?: string) => {
      setError(null)
      const ready = await ensureSidecar(workspacePath)
      if (!ready) {
        setError('Failed to start workspace sidecar')
        return
      }
      try {
        await submitJob({
          workspacePath,
          type: 'create_session',
          payload: JSON.stringify({ workspacePath, title }),
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [ensureSidecar, submitJob],
  )

  const deleteSession = useCallback(
    async (workspacePath: string, externalId: string) => {
      setError(null)
      const ready = await ensureSidecar(workspacePath)
      if (!ready) {
        setError('Failed to start workspace sidecar')
        return
      }
      try {
        await submitJob({
          workspacePath,
          type: 'delete_session',
          payload: JSON.stringify({ workspacePath, sessionExternalId: externalId }),
        })
        if (activeSessionId === externalId) setActiveSessionId(null)
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [ensureSidecar, submitJob, activeSessionId],
  )

  const sendMsg = useCallback(
    async (content: string) => {
      if (!activeWorkspacePath || !activeSessionId) return
      setError(null)
      const ready = await ensureSidecar(activeWorkspacePath)
      if (!ready) {
        setError('Workspace sidecar not available')
        return
      }
      try {
        await submitMessage({
          workspacePath: activeWorkspacePath,
          sessionExternalId: activeSessionId,
          content,
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, activeSessionId, ensureSidecar, submitMessage],
  )

  const abortSession = useCallback(
    async (externalId: string) => {
      if (!activeWorkspacePath) return
      try {
        await submitJob({
          workspacePath: activeWorkspacePath,
          type: 'abort',
          payload: JSON.stringify({
            workspacePath: activeWorkspacePath,
            sessionExternalId: externalId,
          }),
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, submitJob],
  )

  const resolvePermission = useCallback(
    async (sessionExternalId: string, permissionId: string, approved: boolean) => {
      if (!activeWorkspacePath) return
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
        })
      } catch (err) {
        setError((err as Error).message)
      }
    },
    [activeWorkspacePath, submitJob],
  )

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

  const value: SessionStoreValue = {
    workspaces,
    activeWorkspacePath,
    activeSessionId,
    sessions,
    messages,
    error,
    addWorkspace,
    removeWorkspace,
    selectSession,
    createSession,
    deleteSession,
    sendMessage: sendMsg,
    abortSession,
    resolvePermission,
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
