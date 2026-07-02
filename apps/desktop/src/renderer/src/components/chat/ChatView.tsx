import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { api } from '@openmanager/convex/_generated/api'
import { useActiveSession, useStreamingMessage } from '../../providers/active-session-provider'
import { useAppUi } from '../../providers/app-ui-provider'
import {
  AssistantMessage,
  ChatViewPanel,
  UserMessage,
  type RuntimeMetadata,
} from './ChatViewPrimitives'
import { trackedConvexQuery, useTrackedQuery } from '../../lib/convex-telemetry'
import {
  applyPartUpdate,
  createPartOrdinalState,
  type StreamMessagePart,
} from '../../lib/remote-stream-parts'

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8

export function ChatView() {
  const { activeSessionId, messages, activeSessionDriven } = useActiveSession()
  const { activeWorkspacePath, isSessionDraftOpen, pendingDraftSessionStart } = useAppUi()
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

  if (!activeSessionId) {
    if (isSessionDraftOpen && activeWorkspacePath) {
      const workspaceName =
        activeWorkspacePath.split(/[\\/]/).filter(Boolean).pop() ?? activeWorkspacePath
      return (
        <div className="flex min-h-0 flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-16-medium text-foreground">Let&apos;s build in</div>
            <div className="mt-1 text-20-medium text-sidebar-primary">{workspaceName}</div>
            <div className="mt-3 text-13-regular text-muted-foreground">
              {pendingDraftSessionStart
                ? 'Creating session...'
                : 'Session will be created when you send your first message'}
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="flex min-h-0 flex-1 flex items-center justify-center text-muted-foreground text-13-regular">
        Select or create a session
      </div>
    )
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
          {chatMessages.length === 0 && (
            <div className="text-muted-foreground/70 text-[13px] text-center mt-10">
              Send a message to start
            </div>
          )}

          <MessageTimeline
            messages={chatMessages}
            scrollElement={scrollRef.current}
            isDriven={activeSessionDriven}
            onStreamUpdate={scheduleStickToBottom}
          />
        </div>
      </div>
    </ChatViewPanel>
  )
}

function MessageTimeline({
  messages,
  scrollElement,
  isDriven,
  onStreamUpdate,
}: {
  messages: Array<{
    externalId: string
    role: string
    isFinal?: boolean
    optimisticContent?: string
    isOptimistic?: boolean
  }>
  scrollElement: HTMLDivElement | null
  isDriven: boolean
  onStreamUpdate: () => void
}) {
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

  return (
    <div className="min-w-0">
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
                <MessageRow message={message} isDriven={isDriven} onStreamUpdate={onStreamUpdate} />
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
        />
      ))}
    </div>
  )
}

function MessageRow({
  message,
  isDriven,
  onStreamUpdate,
}: {
  message: {
    externalId: string
    role: string
    isFinal?: boolean
    optimisticContent?: string
    isOptimistic?: boolean
  }
  isDriven: boolean
  onStreamUpdate: () => void
}) {
  return (
    <div className="chat-animate-slide-up">
      <ResolvedMessage
        externalId={message.externalId}
        role={message.role}
        isFinal={message.isFinal}
        optimisticContent={message.optimisticContent}
        isOptimistic={message.isOptimistic}
        isDriven={isDriven}
        onStreamUpdate={onStreamUpdate}
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
  isOptimistic?: boolean
  isDriven: boolean
  onStreamUpdate: () => void
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
  const remoteStreaming = useRemoteStreamingMessage(
    props.externalId,
    shouldUseRemoteStreaming,
    props.onStreamUpdate,
  )

  const finalizedParts = (contentDoc?.metadata as { parts?: MessagePart[] } | undefined)?.parts
  const runtimeMetadata = (contentDoc?.metadata as { runtime?: RuntimeMetadata } | undefined)
    ?.runtime
  const drivenStreamingMessage = props.isDriven ? localStreamingMessage : undefined

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
    return <UserMessage content={content} runtime={runtimeMetadata} />
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
