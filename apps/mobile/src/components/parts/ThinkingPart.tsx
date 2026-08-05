import { useEffect, useRef, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import { AppText } from '../ui/AppText'
import { ShimmerText } from '../chat/ShimmerText'

// Mirror of the desktop `ThinkingPart` (<details open={isStreaming}>): a
// collapsed reasoning row that reads "Thought" (shimmering while streaming) and
// expands to italic muted text. Expanded while streaming, auto-collapses when
// streaming ends, and a manual tap takes control until the next transition.

/** Sub-second thoughts read as noise, so the duration only joins the label above 1s. */
function thoughtLabel(durationMs?: number): string {
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

export function ThinkingPart({
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
  const [expanded, setExpanded] = useState(isStreaming)
  const manuallyToggledRef = useRef(false)
  const prevStreamingRef = useRef(isStreaming)

  useEffect(() => {
    const prev = prevStreamingRef.current
    prevStreamingRef.current = isStreaming
    if (prev === isStreaming) return
    if (isStreaming) {
      // New streaming episode: expand and hand control back to auto behavior.
      manuallyToggledRef.current = false
      setExpanded(true)
    } else if (!manuallyToggledRef.current) {
      // Streaming ended without a manual override: collapse.
      setExpanded(false)
    }
  }, [isStreaming])

  const onToggle = () => {
    manuallyToggledRef.current = true
    setExpanded((prev) => !prev)
  }

  // A part with a token count but no text is still a real thought worth
  // showing; only a part with nothing at all is dropped. Branching on the shape
  // of the part rather than on the provider is deliberate.
  const body = text ?? ''
  if (!body && tokens === undefined && !isStreaming) return null

  const label = `${isStreaming ? 'Thinking' : thoughtLabel(duration)}${tokenLabel(tokens)}`
  // Nothing to disclose without text, so the row is not tappable in that case.
  if (!body) {
    return (
      <View className="py-px">
        {isStreaming ? (
          <ShimmerText variant="text-12-regular">{label}</ShimmerText>
        ) : (
          <AppText variant="text-12-regular" className="text-textMuted">
            {label}
          </AppText>
        )}
      </View>
    )
  }

  return (
    <View className="py-px">
      <TouchableOpacity activeOpacity={0.7} onPress={onToggle} hitSlop={6}>
        {isStreaming ? (
          <ShimmerText variant="text-12-regular">{label}</ShimmerText>
        ) : (
          <AppText variant="text-12-regular" className="text-textMuted">
            {label}
          </AppText>
        )}
      </TouchableOpacity>
      {expanded ? (
        <AppText
          variant="text-12-regular"
          className="mt-1 text-textMuted"
          style={{ fontStyle: 'italic' }}
        >
          {body}
        </AppText>
      ) : null}
    </View>
  )
}
