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
import { api } from '@openmanager/convex/_generated/api'
import type { AgentEvent } from '@agentpack/contract'
import { foldAgentEvents, presentTool, type FoldedRow, type FoldedToolRow } from '@agentpack/view'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'

interface MessagePart {
  type: string
  id: string
  __ordinal?: number
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

export class StreamingMessagesStore {
  private messages = new Map<string, LocalStreamingMessage>()
  private listeners = new Map<string, Set<() => void>>()
  private eventsByThread = new Map<string, AgentEvent[]>()
  private messageIdByThread = new Map<string, string>()

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

  update(event: AgentEvent) {
    if (event.category !== 'stream' && event.category !== 'tool') return
    const previousMessageId = this.messageIdByThread.get(event.threadId)
    const startsNewMessage =
      !!event.messageId && !!previousMessageId && event.messageId !== previousMessageId
    const currentEvents = startsNewMessage ? [] : (this.eventsByThread.get(event.threadId) ?? [])
    if (currentEvents.some((candidate) => candidate.id === event.id)) return
    const events = [...currentEvents, event]
    this.eventsByThread.set(event.threadId, events)

    let messageExternalId = event.messageId ?? previousMessageId
    if (!messageExternalId) {
      messageExternalId = event.messageId ?? `agent_asst_${event.id}`
    }
    this.messageIdByThread.set(event.threadId, messageExternalId)

    const rows = foldAgentEvents(events, { summarizeWork: false })
    const parts = rows.flatMap(partsFromFoldedRow)
    const content = parts
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('')
    this.messages = new Map(this.messages).set(messageExternalId, { content, parts })
    this.emit(messageExternalId)
  }

  remove(messageExternalId: string) {
    if (!this.messages.has(messageExternalId)) return
    this.messages.delete(messageExternalId)
    for (const [threadId, id] of this.messageIdByThread) {
      if (id !== messageExternalId) continue
      this.messageIdByThread.delete(threadId)
      this.eventsByThread.delete(threadId)
    }
    this.emit(messageExternalId)
  }

  reset() {
    if (this.messages.size === 0) return
    const ids = [...this.messages.keys()]
    this.messages = new Map()
    this.eventsByThread = new Map()
    this.messageIdByThread = new Map()
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

function toolPart(row: FoldedToolRow): MessagePart {
  const viewModel = presentTool(row)
  return {
    type: 'tool',
    id: row.id,
    callID: row.toolCallId,
    tool: row.title,
    kind: row.kind,
    locations: row.locations,
    content: row.contentItems,
    viewModel,
    state: {
      status: viewModel.status,
      input: row.rawInput,
      output: row.rawOutput,
      metadata: row.metadata,
    },
  }
}

function partsFromFoldedRow(row: FoldedRow): MessagePart[] {
  switch (row.type) {
    case 'assistant':
      return [{ type: 'text', id: row.id, text: row.text }]
    case 'thinking':
      return [{ type: 'reasoning', id: row.id, text: row.text }]
    case 'tool':
      return [toolPart(row)]
    case 'explore_group':
      return row.items.map(toolPart)
    case 'subagent':
      return [
        {
          type: 'subtask',
          id: row.id,
          description: row.subtitle ?? row.title,
          status: row.status,
          modelId: row.model,
          targetSessionId: row.targetSessionId,
        },
      ]
    case 'worked_group':
      return row.items.flatMap(partsFromFoldedRow)
    case 'user':
    case 'permission':
    case 'extension':
    case 'plan':
    case 'error':
      return []
    default:
      row satisfies never
      return []
  }
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
    const cleanup = window.electronAPI.onStreamToken((event) => {
      if (!ui.activeSessionId || event.sessionId !== ui.activeSessionId) return
      if (!activeSessionDriven) return
      streamingStore.update(event)
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
