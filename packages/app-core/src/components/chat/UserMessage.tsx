import { useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowsOutIcon, ArrowUpIcon, CircleNotchIcon, ImageBrokenIcon } from '@phosphor-icons/react'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { cn } from '../../lib/utils'
import type { ArtifactSource, OptimisticImage } from '../../lib/attachments'
import { partArtifact, useArtifactPreview } from '../../lib/artifact-preview'
import { useEnvironmentAvailability } from '../../providers/environment-availability'
import { Markdown } from '../markdown/Markdown'
import { ImageViewer } from '../parts/GeneratedImagePart'
import { Tooltip } from '../ui/Tooltip'
import { CopyMessageButton } from './CopyMessageButton'
import { chatUserInner, chatUserMessageShell } from './userMessageStyles'

type MessagePart = StreamMessagePart

/** An image of the bubble: a URL the row already holds, or stored bytes to read. */
type BubbleImage = {
  id: string
  name: string
  url?: string
  artifact?: ArtifactSource
}

const thumbnailShell =
  'group relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-[var(--basis-border-muted)] bg-[var(--basis-surface)]'

function ImageThumbnail({ image, onPreview }: { image: BubbleImage; onPreview: () => void }) {
  const preview = useArtifactPreview(image.url ? undefined : image.artifact)
  const url = image.url ?? preview.url
  if (!url) {
    return (
      <div
        role="img"
        aria-label={preview.failed ? `${image.name} is unavailable` : `Loading ${image.name}`}
        className={cn(
          thumbnailShell,
          'flex items-center justify-center text-[var(--basis-text-faint)]',
          !preview.failed && 'animate-pulse',
        )}
      >
        {preview.failed && <ImageBrokenIcon className="h-4 w-4" />}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onPreview}
      className={thumbnailShell}
      aria-label={`Preview ${image.name}`}
    >
      <img
        src={url}
        alt={image.name}
        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
      />
      <span className="pointer-events-none absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border border-white/15 bg-black/55 text-white/75 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
        <ArrowsOutIcon className="h-2.5 w-2.5" />
      </span>
    </button>
  )
}

/**
 * Under a steered message the agent has not read yet: what it waits for, and
 * a way to stop waiting. It fades in after a beat, so a steer the agent takes
 * at once reads as a plain send rather than flashing a status.
 */
function SteerStatus({
  steer,
  onSendNow,
}: {
  steer: 'waiting' | 'next'
  onSendNow?: () => Promise<void>
}) {
  const reduceMotion = useReducedMotion()
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const sendNow = () => {
    if (!onSendNow) return
    setFailure(null)
    setSending(true)
    onSendNow().catch((error: unknown) => {
      setFailure(error instanceof Error && error.message ? error.message : 'Couldn’t send it now.')
      setSending(false)
    })
  }
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: reduceMotion ? 0 : 0.4, duration: 0.18 }}
      className="mt-1 flex flex-col items-end"
    >
      <div className="flex h-6 items-center gap-2">
        <span
          className="todo-progress-loader shrink-0 text-[var(--basis-text-muted)]"
          aria-hidden="true"
        />
        <span className="text-11-regular leading-none text-[var(--basis-text-muted)]">
          {steer === 'waiting' ? 'Waiting for the current step' : 'Sending next'}
        </span>
        {steer === 'waiting' && onSendNow ? (
          <Tooltip content="Stop the current step and send this now">
            <button
              type="button"
              onClick={sendNow}
              disabled={sending}
              className="flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-hover px-2 text-11-regular leading-none text-[var(--basis-text)] transition-colors duration-100 hover:bg-active focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60"
            >
              {sending ? (
                <CircleNotchIcon className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowUpIcon className="h-3 w-3" weight="bold" aria-hidden="true" />
              )}
              Send now
            </button>
          </Tooltip>
        ) : null}
      </div>
      {failure ? (
        <p role="alert" className="text-11-regular leading-4 text-red-400">
          {failure}
        </p>
      ) : null}
    </motion.div>
  )
}

export function UserMessage({
  content,
  parts,
  optimisticAttachments,
  sendError,
  sendWaiting = false,
  onRetry,
  steer,
  onSendNow,
}: {
  content: string
  parts?: MessagePart[]
  optimisticAttachments?: OptimisticImage[]
  sendError?: string
  /** On its way: it goes by itself once the chat has caught up. */
  sendWaiting?: boolean
  /** Send this message again. Omitted when the host cannot retry it. */
  onRetry?: () => void
  /** A steered message the agent has not read yet; see `UIMessage.steer`. */
  steer?: 'waiting' | 'next'
  /** Stop the agent's current step and send it now. Omitted when the host cannot. */
  onSendNow?: () => Promise<void>
}) {
  const [viewing, setViewing] = useState<number | null>(null)
  const environmentName = useEnvironmentAvailability()?.name
  const persistedImages = (parts ?? []).flatMap((part): BubbleImage[] => {
    if (part.type !== 'image') return []
    const url = typeof part.url === 'string' ? part.url : undefined
    const artifact = partArtifact(part)
    if (!url && !artifact) return []
    return [
      { id: part.id, url, artifact, name: typeof part.name === 'string' ? part.name : 'Image' },
    ]
  })
  const images: BubbleImage[] = persistedImages.length
    ? persistedImages
    : (optimisticAttachments ?? []).map((attachment) => ({
        id: attachment.id,
        url: attachment.previewUrl,
        artifact: attachment.artifact,
        name: attachment.name,
      }))
  return (
    <div className="group/user flex w-full flex-col items-end pt-6 pb-1">
      {/* Dimmed until the agent reads it; the same bubble then comes up to
          full strength in place. */}
      <div
        className={cn(
          chatUserMessageShell,
          'transition-opacity duration-200 ease-out',
          steer && 'opacity-55',
        )}
      >
        <div className={chatUserInner}>
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {/* Keyed by the stored image where there is one: the echo of a
                  send and the message that confirms it name the same bytes
                  under different ids, and a remount would blank the preview
                  for a frame. */}
              {images.map((image, index) => (
                <ImageThumbnail
                  key={image.artifact ? `artifact:${image.artifact.artifactId}` : image.id}
                  image={image}
                  onPreview={() => setViewing(index)}
                />
              ))}
            </div>
          )}
          {/* Same renderer as assistant prose, so a prompt's code, lists and
              links read the way the reply's do. */}
          {content && <Markdown>{content}</Markdown>}
          {sendError && (
            <div className="mt-2 flex items-start justify-between gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-[11px] leading-4 text-red-500">
              <span className="min-w-0 break-words">
                {environmentName ? `Not sent to ${environmentName}` : 'Not sent'}: {sendError}
              </span>
              {onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="shrink-0 font-medium underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Under the bubble's right edge, where the eye finishes reading it. */}
      {steer ? (
        <SteerStatus steer={steer} onSendNow={onSendNow} />
      ) : content || sendWaiting ? (
        <div className="mt-1 flex items-center justify-end gap-1.5">
          {sendWaiting ? (
            <span
              className="todo-progress-loader shrink-0 text-[var(--basis-text-muted)]"
              role="img"
              aria-label="Waiting to send"
              title="Sends once this chat has caught up"
            />
          ) : null}
          {content ? <CopyMessageButton text={content} row="user" /> : null}
        </div>
      ) : (
        <div className="h-2" />
      )}
      {viewing !== null && viewing < images.length && (
        <ImageViewer
          images={images}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}
