import { View } from 'react-native'

import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'

import { MessageParts } from '../parts/MessageParts'
import { TextPart } from '../parts/TextPart'
import { ShimmerText } from './ShimmerText'

// Full-width assistant message (desktop `AssistantMessage`): rich parts when
// available, else plain markdown content. While a streaming message has no
// parts and no text yet, show the animated "Working" shimmer row (the
// streaming tail per plan Phase 4).

export function AssistantMessage({
  content,
  isFinal,
  parts,
}: {
  content: string
  isFinal?: boolean
  parts?: StreamMessagePart[]
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
    <View className="w-full py-1" style={{ opacity: isStreaming ? 0.9 : 1 }}>
      {hasParts ? (
        <MessageParts parts={parts as StreamMessagePart[]} isStreaming={isStreaming} />
      ) : (
        <TextPart text={content} />
      )}
    </View>
  )
}
