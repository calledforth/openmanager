import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import type { PlanReviewOutcome, ProviderId, QuestionOutcome } from '@agentpack/contract'
import type { UploadedImageAttachment } from '../lib/attachments'
import type { LocalStreamingMessage, MessagePart } from '../lib/streaming-messages-store'
import type { TurnRuntimeMetadata } from '../components/parts/turn-work-group'
import type { PermissionSelection } from './permission-provider'

export interface UIMessage {
  externalId: string
  role: string
  isFinal?: boolean
  sequenceNum: number
  optimisticContent?: string
  optimisticAttachments?: UploadedImageAttachment[]
  optimisticJobId?: string
  isOptimistic?: boolean
  /** Why the host could not send this optimistic message, once it knows. */
  sendError?: string
}

/** The persisted record of the thread on screen, plus whether this client drives it. */
export interface ActiveThreadDetails {
  externalId: string
  title?: string
  status: string
  clientId?: string
  providerId?: ProviderId
  parentExternalId?: string
  isDriven: boolean
}

/** The persisted body of one message: what a settled assistant turn or a
 * user prompt rendered as, plus the turn metadata the timeline labels it with. */
export interface MessageContentSnapshot {
  content: string
  parts?: MessagePart[]
  runtime?: TurnRuntimeMetadata
}

/** External store of persisted message bodies, keyed by message ID.
 *
 * `get` returns `undefined` while the body is still loading and `null` when
 * the host has no record of it. Subscribing is what starts the load; hosts
 * are free to keep nothing for messages nobody is looking at. */
export interface MessageContentStore {
  subscribe(messageExternalId: string, listener: () => void): () => void
  get(messageExternalId: string): MessageContentSnapshot | null | undefined
}

/** External store of in-flight assistant turns, keyed by message ID. The
 * `StreamingMessagesStore` class is one implementation; hosts that already
 * hold a normalized thread state project it into this shape instead. */
export interface StreamingMessageSource {
  subscribe(messageExternalId: string, listener: () => void): () => void
  get(messageExternalId: string): LocalStreamingMessage | undefined
  /** Backfill this message from the host when the local snapshot cannot cover
   * the whole turn. Idempotent; a no-op for sources that are always complete. */
  ensureHydrated(messageExternalId: string): void
}

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

/**
 * The thread on screen: its persisted record, message list with optimistic
 * user messages, the streaming store for in-flight turns, and every command
 * that acts on a turn (send, abort, permission/question/plan answers).
 */
export interface ActiveThreadStateValue {
  activeSessionId: string | null
  activeThread: ActiveThreadDetails | null
  /** This client owns the thread: it created it, or adopted it from a draft. */
  activeThreadDriven: boolean
  isMessagesLoading: boolean
  messages: UIMessage[]
  /** Per-message streaming snapshots for turns this client drives; subscribe
   * through `useStreamingMessage`. */
  streamingStore: StreamingMessageSource
  /** Snapshots for unfinished assistant turns this client does *not* drive
   * (another host is running the agent). Falls back to `streamingStore` when
   * the host makes no such distinction. */
  remoteStreamingStore?: StreamingMessageSource
  /** Persisted message bodies; subscribe through `useMessageContent`. */
  messageContentStore: MessageContentStore
  /** Last failure from a thread command. */
  error: string | null
  /** Drop an optimistic user message once its persisted body is on screen. */
  acknowledgeOptimisticMessage: (externalId: string) => void
  /** Send a prompt to the active session, or start a session from the open draft. */
  sendMessage: (content: string, attachments?: UploadedImageAttachment[]) => Promise<void>
  abortSession: (externalId: string) => Promise<void>
  resolvePermission: (
    sessionExternalId: string,
    permissionId: string,
    selection: PermissionSelection,
  ) => Promise<void>
  resolveQuestion: (
    sessionExternalId: string,
    requestId: string,
    outcome: QuestionOutcome,
  ) => Promise<void>
  resolvePlan: (
    sessionExternalId: string,
    requestId: string,
    outcome: PlanReviewOutcome,
  ) => Promise<void>
  buildPlan: (sessionExternalId: string, requestId: string, modeId?: string) => Promise<void>
}

export const ActiveThreadStateContext = createContext<ActiveThreadStateValue | null>(null)

export function useActiveThreadState(): ActiveThreadStateValue {
  const ctx = useContext(ActiveThreadStateContext)
  if (!ctx) throw new Error('useActiveThreadState must be used within ActiveThreadStateProvider')
  return ctx
}

/** `hydrate` asks the store to backfill this message from the host when the
 * local snapshot cannot cover the whole turn. Callers pass it for driven,
 * unfinished assistant messages — including turns that stopped emitting
 * events entirely, which no live event would ever trigger hydration for. */
export function useStreamingMessage(messageExternalId: string, hydrate = false) {
  const { streamingStore } = useActiveThreadState()
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

const noop = () => undefined

/** The live snapshot of an assistant turn another host is driving. Reads
 * `remoteStreamingStore` when the host provides one, the local store
 * otherwise; `enabled` keeps the subscription off for settled messages. */
export function useRemoteStreamingMessage(messageExternalId: string, enabled: boolean) {
  const { streamingStore, remoteStreamingStore } = useActiveThreadState()
  const source = remoteStreamingStore ?? streamingStore
  return useSyncExternalStore(
    (listener) => (enabled ? source.subscribe(messageExternalId, listener) : noop),
    () => (enabled ? source.get(messageExternalId) : undefined),
    () => (enabled ? source.get(messageExternalId) : undefined),
  )
}

/** The persisted body of a message. `undefined` while loading (or while
 * `enabled` is false), `null` when the host has none. */
export function useMessageContent(messageExternalId: string, enabled: boolean) {
  const { messageContentStore } = useActiveThreadState()
  return useSyncExternalStore(
    (listener) => (enabled ? messageContentStore.subscribe(messageExternalId, listener) : noop),
    () => (enabled ? messageContentStore.get(messageExternalId) : undefined),
    () => (enabled ? messageContentStore.get(messageExternalId) : undefined),
  )
}
