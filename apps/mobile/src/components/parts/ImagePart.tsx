import { ImageBrokenIcon } from 'phosphor-react-native'
import { useEffect, useState } from 'react'
import { Image, type ImageLoadEventData, type NativeSyntheticEvent } from 'react-native'
import { useEnvironmentClientOptional, type ArtifactSource } from '@openmanager/app-core/logic'

import { readAsDataUri } from '../../lib/dataUri'
import { usePhoneTheme } from '../../theme/ThemeProvider'
import { tap } from '../../ui/haptics'
import { Press } from '../../ui/Press'

/** An image of the transcript: a URL the part carries, or stored bytes to read through the environment. */
export interface GalleryImage {
  id: string
  url?: string
  artifact?: ArtifactSource
  name?: string
}

/** The key a transcript tile keeps across an echo and the message that confirms it (web's). */
export const imageKey = (image: GalleryImage) =>
  image.artifact ? `artifact:${image.artifact.artifactId}` : image.id

export const imageName = (image: GalleryImage) => image.name?.trim() || 'Image'

/*
 * Stored bytes once read, kept as data URIs up to a budget of characters,
 * oldest out first: a row that remounts (the list opens anew, the page comes
 * back) and the viewer over a gallery show the image at once instead of
 * asking the environment again. A read that failed is not kept, so a remount
 * tries again.
 */
const CACHE_BUDGET = 48 * 1024 * 1024
const cache = new Map<string, string>()
let cacheSize = 0

const artifactKey = (artifact: ArtifactSource) =>
  `${artifact.draftId !== undefined ? `draft:${artifact.draftId}` : `session:${artifact.sessionId}`}:${artifact.artifactId}`

function remember(key: string, uri: string) {
  if (cache.has(key)) return
  cache.set(key, uri)
  cacheSize += uri.length
  for (const [oldest, value] of cache) {
    if (cacheSize <= CACHE_BUDGET || cache.size <= 1) break
    cache.delete(oldest)
    cacheSize -= value.length
  }
}

export interface ImageSource {
  /** Something the native image view can show; undefined while on its way or when it cannot be read. */
  uri: string | undefined
  /** The environment could not give the bytes. */
  failed: boolean
}

const WAITING: ImageSource = { uri: undefined, failed: false }
const UNREADABLE: ImageSource = { uri: undefined, failed: true }

/**
 * What an image shows: its own URL, or its stored bytes fetched through the
 * environment client (`fetchArtifact`) while it is on screen, and remembered.
 */
export function useImageSource(image: Pick<GalleryImage, 'url' | 'artifact'>): ImageSource {
  const client = useEnvironmentClientOptional()
  const artifact = image.url ? undefined : image.artifact
  const key = artifact ? artifactKey(artifact) : null
  const sessionId = artifact?.sessionId
  const draftId = artifact?.draftId
  const artifactId = artifact?.artifactId
  const [fetched, setFetched] = useState<{ key: string; uri: string | null } | null>(null)
  useEffect(() => {
    if (!key || !artifactId || cache.has(key)) return
    if (!client?.fetchArtifact) {
      setFetched({ key, uri: null })
      return
    }
    const controller = new AbortController()
    const target: ArtifactSource =
      draftId !== undefined ? { draftId, artifactId } : { sessionId: sessionId!, artifactId }
    client
      .fetchArtifact(target, { signal: controller.signal })
      .then(readAsDataUri)
      .then(
        (uri) => {
          remember(key, uri)
          if (!controller.signal.aborted) setFetched({ key, uri })
        },
        () => {
          if (!controller.signal.aborted) setFetched({ key, uri: null })
        },
      )
    return () => controller.abort()
  }, [artifactId, client, draftId, key, sessionId])

  if (image.url) return { uri: image.url, failed: false }
  if (!key) return UNREADABLE
  const cached = cache.get(key)
  if (cached !== undefined) return { uri: cached, failed: false }
  if (fetched?.key === key) return fetched.uri === null ? UNREADABLE : { uri: fetched.uri, failed: false }
  return WAITING
}

/**
 * One image of a gallery, `width` by `height`: the picture once it is here,
 * a fill while it is on its way, a broken-image glyph when it cannot be
 * read. A tap hands it to the gallery's viewer.
 */
export function ImageTile({
  image,
  width,
  height,
  radius = 10,
  onPress,
  onNaturalSize,
}: {
  image: GalleryImage
  width: number
  height: number
  radius?: number
  onPress: () => void
  /** The picture's own size, once it has loaded. */
  onNaturalSize?: (width: number, height: number) => void
}) {
  const theme = usePhoneTheme()
  const { uri, failed } = useImageSource(image)
  const name = imageName(image)
  return (
    <Press
      accessibilityRole="imagebutton"
      accessibilityLabel={uri ? name : failed ? `${name} is unavailable` : `Loading ${name}`}
      accessibilityHint={uri ? 'Opens the image full size' : undefined}
      accessibilityState={{ disabled: !uri }}
      disabled={!uri}
      onPress={() => {
        tap()
        onPress()
      }}
      style={({ pressed }) => ({
        width,
        height,
        borderRadius: radius,
        overflow: 'hidden',
        backgroundColor: theme.hover,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {uri ? (
        <Image
          source={{ uri }}
          resizeMode="cover"
          style={{ width, height }}
          accessibilityIgnoresInvertColors
          onLoad={
            onNaturalSize
              ? (event: NativeSyntheticEvent<ImageLoadEventData>) =>
                  onNaturalSize(event.nativeEvent.source.width, event.nativeEvent.source.height)
              : undefined
          }
        />
      ) : failed ? (
        <ImageBrokenIcon size={20} color={theme.faint} />
      ) : null}
    </Press>
  )
}
