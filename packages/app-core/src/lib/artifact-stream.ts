import { useCallback, useEffect, useState } from 'react'
import type { EnvironmentClient } from '@openmanager/environment-client'
import { useEnvironmentClientOptional } from '../providers/environment-client'

export type ArtifactStream = {
  /** A URL a media player streams from; absent while it is asked for. */
  url?: string
  /** The environment cannot stream it: an older one, or the artifact is gone. */
  failed: boolean
  /** Ask for a new URL, as a player whose URL expired mid-video does. */
  retry: () => void
}

type Target = { sessionId: string; artifactId: string }
type Grant = { url: string; expiresAt: number }

/** A grant this close to expiring is not handed to a new player. */
const GRANT_MARGIN_MS = 5 * 60_000

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

/**
 * A streaming URL for a session's artifact (`artifactStreamUrl`), for a
 * player that reads it in ranges as it plays, rather than the whole file up
 * front. Asked for while the view is on screen.
 */
export function useArtifactStream(artifact: Target | undefined): ArtifactStream {
  const client = useEnvironmentClientOptional()
  const sessionId = artifact?.sessionId
  const artifactId = artifact?.artifactId
  const key = sessionId && artifactId ? keyOf({ sessionId, artifactId }) : undefined
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key?: string; url?: string; failed: boolean }>(() => {
    const held = client && key ? heldGrant(client, key) : undefined
    return held ? { key, url: held.url, failed: false } : { failed: false }
  })

  useEffect(() => {
    if (!sessionId || !artifactId) return
    const current = keyOf({ sessionId, artifactId })
    if (!client?.artifactStreamUrl) {
      setState({ key: current, failed: true })
      return
    }
    const held = attempt === 0 ? heldGrant(client, current) : undefined
    if (held) {
      setState((previous) =>
        previous.key === current && previous.url === held.url
          ? previous
          : { key: current, url: held.url, failed: false },
      )
      return
    }
    const controller = new AbortController()
    client.artifactStreamUrl({ sessionId, artifactId }, { signal: controller.signal }).then(
      (grant) => {
        const byKey = grants.get(client) ?? new Map<string, Grant>()
        grants.set(client, byKey)
        byKey.set(current, grant)
        if (!controller.signal.aborted) setState({ key: current, url: grant.url, failed: false })
      },
      () => {
        if (!controller.signal.aborted) setState({ key: current, failed: true })
      },
    )
    return () => controller.abort()
  }, [artifactId, attempt, client, sessionId])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  // A view reused for another artifact must not play the previous one.
  return state.key === key ? { url: state.url, failed: state.failed, retry } : { failed: false, retry }
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
