import { ImageIcon } from 'phosphor-react-native'
import { useEffect, useState } from 'react'
import { Image, View } from 'react-native'
import { useEnvironmentClientOptional, type ArtifactSource } from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'

/** A Blob as a data URI the native image view can show. */
function readAsDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Unreadable'))
    reader.onerror = () => reject(reader.error ?? new Error('Unreadable'))
    reader.readAsDataURL(blob)
  })
}

/**
 * The bytes of a stored image, fetched through the environment client
 * (`fetchArtifact`) while the row is on screen. `undefined` while on their
 * way, `null` when the environment could not give them.
 */
function useArtifactUri(artifact: ArtifactSource | undefined): string | null | undefined {
  const client = useEnvironmentClientOptional()
  const [uri, setUri] = useState<string | null | undefined>(undefined)
  const sessionId = artifact?.sessionId
  const draftId = artifact?.draftId
  const artifactId = artifact?.artifactId
  useEffect(() => {
    if (!artifactId) return
    if (!client?.fetchArtifact) {
      setUri(null)
      return
    }
    const controller = new AbortController()
    setUri(undefined)
    const target: ArtifactSource =
      draftId !== undefined ? { draftId, artifactId } : { sessionId: sessionId!, artifactId }
    client
      .fetchArtifact(target, { signal: controller.signal })
      .then(readAsDataUri)
      .then(
        (next) => {
          if (!controller.signal.aborted) setUri(next)
        },
        () => {
          if (!controller.signal.aborted) setUri(null)
        },
      )
    return () => controller.abort()
  }, [artifactId, client, draftId, sessionId])
  return uri
}

/**
 * An image in the transcript: inline bytes as they came, a stored one
 * through `fetchArtifact`. A fill holds its place while it loads, and stays
 * with an image glyph when it cannot be read.
 */
export function ImagePart({
  url,
  artifact,
  size = 160,
}: {
  url?: string
  artifact?: ArtifactSource
  size?: number
}) {
  const theme = usePhoneTheme()
  const fetched = useArtifactUri(url ? undefined : artifact)
  const uri = url ?? fetched
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.hover,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {uri ? (
        <Image
          source={{ uri }}
          resizeMode="cover"
          style={{ width: size, height: size }}
          accessibilityIgnoresInvertColors
        />
      ) : uri === null ? (
        <ImageIcon size={22} color={theme.faint} />
      ) : null}
    </View>
  )
}
