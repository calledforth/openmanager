import { ArrowClockwiseIcon, ArrowDownIcon, CaretLeftIcon, EyeIcon } from 'phosphor-react-native'
import { useCallback, useRef, useState } from 'react'
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { UIMessage } from '@openmanager/app-core/logic'

import { ResolvedMessage } from '../components/chat/ResolvedMessage'
import { ShimmerText } from '../components/chat/ShimmerText'
import { AppText } from '../components/ui/AppText'
import type { StatusMark as Mark } from '../home/rows'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { FadeOut } from '../ui/chrome'
import { Glass } from '../ui/Glass'
import { useGoBack } from '../ui/goBack'
import { IconButton } from '../ui/IconButton'
import { ProjectChip } from '../ui/ProjectChip'
import { StatusMark } from '../ui/StatusMark'
import type { ReadOnlySessionPhase } from './useReadOnlySession'

/** Within this of the end, the list follows new content; scrolled further up, it stays put. */
const FOLLOW_THRESHOLD_PX = 96
const BAR_HEIGHT = 48

const keyOf = (message: UIMessage) => message.rowKey ?? message.externalId

export interface SessionThreadProps {
  title: string
  project?: string
  /** The status mark and line, as the home shows them; none at rest. */
  mark?: Mark
  statusLine?: string | null
  messages: UIMessage[]
  phase: ReadOnlySessionPhase
  failure?: string | null
  onRetry?: () => void
}

/**
 * A session's page, read-only: back, title and project, the status line,
 * then the transcript, kept at its end while it streams unless the reader
 * scrolled up (a glass button brings them back). No composer yet: a glass bar
 * at the bottom says replies happen elsewhere for now.
 */
export function SessionThread({
  title,
  project,
  mark,
  statusLine,
  messages,
  phase,
  failure,
  onRetry,
}: SessionThreadProps) {
  const goBack = useGoBack()
  const insets = useSafeAreaInsets()
  const theme = usePhoneTheme()
  const listRef = useRef<FlatList<UIMessage>>(null)
  const followRef = useRef(true)
  const lastOffsetRef = useRef(0)
  const [atEnd, setAtEnd] = useState(true)

  const follow = useCallback(() => {
    if (followRef.current) listRef.current?.scrollToEnd({ animated: false })
  }, [])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const fromEnd = contentSize.height - layoutMeasurement.height - contentOffset.y
    const scrolledUp = contentOffset.y < lastOffsetRef.current - 1
    lastOffsetRef.current = contentOffset.y
    if (fromEnd <= FOLLOW_THRESHOLD_PX) followRef.current = true
    else if (scrolledUp) followRef.current = false
    setAtEnd(fromEnd <= FOLLOW_THRESHOLD_PX)
  }, [])

  const toLatest = useCallback(() => {
    followRef.current = true
    listRef.current?.scrollToEnd({ animated: true })
  }, [])

  const renderItem = useCallback(
    ({ item }: { item: UIMessage }) => <ResolvedMessage message={item} onStreamUpdate={follow} />,
    [follow],
  )

  const barBottom = Math.max(insets.bottom, 12) + 8
  const listBottom = barBottom + BAR_HEIGHT + 16

  return (
    <View className="flex-1" style={{ paddingTop: insets.top + 6 }}>
      <View className="flex-row items-center px-5" style={{ height: 48 }}>
        <IconButton label="Back" onPress={goBack}>
          <CaretLeftIcon size={18} color={theme.fg} />
        </IconButton>
      </View>
      <View className="px-5 pb-2 pt-0.5">
        {project ? <ProjectChip name={project} /> : null}
        <AppText
          variant="text-20-medium"
          numberOfLines={2}
          style={{ color: theme.fg, marginTop: 4, letterSpacing: -0.3 }}
        >
          {title}
        </AppText>
        {mark && statusLine ? (
          <View className="mt-1.5 flex-row items-center gap-2">
            <StatusMark mark={mark} size={12} />
            <AppText variant="text-13-regular" style={{ color: theme.muted }}>
              {statusLine}
            </AppText>
          </View>
        ) : null}
      </View>

      <View className="flex-1">
        {messages.length === 0 ? (
          <View className="flex-1 items-center justify-center gap-3 px-10">
            {phase === 'opening' ? (
              <ShimmerText variant="text-14-regular">Opening…</ShimmerText>
            ) : (
              <AppText
                variant="text-14-regular"
                style={{ color: theme.muted, textAlign: 'center' }}
              >
                {phase === 'gone'
                  ? 'This session is gone from your environment.'
                  : phase === 'failed'
                    ? (failure ?? 'Could not open this session.')
                    : 'No messages yet.'}
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
            data={messages}
            keyExtractor={keyOf}
            renderItem={renderItem}
            onScroll={onScroll}
            scrollEventThrottle={32}
            onContentSizeChange={follow}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 4,
              paddingBottom: listBottom,
            }}
            showsVerticalScrollIndicator={false}
          />
        )}

        <FadeOut height={barBottom + BAR_HEIGHT + 40} />

        {!atEnd && messages.length > 0 ? (
          <View
            pointerEvents="box-none"
            style={{
              position: 'absolute',
              right: 20,
              bottom: barBottom + BAR_HEIGHT + 12,
            }}
          >
            <IconButton label="Scroll to latest" onPress={toLatest}>
              <ArrowDownIcon size={18} color={theme.fg} />
            </IconButton>
          </View>
        ) : null}

        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', left: 16, right: 16, bottom: barBottom }}
        >
          <Glass
            shadow="float"
            radius={BAR_HEIGHT / 2}
            contentStyle={{
              height: BAR_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingHorizontal: 18,
            }}
          >
            <EyeIcon size={16} color={theme.muted} />
            <AppText
              variant="text-13-regular"
              numberOfLines={1}
              style={{ color: theme.muted, flex: 1 }}
            >
              Read-only on the phone for now
            </AppText>
          </Glass>
        </View>
      </View>
    </View>
  )
}
