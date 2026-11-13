import { ArrowUpIcon, ClockIcon, WarningCircleIcon } from 'phosphor-react-native'
import { memo, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import type { ArtifactSource, MessagePart, OptimisticImage } from '@openmanager/app-core/logic'

import { MessageLongPress } from '../../session/message-actions'
import { useSendSteerNow } from '../../session/steer-now'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { tap } from '../../ui/haptics'
import { Press } from '../../ui/Press'
import { ImageGroup, useTranscriptWidth, type GalleryImage } from '../parts/ImageGroup'
import { AppText } from '../ui/AppText'

/** The images a prompt carries: its own parts once confirmed, its echo's before. */
function imagesOf(
  parts: readonly MessagePart[],
  attachments: readonly OptimisticImage[],
): GalleryImage[] {
  const fromParts = parts
    .filter((part) => part.type === 'image')
    .map((part) => ({
      id: part.id,
      url: typeof part.url === 'string' ? part.url : undefined,
      artifact: part.artifact as ArtifactSource | undefined,
      name: typeof part.name === 'string' ? part.name : undefined,
    }))
  if (fromParts.length > 0) return fromParts
  return attachments.map((image) => ({
    id: image.id,
    url: image.previewUrl,
    artifact: image.artifact,
    name: image.name,
  }))
}

/** The bubble's share of the row (`max-w-[86%]`), which its images keep to. */
const BUBBLE_SHARE = 0.86

/** How dim a steered message stands until the agent reads it. */
const STEER_DIM = 0.55
const BRIGHTEN = { duration: 200, easing: Easing.out(Easing.quad) }
/** After a beat, so a steer the agent takes at once reads as a plain send. */
const STATUS_IN = FadeIn.delay(400).duration(180).easing(Easing.out(Easing.quad))

/**
 * Under a steered message the agent has not read yet: what it waits for, and
 * Send now, which stops the agent's step and runs it next. Fades in after a
 * beat, on the UI thread; gone once the message arrives.
 */
function SteerStatus({ steer, queueItemId }: { steer: 'waiting' | 'next'; queueItemId?: string }) {
  const theme = usePhoneTheme()
  const sendNow = useSendSteerNow()
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const canSend = steer === 'waiting' && !!sendNow && !!queueItemId
  const press = () => {
    if (!canSend || sending) return
    tap()
    setFailure(null)
    setSending(true)
    sendNow!(queueItemId!).catch((error: unknown) => {
      setFailure(error instanceof Error && error.message ? error.message : 'Couldn’t send it now')
      setSending(false)
    })
  }
  const label = steer === 'waiting' ? 'Waiting for the current step' : 'Sending next'
  return (
    <Animated.View entering={STATUS_IN} style={{ alignItems: 'flex-end', gap: 2 }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 }}
        accessibilityLiveRegion="polite"
      >
        <ActivityIndicator
          size="small"
          color={theme.faint}
          style={{ transform: [{ scale: 0.7 }], width: 16, height: 16 }}
        />
        <AppText variant="text-12-regular" style={{ color: theme.muted }}>
          {label}
        </AppText>
        {canSend ? (
          <Press
            accessibilityRole="button"
            accessibilityLabel="Send now"
            accessibilityHint="Stops the current step and sends this message now"
            accessibilityState={{ busy: sending, disabled: sending }}
            disabled={sending}
            hitSlop={6}
            onPress={press}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              height: 26,
              paddingHorizontal: 10,
              borderRadius: 13,
              backgroundColor: pressed ? theme.active : theme.hover,
              opacity: sending ? 0.6 : 1,
            })}
          >
            {sending ? (
              <ActivityIndicator
                size="small"
                color={theme.fg}
                style={{ transform: [{ scale: 0.6 }], width: 12, height: 12 }}
              />
            ) : (
              <ArrowUpIcon size={12} color={theme.fg} weight="bold" />
            )}
            <AppText variant="text-12-medium" style={{ color: theme.fg }}>
              Send now
            </AppText>
          </Press>
        ) : null}
      </View>
      {failure ? (
        <AppText variant="text-11-regular" style={{ color: theme.status.error }}>
          {failure}
        </AppText>
      ) : null}
    </Animated.View>
  )
}

/**
 * The bubble's strength: dim while a steered message waits, eased up to full
 * when it arrives (the same row, now the message). Driven by that change
 * alone, on the UI thread; a row that mounts as either state starts there.
 */
function useSteerDim(steer: 'waiting' | 'next' | undefined) {
  const opacity = useSharedValue(steer ? STEER_DIM : 1)
  useEffect(() => {
    opacity.value = withTiming(steer ? STEER_DIM : 1, BRIGHTEN)
  }, [opacity, steer])
  return useAnimatedStyle(() => ({ opacity: opacity.value }))
}

/**
 * Right-aligned user bubble on web's chat-user fill (a sent message reads by
 * colour, no outline), with its images above it as one group. An echo the
 * environment has not confirmed is dimmed with a clock; one it refused says
 * why.
 */
export const UserMessage = memo(function UserMessage({
  content,
  parts = [],
  attachments = [],
  isQueued,
  steer,
  queueItemId,
  sendError,
}: {
  content: string
  parts?: readonly MessagePart[]
  attachments?: readonly OptimisticImage[]
  isQueued?: boolean
  /** A steered message the agent has not read yet; see `ThreadRowView.steer`. */
  steer?: 'waiting' | 'next'
  queueItemId?: string
  sendError?: string
}) {
  const theme = usePhoneTheme()
  const images = useMemo(() => imagesOf(parts, attachments), [attachments, parts])
  const width = Math.round(useTranscriptWidth() * BUBBLE_SHARE)
  const dim = useSteerDim(steer)

  return (
    <View className="w-full items-end gap-1.5">
      <Animated.View style={[{ width: '100%', alignItems: 'flex-end', gap: 6 }, dim]}>
        {images.length > 0 ? <ImageGroup images={images} width={width} align="end" /> : null}
        {content ? (
          // Held, the message's actions: copy it, or select from it.
          <MessageLongPress
            style={{
              maxWidth: '86%',
              backgroundColor: theme.bubble,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              borderBottomLeftRadius: 18,
              borderBottomRightRadius: 4,
              paddingHorizontal: 14,
              paddingVertical: 10,
              ...(isQueued && !sendError ? { opacity: 0.6 } : null),
            }}
          >
            <AppText variant="chat-user" style={{ color: theme.fg, fontSize: 15, lineHeight: 22 }}>
              {content}
            </AppText>
            {isQueued && !sendError ? (
              <View className="mt-1 flex-row items-center justify-end gap-1">
                <ClockIcon size={11} color={theme.faint} />
                <AppText variant="text-11-regular" style={{ color: theme.faint }}>
                  queued
                </AppText>
              </View>
            ) : null}
          </MessageLongPress>
        ) : null}
      </Animated.View>
      {steer ? <SteerStatus steer={steer} queueItemId={queueItemId} /> : null}
      {sendError ? (
        <View className="max-w-[86%] flex-row items-center gap-1">
          <WarningCircleIcon size={12} color={theme.status.error} />
          <AppText variant="text-11-regular" style={{ color: theme.status.error }}>
            {sendError}
          </AppText>
        </View>
      ) : null}
    </View>
  )
})
