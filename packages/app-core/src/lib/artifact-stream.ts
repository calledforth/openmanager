import { useCallback, useEffect, useState } from 'react'
import { isEnvironmentClientError, type EnvironmentClient } from '@openmanager/environment-client'
import { useEnvironmentClientOptional } from '../providers/environment-client'

export type ArtifactStream = {
  /** A URL a media player streams from; absent while it is asked for. */
  url?: string
  /** It cannot be streamed: the artifact is gone, or asking kept failing. */
  failed: boolean
  /**
   * This client has no way to ask for a stream at all (an older or a
   * desktop client), as opposed to one that asked and was refused.
   */
  unsupported: boolean
  /** Ask for a new URL, as a player whose URL expired mid-video does. */
  retry: () => void
}

type Target = { sessionId: string; artifactId: string }
type Grant = { url: string; expiresAt: number }

/** A grant this close to expiring is not handed to a new player. */
const GRANT_MARGIN_MS = 5 * 60_000
/**
 * Waits before asking again after a failure that may pass (the socket is
 * reconnecting, a request dropped). After the last, the stream has failed.
 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]

/**
 * Grants by client, then by artifact. A transcript re-lays a turn out when it
 * settles, and the player is mounted anew: it gets the URL it already had, so
 * it carries on rather than asking the environment again. Grants belong to
 * the credential that asked, so they are never shared across clients.
 */
const grants = new WeakMap<EnvironmentClient, Map<string, Grant>>()

const keyOf = (target: Target) => `${target.sessionId}/${target.artifactId}`

function heldGrant(client: EnvironmentClient, key: string): Grant | undefined {
  const grant = grants.get(client)?.get(key)
  return grant && grant.expiresAt - Date.now() > GRANT_MARGIN_MS ? grant : undefined
}

/** Whether asking again could get a different answer. */
const mayPass = (error: unknown) =>
  !isEnvironmentClientError(error) || error.code === 'unavailable' || error.code === 'internal'

type State = { key?: string; url?: string; failed: boolean; unsupported: boolean }
const WAITING: State = { failed: false, unsupported: false }

/**
 * A streaming URL for a session's artifact (`artifactStreamUrl`), for a
 * player that reads it in ranges as it plays, rather than the whole file up
 * front. Asked for while the view is on screen; a failure that may pass is
 * asked again, with growing waits, before the stream counts as failed.
 */
export function useArtifactStream(artifact: Target | undefined): ArtifactStream {
  const client = useEnvironmentClientOptional()
  const sessionId = artifact?.sessionId
  const artifactId = artifact?.artifactId
  const key = sessionId && artifactId ? keyOf({ sessionId, artifactId }) : undefined
  // `fresh` skips a held grant: the player said the one it had stopped working.
  const [request, setRequest] = useState({ count: 0, fresh: false, failures: 0 })
  const [state, setState] = useState<State>(() => {
    const held = client && key ? heldGrant(client, key) : undefined
    return held ? { key, url: held.url, failed: false, unsupported: false } : WAITING
  })

  useEffect(() => {
    if (!sessionId || !artifactId) return
    const current = keyOf({ sessionId, artifactId })
    if (!client?.artifactStreamUrl) {
      setState({ key: current, failed: true, unsupported: true })
      return
    }
    const held = request.fresh ? undefined : heldGrant(client, current)
    if (held) {
      setState((previous) =>
        previous.key === current && previous.url === held.url
          ? previous
          : { key: current, url: held.url, failed: false, unsupported: false },
      )
      return
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    client.artifactStreamUrl({ sessionId, artifactId }, { signal: controller.signal }).then(
      (grant) => {
        const byKey = grants.get(client) ?? new Map<string, Grant>()
        grants.set(client, byKey)
        byKey.set(current, grant)
        if (!controller.signal.aborted) {
          setState({ key: current, url: grant.url, failed: false, unsupported: false })
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        const wait = mayPass(error) ? BACKOFF_MS[request.failures] : undefined
        if (wait === undefined) {
          setState({ key: current, failed: true, unsupported: false })
          return
        }
        timer = setTimeout(
          () =>
            setRequest((previous) => ({
              count: previous.count + 1,
              fresh: previous.fresh,
              failures: previous.failures + 1,
            })),
          wait,
        )
      },
    )
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [artifactId, client, request, sessionId])

  // A client that comes back (a new socket) starts the waits over.
  useEffect(() => {
    setRequest((previous) => (previous.failures === 0 ? previous : { ...previous, failures: 0 }))
  }, [client])

  const retry = useCallback(
    () => setRequest((previous) => ({ count: previous.count + 1, fresh: true, failures: 0 })),
    [],
  )
  // A view reused for another artifact must not play the previous one.
  return state.key === key ? { ...state, retry } : { ...WAITING, retry }
}

export type VideoFrame = { width: number; height: number }

/**
 * Each shared video's frame size, by artifact, once a player has read it. The
 * transcript unmounts rows that scroll out of view and mounts them anew on the
 * way back; a player that already knows its shape lays out at its final size
 * at once, rather than as a default box that grows when the video loads (which
 * moves everything below it under a reader scrolling past).
 */
const frames = new Map<string, VideoFrame>()
const FRAMES_KEPT = 200

export const videoFrames = {
  get(artifact: Target): VideoFrame | undefined {
    return frames.get(keyOf(artifact))
  },
  set(artifact: Target, frame: VideoFrame) {
    if (!(frame.width > 0 && frame.height > 0)) return
    const key = keyOf(artifact)
    frames.delete(key)
    frames.set(key, frame)
    if (frames.size > FRAMES_KEPT) frames.delete(frames.keys().next().value!)
  },
}

export type PlaybackPosition = { time: number; playing: boolean }

/**
 * Where each shared video was when its player went away, by artifact. A turn
 * that settles re-lays its parts out and mounts the player anew; the new one
 * picks up here, so a video the reader started keeps playing.
 */
const positions = new Map<string, PlaybackPosition & { at: number }>()
const POSITIONS_KEPT = 50
/**
 * A player mounted this soon after the last went away is the same one moved:
 * it plays on. Later (the reader left the session and came back) it waits,
 * where it was, to be played.
 */
const MOVED_WITHIN_MS = 2_000

export const playbackMemory = {
  save(artifact: Target, position: PlaybackPosition) {
    const key = keyOf(artifact)
    positions.delete(key)
    positions.set(key, { ...position, at: Date.now() })
    if (positions.size > POSITIONS_KEPT) positions.delete(positions.keys().next().value!)
  },
  /** The position to resume from, once: a later mount starts from the top. */
  take(artifact: Target): PlaybackPosition | undefined {
    const key = keyOf(artifact)
    const position = positions.get(key)
    positions.delete(key)
    if (!position) return undefined
    return {
      time: position.time,
      playing: position.playing && Date.now() - position.at < MOVED_WITHIN_MS,
    }
  },
}
