import { LinearGradient } from 'expo-linear-gradient'
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  CaretLeftIcon,
  WarningCircleIcon,
} from 'phosphor-react-native'
import { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  FlatList,
  Text,
  View,
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
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { ProjectChip } from '../ui/ProjectChip'
import { ChildSessionCards } from './ChildSessionCards'
import { countRender } from './render-probe'
import { ReadOnlyBar, SessionDock } from './SessionDock'
import type { StatusLineView } from './status-line'
import type { ReadOnlySessionPhase } from './useReadOnlySession'

/**
 * Within this of the newest row, a change below the reader keeps them at the
 * end (the list's own follow); scrolled further up, nothing moves them.
 */
const FOLLOW_THRESHOLD_PX = 48
/** Scrolled this far from the end, the scroll-to-latest button shows. */
const AWAY_PX = 200
/** The dock's height before it has measured itself: the status line and a one-line slot. */
const DOCK_ESTIMATE = 96
const ROW_GAP_BOTTOM = 18

/**
 * The transcript keeps the reader where they are and follows the end on its
 * own. The list is inverted (its offset 0 is the newest row), so a reader at
 * the end stays there as the live row grows without any scroll call, and the
 * platform's visible-content anchoring (`maintainVisibleContentPosition`)
 * holds a reader who scrolled up in place while rows below them grow, settle
 * or arrive. The anchor is the first row past the reader's position, never
 * the live row they may be reading inside; a reader within the threshold of
 * the end is brought back to it.
 */
const MAINTAIN_POSITION = {
  minIndexForVisible: 0,
  autoscrollToTopThreshold: FOLLOW_THRESHOLD_PX,
} as const

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

/** Back, then the project and the title: the top kept as clear as it can be. */
const SessionHeader = memo(function SessionHeader({
  title,
  project,
  topInset,
}: {
  title: string
  project?: string
  topInset: number
}) {
  const goBack = useGoBack()
  const theme = usePhoneTheme()
  return (
    <View style={{ paddingTop: topInset + 6 }}>
      <View className="flex-row items-center px-5" style={{ height: 48 }}>
        <IconButton label="Back" onPress={goBack}>
          <CaretLeftIcon size={18} color={theme.fg} weight="bold" />
        </IconButton>
      </View>
      <View className="px-5" style={{ paddingTop: 2, paddingBottom: 10 }}>
        {project ? <ProjectChip name={project} /> : null}
        <Text
          accessibilityRole="header"
          numberOfLines={2}
          style={{
            fontFamily: 'Geist-SemiBold',
            fontSize: 22,
            lineHeight: 26.5,
            letterSpacing: -0.33,
            color: theme.fg,
            marginTop: 4,
          }}
        >
          {title}
        </Text>
      </View>
    </View>
  )
})

export interface SessionThreadProps {
  title: string
  project?: string
  /** The line above the dock; none at rest. */
  status: StatusLineView | null
  messages: UIMessage[]
  phase: ReadOnlySessionPhase
  failure?: string | null
  onRetry?: () => void
  /** The sessions it delegated to, as cards at the end of its transcript. */
  childSessions?: readonly HomeSession[]
}

const NO_CHILDREN: readonly HomeSession[] = []

/**
 * A session's page: back, project and title; the transcript, newest at the
 * bottom, running under the glass dock with a soft fade; the dock with the
 * status line and the slot the composer will take (the read-only bar until
 * then). The reader's place is theirs: the list follows the end only while
 * they are at it, and a glass button brings them back when they scroll up.
 */
export const SessionThread = memo(function SessionThread({
  title,
  project,
  status,
  messages,
  phase,
  failure,
  onRetry,
  childSessions = NO_CHILDREN,
}: SessionThreadProps) {
  countRender('SessionThread')
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const listRef = useRef<FlatList<UIMessage>>(null)
  const [away] = useState(createFlag)
  const [dockHeight, setDockHeight] = useState(DOCK_ESTIMATE)

  // Newest first: the inverted list's offset 0 is the end of the transcript.
  const rows = useMemo(() => [...messages].reverse(), [messages])

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      away.set(event.nativeEvent.contentOffset.y > AWAY_PX)
    },
    [away],
  )
  const toLatest = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [])
  const onDockHeight = useCallback((height: number) => {
    setDockHeight((previous) => (Math.abs(previous - height) < 1 ? previous : Math.round(height)))
  }, [])

  // Inverted, the content's top padding is the room under the newest row.
  const contentStyle = useMemo(
    () => ({ paddingHorizontal: 20, paddingTop: dockHeight + ROW_GAP_BOTTOM, paddingBottom: 8 }),
    [dockHeight],
  )
  const footer = useMemo(
    () => (childSessions.length > 0 ? <ChildSessionCards sessions={childSessions} /> : null),
    [childSessions],
  )

  const problem = problemOf(phase, failure)
  const bottomInset = Math.max(insets.bottom, 12) + 8

  return (
    <View className="flex-1">
      <SessionHeader title={title} project={project} topInset={insets.top} />

      <View className="flex-1">
        {messages.length === 0 ? (
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
              <IconButton label="Try again" onPress={onRetry}>
                <ArrowClockwiseIcon size={18} color={theme.fg} />
              </IconButton>
            ) : null}
          </View>
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={rows}
            keyExtractor={keyOf}
            renderItem={renderRow}
            ListHeaderComponent={footer}
            maintainVisibleContentPosition={MAINTAIN_POSITION}
            onScroll={onScroll}
            scrollEventThrottle={32}
            contentContainerStyle={contentStyle}
            initialNumToRender={8}
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
          style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 14 }}
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
                <IconButton label="Try again" size={32} onPress={onRetry}>
                  <ArrowClockwiseIcon size={16} color={theme.fg} />
                </IconButton>
              ) : null}
            </View>
          </View>
        ) : null}

        {messages.length > 0 && !problem ? (
          <ScrollToLatest away={away} bottom={dockHeight + 12} onPress={toLatest} />
        ) : null}

        <SessionDock status={status} bottomInset={bottomInset} onHeight={onDockHeight}>
          <ReadOnlyBar />
        </SessionDock>
      </View>
    </View>
  )
})
