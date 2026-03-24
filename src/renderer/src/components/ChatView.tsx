import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { api } from '@convex/_generated/api'
import { useActiveSession, useStreamingMessage } from '../providers/active-session-provider'
import { useAppUi } from '../providers/app-ui-provider'
import { MessageParts } from './parts/MessageParts'
import { TextPart } from './parts/TextPart'
import { cn } from '../lib/utils'
import { trackedConvexQuery, useTrackedQuery } from '../lib/convex-telemetry'

interface RuntimeMetadata {
  providerId?: string
  modelId?: string
  modeId?: string
  agentId?: string
  finishReason?: string
  costUsd?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
}

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 96
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8

export function ChatView() {
  const { activeSessionId, activeSession, messages, abortSession, activeSessionDriven } =
    useActiveSession()
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
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-xl font-medium text-foreground">Let&apos;s build in</div>
            <div className="mt-1 text-2xl font-semibold text-sidebar-primary">{workspaceName}</div>
            <div className="mt-3 text-xs text-muted-foreground">
              {pendingDraftSessionStart
                ? 'Creating session...'
                : 'Session will be created when you send your first message'}
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs">
        Select or create a session
      </div>
    )
  }

  const chatMessages = messages.filter((m) => m.role !== 'permission')
  const isStreaming = activeSession?.status === 'running' || activeSession?.status === 'busy'

  return (
    <div data-chat-view className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2.5 flex justify-between items-center shrink-0">
        <span className="text-sm font-medium text-sidebar-primary">
          {activeSession?.title || activeSessionId.slice(0, 12)}
        </span>
        <div className="flex items-center gap-2">
          {activeSession?.status && activeSession.status !== 'idle' && (
            <span
              className={cn(
                'text-[11px]',
                activeSession.status === 'running' || activeSession.status === 'busy'
                  ? 'text-primary'
                  : activeSession.status === 'error'
                    ? 'text-destructive'
                    : 'text-muted-foreground',
              )}
            >
              {activeSession.status}
            </span>
          )}
          {isStreaming && (
            <button
              type="button"
              onClick={() => abortSession(activeSessionId)}
              className="rounded-md border border-destructive px-2 py-0.5 text-[11px] text-destructive bg-transparent cursor-pointer transition-default hover:bg-destructive/10"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden min-h-0"
      >
        <div className="mx-auto max-w-2xl px-4 py-6 space-y-1">
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

          {isStreaming && (
            <div className="flex items-center gap-2 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              <span className="text-xs text-muted-foreground">Thinking...</span>
            </div>
          )}
        </div>
      </div>
    </div>
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
      (message) => message.isOptimistic || (message.role === 'assistant' && message.isFinal !== true),
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
                <MessageRow
                  message={message}
                  isDriven={isDriven}
                  onStreamUpdate={onStreamUpdate}
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

function UserMessage({ content, runtime }: { content: string; runtime?: RuntimeMetadata }) {
  const [expanded, setExpanded] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const [showGradient, setShowGradient] = useState(false)

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const check = () => setShowGradient(el.scrollHeight > el.clientHeight)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [content])

  const canExpand = showGradient && !expanded

  return (
    <div className="py-1.5">
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[85%] relative rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[14px] text-foreground leading-relaxed whitespace-pre-wrap break-words transition-all duration-200',
            canExpand ? 'cursor-pointer hover:brightness-110' : '',
          )}
          onClick={() => canExpand && setExpanded(true)}
        >
          <div ref={contentRef} className={cn(canExpand && 'max-h-[100px] overflow-hidden')}>
            {content}
          </div>
          {canExpand && (
            <div
              className="absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-secondary to-transparent pointer-events-none"
              aria-hidden
            />
          )}
        </div>
      </div>
      <MessageRuntimeMeta runtime={runtime} align="right" />
    </div>
  )
}

interface MessagePart {
  type: string
  id: string
  [key: string]: unknown
}

function useRemoteStreamingMessage(
  messageExternalId: string,
  enabled: boolean,
  onUpdate?: () => void,
) {
  const cursor = useTrackedQuery(
    'streamCursors.get',
    api.streamCursors.get,
    enabled ? { messageExternalId } : 'skip',
  )
  const [content, setContent] = useState('')
  const [parts, setParts] = useState<MessagePart[] | undefined>(undefined)
  const lastChunkIndex = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) return
    setContent('')
    setParts(undefined)
    lastChunkIndex.current = null
  }, [enabled, messageExternalId])

  useEffect(() => {
    if (!enabled || !cursor) return

    if (lastChunkIndex.current !== null && cursor.chunkIndex <= lastChunkIndex.current) return

    const expectedChunkIndex = cursor.chunkIndex
    const requiresSnapshot =
      lastChunkIndex.current === null || expectedChunkIndex > lastChunkIndex.current + 1

    if (!requiresSnapshot) {
      lastChunkIndex.current = expectedChunkIndex
      setContent((prev) => prev + cursor.chunkText)
      onUpdate?.()
      return
    }

    let cancelled = false

    trackedConvexQuery('streamCursors.getSnapshot', api.streamCursors.getSnapshot, {
      messageExternalId,
    })
      .then((snapshot) => {
        if (cancelled || !snapshot) return
        if (snapshot.chunkIndex < expectedChunkIndex) return
        if (lastChunkIndex.current !== null && snapshot.chunkIndex <= lastChunkIndex.current) return
        lastChunkIndex.current = snapshot.chunkIndex
        setContent(snapshot.bodyUpToHere)
        setParts((snapshot.partsUpToHere as MessagePart[] | undefined) ?? undefined)
        onUpdate?.()
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [cursor, enabled, messageExternalId, onUpdate])

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
  const runtimeMetadata = (contentDoc?.metadata as { runtime?: RuntimeMetadata } | undefined)?.runtime
  const drivenStreamingMessage = props.isDriven ? localStreamingMessage : undefined

  // Cache last-known streaming parts so the isFinal transition doesn't flash empty
  // (getContent query needs a round-trip to resolve after listMetadata flips isFinal)
  const lastStreamingPartsRef = useRef<MessagePart[] | undefined>(undefined)
  const streamingParts = drivenStreamingMessage?.parts ?? remoteStreaming.parts
  if (streamingParts && streamingParts.length > 0) {
    lastStreamingPartsRef.current = streamingParts
  }

  const localStreamingContent = drivenStreamingMessage?.content ?? ''
  const streamingContent =
    localStreamingContent.length >= remoteStreaming.content.length
      ? localStreamingContent
      : remoteStreaming.content
  const finalizedContent = contentDoc?.content ?? streamingContent
  const content =
    props.role === 'assistant'
      ? props.isFinal === true
        ? finalizedContent
        : streamingContent
      : props.optimisticContent ?? contentDoc?.content ?? ''
  const parts =
    props.role === 'assistant' && props.isFinal !== true
      ? streamingParts
      : finalizedParts ?? lastStreamingPartsRef.current

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

const AssistantMessage = memo(function AssistantMessage({
  content,
  isFinal,
  parts,
  runtime,
}: {
  content: string
  isFinal?: boolean
  parts?: MessagePart[]
  runtime?: RuntimeMetadata
}) {
  const hasParts = !!parts && parts.length > 0
  const isStreaming = isFinal === false

  return (
    <div className="py-2">
      <div className="text-[14px] leading-relaxed text-foreground space-y-0.5">
        {hasParts ? (
          <MessageParts parts={parts} isStreaming={isStreaming} />
        ) : (
          <div className={isStreaming ? 'opacity-80' : 'opacity-100'}>
            <TextPart text={content} />
          </div>
        )}
      </div>
      <MessageRuntimeMeta runtime={runtime} align="left" />
    </div>
  )
})

function MessageRuntimeMeta({
  runtime,
  align,
}: {
  runtime?: RuntimeMetadata
  align: 'left' | 'right'
}) {
  if (!runtime) return null
  const parts: string[] = []
  const modelLabel =
    runtime.providerId && runtime.modelId
      ? `${runtime.providerId}/${runtime.modelId}`
      : runtime.modelId ?? undefined
  if (modelLabel) parts.push(modelLabel)
  if (runtime.modeId) parts.push(`mode:${runtime.modeId}`)
  if (runtime.agentId) parts.push(`agent:${runtime.agentId}`)
  if (runtime.tokens?.total != null) parts.push(`${runtime.tokens.total} tokens`)
  if (runtime.costUsd != null && runtime.costUsd > 0) parts.push(`$${runtime.costUsd.toFixed(4)}`)
  if (runtime.finishReason) parts.push(runtime.finishReason)
  if (parts.length === 0) return null

  return (
    <div
      className={cn(
        'mt-1 text-[11px] text-muted-foreground tabular-nums',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {parts.join(' • ')}
    </div>
  )
}
