import { LinearGradient } from 'expo-linear-gradient'
import { ArrowClockwiseIcon, ArrowDownIcon, WarningCircleIcon } from 'phosphor-react-native'
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  View,
  type LayoutChangeEvent,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import Animated, { Easing, FadeIn, FadeOut } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { withAlpha } from '@openmanager/app-core/lib/theme-tokens'
import type { UIMessage } from '@openmanager/app-core/logic'

import { ResolvedMessage } from '../components/chat/ResolvedMessage'
import { ShimmerText } from '../components/chat/ShimmerText'
import { AppText } from '../components/ui/AppText'
import type { HomeSession } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { FadeOut as BottomFade } from '../ui/chrome'
import { coveredBySheet } from '../ui/a11y-focus'
import { GlassContent } from '../ui/Glass'
import { IconButton } from '../ui/IconButton'
import { Screen } from '../ui/Screen'
import { ChildSessionCards } from './ChildSessionCards'
import { countRender } from './render-probe'
import { createScrollFollower, flingsUp, INITIAL_ROWS, MAINTAIN_POSITION } from './scroll-anchor'
import { DockSlotContext, ReadOnlyBar, SessionDock, type DockSlot } from './SessionDock'
import { HEADER_ROW, SessionHeader, SessionHeaderBar } from './SessionHeader'
import { SessionMenu } from './SessionMenu'
import type { StatusLineView } from './status-line'
import type { ReadOnlySessionPhase } from './useReadOnlySession'
import type { SessionActions } from './useSessionActions'
import { useOpeningIndex } from './useOpeningIndex'
import { useSessionChrome } from './useSessionChrome'

/** The dock's height before it has measured itself: the status line and a one-line slot. */
const DOCK_ESTIMATE = 96
const ROW_GAP_BOTTOM = 18

/**
 * The scroll view's own scroll to the end, which lands on the content's true
 * end (the room left for the dock included). The list's `scrollToEnd` adds
 * up its cells' estimated sizes and leaves the bottom padding out.
 */
function nativeScrollToEnd(list: FlatList<UIMessage> | null, animated: boolean) {
  const scroller = list?.getScrollResponder() as unknown as {
    scrollToEnd?: (options: { animated: boolean }) => void
  } | null
  scroller?.scrollToEnd?.({ animated })
}

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>

const metricsOf = ({ nativeEvent }: ScrollEvent) => ({
  offset: nativeEvent.contentOffset.y,
  contentHeight: nativeEvent.contentSize.height,
  viewportHeight: nativeEvent.layoutMeasurement.height,
})

const keyOf = (message: UIMessage) => message.rowKey ?? message.externalId
const renderRow: ListRenderItem<UIMessage> = ({ item }) => <ResolvedMessage message={item} />

/** What the page says when the transcript cannot be kept current; null when it is. */
function problemOf(phase: ReadOnlySessionPhase, failure: string | null | undefined) {
  switch (phase) {
    case 'gone':
      return 'This session is gone from your environment.'
    case 'unsupported':
      return 'This environment is older than the phone: update it to open its sessions here.'
    case 'failed':
      return failure ?? 'Could not open this session.'
    default:
      return null
  }
}

/** A flag the scroll handler sets and one small view reads, so a scroll re-renders nothing else. */
function createFlag() {
  let value = false
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: boolean) {
      if (next === value) return
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
type Flag = ReturnType<typeof createFlag>

const BUTTON_IN = FadeIn.duration(180).easing(Easing.out(Easing.quad))
const BUTTON_OUT = FadeOut.duration(150).easing(Easing.in(Easing.quad))

/** The glass button that brings a reader who scrolled up back to the newest row. */
function ScrollToLatest({
  away,
  bottom,
  onPress,
}: {
  away: Flag
  bottom: number
  onPress: () => void
}) {
  const theme = usePhoneTheme()
  const shown = useSyncExternalStore(away.subscribe, away.get, away.get)
  if (!shown) return null
  return (
    <Animated.View
      entering={BUTTON_IN}
      exiting={BUTTON_OUT}
      pointerEvents="box-none"
      style={{ position: 'absolute', right: 20, bottom }}
    >
      <IconButton label="Scroll to latest" onPress={onPress}>
        <ArrowDownIcon size={16} color={theme.fg} weight="bold" />
      </IconButton>
    </Animated.View>
  )
}

export interface SessionThreadProps {
  title: string
  project?: string
  /** The project's path, for its declared icon. */
  projectId?: string | null
  /** Above the status line in the dock: the session's background work. */
  above?: ReactNode
  /** The line above the dock; none at rest. */
  status: StatusLineView | null
  messages: UIMessage[]
  phase: ReadOnlySessionPhase
  failure?: string | null
  onRetry?: () => void
  /** The sessions it delegated to, as cards at the end of its transcript. */
  childSessions?: readonly HomeSession[]
  /** What the ⋯ menu and the title can ask the environment; null leaves the ⋯ out. */
  actions?: SessionActions | null
  /** What an empty, ready transcript shows: a new session's landing. */
  empty?: ReactNode
  /** A button in the header's corner where there is no ⋯ menu: a draft's Discard. */
  headerAction?: ReactNode
  /**
   * The composer: a layer over the whole page that draws the dock (through
   * `DockSlotContext`) and whatever it opens. Without one the dock holds the
   * read-only bar.
   */
  composer?: ReactNode
}

const NO_CHILDREN: readonly HomeSession[] = []

/**
 * A session's page: back, project and title; the transcript, newest at the
 * bottom, running under the glass dock with a soft fade; the dock with the
 * status line and the slot the composer will take (the read-only bar until
 * then). The reader's place is theirs: the list follows the end only while
 * they are at it, and a glass button brings them back when they scroll up.
 *
 * One `Screen`: the header's words and the transcript are its content, what
 * its glass blurs; the header's buttons, the jump-to-latest button, the dock,
 * the composer's layers and the ⋯ menu float beside it, over it.
 */
export const SessionThread = memo(function SessionThread({
  title,
  project,
  projectId = null,
  above = null,
  status,
  messages,
  phase,
  failure,
  onRetry,
  childSessions = NO_CHILDREN,
  actions = null,
  empty,
  headerAction,
  composer,
}: SessionThreadProps) {
  countRender('SessionThread')
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const listRef = useRef<FlatList<UIMessage>>(null)
  const [away] = useState(createFlag)
  const [dockHeight, setDockHeight] = useState(DOCK_ESTIMATE)
  const chrome = useSessionChrome(actions, title)

  // Follows the end while the reader is at it; see scroll-anchor.ts.
  const [follower] = useState(() =>
    createScrollFollower({
      scrollToEnd: (animated) => nativeScrollToEnd(listRef.current, animated),
      schedule: (run) => requestAnimationFrame(run),
      onAway: (next) => away.set(next),
    }),
  )
  // The page opens at its newest row: a long thread starts drawing there,
  // read when the transcript first has rows (the snapshot), not at mount.
  const initialIndex = useOpeningIndex(messages.length)

  const onScroll = useCallback(
    (event: ScrollEvent) => follower.onScroll(metricsOf(event)),
    [follower],
  )
  const onDragStart = useCallback(() => follower.onDragStart(), [follower])
  // The drag-end event's own place and speed: scroll events are throttled,
  // so the last one may not have seen how far the finger took the list.
  const onDragEnd = useCallback(
    (event: ScrollEvent) =>
      follower.onDragEnd(metricsOf(event), flingsUp(event.nativeEvent.velocity?.y, Platform.OS)),
    [follower],
  )
  const onMomentumEnd = useCallback(
    (event: ScrollEvent) => follower.onMomentumEnd(metricsOf(event)),
    [follower],
  )
  const onContentSize = useCallback(
    (_width: number, height: number) => follower.onContentHeight(height),
    [follower],
  )
  const onListLayout = useCallback(
    (event: LayoutChangeEvent) => follower.onViewportHeight(event.nativeEvent.layout.height),
    [follower],
  )
  const onIndexFailed = useCallback(() => nativeScrollToEnd(listRef.current, false), [])
  const toLatest = useCallback(() => follower.toLatest(), [follower])
  const onDockHeight = useCallback((height: number) => {
    setDockHeight((previous) => (Math.abs(previous - height) < 1 ? previous : Math.round(height)))
  }, [])

  // Top-aligned, as the mockup's transcript is; the end clears the dock.
  const contentStyle = useMemo(
    () => ({ paddingHorizontal: 20, paddingTop: 8, paddingBottom: dockHeight + ROW_GAP_BOTTOM }),
    [dockHeight],
  )
  const footer = useMemo(
    () => (childSessions.length > 0 ? <ChildSessionCards sessions={childSessions} /> : null),
    [childSessions],
  )

  const problem = problemOf(phase, failure)
  const bottomInset = Math.max(insets.bottom, 12) + 8
  // A composer sheet, popover, camera or the pulled-up editor over the page.
  const [covered, setCovered] = useState(false)
  const dockSlot = useMemo<DockSlot>(
    () => ({ status, above, bottomInset, onHeight: onDockHeight, onCovered: setCovered }),
    [above, bottomInset, onDockHeight, status],
  )

  return (
    // The page makes room for the keyboard itself, so the dock rises with it:
    // iOS never resizes the window, and an edge-to-edge Android window (the
    // only kind since Android 15) does not either. The avoider pads only by
    // how far the keyboard overlaps it, so a window that did resize gets no
    // second lift. The screen is the box inside that padding: the composer
    // layer and the menu, absolutely placed, fill it and not the padded
    // avoider, so they rise with the keyboard too.
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <Screen>
        {/* Hidden from a screen reader while a composer layer covers it, as under a sheet. */}
        <View style={{ flex: 1 }} {...coveredBySheet(covered)}>
          <SessionHeaderBar
            topInset={insets.top}
            onMenu={actions ? chrome.openMenu : undefined}
            action={headerAction}
          />
          <GlassContent>
            <SessionHeader
              title={title}
              project={project}
              projectId={projectId}
              topInset={insets.top}
              chrome={chrome}
            />

            <View className="flex-1">
              {messages.length === 0 && empty && !problem && phase === 'ready' ? (
                <View className="flex-1" style={{ paddingBottom: dockHeight }}>
                  {empty}
                </View>
              ) : messages.length === 0 ? (
                <View
                  className="flex-1 items-center justify-center gap-3 px-10"
                  style={{ paddingBottom: dockHeight }}
                >
                  {phase === 'opening' ? (
                    <ShimmerText variant="text-14-regular">Opening…</ShimmerText>
                  ) : (
                    <AppText
                      variant="text-14-regular"
                      style={{ color: theme.muted, textAlign: 'center' }}
                    >
                      {problem ?? 'No messages yet.'}
                    </AppText>
                  )}
                  {phase === 'failed' && onRetry ? (
                    <IconButton label="Try again" surface="fill" onPress={onRetry}>
                      <ArrowClockwiseIcon size={18} color={theme.fg} />
                    </IconButton>
                  ) : null}
                </View>
              ) : (
                <FlatList
                  ref={listRef}
                  data={messages}
                  keyExtractor={keyOf}
                  renderItem={renderRow}
                  ListFooterComponent={footer}
                  maintainVisibleContentPosition={MAINTAIN_POSITION}
                  initialScrollIndex={initialIndex}
                  onScrollToIndexFailed={onIndexFailed}
                  onScroll={onScroll}
                  onScrollBeginDrag={onDragStart}
                  onScrollEndDrag={onDragEnd}
                  onMomentumScrollEnd={onMomentumEnd}
                  onContentSizeChange={onContentSize}
                  onLayout={onListLayout}
                  scrollEventThrottle={32}
                  contentContainerStyle={contentStyle}
                  initialNumToRender={INITIAL_ROWS}
                  maxToRenderPerBatch={6}
                  updateCellsBatchingPeriod={40}
                  windowSize={9}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                />
              )}

              {/* The transcript's top edge eases under the header rather than cutting off. */}
              <LinearGradient
                pointerEvents="none"
                colors={[theme.bg, withAlpha(theme.bg, 0)]}
                style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 22 }}
              />
              <BottomFade height={dockHeight + 48} />

              {messages.length > 0 && problem ? (
                <View
                  pointerEvents="box-none"
                  style={{ position: 'absolute', left: 16, right: 16, bottom: dockHeight + 10 }}
                >
                  {/* What is on screen may be stale: said over the transcript, not hidden behind it. */}
                  <View
                    className="flex-row items-center gap-2.5 rounded-2xl px-4 py-2.5"
                    style={{ backgroundColor: theme.statusWash.error }}
                  >
                    <WarningCircleIcon size={16} color={theme.status.error} />
                    <AppText variant="text-13-regular" style={{ color: theme.fg, flex: 1 }}>
                      {problem}
                    </AppText>
                    {phase === 'failed' && onRetry ? (
                      <IconButton label="Try again" size={32} surface="fill" onPress={onRetry}>
                        <ArrowClockwiseIcon size={16} color={theme.fg} />
                      </IconButton>
                    ) : null}
                  </View>
                </View>
              ) : null}
            </View>
          </GlassContent>

          {/* The glass over the transcript's end: beside the content, so it blurs it. */}
          {messages.length > 0 && !problem ? (
            <ScrollToLatest away={away} bottom={dockHeight + 12} onPress={toLatest} />
          ) : null}

          {composer ? null : (
            <SessionDock
              status={status}
              above={above}
              bottomInset={bottomInset}
              onHeight={onDockHeight}
            >
              <ReadOnlyBar />
            </SessionDock>
          )}
        </View>

        {/* Over the whole page, header included: its sheets and pulled-up state cover it all. */}
        {composer ? (
          <DockSlotContext.Provider value={dockSlot}>{composer}</DockSlotContext.Provider>
        ) : null}

        {chrome.menuOpen ? (
          <SessionMenu
            items={chrome.menu}
            note={actions?.unavailable ?? null}
            top={insets.top + 6 + HEADER_ROW}
            onChoose={chrome.choose}
            onClose={chrome.closeMenu}
          />
        ) : null}
      </Screen>
    </KeyboardAvoidingView>
  )
})
