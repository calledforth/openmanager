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

/** Grants a mounted player renews before it counts the video as broken. */
const MAX_RETRIES = 3

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
  const { retry } = stream
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
  const resumeAt = useRef<number | null>(null)
  // Set by a retry, cleared once the new source is ready: a second error in
  // between is the file, not the grant. A player renews a few times at most.
  const retrying = useRef(false)
  const retries = useRef(0)
  const [unplayable, setUnplayable] = useState(false)
  // Read from events, not the player: when the part unmounts the player is
  // released before this component's own cleanup runs.
  const position = useRef({ time: 0, playing: false, ended: false })
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
      if (event.isPlaying) position.current.ended = false
    })
    const ended = player.addListener('playToEnd', () => {
      position.current.ended = true
    })
    // This player's own status, never a previous one's: each URL gets a new
    // player. A grant that ran out while the video sat paused fails the next
    // range: ask for a new one and carry on where it was.
    const status = player.addListener('statusChange', (event) => {
      if (event.status === 'readyToPlay') retrying.current = false
      if (event.status !== 'error') return
      if (retrying.current || retries.current >= MAX_RETRIES) {
        setUnplayable(true)
        return
      }
      retrying.current = true
      retries.current += 1
      resumeAt.current = position.current.time
      retry()
    })
    return () => {
      loaded.remove()
      timed.remove()
      playing.remove()
      ended.remove()
      status.remove()
    }
  }, [artifactId, player, retry, sessionId])

  useEffect(() => {
    if (!sessionId || !artifactId) return
    const kept = position.current
    return () => {
      // A video watched to the end starts again from the top, as on web.
      if (kept.time > 0 && !kept.ended) {
        playbackMemory.save({ sessionId, artifactId }, { time: kept.time, playing: kept.playing })
      }
    }
  }, [artifactId, sessionId])

  const failed = stream.failed || unplayable
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
          {unplayable ? `${name} cannot be played here` : failed ? `${name} is unavailable` : name}
        </AppText>
      </View>
    </View>
  )
})
