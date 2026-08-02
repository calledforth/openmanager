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
import {
  reconstructSnapshot,
  type StreamChunk,
} from '@openmanager/shared/lib/stream-reconstruction'
import { trackedConvexQuery, useTrackedQuery } from '../lib/convex-telemetry'
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
  /** True when this snapshot covers the turn from its start: either the
   * renderer watched it from `prompt_started`, or the Convex snapshot of
   * everything before it has been folded in. Note that AgentEvent sequence
   * numbers cannot be used to infer this — the renderer is sent a filtered
   * subset of the stream, so ordinary turns skip sequences. */
  hasCompleteHistory: boolean
}

/** What a reconnecting client needs to resume a turn it did not watch from the
 * start: the parts as persisted, and how far into the event stream they reach. */
export interface StreamHydrationSnapshot {
  parts?: MessagePart[]
  throughSeq?: number
}

export type StreamSnapshotSource = (
  messageExternalId: string,
) => Promise<StreamHydrationSnapshot | null>

type LiveThreadState = {
  messageId: string
  parts: Map<string, MessagePart>
  seenEventIds: Set<string>
  hasCompleteHistory: boolean
  activeTextPartId?: string
  activeReasoningPartId?: string
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
  // Keyed by assistant message id, not thread id: a turn is the unit that gets
  // hydrated, and hydration can be requested for a turn that has stopped
  // emitting events entirely (the app was restarted mid-stream).
  private threads = new Map<string, LiveThreadState>()
  private queuedEvents = new Map<string, AgentEvent[]>()
  private hydrationRequested = new Set<string>()
  private snapshotSource?: StreamSnapshotSource

  constructor(private readonly maxMessages = 100) {}

  setSnapshotSource(source: StreamSnapshotSource | undefined) {
    this.snapshotSource = source
  }

  /** Pull the persisted snapshot for a turn this renderer may have joined late.
   * Idempotent: only the first call per message does any work. */
  ensureHydrated(messageExternalId: string) {
    if (this.threads.get(messageExternalId)?.hasCompleteHistory) return
    this.beginHydration(messageExternalId)
  }

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
    const queued = this.queuedEvents.get(messageId)
    if (queued) {
      queued.push(event)
      return
    }
    let state = this.threads.get(messageId)
    if (!state) {
      // A turn that does not open with prompt_started is one this renderer
      // joined in flight — after a reload, a crash, or from a second window.
      // Everything before this event exists only in Convex, so fetch that
      // snapshot first and replay the live tail onto it.
      if (event.event !== 'prompt_started' && this.beginHydration(messageId, event)) return
      state = {
        messageId,
        parts: new Map(),
        seenEventIds: new Set(),
        hasCompleteHistory: event.event === 'prompt_started',
      }
      this.threads.set(messageId, state)
    }
    if (state.seenEventIds.has(event.id)) return
    state.seenEventIds.add(event.id)

    let changed = false
    switch (event.event) {
      case 'prompt_started':
        changed = true
        break
      case 'agent_message_chunk':
        this.finishReasoning(state)
        changed = this.appendText(state, event.data.content, event.id)
        break
      case 'agent_thought_chunk':
        state.activeTextPartId = undefined
        changed = this.appendThought(state, event.data, event.id)
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
    this.publish(state)
  }

  private publish(state: LiveThreadState) {
    const parts = [...state.parts.values()]
    const content = parts
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('')
    const messages = new Map(this.messages)
    messages.delete(state.messageId)
    messages.set(state.messageId, {
      content,
      parts,
      hasCompleteHistory: state.hasCompleteHistory,
    })
    this.messages = messages
    this.evictOverflow()
    this.emit(state.messageId)
  }

  private beginHydration(messageExternalId: string, event?: AgentEvent): boolean {
    if (!this.snapshotSource) return false
    if (this.hydrationRequested.has(messageExternalId)) return false
    this.hydrationRequested.add(messageExternalId)
    // Queue from this instant so the join has neither a gap nor an unbounded
    // overlap: everything from here is either covered by the snapshot (dropped
    // by sequence below) or replayed.
    this.queuedEvents.set(messageExternalId, event ? [event] : [])
    this.snapshotSource(messageExternalId)
      .then((snapshot) => this.completeHydration(messageExternalId, snapshot))
      .catch(() => this.completeHydration(messageExternalId, null))
    return true
  }

  private completeHydration(
    messageExternalId: string,
    snapshot: StreamHydrationSnapshot | null,
  ): void {
    const queued = this.queuedEvents.get(messageExternalId)
    // Removed (finalized or evicted) while the snapshot was in flight.
    if (!queued) return
    this.queuedEvents.delete(messageExternalId)

    const hydratedParts = snapshot?.parts ?? []
    if (hydratedParts.length > 0) {
      // Queueing means no live event has been applied yet, so the snapshot is
      // the whole state; the tail below builds on it through the normal merge
      // paths, which is what keeps a half-described tool from replacing a
      // fully described one.
      const state: LiveThreadState = {
        messageId: messageExternalId,
        parts: new Map(hydratedParts.map((part) => [part.id, part])),
        seenEventIds: new Set<string>(),
        hasCompleteHistory: true,
      }
      this.threads.set(messageExternalId, state)
      this.publish(state)
    }

    const throughSeq = snapshot?.throughSeq
    for (const event of queued) {
      // Chunks written before the projector stamped sequences leave nothing to
      // join on; replay everything rather than risk dropping live events. With
      // event-derived part ids a repeated fragment lands in its own part and
      // can never corrupt what the snapshot restored.
      if (throughSeq !== undefined && event.seq <= throughSeq) continue
      this.update(event)
    }
  }

  remove(messageExternalId: string) {
    this.threads.delete(messageExternalId)
    this.queuedEvents.delete(messageExternalId)
    this.hydrationRequested.delete(messageExternalId)
    if (!this.messages.has(messageExternalId)) return
    this.messages.delete(messageExternalId)
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

  // Derived from the event that opened the run rather than a positional
  // counter, and identically to the projector: a renderer that starts mid-turn
  // can never mint an id that collides with a run it did not witness, so a
  // hydrated snapshot and the live tail always merge instead of overwriting.
  private nextPartId(state: LiveThreadState, kind: 'text' | 'reasoning', eventId: string): string {
    return `${state.messageId}_${kind}_${eventId}`
  }

  private appendText(state: LiveThreadState, block: ContentBlock, eventId: string): boolean {
    const text = this.text(block)
    if (!text) return false
    const partId = state.activeTextPartId ?? this.nextPartId(state, 'text', eventId)
    state.activeTextPartId = partId
    const existing = state.parts.get(partId)
    state.parts.set(partId, {
      ...(existing ?? {}),
      type: 'text',
      id: partId,
      text: `${String(existing?.text ?? '')}${text}`,
    })
    return true
  }

  /** Reasoning is deliberately NOT routed through `appendText`.
   *
   * `appendText` bails on empty text, which is exactly right for message
   * chunks and exactly wrong here: a provider whose thinking blocks carry no
   * text at all (Claude Code — see `ThoughtChunk`) would produce no part, no
   * `time.start` and no shimmer, so the UI would sit frozen for the 3-8s the
   * block runs. A chunk carrying only a token count, or only a phase, still has
   * to open and update the part. */
  private appendThought(
    state: LiveThreadState,
    data: Extract<AgentEvent, { event: 'agent_thought_chunk' }>['data'],
    eventId: string,
  ): boolean {
    const text = data.content ? this.text(data.content) : ''
    // `tokens: 0` is a real first reading, so this tests presence, not truth.
    const carriesProgress = text !== '' || data.tokens !== undefined
    const opens = data.phase === 'start' || carriesProgress
    if (!opens && data.phase !== 'stop') return false
    if (opens) {
      const partId = state.activeReasoningPartId ?? this.nextPartId(state, 'reasoning', eventId)
      state.activeReasoningPartId = partId
      const existing = state.parts.get(partId)
      const previousTokens = typeof existing?.tokens === 'number' ? existing.tokens : undefined
      const tokens =
        data.tokens !== undefined
          ? Math.max(previousTokens ?? 0, data.tokens)
          : /* keep whatever the run has already reported */ previousTokens
      state.parts.set(partId, {
        ...(existing ?? {}),
        type: 'reasoning',
        id: partId,
        text: `${String(existing?.text ?? '')}${text}`,
        // estimated_tokens is a cumulative total, never an increment: summing
        // it would multiply the count, and a late duplicate would inflate it.
        ...(tokens !== undefined ? { tokens } : {}),
        time: existing?.time ?? { start: Date.now() },
      })
    }
    if (data.phase !== 'stop') return true
    // Only `stop` can settle a block whose text is empty; without it the
    // shimmer would run until some later event happened to close the part.
    const closing = state.activeReasoningPartId !== undefined
    this.finishReasoning(state)
    return opens || closing
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

/** `hydrate` asks the store to backfill this message from Convex when the local
 * snapshot cannot cover the whole turn. Callers pass it for driven, unfinished
 * assistant messages — including turns that stopped emitting events entirely,
 * which no live event would ever trigger hydration for. */
export function useStreamingMessage(messageExternalId: string, hydrate = false) {
  const { streamingStore } = useActiveSession()
  useEffect(() => {
    if (!hydrate) return
    streamingStore.ensureHydrated(messageExternalId)
  }, [hydrate, messageExternalId, streamingStore])
  return useSyncExternalStore(
    (listener) => streamingStore.subscribe(messageExternalId, listener),
    () => streamingStore.get(messageExternalId),
    () => streamingStore.get(messageExternalId),
  )
}

// Rebuild a turn from its persisted chunks. The desktop reads these only to
// recover history it missed; subsequent tokens keep arriving over IPC, which is
// both faster and the only source once the chunks are swept.
async function hydrateStreamSnapshot(
  messageExternalId: string,
): Promise<StreamHydrationSnapshot | null> {
  const chunks = (await trackedConvexQuery(
    'streamChunks.getChunksSince.hydrate',
    api.streamChunks.getChunksSince,
    { messageExternalId, afterIndex: -1 },
  )) as StreamChunk[] | null
  if (!chunks?.length) return null
  const snapshot = reconstructSnapshot(chunks)
  return {
    parts: snapshot.parts as MessagePart[] | undefined,
    ...(snapshot.throughSeq !== undefined ? { throughSeq: snapshot.throughSeq } : {}),
  }
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
  // The source is attached at construction so it is in place before the IPC
  // listener below can deliver the first event of an in-flight turn.
  const streamingStore = useMemo(() => {
    const store = new StreamingMessagesStore()
    store.setSnapshotSource(hydrateStreamSnapshot)
    return store
  }, [])
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
