import { ClockIcon, WarningCircleIcon } from 'phosphor-react-native'
import { View } from 'react-native'
import type { ArtifactSource, MessagePart, OptimisticImage } from '@openmanager/app-core/logic'

import { useTokens } from '../../theme/useTokens'
import { ImagePart } from '../parts/ImagePart'
import { AppText } from '../ui/AppText'

/** The images a prompt carries: its own parts once confirmed, its echo's before. */
function imagesOf(parts: readonly MessagePart[], attachments: readonly OptimisticImage[]) {
  const fromParts = parts
    .filter((part) => part.type === 'image')
    .map((part) => ({
      id: part.id,
      url: typeof part.url === 'string' ? part.url : undefined,
      artifact: part.artifact as ArtifactSource | undefined,
    }))
  if (fromParts.length > 0) return fromParts
  return attachments.map((image) => ({
    id: image.id,
    url: image.previewUrl,
    artifact: image.artifact,
  }))
}

/**
 * Right-aligned user bubble on web's chat-user fill (a sent message reads by
 * colour, no outline), with its images above it. An echo the environment has
 * not confirmed is dimmed with a clock; one it refused says why.
 */
export function UserMessage({
  content,
  parts = [],
  attachments = [],
  isQueued,
  sendError,
}: {
  content: string
  parts?: readonly MessagePart[]
  attachments?: readonly OptimisticImage[]
  isQueued?: boolean
  sendError?: string
}) {
  const tokens = useTokens()
  const images = imagesOf(parts, attachments)

  return (
    <View className="w-full items-end gap-1.5 py-1">
      {images.length > 0 ? (
        <View className="max-w-[85%] flex-row flex-wrap justify-end gap-1.5">
          {images.map((image) => (
            <ImagePart key={image.id} url={image.url} artifact={image.artifact} size={120} />
          ))}
        </View>
      ) : null}
      {content ? (
        <View
          className="max-w-[85%] rounded-2xl rounded-br bg-bubble px-3 py-2"
          style={isQueued && !sendError ? { opacity: 0.6 } : undefined}
        >
          <AppText variant="chat-user" selectable>
            {content}
          </AppText>
          {isQueued && !sendError ? (
            <View className="mt-1 flex-row items-center justify-end gap-1">
              <ClockIcon size={11} color={tokens.textFaint} />
              <AppText variant="text-11-regular" className="text-textFaint">
                queued
              </AppText>
            </View>
          ) : null}
        </View>
      ) : null}
      {sendError ? (
        <View className="max-w-[85%] flex-row items-center gap-1">
          <WarningCircleIcon size={12} color={tokens.destructive} />
          <AppText variant="text-11-regular" className="text-destructive">
            {sendError}
          </AppText>
        </View>
      ) : null}
    </View>
  )
}
