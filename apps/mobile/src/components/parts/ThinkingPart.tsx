import { memo, useRef, useState } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { Press } from '../../ui/Press'
import { ShimmerText } from '../chat/ShimmerText'
import { AppText } from '../ui/AppText'
import { DisclosureChevron, revealBody } from './Disclosure'

/** Sub-second thoughts read as noise, so the duration only joins the label above 1s. */
export function thoughtLabel(durationMs?: number): string {
  if (!durationMs || durationMs < 1000) return 'Thought'
  const totalSeconds = Math.round(durationMs / 1000)
  if (totalSeconds < 60) return `Thought for ${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds ? `Thought for ${minutes}m ${seconds}s` : `Thought for ${minutes}m`
}

/** Zero is a real reading but says nothing a reader can use, so it is left off
 * the label; the row itself still renders, which is the part that matters. */
function tokenLabel(tokens?: number): string {
  if (tokens === undefined || tokens <= 0) return ''
  const rounded = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
  return ` · ~${rounded} tokens`
}

/**
 * Reasoning as one collapsed row: "Thinking" shimmering while it streams,
 * "Thought" (with how long, when the environment says) once it is done. It
 * stays folded whether live or not; a tap on a thought with text opens it,
 * and the text fades in. A thought with no text yet (or a provider that
 * reports only a token count) keeps the same row, its chevron dimmed, with
 * nothing to open.
 */
export const ThinkingPart = memo(function ThinkingPart({
  text,
  duration,
  tokens,
  isStreaming = false,
}: {
  text?: string
  duration?: number
  /** Provider's running estimate of thinking tokens. The only progress signal
   * for providers whose thinking blocks carry no text at all. */
  tokens?: number
  isStreaming?: boolean
}) {
  const theme = usePhoneTheme()
  const [open, setOpen] = useState(false)
  const revealedRef = useRef(false)

  const body = text ?? ''
  if (!body && tokens === undefined && !isStreaming) return null

  const label = `${isStreaming ? 'Thinking' : thoughtLabel(duration)}${tokenLabel(tokens)}`
  const labelView = isStreaming ? (
    <ShimmerText variant="text-13-regular">{label}</ShimmerText>
  ) : (
    <AppText variant="text-13-regular" style={{ color: theme.muted }}>
      {label}
    </AppText>
  )

  if (!body) {
    // The same collapsed row as a thought with text, chevron and all, so a
    // live "Thinking" and a settled "Thought for 12s" read alike. With nothing
    // to open it is not a button, and its chevron is dimmed to say so.
    return (
      <View
        style={{
          paddingVertical: 2,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          alignSelf: 'flex-start',
        }}
      >
        <View style={{ opacity: 0.4 }}>
          <DisclosureChevron open={false} color={theme.faint} />
        </View>
        {labelView}
      </View>
    )
  }

  return (
    <View style={{ paddingVertical: 2 }}>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        hitSlop={6}
        onPress={() => {
          revealedRef.current = true
          setOpen((value) => !value)
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          alignSelf: 'flex-start',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <DisclosureChevron open={open} color={theme.faint} />
        {labelView}
      </Press>
      {open ? (
        <Animated.View
          entering={revealedRef.current ? revealBody : undefined}
          style={{ marginTop: 6, paddingLeft: 20 }}
        >
          <AppText
            variant="text-13-regular"
            selectable
            style={{ color: theme.muted, fontStyle: 'italic' }}
          >
            {body}
          </AppText>
        </Animated.View>
      ) : null}
    </View>
  )
})
