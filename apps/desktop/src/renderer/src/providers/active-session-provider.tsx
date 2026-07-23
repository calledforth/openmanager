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
import type { AgentEvent, ContentBlock, ToolCallStatus } from '@agentpack/contract'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'
import type { UploadedImageAttachment } from '../lib/attachments'
import { promptAttachment } from '../lib/attachments'

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
  optimisticAttachments?: UploadedImageAttachment[]
  optimisticJobId?: string
  isOptimistic?: boolean
}

export interface LocalStreamingMessage {
  content: string
  parts: MessagePart[]
  hasCompleteHistory: boolean
}

type LiveThreadState = {
  messageId: string
  parts: Map<string, MessagePart>
  seenEventIds: Set<string>
  hasCompleteHistory: boolean
  lastSeq: number
  activeTextPartId?: string
  activeReasoningPartId?: string
  nextPartOrdinal: number
}

interface ActiveSessionDetails {
  externalId: string
  title?: string
  status: string
  clientId?: string
  providerId?: AgentEvent['providerId']
  parentExternalId?: string
  isDriven: boolean
}

export class StreamingMessagesStore {
  private messages = new Map<string, LocalStreamingMessage>()
  private listeners = new Map<string, Set<() => void>>()
  private threads = new Map<string, LiveThreadState>()

  constructor(private readonly maxMessages = 100) {}

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
    const messageId = event.messageId
    if (!messageId) return
    let state = this.threads.get(event.threadId)
    if (!state || state.messageId !== messageId) {
      state = {
        messageId,
        parts: new Map(),
        seenEventIds: new Set(),
        hasCompleteHistory: event.event === 'prompt_started',
        lastSeq: event.seq,
        nextPartOrdinal: 0,
      }
      this.threads.set(event.threadId, state)
    }
    if (state.seenEventIds.has(event.id)) return
    state.seenEventIds.add(event.id)
    if (event.seq > state.lastSeq + 1) {
      state.hasCompleteHistory = false
    }
    state.lastSeq = Math.max(state.lastSeq, event.seq)

    let changed = false
    switch (event.event) {
      case 'prompt_started':
        changed = true
        break
      case 'agent_message_chunk':
        this.finishReasoning(state)
        changed = this.appendText(state, event.data.content, false)
        break
      case 'agent_thought_chunk':
        state.activeTextPartId = undefined
        changed = this.appendText(state, event.data.content, true)
        break
      case 'tool_call':
      case 'tool_call_update':
        this.finishActiveParts(state)
        changed = this.mergeTool(state, event.data)
        break
      case 'tool_call_content':
        this.finishActiveParts(state)
        changed = this.appendToolContent(state, event.data.toolCallId, event.data.item)
        break
      case 'plan_update':
        // One stable part keyed 'plan', replaced wholesale on every update —
        // the live analogue of the persisted per-turn plan checklist.
        state.parts.set('plan', { type: 'plan', id: 'plan', entries: event.data.entries })
        changed = true
        break
      case 'subtask_update':
        this.finishActiveParts(state)
        changed = this.mergeSubtask(state, event.data)
        break
      case 'prompt_completed':
        this.finishActiveParts(state)
        this.finishRunningTools(state, event.data.stopReason)
        this.finishRunningSubtasks(state, event.data.stopReason)
        changed = true
        break
      case 'rpc_error':
      case 'runtime_error':
      case 'process_exited':
        this.finishActiveParts(state)
        this.finishRunningTools(state, 'error')
        this.finishRunningSubtasks(state, 'error')
        changed = true
        break
      default:
        return
    }

    if (!changed) return
    const parts = [...state.parts.values()]
    const content = parts
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('')
    const messages = new Map(this.messages)
    messages.delete(messageId)
    messages.set(messageId, {
      content,
      parts,
      hasCompleteHistory: state.hasCompleteHistory,
    })
    this.messages = messages
    this.evictOverflow()
    this.emit(messageId)
  }

  remove(messageExternalId: string) {
    if (!this.messages.has(messageExternalId)) return
    this.messages.delete(messageExternalId)
    for (const [threadId, state] of this.threads) {
      if (state.messageId !== messageExternalId) continue
      this.threads.delete(threadId)
    }
    this.emit(messageExternalId)
  }

  private evictOverflow() {
    const limit = Math.max(1, this.maxMessages)
    while (this.messages.size > limit) {
      const oldestMessageId = this.messages.keys().next().value
      if (typeof oldestMessageId !== 'string') return
      this.remove(oldestMessageId)
    }
  }

  private emit(messageExternalId: string) {
    const listeners = this.listeners.get(messageExternalId)
    if (!listeners) return
    for (const listener of listeners) {
      listener()
    }
  }

  private text(block: ContentBlock): string {
    if (block.type === 'text') return block.text
    if (block.type === 'resource_link') return block.uri
    if (block.type === 'resource') return block.text ?? block.uri ?? ''
    return ''
  }

  private nextPartId(state: LiveThreadState, kind: 'text' | 'reasoning'): string {
    return `${state.messageId}_${kind}_${state.nextPartOrdinal++}`
  }

  private appendText(state: LiveThreadState, block: ContentBlock, reasoning: boolean): boolean {
    const text = this.text(block)
    if (!text) return false
    const activeKey = reasoning ? 'activeReasoningPartId' : 'activeTextPartId'
    const partId = state[activeKey] ?? this.nextPartId(state, reasoning ? 'reasoning' : 'text')
    state[activeKey] = partId
    const existing = state.parts.get(partId)
    state.parts.set(partId, {
      ...(existing ?? {}),
      type: reasoning ? 'reasoning' : 'text',
      id: partId,
      text: `${String(existing?.text ?? '')}${text}`,
      ...(reasoning ? { time: existing?.time ?? { start: Date.now() } } : {}),
    })
    return true
  }

  private finishReasoning(state: LiveThreadState): void {
    const partId = state.activeReasoningPartId
    state.activeReasoningPartId = undefined
    if (!partId) return
    const part = state.parts.get(partId)
    if (!part) return
    const time =
      part.time && typeof part.time === 'object'
        ? (part.time as Record<string, number>)
        : { start: Date.now() }
    state.parts.set(partId, { ...part, time: { ...time, end: time.end ?? Date.now() } })
  }

  private finishActiveParts(state: LiveThreadState): void {
    state.activeTextPartId = undefined
    this.finishReasoning(state)
  }

  private status(status: ToolCallStatus | undefined): string {
    if (status === 'in_progress') return 'running'
    if (status === 'failed') return 'error'
    return status ?? 'pending'
  }

  private statusRank(status: unknown): number {
    if (status === 'completed' || status === 'error' || status === 'cancelled') return 2
    if (status === 'running') return 1
    return 0
  }

  private mergeTool(
    state: LiveThreadState,
    tool: Extract<AgentEvent, { event: 'tool_call' | 'tool_call_update' }>['data'],
  ): boolean {
    if (!tool.toolCallId) return false
    const existing = state.parts.get(tool.toolCallId)
    const existingState = (existing?.state as Record<string, unknown> | undefined) ?? {}
    const proposedStatus = this.status(tool.status)
    const status =
      this.statusRank(existingState.status) > this.statusRank(proposedStatus)
        ? existingState.status
        : proposedStatus
    state.parts.set(tool.toolCallId, {
      ...(existing ?? {}),
      type: 'tool',
      id: tool.toolCallId,
      callID: tool.toolCallId,
      tool: tool.title ?? existing?.tool ?? 'tool',
      state: {
        ...existingState,
        status,
        ...(tool.rawInput !== undefined ? { input: tool.rawInput } : {}),
        ...(tool.rawOutput !== undefined ? { output: tool.rawOutput } : {}),
      },
      ...(tool.kind ? { kind: tool.kind } : {}),
      ...(tool.locations ? { locations: tool.locations } : {}),
      ...(tool.metadata ? { metadata: tool.metadata } : {}),
      ...(tool.content ? { content: tool.content } : {}),
    })
    return true
  }

  private appendToolContent(
    state: LiveThreadState,
    toolCallId: string,
    item: Extract<AgentEvent, { event: 'tool_call_content' }>['data']['item'],
  ): boolean {
    if (!toolCallId) return false
    const existing = state.parts.get(toolCallId) ?? {
      type: 'tool',
      id: toolCallId,
      callID: toolCallId,
      tool: 'tool',
      state: { status: 'running' },
    }
    const content = Array.isArray(existing.content) ? existing.content : []
    state.parts.set(toolCallId, { ...existing, content: [...content, item] })
    return true
  }

  private terminalSubtaskStatus(status: unknown): boolean {
    return (
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'interrupted' ||
      status === 'unknown'
    )
  }

  private mergeSubtask(
    state: LiveThreadState,
    update: Extract<AgentEvent, { event: 'subtask_update' }>['data'],
  ): boolean {
    const existing = state.parts.get(update.taskId)
    const acceptsStatus =
      !!update.status &&
      !(this.terminalSubtaskStatus(existing?.status) && !this.terminalSubtaskStatus(update.status))
    state.parts.set(update.taskId, {
      ...(existing ?? { status: 'pending' }),
      type: 'subtask',
      id: update.taskId,
      ...(acceptsStatus
        ? {
            status: update.status,
            ...(update.statusSource ? { statusSource: update.statusSource } : {}),
            ...(update.statusReason ? { statusReason: update.statusReason } : {}),
          }
        : {}),
      ...(update.title ? { title: update.title } : {}),
      ...(update.description ? { description: update.description } : {}),
      ...(update.prompt ? { prompt: update.prompt } : {}),
      ...(update.subagentType ? { subagentType: update.subagentType } : {}),
      ...(update.modelId ? { modelId: update.modelId } : {}),
      ...(update.childSessionId ? { targetSessionId: update.childSessionId } : {}),
      ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
      ...(update.resultText ? { resultText: update.resultText } : {}),
      ...(update.currentActivity ? { currentActivity: update.currentActivity } : {}),
      ...(update.toolCallCount !== undefined ? { toolCallCount: update.toolCallCount } : {}),
    })
    return true
  }

  private finishRunningTools(state: LiveThreadState, stopReason?: string): void {
    const failed = !!stopReason && /error|fail|cancel|abort/i.test(stopReason)
    for (const [id, part] of state.parts) {
      if (part.type !== 'tool') continue
      const toolState = (part.state as Record<string, unknown> | undefined) ?? {}
      if (this.statusRank(toolState.status) >= 2) continue
      state.parts.set(id, {
        ...part,
        state: { ...toolState, status: failed ? 'error' : 'completed' },
      })
    }
  }

  private finishRunningSubtasks(state: LiveThreadState, stopReason?: string): void {
    const reason = stopReason?.trim() || 'missing_provider_terminal_status'
    const status = /cancel|abort/i.test(reason)
      ? 'cancelled'
      : /interrupt/i.test(reason)
        ? 'interrupted'
        : /error|fail/i.test(reason)
          ? 'failed'
          : 'unknown'
    for (const [id, part] of state.parts) {
      if (part.type !== 'subtask' || this.terminalSubtaskStatus(part.status)) continue
      state.parts.set(id, {
        ...part,
        status,
        statusSource: 'turn_result',
        statusReason: reason,
      })
    }
  }
}

interface ActiveSessionValue {
  activeSessionId: string | null
  activeSession: ActiveSessionDetails | null
  activeSessionDriven: boolean
  isMessagesLoading: boolean
  messages: UIMessage[]
  acknowledgeOptimisticMessage: (externalId: string) => void
  abortSession: (externalId: string) => Promise<void>
  sendMessage: (content: string, attachments?: UploadedImageAttachment[]) => Promise<void>
  streamingStore: StreamingMessagesStore
}

const ActiveSessionContext = createContext<ActiveSessionValue | null>(null)

const EMPTY_MESSAGES: Array<{
  externalId: string
  role: string
  isFinal?: boolean
  sequenceNum: number
}> = []

export function mergePersistedAndOptimisticMessages(
  persisted: UIMessage[],
  optimistic: UIMessage[],
): UIMessage[] {
  if (optimistic.length === 0) return persisted
  const optimisticById = new Map(optimistic.map((message) => [message.externalId, message]))
  const acknowledged = persisted.map((message) => {
    const optimisticMessage = optimisticById.get(message.externalId)
    if (!optimisticMessage) return message
    return {
      ...message,
      optimisticContent: optimisticMessage.optimisticContent,
      optimisticAttachments: optimisticMessage.optimisticAttachments,
      optimisticJobId: optimisticMessage.optimisticJobId,
      isOptimistic: false,
    }
  })
  const persistedIds = new Set(acknowledged.map((message) => message.externalId))
  const unacknowledged = optimistic.filter((message) => !persistedIds.has(message.externalId))
  return [...acknowledged, ...unacknowledged].sort(
    (left, right) => left.sequenceNum - right.sequenceNum,
  )
}

export function shouldPreserveOptimisticMessages(
  previousSessionId: string | null,
  nextSessionId: string | null,
  adoptedDraftSessionId: string | null,
): boolean {
  return (
    previousSessionId === null && nextSessionId !== null && nextSessionId === adoptedDraftSessionId
  )
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
  // Destructure so callbacks/memos below depend on the stable pieces they use,
  // not on the whole context value (which changes on unrelated updates).
  const {
    activeSessionId,
    adoptedDraftSessionId,
    currentClientId,
    sendMessage: uiSendMessage,
    abortSession: uiAbortSession,
  } = useAppUi()
  const streamingStore = useMemo(() => new StreamingMessagesStore(), [])
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<UIMessage[]>([])
  const previousActiveSessionIdRef = useRef(activeSessionId)

  const rawSession = useTrackedQuery(
    'sessions.getByExternalId.active',
    api.sessions.getByExternalId,
    activeSessionId ? { externalId: activeSessionId } : 'skip',
  ) as
    | {
        externalId: string
        title?: string
        status: string
        clientId?: string
        providerId?: AgentEvent['providerId']
        parentExternalId?: string
      }
    | null
    | undefined

  const rawMessages = useTrackedQuery(
    'messages.listMetadata',
    api.messages.listMetadata,
    activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
  ) as typeof EMPTY_MESSAGES | undefined

  const messageList = rawMessages ?? EMPTY_MESSAGES
  const isMessagesLoading = !!activeSessionId && rawMessages === undefined
  const activeSessionDriven =
    (!!rawSession && !!currentClientId && rawSession.clientId === currentClientId) ||
    (!!activeSessionId && activeSessionId === adoptedDraftSessionId)
  const activeSession = useMemo<ActiveSessionDetails | null>(
    () =>
      rawSession
        ? {
            externalId: rawSession.externalId,
            title: rawSession.title,
            status: rawSession.status,
            clientId: rawSession.clientId,
            providerId: rawSession.providerId,
            parentExternalId: rawSession.parentExternalId,
            isDriven: activeSessionDriven,
          }
        : null,
    [activeSessionDriven, rawSession],
  )

  useEffect(() => {
    const cleanup = window.electronAPI.onStreamToken((event) => {
      streamingStore.update(event)
    })
    return cleanup
  }, [streamingStore])

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
    const previousSessionId = previousActiveSessionIdRef.current
    if (previousSessionId === activeSessionId) return
    previousActiveSessionIdRef.current = activeSessionId
    const preserveOptimisticMessages = shouldPreserveOptimisticMessages(
      previousSessionId,
      activeSessionId,
      adoptedDraftSessionId,
    )

    if (!preserveOptimisticMessages) {
      setOptimisticUserMessages((prev) => {
        for (const message of prev) {
          for (const attachment of message.optimisticAttachments ?? []) {
            URL.revokeObjectURL(attachment.previewUrl)
          }
        }
        return []
      })
    }
  }, [activeSessionId, adoptedDraftSessionId])

  const acknowledgeOptimisticMessage = useCallback((externalId: string) => {
    setOptimisticUserMessages((prev) => {
      const acknowledged = prev.find((message) => message.externalId === externalId)
      if (!acknowledged) return prev
      for (const attachment of acknowledged.optimisticAttachments ?? []) {
        URL.revokeObjectURL(attachment.previewUrl)
      }
      return prev.filter((message) => message.externalId !== externalId)
    })
  }, [])

  const sendMessage = useCallback(
    async (content: string, attachments: UploadedImageAttachment[] = []) => {
      const trimmed = content.trim()
      if (!trimmed && attachments.length === 0) return
      const maxSequenceNum = messageList.reduce(
        (max, message) => Math.max(max, message.sequenceNum),
        -1,
      )
      const localExternalId = `agent_usr_${crypto.randomUUID()}`
      const optimisticMessage: UIMessage = {
        externalId: localExternalId,
        role: 'user',
        isFinal: true,
        sequenceNum: maxSequenceNum + optimisticUserMessages.length + 1,
        optimisticContent: trimmed,
        optimisticAttachments: attachments,
        isOptimistic: true,
      }

      setOptimisticUserMessages((prev) => [...prev, optimisticMessage])
      try {
        const jobId = await uiSendMessage(
          trimmed,
          localExternalId,
          attachments.map(promptAttachment),
        )
        if (jobId) {
          setOptimisticUserMessages((prev) =>
            prev.map((message) =>
              message.externalId === localExternalId
                ? { ...message, optimisticJobId: jobId }
                : message,
            ),
          )
        }
      } catch (error) {
        setOptimisticUserMessages((prev) =>
          prev.filter((message) => message.externalId !== localExternalId),
        )
        throw error
      }
    },
    [messageList, optimisticUserMessages.length, uiSendMessage],
  )

  const messages: UIMessage[] = useMemo(() => {
    const persisted = messageList.map((message) => ({
      externalId: message.externalId,
      role: message.role,
      isFinal: message.isFinal,
      sequenceNum: message.sequenceNum,
    }))

    return mergePersistedAndOptimisticMessages(persisted, optimisticUserMessages)
  }, [messageList, optimisticUserMessages])

  const value = useMemo<ActiveSessionValue>(
    () => ({
      activeSessionId,
      activeSession,
      activeSessionDriven,
      isMessagesLoading,
      messages,
      acknowledgeOptimisticMessage,
      abortSession: uiAbortSession,
      sendMessage,
      streamingStore,
    }),
    [
      activeSessionId,
      activeSession,
      activeSessionDriven,
      isMessagesLoading,
      messages,
      acknowledgeOptimisticMessage,
      uiAbortSession,
      sendMessage,
      streamingStore,
    ],
  )

  return <ActiveSessionContext.Provider value={value}>{children}</ActiveSessionContext.Provider>
}
