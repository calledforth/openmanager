import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { api } from '@convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'

interface MessagePart {
  type: string
  id: string
  [key: string]: unknown
}

export interface UIMessage {
  externalId: string
  role: string
  isFinal?: boolean
  sequenceNum: number
  optimisticContent?: string
  isOptimistic?: boolean
}

export interface LocalStreamingMessage {
  content: string
  parts: MessagePart[]
}

interface ActiveSessionDetails {
  externalId: string
  title?: string
  status: string
  clientId?: string
  isDriven: boolean
}

class StreamingMessagesStore {
  private messages = new Map<string, LocalStreamingMessage>()
  private listeners = new Map<string, Set<() => void>>()

  subscribe(messageExternalId: string, listener: () => void) {
    const current = this.listeners.get(messageExternalId) ?? new Set<() => void>()
    current.add(listener)
    this.listeners.set(messageExternalId, current)
    return () => {
      const next = this.listeners.get(messageExternalId)
      if (!next) return
      next.delete(listener)
      if (next.size === 0) {
        this.listeners.delete(messageExternalId)
      }
    }
  }

  get(messageExternalId: string) {
    return this.messages.get(messageExternalId)
  }

  update(payload: {
    messageExternalId: string
    delta?: string
    partId?: string
    field?: string
    part?: Record<string, unknown>
  }) {
    this.messages = applyStreamDelta(this.messages, payload)
    this.emit(payload.messageExternalId)
  }

  remove(messageExternalId: string) {
    if (!this.messages.has(messageExternalId)) return
    this.messages.delete(messageExternalId)
    this.emit(messageExternalId)
  }

  reset() {
    if (this.messages.size === 0) return
    const ids = [...this.messages.keys()]
    this.messages = new Map()
    for (const id of ids) {
      this.emit(id)
    }
  }

  private emit(messageExternalId: string) {
    const listeners = this.listeners.get(messageExternalId)
    if (!listeners) return
    for (const listener of listeners) {
      listener()
    }
  }
}

interface ActiveSessionValue {
  activeSessionId: string | null
  activeSession: ActiveSessionDetails | null
  activeSessionDriven: boolean
  messages: UIMessage[]
  abortSession: (externalId: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  streamingStore: StreamingMessagesStore
}

const ActiveSessionContext = createContext<ActiveSessionValue | null>(null)

const EMPTY_MESSAGES: Array<{
  externalId: string
  role: string
  isFinal?: boolean
  sequenceNum: number
}> = []

function upsertPart(parts: MessagePart[], part: MessagePart): MessagePart[] {
  const index = parts.findIndex((entry) => entry.id === part.id)
  if (index === -1) return [...parts, part]
  const next = [...parts]
  next[index] = part
  return next
}

function applyStreamDelta(
  prev: Map<string, LocalStreamingMessage>,
  payload: {
    messageExternalId: string
    delta?: string
    partId?: string
    field?: string
    part?: Record<string, unknown>
  },
): Map<string, LocalStreamingMessage> {
  const next = new Map(prev)
  const current = next.get(payload.messageExternalId) ?? { content: '', parts: [] }
  let parts = current.parts

  if (payload.part) {
    parts = upsertPart(parts, payload.part as MessagePart)
  }

  if (payload.delta && payload.partId) {
    const existing =
      parts.find((part) => part.id === payload.partId) ??
      ({ type: 'text', id: payload.partId } as MessagePart)
    const field = payload.field ?? 'text'
    const patched = {
      ...existing,
      [field]: `${String(existing[field] ?? '')}${payload.delta}`,
    } satisfies MessagePart
    parts = upsertPart(parts, patched)
  }

  const content = parts
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('')

  next.set(payload.messageExternalId, { content, parts })
  return next
}

export function useActiveSession() {
  const ctx = useContext(ActiveSessionContext)
  if (!ctx) throw new Error('useActiveSession must be used within ActiveSessionProvider')
  return ctx
}

export function useStreamingMessage(messageExternalId: string) {
  const { streamingStore } = useActiveSession()
  return useSyncExternalStore(
    (listener) => streamingStore.subscribe(messageExternalId, listener),
    () => streamingStore.get(messageExternalId),
    () => streamingStore.get(messageExternalId),
  )
}

export function ActiveSessionProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const streamingStore = useMemo(() => new StreamingMessagesStore(), [])
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<UIMessage[]>([])
  const userMessageCountRef = useRef<number | null>(null)
  const optimisticCounterRef = useRef(0)

  const rawSession = useTrackedQuery(
    'sessions.getByExternalId.active',
    api.sessions.getByExternalId,
    ui.activeSessionId ? { externalId: ui.activeSessionId } : 'skip',
  ) as { externalId: string; title?: string; status: string; clientId?: string } | null | undefined

  const rawMessages = useTrackedQuery(
    'messages.listMetadata',
    api.messages.listMetadata,
    ui.activeSessionId ? { sessionExternalId: ui.activeSessionId } : 'skip',
  ) as typeof EMPTY_MESSAGES | undefined

  const messageList = rawMessages ?? EMPTY_MESSAGES
  const activeSessionDriven =
    !!rawSession && !!ui.currentClientId && rawSession.clientId === ui.currentClientId
  const activeSession = useMemo<ActiveSessionDetails | null>(
    () =>
      rawSession
        ? {
            externalId: rawSession.externalId,
            title: rawSession.title,
            status: rawSession.status,
            clientId: rawSession.clientId,
            isDriven: activeSessionDriven,
          }
        : null,
    [activeSessionDriven, rawSession],
  )

  useEffect(() => {
    const cleanup = window.electronAPI.onStreamToken((payload) => {
      if (!ui.activeSessionId || payload.sessionExternalId !== ui.activeSessionId) return
      if (!activeSessionDriven) return
      streamingStore.update(payload)
    })
    return cleanup
  }, [activeSessionDriven, streamingStore, ui.activeSessionId])

  useEffect(() => {
    const finalIds = new Set(
      messageList.filter((message) => message.isFinal).map((message) => message.externalId),
    )
    if (finalIds.size === 0) return
    for (const messageId of finalIds) {
      streamingStore.remove(messageId)
    }
  }, [messageList, streamingStore])

  useEffect(() => {
    userMessageCountRef.current = null
    setOptimisticUserMessages([])
    streamingStore.reset()
  }, [streamingStore, ui.activeSessionId])

  useEffect(() => {
    const persistedUserCount = messageList.filter((message) => message.role === 'user').length
    const previousCount = userMessageCountRef.current
    userMessageCountRef.current = persistedUserCount
    if (previousCount === null) return
    const ackedCount = persistedUserCount - previousCount
    if (ackedCount <= 0) return
    setOptimisticUserMessages((prev) => prev.slice(Math.min(ackedCount, prev.length)))
  }, [messageList])

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim()
      if (!trimmed) return
      const maxSequenceNum = messageList.reduce(
        (max, message) => Math.max(max, message.sequenceNum),
        -1,
      )
      const localExternalId = `local-user-${Date.now()}-${optimisticCounterRef.current++}`
      const optimisticMessage: UIMessage = {
        externalId: localExternalId,
        role: 'user',
        isFinal: true,
        sequenceNum: maxSequenceNum + optimisticUserMessages.length + 1,
        optimisticContent: trimmed,
        isOptimistic: true,
      }

      setOptimisticUserMessages((prev) => [...prev, optimisticMessage])
      try {
        await ui.sendMessage(trimmed)
      } catch (error) {
        setOptimisticUserMessages((prev) =>
          prev.filter((message) => message.externalId !== localExternalId),
        )
        throw error
      }
    },
    [messageList, optimisticUserMessages.length, ui],
  )

  const messages: UIMessage[] = useMemo(() => {
    const persisted = messageList.map((message) => ({
      externalId: message.externalId,
      role: message.role,
      isFinal: message.isFinal,
      sequenceNum: message.sequenceNum,
    }))

    if (optimisticUserMessages.length === 0) return persisted
    return [...persisted, ...optimisticUserMessages].sort(
      (left, right) => left.sequenceNum - right.sequenceNum,
    )
  }, [messageList, optimisticUserMessages])

  const value = useMemo<ActiveSessionValue>(
    () => ({
      activeSessionId: ui.activeSessionId,
      activeSession,
      activeSessionDriven,
      messages,
      abortSession: ui.abortSession,
      sendMessage,
      streamingStore,
    }),
    [
      ui.activeSessionId,
      activeSession,
      activeSessionDriven,
      messages,
      ui.abortSession,
      sendMessage,
      streamingStore,
    ],
  )

  return <ActiveSessionContext.Provider value={value}>{children}</ActiveSessionContext.Provider>
}
