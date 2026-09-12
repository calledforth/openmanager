import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import {
  useActiveThreadState,
  useMessageContent,
  useRemoteStreamingMessage,
  useStreamingMessage,
  type UIMessage,
} from '../../providers/active-thread-provider'
import { AssistantMessage, ChatLoadingSkeleton, ChatViewPanel, UserMessage } from './ChatViewPrimitives'
import { shouldHydrateLocalStream, shouldUseRemoteStreaming } from '../../lib/stream-continuity'
import type { MessagePart } from '../../lib/streaming-messages-store'
import { cn } from '../../lib/utils'
import { PendingPermissionFallback } from '../permissions/InlinePermissionPrompt'
import { NewSessionLanding } from './NewSessionLanding'

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8

type TimelineMessage = Pick<
  UIMessage,
  | 'externalId'
  | 'role'
  | 'isFinal'
  | 'optimisticContent'
  | 'optimisticAttachments'
  | 'optimisticJobId'
  | 'isOptimistic'
  | 'sendError'
>

/**
 * The conversation on screen, bound to the active thread contract. Message
 * bodies come from `messageContentStore`, in-flight turns from the streaming
 * stores; nothing here knows which host supplied them.
 */
export function ChatView() {
  const {
    activeSessionId,
    messages,
    activeThreadDriven,
    isMessagesLoading,
    acknowledgeOptimisticMessage,
  } = useActiveThreadState()
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollRef = useRef(true)
  const lastKnownScrollTopRef = useRef(0)
  const pendingAutoScrollFrameRef = useRef<number | null>(null)

  const scheduleStickToBottom = useCallback(() => {
    if (!shouldAutoScrollRef.current) return
    if (pendingAutoScrollFrameRef.current !== null) return
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null
      const el = scrollRef.current
      if (!el || !shouldAutoScrollRef.current) return
      el.scrollTop = el.scrollHeight
      lastKnownScrollTopRef.current = el.scrollTop
    })
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    const scrolledUp = el.scrollTop < lastKnownScrollTopRef.current - 1
    if (distanceFromBottom <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX) {
      shouldAutoScrollRef.current = true
    } else if (scrolledUp) {
      shouldAutoScrollRef.current = false
    }
    lastKnownScrollTopRef.current = el.scrollTop
  }, [])

  useLayoutEffect(() => {
    shouldAutoScrollRef.current = true
    scheduleStickToBottom()
  }, [activeSessionId, scheduleStickToBottom])

  useEffect(() => {
    scheduleStickToBottom()
  }, [messages, scheduleStickToBottom])

  useEffect(() => {
    return () => {
      if (pendingAutoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingAutoScrollFrameRef.current)
      }
    }
  }, [])

  if (!activeSessionId && messages.length === 0) {
    return <NewSessionLanding />
  }

  const chatMessages = messages.filter((m) => m.role !== 'permission')

  return (
    <ChatViewPanel>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="custom-scrollbar flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
      >
        <div className="mx-auto max-w-[52rem] space-y-1 px-4 pt-2 pb-44">
          <ConversationTimeline
            sessionId={activeSessionId}
            messages={chatMessages}
            isMessagesLoading={isMessagesLoading}
            scrollElement={scrollRef.current}
            isDriven={activeThreadDriven}
            onStreamUpdate={scheduleStickToBottom}
            onPersistedContentReady={acknowledgeOptimisticMessage}
          />
          <PendingPermissionFallback />
        </div>
      </div>
    </ChatViewPanel>
  )
}

function ConversationTimeline({
  sessionId,
  messages,
  isMessagesLoading,
  scrollElement,
  isDriven,
  onStreamUpdate,
  onPersistedContentReady,
}: {
  sessionId: string | null
  messages: TimelineMessage[]
  isMessagesLoading: boolean
  scrollElement: HTMLDivElement | null
  isDriven: boolean
  onStreamUpdate: () => void
  onPersistedContentReady: (messageId: string) => void
}) {
  const [hydratingSessionId, setHydratingSessionId] = useState<string | null>(null)
  const isColdSessionLoad = !!sessionId && isMessagesLoading && messages.length === 0
  const isHydrating = isColdSessionLoad || (!!sessionId && hydratingSessionId === sessionId)
  const handleHydrated = useCallback(() => {
    setHydratingSessionId((current) => (current === sessionId ? null : current))
  }, [sessionId])

  useEffect(() => {
    if (isColdSessionLoad) {
      setHydratingSessionId(sessionId)
      return
    }
    if (!isMessagesLoading && messages.length === 0 && hydratingSessionId === sessionId) {
      setHydratingSessionId(null)
    }
  }, [hydratingSessionId, isColdSessionLoad, isMessagesLoading, messages.length, sessionId])

  useEffect(() => {
    if (!isHydrating) onStreamUpdate()
  }, [isHydrating, onStreamUpdate])

  return (
    <>
      {isHydrating ? (
        <ChatLoadingSkeleton />
      ) : messages.length === 0 ? (
        <div className="text-muted-foreground/70 text-[13px] text-center mt-10">
          Send a message to start
        </div>
      ) : null}

      {messages.length > 0 && (
        <MessageTimeline
          messages={messages}
          scrollElement={scrollElement}
          isDriven={isDriven}
          onStreamUpdate={onStreamUpdate}
          hidden={isHydrating}
          onHydrated={handleHydrated}
          onPersistedContentReady={onPersistedContentReady}
        />
      )}
    </>
  )
}

function MessageTimeline({
  messages,
  scrollElement,
  isDriven,
  onStreamUpdate,
  hidden,
  onHydrated,
  onPersistedContentReady,
}: {
  messages: TimelineMessage[]
  scrollElement: HTMLDivElement | null
  isDriven: boolean
  onStreamUpdate: () => void
  hidden: boolean
  onHydrated: () => void
  onPersistedContentReady: (messageId: string) => void
}) {
  const [readyMessageIds, setReadyMessageIds] = useState<Set<string>>(() => new Set())
  const didReportHydratedRef = useRef(false)
  // Messages already present at mount are restored history and must not replay
  // their entrance. An optimistic message is never history — it exists only
  // because this client just sent it, so it keeps its slide-up. That matters on
  // a fresh session, where the timeline mounts 0 → 1 on the very first send and
  // would otherwise pop the first bubble in with no transition at all.
  const initialMessageIdsRef = useRef(
    new Set(
      messages.filter((message) => !message.isOptimistic).map((message) => message.externalId),
    ),
  )
  const firstUnvirtualizedIndex = useMemo(() => {
    const firstTailIndex = Math.max(messages.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0)
    const firstLiveIndex = messages.findIndex(
      (message) =>
        message.isOptimistic || (message.role === 'assistant' && message.isFinal !== true),
    )
    if (firstLiveIndex < 0) return firstTailIndex
    return Math.min(firstLiveIndex, firstTailIndex)
  }, [messages])

  const virtualizedCount = Math.min(firstUnvirtualizedIndex, messages.length)
  const tailMessages = messages.slice(virtualizedCount)

  const rowVirtualizer = useVirtualizer({
    count: virtualizedCount,
    getScrollElement: () => scrollElement,
    getItemKey: (index) => messages[index]?.externalId ?? index,
    estimateSize: () => 112,
    overscan: 8,
  })

  const virtualRows = rowVirtualizer.getVirtualItems()
  const hydrationTargetIds = useMemo(
    () => tailMessages.map((message) => message.externalId),
    [tailMessages],
  )
  const handleMessageReady = useCallback((messageId: string) => {
    setReadyMessageIds((current) => {
      if (current.has(messageId)) return current
      const next = new Set(current)
      next.add(messageId)
      return next
    })
  }, [])

  useEffect(() => {
    if (didReportHydratedRef.current || hydrationTargetIds.length === 0) return
    if (hydrationTargetIds.every((messageId) => readyMessageIds.has(messageId))) {
      didReportHydratedRef.current = true
      onHydrated()
    }
  }, [hydrationTargetIds, onHydrated, readyMessageIds])

  return (
    <div className={cn('min-w-0', hidden && 'pointer-events-none invisible h-0 overflow-hidden')}>
      {virtualizedCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const message = messages[virtualRow.index]
            if (!message) return null
            return (
              <div
                key={`virtual-row:${message.externalId}`}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <MessageRow
                  message={message}
                  isDriven={isDriven}
                  onStreamUpdate={onStreamUpdate}
                  onReady={handleMessageReady}
                  onPersistedContentReady={onPersistedContentReady}
                  animate={!initialMessageIdsRef.current.has(message.externalId)}
                />
              </div>
            )
          })}
        </div>
      )}

      {tailMessages.map((message) => (
        <MessageRow
          key={`tail-row:${message.externalId}`}
          message={message}
          isDriven={isDriven}
          onStreamUpdate={onStreamUpdate}
          onReady={handleMessageReady}
          onPersistedContentReady={onPersistedContentReady}
          animate={!initialMessageIdsRef.current.has(message.externalId)}
        />
      ))}
    </div>
  )
}

function MessageRow({
  message,
  isDriven,
  onStreamUpdate,
  onReady,
  onPersistedContentReady,
  animate,
}: {
  message: TimelineMessage
  isDriven: boolean
  onStreamUpdate: () => void
  onReady: (messageId: string) => void
  onPersistedContentReady: (messageId: string) => void
  animate: boolean
}) {
  return (
    <div className={cn(animate && 'chat-animate-slide-up')}>
      <ResolvedMessage
        externalId={message.externalId}
        role={message.role}
        isFinal={message.isFinal}
        optimisticContent={message.optimisticContent}
        optimisticAttachments={message.optimisticAttachments}
        isOptimistic={message.isOptimistic}
        sendError={message.sendError}
        isDriven={isDriven}
        onStreamUpdate={onStreamUpdate}
        onReady={onReady}
        onPersistedContentReady={onPersistedContentReady}
      />
    </div>
  )
}

const ResolvedMessage = memo(function ResolvedMessage(props: {
  externalId: string
  role: string
  isFinal?: boolean
  optimisticContent?: string
  optimisticAttachments?: TimelineMessage['optimisticAttachments']
  isOptimistic?: boolean
  sendError?: string
  isDriven: boolean
  onStreamUpdate: () => void
  onReady?: (messageId: string) => void
  onPersistedContentReady?: (messageId: string) => void
}) {
  const useRemoteStreaming = shouldUseRemoteStreaming(props.role, props.isFinal, props.isDriven)
  // A driven session takes its tokens from the host at zero latency, but that
  // copy starts empty on every reload. Hydrating restores the turn so far;
  // everything after keeps arriving live.
  const localStreamingMessage = useStreamingMessage(
    props.externalId,
    shouldHydrateLocalStream(props.role, props.isFinal, props.isDriven),
  )
  const contentDoc = useMessageContent(
    props.externalId,
    !props.isOptimistic && (props.isFinal === true || props.role === 'user'),
  )
  const remoteStreaming = useRemoteStreamingMessage(props.externalId, useRemoteStreaming)
  const onStreamUpdate = props.onStreamUpdate
  useEffect(() => {
    if (useRemoteStreaming && remoteStreaming) onStreamUpdate()
  }, [onStreamUpdate, remoteStreaming, useRemoteStreaming])

  const finalizedParts = contentDoc?.parts
  // Cache last-known streaming parts so the isFinal transition doesn't flash
  // empty while the persisted body is still on its way.
  const lastStreamingPartsRef = useRef<MessagePart[] | undefined>(undefined)
  const lastStreamingContentRef = useRef<string>('')
  const streamingParts = props.isDriven ? localStreamingMessage?.parts : remoteStreaming?.parts
  if (streamingParts && streamingParts.length > 0) {
    lastStreamingPartsRef.current = streamingParts
  }

  const streamingContent = props.isDriven
    ? (localStreamingMessage?.content ?? '')
    : (remoteStreaming?.content ?? '')
  if (streamingContent.length > 0) {
    lastStreamingContentRef.current = streamingContent
  }

  const isContentLoading =
    !props.isOptimistic &&
    (props.isFinal === true || props.role === 'user') &&
    contentDoc === undefined
  const hasRenderableFallback =
    props.optimisticContent !== undefined ||
    !!props.optimisticAttachments?.length ||
    lastStreamingContentRef.current.length > 0 ||
    !!lastStreamingPartsRef.current?.length
  const onReady = props.onReady
  const onPersistedContentReady = props.onPersistedContentReady
  const externalId = props.externalId
  useEffect(() => {
    if (!isContentLoading || hasRenderableFallback) onReady?.(externalId)
  }, [externalId, hasRenderableFallback, isContentLoading, onReady])

  useEffect(() => {
    if (props.optimisticContent !== undefined && contentDoc !== undefined && contentDoc !== null) {
      onPersistedContentReady?.(externalId)
    }
  }, [contentDoc, externalId, onPersistedContentReady, props.optimisticContent])

  if (isContentLoading && !hasRenderableFallback) return null

  const content =
    props.role === 'assistant'
      ? props.isFinal === true
        ? (contentDoc?.content ?? lastStreamingContentRef.current)
        : streamingContent
      : (props.optimisticContent ?? contentDoc?.content ?? '')
  const parts =
    props.role === 'assistant' && props.isFinal !== true
      ? streamingParts
      : (finalizedParts ?? lastStreamingPartsRef.current)

  if (props.role === 'user') {
    return (
      <UserMessage
        content={content}
        parts={parts}
        optimisticAttachments={props.optimisticAttachments}
        sendError={props.sendError}
      />
    )
  }

  return (
    <AssistantMessage
      content={content}
      isFinal={props.isFinal}
      parts={parts}
      runtime={contentDoc?.runtime}
    />
  )
})
