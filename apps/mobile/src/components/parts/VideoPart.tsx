import { useEvent } from 'expo'
import { useVideoPlayer, VideoView } from 'expo-video'
import { FilmStripIcon, WarningCircleIcon } from 'phosphor-react-native'
import { memo, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { playbackMemory, useArtifactStream } from '@openmanager/app-core/logic'

import { usePhoneTheme } from '../../theme/ThemeProvider'
import { AppText } from '../ui/AppText'

export interface TranscriptVideo {
  id: string
  /** The stored video, in the session the agent shared it in. */
  artifact?: { sessionId: string; artifactId: string }
  name?: string
}

/** A card is no wider than this, as an image card is not. */
const CARD_MAX_WIDTH = 360
/** Until the video says its own shape. */
const DEFAULT_RATIO = 16 / 9
/** Portrait recordings (a phone's screen) stay this tall at most. */
const CARD_MAX_HEIGHT = 420

/**
 * A video the agent shared (`share_file`), played in the transcript by the
 * system player, which streams it from the environment in ranges as it plays
 * and seeks: nothing is downloaded up front, however long it is. Native
 * controls give fullscreen, scrubbing and picture-in-picture for free.
 */
export const VideoPart = memo(function VideoPart({
  video,
  width,
}: {
  video: TranscriptVideo
  width: number
}) {
  const theme = usePhoneTheme()
  const stream = useArtifactStream(video.artifact)
  const name = video.name?.trim() || 'Video'
  const cardWidth = Math.min(width, CARD_MAX_WIDTH)
  const [ratio, setRatio] = useState(DEFAULT_RATIO)
  const height = Math.min(Math.round(cardWidth / ratio), CARD_MAX_HEIGHT)

  // Nothing plays until asked; the player only reads the first ranges, so
  // the card can show its first frame and length.
  const player = useVideoPlayer(stream.url ?? null, (created) => {
    created.loop = false
    // Where it is, a few times a second, for the position kept below.
    created.timeUpdateEventInterval = 0.5
  })
  const { status } = useEvent(player, 'statusChange', { status: player.status })
  const resumeAt = useRef<number | null>(null)
  const retriedFor = useRef<string | null>(null)
  // Read from events, not the player: when the part unmounts the player is
  // released before this component's own cleanup runs.
  const position = useRef({ time: 0, playing: false })
  const sessionId = video.artifact?.sessionId
  const artifactId = video.artifact?.artifactId

  useEffect(() => {
    const loaded = player.addListener('sourceLoad', (event) => {
      const size = event.availableVideoTracks[0]?.size
      if (size && size.width > 0 && size.height > 0) setRatio(size.width / size.height)
      // A grant renewed mid-video, or the same video mounted anew when its
      // turn settled and the transcript re-laid it out: carry on from there.
      const remembered =
        sessionId && artifactId ? playbackMemory.take({ sessionId, artifactId }) : undefined
      const time = resumeAt.current ?? remembered?.time ?? null
      resumeAt.current = null
      if (time !== null) player.currentTime = time
      if (remembered?.playing) player.play()
    })
    const timed = player.addListener('timeUpdate', (event) => {
      position.current.time = event.currentTime
    })
    const playing = player.addListener('playingChange', (event) => {
      position.current.playing = event.isPlaying
    })
    return () => {
      loaded.remove()
      timed.remove()
      playing.remove()
    }
  }, [artifactId, player, sessionId])

  useEffect(() => {
    if (!sessionId || !artifactId) return
    const kept = position.current
    return () => {
      if (kept.time > 0) playbackMemory.save({ sessionId, artifactId }, { ...kept })
    }
  }, [artifactId, sessionId])

  // A grant that ran out while the video sat paused fails the next range:
  // ask for a new one, once per URL, and carry on where it was.
  const { url, retry } = stream
  useEffect(() => {
    if (status !== 'error' || !url || retriedFor.current === url) return
    retriedFor.current = url
    resumeAt.current = player.currentTime
    retry()
  }, [player, retry, status, url])

  const failed = stream.failed || (status === 'error' && retriedFor.current === stream.url)
  return (
    <View style={{ marginVertical: 6, width: cardWidth }}>
      <View
        style={{
          width: cardWidth,
          height,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: failed ? theme.hover : '#000',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {failed ? (
          <WarningCircleIcon size={20} color={theme.faint} />
        ) : stream.url ? (
          <VideoView
            player={player}
            style={{ width: cardWidth, height }}
            nativeControls
            contentFit="contain"
            accessibilityLabel={name}
          />
        ) : (
          <ActivityIndicator color={theme.faint} />
        )}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
        <FilmStripIcon size={14} color={theme.faint} />
        <AppText
          variant="text-11-regular"
          numberOfLines={1}
          style={{ color: theme.faint, flexShrink: 1 }}
        >
          {failed ? `${name} is unavailable` : name}
        </AppText>
      </View>
    </View>
  )
})
