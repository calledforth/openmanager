import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { api } from '@openmanager/convex/_generated/api'
import { useActiveSession, useStreamingMessage } from '../../providers/active-session-provider'
import {
  AssistantMessage,
  ChatLoadingSkeleton,
  ChatViewPanel,
  UserMessage,
  type RuntimeMetadata,
} from './ChatViewPrimitives'
import { trackedConvexQuery, useTrackedQuery } from '../../lib/convex-telemetry'
import {
  applyPartUpdate,
  createPartOrdinalState,
  type StreamMessagePart,
} from '@openmanager/shared/lib/remote-stream-parts'
import { cn } from '../../lib/utils'
import type { UploadedImageAttachment } from '../../lib/attachments'
import { PendingPermissionFallback } from '../permissions/InlinePermissionPrompt'
import { NewSessionLanding } from './NewSessionLanding'

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8

export function ChatView() {
  const {
    activeSessionId,
    messages,
    activeSessionDriven,
    isMessagesLoading,
    acknowledgeOptimisticMessage,
  } = useActiveSession()
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
        <div className="mx-auto max-w-3xl space-y-1 px-4 pt-2 pb-44">
          <ConversationTimeline
            sessionId={activeSessionId}
            messages={chatMessages}
            isMessagesLoading={isMessagesLoading}
            scrollElement={scrollRef.current}
            isDriven={activeSessionDriven}
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
  messages: Array<{
    externalId: string
    role: string
    isFinal?: boolean
    optimisticContent?: string
    optimisticAttachments?: UploadedImageAttachment[]
    optimisticJobId?: string
    isOptimistic?: boolean
  }>
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
  messages: Array<{
    externalId: string
    role: string
    isFinal?: boolean
    optimisticContent?: string
    optimisticAttachments?: UploadedImageAttachment[]
    optimisticJobId?: string
    isOptimistic?: boolean
  }>
  scrollElement: HTMLDivElement | null
  isDriven: boolean
  onStreamUpdate: () => void
  hidden: boolean
  onHydrated: () => void
  onPersistedContentReady: (messageId: string) => void
}) {
  const [readyMessageIds, setReadyMessageIds] = useState<Set<string>>(() => new Set())
  const didReportHydratedRef = useRef(false)
  const initialMessageIdsRef = useRef(new Set(messages.map((message) => message.externalId)))
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
  message: {
    externalId: string
    role: string
    isFinal?: boolean
    optimisticContent?: string
    optimisticAttachments?: UploadedImageAttachment[]
    optimisticJobId?: string
    isOptimistic?: boolean
  }
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
        optimisticJobId={message.optimisticJobId}
        isOptimistic={message.isOptimistic}
        isDriven={isDriven}
        onStreamUpdate={onStreamUpdate}
        onReady={onReady}
        onPersistedContentReady={onPersistedContentReady}
      />
    </div>
  )
}

type MessagePart = StreamMessagePart

function useRemoteStreamingMessage(
  messageExternalId: string,
  enabled: boolean,
  onUpdate?: () => void,
) {
  const latest = useTrackedQuery(
    'streamChunks.getLatestChunk',
    api.streamChunks.getLatestChunk,
    enabled ? { messageExternalId } : 'skip',
  )
  const [content, setContent] = useState('')
  const [parts, setParts] = useState<MessagePart[] | undefined>(undefined)
  const lastChunkIndex = useRef<number | null>(null)
  const partOrdinalStateRef = useRef(createPartOrdinalState())

  useEffect(() => {
    if (!enabled) return
    setContent('')
    setParts(undefined)
    lastChunkIndex.current = null
    partOrdinalStateRef.current = createPartOrdinalState()
  }, [enabled, messageExternalId])

  useEffect(() => {
    if (!enabled || !latest) return

    if (lastChunkIndex.current !== null && latest.chunkIndex <= lastChunkIndex.current) return

    const applyChunkPart = (partUpdate: unknown) => {
      const part = (partUpdate as { part?: MessagePart } | undefined)?.part
      if (!part?.id) return
      setParts(
        (prev) =>
          applyPartUpdate(
            prev as StreamMessagePart[] | undefined,
            part as StreamMessagePart,
            partOrdinalStateRef.current,
          ) as MessagePart[],
      )
    }

    const expectedChunkIndex = latest.chunkIndex
    const previousIndex = lastChunkIndex.current
    // Sequential delivery: append the single newest chunk without any extra read.
    const isSequential =
      previousIndex === null ? expectedChunkIndex === 0 : expectedChunkIndex === previousIndex + 1

    if (isSequential) {
      lastChunkIndex.current = expectedChunkIndex
      setContent((prev) => prev + latest.chunkText)
      applyChunkPart(latest.partUpdate)
      onUpdate?.()
      return
    }

    // Gap (coalesced updates) or late join: fetch only the missed tail and append it.
    let cancelled = false
    const afterIndex = previousIndex ?? -1

    trackedConvexQuery('streamChunks.getChunksSince', api.streamChunks.getChunksSince, {
      messageExternalId,
      afterIndex,
    })
      .then((chunks) => {
        if (cancelled || !chunks || chunks.length === 0) return
        if (lastChunkIndex.current !== previousIndex) return
        const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
        let appended = ''
        let maxIndex = previousIndex ?? -1
        for (const chunk of ordered) {
          if (chunk.chunkIndex <= maxIndex) continue
          appended += chunk.chunkText
          applyChunkPart(chunk.partUpdate)
          maxIndex = chunk.chunkIndex
        }
        if (maxIndex <= (previousIndex ?? -1)) return
        lastChunkIndex.current = maxIndex
        setContent((prev) => prev + appended)
        onUpdate?.()
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [latest, enabled, messageExternalId, onUpdate])

  return { content, parts }
}

const ResolvedMessage = memo(function ResolvedMessage(props: {
  externalId: string
  role: string
  isFinal?: boolean
  optimisticContent?: string
  optimisticAttachments?: UploadedImageAttachment[]
  optimisticJobId?: string
  isOptimistic?: boolean
  isDriven: boolean
  onStreamUpdate: () => void
  onReady?: (messageId: string) => void
  onPersistedContentReady?: (messageId: string) => void
}) {
  const shouldUseRemoteStreaming =
    props.role === 'assistant' && props.isFinal !== true && !props.isDriven
  const localStreamingMessage = useStreamingMessage(props.externalId)
  const contentDoc = useTrackedQuery(
    'messages.getContent',
    api.messages.getContent,
    !props.isOptimistic && (props.isFinal || props.role === 'user')
      ? { externalId: props.externalId }
      : 'skip',
  )
  const optimisticJob = useTrackedQuery(
    'jobs.getStatus.optimistic',
    api.jobs.getStatus,
    props.isOptimistic && props.optimisticJobId
      ? ({ jobId: props.optimisticJobId } as any)
      : 'skip',
  ) as { status: string; lastError?: string } | null | undefined
  const remoteStreaming = useRemoteStreamingMessage(
    props.externalId,
    shouldUseRemoteStreaming,
    props.onStreamUpdate,
  )

  const finalizedParts = (contentDoc?.metadata as { parts?: MessagePart[] } | undefined)?.parts
  const runtimeMetadata = (contentDoc?.metadata as { runtime?: RuntimeMetadata } | undefined)
    ?.runtime
  const drivenStreamingMessage = localStreamingMessage

  // Cache last-known streaming parts so the isFinal transition doesn't flash empty
  // (getContent query needs a round-trip to resolve after listMetadata flips isFinal)
  const lastStreamingPartsRef = useRef<MessagePart[] | undefined>(undefined)
  const lastStreamingContentRef = useRef<string>('')
  const streamingParts = drivenStreamingMessage?.parts ?? remoteStreaming.parts
  if (streamingParts && streamingParts.length > 0) {
    lastStreamingPartsRef.current = streamingParts
  }

  const localStreamingContent = drivenStreamingMessage?.content ?? ''
  const streamingContent =
    localStreamingContent.length >= remoteStreaming.content.length
      ? localStreamingContent
      : remoteStreaming.content
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
        sendError={optimisticJob?.status === 'failed' ? optimisticJob.lastError : undefined}
        runtime={runtimeMetadata}
      />
    )
  }

  return (
    <AssistantMessage
      content={content}
      isFinal={props.isFinal}
      parts={parts}
      runtime={runtimeMetadata}
    />
  )
})
