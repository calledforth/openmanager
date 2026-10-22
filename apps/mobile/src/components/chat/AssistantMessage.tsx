import { View } from 'react-native'
import type { MessagePart } from '@openmanager/app-core/logic'

import { MessageParts } from '../parts/MessageParts'
import { TextPart } from '../parts/TextPart'
import { ShimmerText } from './ShimmerText'

// Full-width assistant turn (web's `AssistantMessage`): its parts in the order
// they happened when there are any, else plain markdown content. While a live
// turn has nothing to show yet, the "Working" shimmer row stands in.

export function AssistantMessage({
  content,
  isFinal,
  parts,
}: {
  content: string
  isFinal?: boolean
  parts?: readonly MessagePart[]
}) {
  const hasParts = !!parts && parts.length > 0
  const isStreaming = isFinal !== true

  if (!hasParts && !content) {
    if (isStreaming) {
      return (
        <View className="w-full py-1">
          <ShimmerText variant="text-14-regular">Working…</ShimmerText>
        </View>
      )
    }
    return null
  }

  return (
    <View className="w-full py-1">
      {hasParts ? (
        <MessageParts parts={parts} isStreaming={isStreaming} />
      ) : (
        <TextPart text={content} />
      )}
    </View>
  )
}
