import { useEffect, useRef, useState } from 'react'
import { TouchableOpacity, View } from 'react-native'

import { AppText } from '../ui/AppText'
import { ShimmerText } from '../chat/ShimmerText'

// Mirror of the desktop `ThinkingPart` (<details open={isStreaming}>): a
// collapsed reasoning row that reads "Thought" (shimmering while streaming) and
// expands to italic muted text. Expanded while streaming, auto-collapses when
// streaming ends, and a manual tap takes control until the next transition.

export function ThinkingPart({
  text,
  isStreaming = false,
}: {
  text: string
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

  if (!text && !isStreaming) return null

  return (
    <View className="py-px">
      <TouchableOpacity activeOpacity={0.7} onPress={onToggle} hitSlop={6}>
        {isStreaming ? (
          <ShimmerText variant="text-12-regular">Thought</ShimmerText>
        ) : (
          <AppText variant="text-12-regular" className="text-textMuted">
            Thought
          </AppText>
        )}
      </TouchableOpacity>
      {expanded && (text || isStreaming) ? (
        <AppText
          variant="text-12-regular"
          className="mt-1 text-textMuted"
          style={{ fontStyle: 'italic' }}
        >
          {text || '…'}
        </AppText>
      ) : null}
    </View>
  )
}
