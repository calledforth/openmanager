import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  defaultRangeExtractor,
  measureElement as measureRowElement,
  useVirtualizer,
  type Range,
  type VirtualItem,
  type Virtualizer,
} from '@tanstack/react-virtual'
import {
  useActiveThreadState,
  useMessageContent,
  useRemoteStreamingMessage,
  useStreamingMessage,
  type UIMessage,
} from '../../providers/active-thread-provider'
import {
  AssistantMessage,
  ChatLoadingSkeleton,
  ChatViewPanel,
  UserMessage,
} from './ChatViewPrimitives'
import { shouldHydrateLocalStream, shouldUseRemoteStreaming } from '../../lib/stream-continuity'
import type { MessagePart } from '../../lib/streaming-messages-store'
import { cn } from '../../lib/utils'
import { PendingPermissionFallback } from '../permissions/InlinePermissionPrompt'
import { NewSessionLanding } from './NewSessionLanding'
import { ScrollToEndButton } from './ScrollToEndButton'
import {
  measurementsFromRememberedHeights,
  recallTimelinePosition,
  rememberTimelinePosition,
} from './timelinePositions'

/**
 * The newest rows (and any still streaming) stay rendered wherever the reader
 * is: the loading gate waits on them, and a streaming row must not unmount.
 */
const PINNED_TAIL_ROWS = 8
const ESTIMATED_ROW_HEIGHT_PX = 112
const ROW_GAP_PX = 4
const LIST_PADDING_TOP_PX = 8
/** Room below the last row so it can scroll clear of the floating composer. */
const COMPOSER_CLEARANCE_PX = 176
/**
 * How close to the bottom still counts as "at the bottom". There, new rows and
 * a streaming row's growth keep the view pinned; anywhere above, it stays put.
 */
const END_THRESHOLD_PX = 1

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
  | 'commandId'
>

interface TimelineHandle {
  /** Smoothly scroll to the latest message and resume following. */
  scrollToEnd: () => void
}

/** Input that means the reader is steering the scroll themselves. */
const READER_SCROLL_INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
/** Where `scrollend` is unsupported, land once a smooth scroll has surely ended. */
const SMOOTH_SCROLL_FALLBACK_MS = 1000

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
    history,
    acknowledgeOptimisticMessage,
    retrySend,
  } = useActiveThreadState()
  // State rather than a ref: the virtualizer needs the element on the render
  // after it mounts, and a ref read during render is still null then.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const timelineRef = useRef<TimelineHandle | null>(null)
  const [endState, setEndState] = useState({ sessionId: activeSessionId, atEnd: true })
  const handleAtEndChange = useCallback(
    (atEnd: boolean) =>
      setEndState((current) =>
        current.sessionId === activeSessionId && current.atEnd === atEnd
          ? current
          : { sessionId: activeSessionId, atEnd },
      ),
    [activeSessionId],
  )
  const chatMessages = useMemo(
    () => messages.filter((message) => message.role !== 'permission'),
    [messages],
  )

  if (!activeSessionId && messages.length === 0) {
    return <NewSessionLanding />
  }

  const header =
    history?.failed || history?.hasMore ? (
      <>
        {history.failed && (
          <div role="alert" className="py-3 text-center text-sm">
            History could not be synchronized.{' '}
            <button
              type="button"
              className="underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => void history.retry?.()}
            >
              Retry history
            </button>
          </div>
        )}
        {history.hasMore && (
          <div className="flex justify-center py-2">
            <button
              type="button"
              disabled={history.isLoading || isMessagesLoading || history.failed}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              // Older rows arrive above the reader; the list keeps them in place.
              onClick={() => void history.loadMore()}
            >
              {history.isLoading ? 'Loading older messages…' : 'Load older messages'}
            </button>
          </div>
        )}
      </>
    ) : null

  return (
    <ChatViewPanel>
      <div
        ref={setScrollElement}
        className="custom-scrollbar flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
      >
        <ConversationTimeline
          sessionId={activeSessionId}
          messages={chatMessages}
          isMessagesLoading={isMessagesLoading}
          scrollElement={scrollElement}
          isDriven={activeThreadDriven}
          header={header}
          footer={<PendingPermissionFallback />}
          timelineRef={timelineRef}
          onAtEndChange={handleAtEndChange}
          onPersistedContentReady={acknowledgeOptimisticMessage}
          onRetrySend={retrySend}
        />
      </div>
      <ScrollToEndButton
        visible={endState.sessionId === activeSessionId && !endState.atEnd}
        onClick={() => timelineRef.current?.scrollToEnd()}
      />
    </ChatViewPanel>
  )
}

interface TimelineProps {
  sessionId: string | null
  messages: TimelineMessage[]
  scrollElement: HTMLDivElement | null
  isDriven: boolean
  header: ReactNode
  footer: ReactNode
  timelineRef: RefObject<TimelineHandle | null>
  onAtEndChange: (atEnd: boolean) => void
  onPersistedContentReady: (messageId: string) => void
  onRetrySend?: (commandId: string) => Promise<void>
}

function ConversationTimeline({
  isMessagesLoading,
  ...props
}: TimelineProps & { isMessagesLoading: boolean }) {
  const { sessionId, messages, header, footer } = props
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

  if (messages.length === 0) {
    return (
      <div className="mx-auto max-w-[48rem] px-4 pt-2 pb-44">
        {header}
        {isHydrating ? (
          <ChatLoadingSkeleton />
        ) : (
          <div className="text-muted-foreground/70 text-[13px] text-center mt-10">
            Send a message to start
          </div>
        )}
        {footer}
      </div>
    )
  }

  return (
    <>
      {isHydrating && (
        <div className="mx-auto max-w-[48rem] px-4 pt-2">
          {header}
          <ChatLoadingSkeleton />
          {footer}
        </div>
      )}
      {/* One list per session: each visit starts from that session's own
          remembered heights and position, never the previous session's. */}
      <MessageTimeline
        key={sessionId ?? ''}
        {...props}
        header={isHydrating ? null : header}
        footer={isHydrating ? null : footer}
        hidden={isHydrating}
        onHydrated={handleHydrated}
      />
    </>
  )
}

function MessageTimeline({
  sessionId,
  messages,
  scrollElement,
  isDriven,
  header,
  footer,
  timelineRef,
  onAtEndChange,
  hidden,
  onHydrated,
  onPersistedContentReady,
  onRetrySend,
}: TimelineProps & { hidden: boolean; onHydrated: () => void }) {
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
  // Read once: this list instance is one visit to one session.
  const [remembered] = useState(() => (sessionId ? recallTimelinePosition(sessionId) : undefined))
  const [initialMeasurements] = useState(() =>
    remembered ? measurementsFromRememberedHeights(remembered.rowHeights) : undefined,
  )
  const [setHeaderElement, headerHeight] = useElementHeight()
  const [setFooterElement, footerHeight] = useElementHeight()
  const paddingStart = LIST_PADDING_TOP_PX + (headerHeight ?? 0)
  const paddingEnd = (footerHeight ?? 0) + COMPOSER_CLEARANCE_PX

  const firstPinnedIndex = useMemo(() => {
    const firstTailIndex = Math.max(messages.length - PINNED_TAIL_ROWS, 0)
    const firstLiveIndex = messages.findIndex(
      (message) =>
        message.isOptimistic || (message.role === 'assistant' && message.isFinal !== true),
    )
    if (firstLiveIndex < 0) return firstTailIndex
    return Math.min(firstLiveIndex, firstTailIndex)
  }, [messages])
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range))
      for (let index = firstPinnedIndex; index < range.count; index += 1) indexes.add(index)
      return [...indexes].sort((a, b) => a - b)
    },
    [firstPinnedIndex],
  )

  // Last measured height at each position. A row whose id changes in place (a
  // sent message confirmed, a streaming reply given its final id) is new to
  // the virtualizer; starting it from the flat estimate would jump the layout
  // and knock a reader off the bottom mid-reply. Its predecessor's height is
  // the right starting point.
  const heightByIndexRef = useRef(new Map<number, number>())
  // Positions only mean "the same row" while nothing is inserted above. When
  // an older page is prepended every index shifts, so forget them before the
  // virtualizer lays the new rows out; they fall back to the flat estimate.
  // A prepend is told apart from the first row's own id changing in place (a
  // new session's first message confirmed) by the old first row reappearing
  // further down; an in-place swap keeps its predecessor's height.
  const firstMessageId = messages[0]?.externalId
  const indexedFromMessageIdRef = useRef(firstMessageId)
  if (indexedFromMessageIdRef.current !== firstMessageId) {
    const previousFirstId = indexedFromMessageIdRef.current
    indexedFromMessageIdRef.current = firstMessageId
    const prepended =
      previousFirstId !== undefined &&
      messages.some((message, index) => index > 0 && message.externalId === previousFirstId)
    if (prepended) heightByIndexRef.current.clear()
  }
  const getItemKey = useCallback(
    (index: number) => messages[index]?.externalId ?? index,
    [messages],
  )
  const atEndRef = useRef(true)
  const listRef = useRef<HTMLDivElement>(null)
  const hiddenRef = useRef(hidden)
  const lastTotalSizeRef = useRef<number | null>(null)
  const positionedRef = useRef(false)
  const previousPaddingStartRef = useRef(paddingStart)
  const reportAtEnd = (atEnd: boolean) => {
    atEndRef.current = atEnd
    onAtEndChange(atEnd)
  }
  const reportAtEndRef = useRef(reportAtEnd)
  useLayoutEffect(() => {
    reportAtEndRef.current = reportAtEnd
  })
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollElement,
    getItemKey,
    estimateSize: (index) => heightByIndexRef.current.get(index) ?? ESTIMATED_ROW_HEIGHT_PX,
    measureElement: (element, entry, instance) => {
      const height = measureRowElement(element, entry, instance)
      heightByIndexRef.current.set(Number(element.getAttribute('data-index')), height)
      return height
    },
    overscan: 8,
    gap: ROW_GAP_PX,
    paddingStart,
    paddingEnd,
    rangeExtractor,
    // Chat semantics: rows added or removed at either edge leave the rows on
    // screen where they are, and at the bottom, new and growing rows keep the
    // view pinned there.
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: END_THRESHOLD_PX,
    // Attaching to the scroller otherwise jumps to offset 0 (the top).
    initialOffset: () => scrollElement?.scrollTop ?? 0,
    initialMeasurementsCache: initialMeasurements,
    onChange: (instance) => {
      // A row just resized. When the reader was at the bottom the virtualizer
      // has already moved its offset to follow, so "at the end" below is
      // judged after the follow. But React applies the list's new height a
      // render later, and until then the bottom padding is missing from the
      // page, so the real scroll lands short and a frame paints off the
      // bottom. Apply the height now and finish the follow before paint.
      const totalSize = instance.getTotalSize()
      const resized = lastTotalSizeRef.current !== null && lastTotalSizeRef.current !== totalSize
      lastTotalSizeRef.current = totalSize
      const atEnd = isVirtualizerAtEnd(instance)
      if (resized && !hiddenRef.current && listRef.current) {
        listRef.current.style.height = `${totalSize}px`
        if (atEnd && positionedRef.current && scrollElement) {
          scrollElement.scrollTop = scrollElement.scrollHeight - scrollElement.clientHeight
        }
      }
      reportAtEnd(atEnd)
    },
  })
  // Set on the instance (it is not an option); an idempotent assignment.
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldCompensateResize
  const visibleRows = rowVirtualizer.getVirtualItems()
  // Until the scroller has been measured the virtualizer reports no range at
  // all, and never consults rangeExtractor. The pinned rows still belong on
  // screen: they are what the loading gate waits for.
  // (Index into the cache one row at a time: it is a lazy view that
  // materializes rows on indexed reads, and array methods skip unread rows.)
  const virtualRows =
    visibleRows.length > 0
      ? visibleRows
      : Array.from(
          { length: Math.max(messages.length - firstPinnedIndex, 0) },
          (_, offset) => rowVirtualizer.measurementsCache[firstPinnedIndex + offset],
        ).filter((row): row is VirtualItem => row !== undefined)
  const totalSize = rowVirtualizer.getTotalSize()

  useLayoutEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  // The virtualizer only notifies when a scroll crosses a row or starts or
  // stops, so a small scroll would leave the button (and atEndRef) stale.
  useEffect(() => {
    if (!scrollElement) return
    const update = () => {
      if (positionedRef.current) reportAtEndRef.current(isVirtualizerAtEnd(rowVirtualizer))
    }
    scrollElement.addEventListener('scroll', update, { passive: true })
    return () => scrollElement.removeEventListener('scroll', update)
  }, [rowVirtualizer, scrollElement])

  // Place the reader once the rows can be shown: back where they left this
  // session, or at the bottom on a first visit (or if they left it there).
  useLayoutEffect(() => {
    if (hidden || positionedRef.current || !scrollElement || headerHeight === undefined) return
    positionedRef.current = true
    // Positions below already include the current header; the header
    // compensation must not shift them again.
    previousPaddingStartRef.current = paddingStart
    const anchorIndex =
      remembered && !remembered.atEnd
        ? messages.findIndex((message) => message.externalId === remembered.anchorKey)
        : -1
    const anchor = anchorIndex >= 0 ? rowVirtualizer.measurementsCache[anchorIndex] : undefined
    if (anchor && remembered) {
      atEndRef.current = false
      rowVirtualizer.scrollToOffset(anchor.start + remembered.offsetWithinAnchor)
    } else {
      atEndRef.current = true
      rowVirtualizer.scrollToEnd()
    }
  }, [headerHeight, hidden, messages, paddingStart, remembered, rowVirtualizer, scrollElement])

  // Remember where the reader leaves this session.
  useLayoutEffect(() => {
    return () => {
      // Never placed (still loading): keep whatever was remembered before.
      if (!positionedRef.current) return
      // StrictMode replays effects on the same instance; the replay re-places.
      positionedRef.current = false
      if (!sessionId) return
      const offset = rowVirtualizer.scrollOffset ?? 0
      const atEnd = isVirtualizerAtEnd(rowVirtualizer)
      const anchor = atEnd ? undefined : rowVirtualizer.getVirtualItemForOffset(offset)
      rememberTimelinePosition(sessionId, {
        atEnd,
        anchorKey: anchor ? String(anchor.key) : undefined,
        offsetWithinAnchor: anchor ? offset - anchor.start : 0,
        rowHeights: new Map(
          [...rowVirtualizer.itemSizeCache].map(([key, size]) => [String(key), size]),
        ),
      })
    }
  }, [rowVirtualizer, sessionId])

  // Sending is a request to watch the conversation continue, wherever the
  // reader was. (At the bottom, followOnAppend already does this.)
  const lastMessage = messages[messages.length - 1]
  const lastMessageIdRef = useRef(lastMessage?.externalId)
  useLayoutEffect(() => {
    if (lastMessage?.externalId === lastMessageIdRef.current) return
    lastMessageIdRef.current = lastMessage?.externalId
    if (positionedRef.current && lastMessage?.isOptimistic) rowVirtualizer.scrollToEnd()
  }, [lastMessage, rowVirtualizer])

  // The header sits above the first row. When it grows or shrinks (older
  // pages run out, a history error appears), move with it so rows stay put.
  useLayoutEffect(() => {
    const delta = paddingStart - previousPaddingStartRef.current
    previousPaddingStartRef.current = paddingStart
    if (delta !== 0 && positionedRef.current && scrollElement) scrollElement.scrollTop += delta
  }, [paddingStart, scrollElement])

  // The footer (a pending permission) sits below the last row. A reader at the
  // bottom should see it arrive.
  const previousPaddingEndRef = useRef(paddingEnd)
  useLayoutEffect(() => {
    const growth = paddingEnd - previousPaddingEndRef.current
    if (growth === 0) return
    previousPaddingEndRef.current = paddingEnd
    const wasAtEnd = isVirtualizerAtEnd(rowVirtualizer, Math.max(growth, 0))
    if (positionedRef.current && wasAtEnd) rowVirtualizer.scrollToEnd()
  }, [paddingEnd, rowVirtualizer])

  // The scroll-to-latest button. The browser's smooth scroll rather than the
  // virtualizer's: the virtualizer keeps re-aiming at a streaming bottom for
  // up to 5s and overrides a reader who scrolls away meanwhile, while the
  // browser's stops the moment the reader takes over. The bottom moves while
  // it animates, so on arrival hop onto the true bottom to resume following.
  useLayoutEffect(() => {
    if (!scrollElement) return
    let cancelPending: (() => void) | undefined
    timelineRef.current = {
      scrollToEnd: () => {
        cancelPending?.()
        const land = () => {
          cancelPending?.()
          rowVirtualizer.scrollToEnd()
        }
        const fallback = window.setTimeout(land, SMOOTH_SCROLL_FALLBACK_MS)
        cancelPending = () => {
          window.clearTimeout(fallback)
          scrollElement.removeEventListener('scrollend', land)
          for (const type of READER_SCROLL_INPUTS) {
            scrollElement.removeEventListener(type, cancelPending!)
          }
          cancelPending = undefined
        }
        scrollElement.addEventListener('scrollend', land)
        for (const type of READER_SCROLL_INPUTS) {
          scrollElement.addEventListener(type, cancelPending, { passive: true })
        }
        scrollElement.scrollTo({
          top: scrollElement.scrollHeight - scrollElement.clientHeight,
          behavior: 'smooth',
        })
      },
    }
    return () => {
      cancelPending?.()
      timelineRef.current = null
    }
  }, [rowVirtualizer, scrollElement, timelineRef])

  const hydrationTargetIds = useMemo(
    () => messages.slice(firstPinnedIndex).map((message) => message.externalId),
    [firstPinnedIndex, messages],
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
    <div
      className={cn(
        'mx-auto max-w-[48rem] px-4',
        hidden && 'pointer-events-none invisible h-0 overflow-hidden',
      )}
    >
      <div ref={listRef} className="relative min-w-0" style={{ height: hidden ? 0 : totalSize }}>
        <div
          ref={setHeaderElement}
          className="absolute inset-x-0"
          style={{ top: LIST_PADDING_TOP_PX }}
        >
          {header}
        </div>
        {virtualRows.map((virtualRow: VirtualItem) => {
          const message = messages[virtualRow.index]
          if (!message) return null
          return (
            <div
              key={`row:${message.externalId}`}
              ref={rowVirtualizer.measureElement}
              data-index={virtualRow.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <MessageRow
                message={message}
                isDriven={isDriven}
                onReady={handleMessageReady}
                onPersistedContentReady={onPersistedContentReady}
                onRetrySend={onRetrySend}
                animate={!initialMessageIdsRef.current.has(message.externalId)}
              />
            </div>
          )
        })}
        <div
          ref={setFooterElement}
          className="absolute inset-x-0"
          style={{ top: totalSize - paddingEnd }}
        >
          {footer}
        </div>
      </div>
    </div>
  )
}

/**
 * When a row changes height, whether to shift the scroll by the change so the
 * content on screen stays still. The virtualizer's default does so whenever
 * the row *starts* above the viewport, which drags a reader who has scrolled
 * up inside a long reply along with its streaming growth: the reply starts
 * above them but grows below them. Only a row wholly above the viewport moves
 * what the reader sees. (A reader at the bottom is followed separately.)
 * Re-measurements are skipped while scrolling up, as the default does, so rows
 * settling above do not fight the reader's scroll.
 */
function shouldCompensateResize(
  item: VirtualItem,
  _delta: number,
  instance: Pick<
    Virtualizer<HTMLDivElement, Element>,
    'scrollOffset' | 'itemSizeCache' | 'scrollDirection'
  >,
): boolean {
  const whollyAbove = item.end <= (instance.scrollOffset ?? 0)
  const firstMeasurement = !instance.itemSizeCache.has(item.key)
  return whollyAbove && (firstMeasurement || instance.scrollDirection !== 'backward')
}

/**
 * Whether the reader is at the bottom by the virtualizer's own numbers, which
 * already include a follow it just applied. `slack` widens the check (to ask
 * whether the reader was at the bottom before something below grew).
 */
function isVirtualizerAtEnd(
  instance: Pick<
    Virtualizer<HTMLDivElement, Element>,
    'getTotalSize' | 'scrollRect' | 'scrollOffset'
  >,
  slack = 0,
): boolean {
  const viewport = instance.scrollRect?.height ?? 0
  const distance = instance.getTotalSize() - viewport - (instance.scrollOffset ?? 0)
  return distance <= END_THRESHOLD_PX + slack
}

/**
 * Height of an element, measured before paint and kept current. `undefined`
 * until the element has mounted and been measured once.
 */
function useElementHeight(): [(element: HTMLDivElement | null) => void, number | undefined] {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    if (!element) return
    setHeight(element.offsetHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, height]
}

function MessageRow({
  message,
  isDriven,
  onReady,
  onPersistedContentReady,
  onRetrySend,
  animate,
}: {
  message: TimelineMessage
  isDriven: boolean
  onReady: (messageId: string) => void
  onPersistedContentReady: (messageId: string) => void
  onRetrySend?: (commandId: string) => Promise<void>
  animate: boolean
}) {
  // Resolved here rather than inside the memoized row: a row that reads the
  // active-thread context re-renders on every streamed token.
  const { commandId, sendError } = message
  const retry = useCallback(() => {
    if (commandId && onRetrySend) void onRetrySend(commandId)
  }, [commandId, onRetrySend])
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
        onRetry={sendError && commandId && onRetrySend ? retry : undefined}
        isDriven={isDriven}
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
  onRetry?: () => void
  isDriven: boolean
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
        onRetry={props.onRetry}
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
