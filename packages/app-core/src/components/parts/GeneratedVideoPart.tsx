import { useLayoutEffect, useRef } from 'react'
import { FilmStripIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { useArtifactPreview } from '../../lib/artifact-preview'
import { playbackMemory, useArtifactStream } from '../../lib/artifact-stream'

export type GeneratedVideo = {
  id: string
  /** The stored video, in the session the agent shared it in. */
  artifact?: { sessionId: string; artifactId: string }
  name?: string
}

const videoName = (part: GeneratedVideo) => part.name?.trim() || 'Video'

/**
 * Where the video plays from: a streaming URL the environment grants, read in
 * ranges as it plays and seeks. An environment that grants none still serves
 * the bytes whole, which is fine for a short clip.
 */
function useVideoSource(part: GeneratedVideo) {
  const stream = useArtifactStream(part.artifact)
  const whole = useArtifactPreview(stream.failed ? part.artifact : undefined)
  if (!stream.failed) return { url: stream.url, failed: false, retry: stream.retry }
  return { url: whole.url, failed: whole.failed, retry: undefined }
}

/**
 * A video the agent shared (`share_file`): a player in the reply, under its
 * file name. A grant that expires while the video is paused fails the next
 * range; the player asks for a new one and carries on where it was. The
 * transcript mounts the part anew when its turn settles (the work folds away
 * around it); the new player resumes where the old one was, playing if it was.
 */
export function GeneratedVideoPart({ part }: { part: GeneratedVideo }) {
  const { url, failed, retry } = useVideoSource(part)
  const name = videoName(part)
  const resumeAt = useRef<{ time: number; play: boolean } | null>(null)
  const retriedFor = useRef<string | null>(null)
  // The element as last mounted. Kept after React detaches it, so the cleanup
  // below can still read where it was.
  const element = useRef<HTMLVideoElement | null>(null)
  const artifact = part.artifact
  const sessionId = artifact?.sessionId
  const artifactId = artifact?.artifactId

  // A layout cleanup runs before the browser pauses a removed element, so it
  // still reads whether the video was playing.
  useLayoutEffect(() => {
    if (!sessionId || !artifactId) return
    return () => {
      const video = element.current
      if (!video || video.currentTime === 0 || video.ended) return
      playbackMemory.save(
        { sessionId, artifactId },
        { time: video.currentTime, playing: !video.paused },
      )
    }
  }, [artifactId, sessionId])

  if (failed) {
    return (
      <div className="my-2 flex w-fit items-center gap-2 rounded-xl border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] px-3 py-2 text-[11px] text-[var(--basis-text-faint)]">
        <WarningCircleIcon className="h-3.5 w-3.5" />
        {name} is unavailable
      </div>
    )
  }

  return (
    <figure className="my-2 w-fit max-w-full">
      <div
        className={cn(
          'overflow-hidden rounded-xl border border-[var(--basis-border-muted)] bg-black shadow-sm',
          !url && 'aspect-video w-[min(28rem,100%)] animate-pulse bg-[var(--basis-surface)]',
        )}
      >
        {url && (
          <video
            key={url}
            ref={(video) => {
              if (video) element.current = video
            }}
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label={name}
            className="block max-h-[440px] max-w-full"
            onLoadedMetadata={(event) => {
              const remembered =
                sessionId && artifactId ? playbackMemory.take({ sessionId, artifactId }) : undefined
              const resume =
                resumeAt.current ??
                (remembered ? { time: remembered.time, play: remembered.playing } : null)
              if (!resume) return
              resumeAt.current = null
              event.currentTarget.currentTime = resume.time
              if (resume.play) void event.currentTarget.play().catch(() => undefined)
            }}
            onError={(event) => {
              // Once per URL: a second failure is the file, not the grant.
              if (!retry || retriedFor.current === url) return
              retriedFor.current = url
              const video = event.currentTarget
              resumeAt.current = { time: video.currentTime, play: !video.paused }
              retry()
            }}
          />
        )}
      </div>
      <figcaption className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--basis-text-faint)]">
        <FilmStripIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </figcaption>
    </figure>
  )
}
