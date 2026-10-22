import { ClockIcon, WarningCircleIcon } from 'phosphor-react-native'
import { memo } from 'react'
import { View } from 'react-native'
import type { ArtifactSource, MessagePart, OptimisticImage } from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
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
export const UserMessage = memo(function UserMessage({
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
  const theme = usePhoneTheme()
  const images = imagesOf(parts, attachments)

  return (
    <View className="w-full items-end gap-1.5">
      {images.length > 0 ? (
        <View className="max-w-[86%] flex-row flex-wrap justify-end gap-1.5">
          {images.map((image) => (
            <ImagePart key={image.id} url={image.url} artifact={image.artifact} size={120} />
          ))}
        </View>
      ) : null}
      {content ? (
        <View
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
          <AppText
            variant="chat-user"
            selectable
            style={{ color: theme.fg, fontSize: 15, lineHeight: 22 }}
          >
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
        </View>
      ) : null}
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
