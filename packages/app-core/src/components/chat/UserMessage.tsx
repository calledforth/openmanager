import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowsOutIcon, CheckIcon, CopyIcon, ImageBrokenIcon, XIcon } from '@phosphor-icons/react'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { cn } from '../../lib/utils'
import type { ArtifactSource, OptimisticImage } from '../../lib/attachments'
import { partArtifact, useArtifactPreview } from '../../lib/artifact-preview'
import { Tooltip } from '../ui/Tooltip'
import { chatUserInner, chatUserMessageShell } from './userMessageStyles'

type MessagePart = StreamMessagePart

type PreviewImage = {
  id: string
  url: string
  name: string
}

/** An image of the bubble: a URL the row already holds, or stored bytes to read. */
type BubbleImage = {
  id: string
  name: string
  url?: string
  artifact?: ArtifactSource
}

const thumbnailShell =
  'group relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-[var(--basis-border-muted)] bg-[var(--basis-surface)]'

function ImageThumbnail({
  image,
  onPreview,
}: {
  image: BubbleImage
  onPreview: (image: PreviewImage) => void
}) {
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
      onClick={() => onPreview({ id: image.id, url, name: image.name })}
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

function ImagePreviewDialog({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previousActiveElement = document.activeElement as HTMLElement | null
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    closeButtonRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousActiveElement?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className="chat-animate-fade-in fixed inset-0 z-[500] flex items-center justify-center bg-black/70 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <XIcon className="h-4 w-4" />
      </button>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${image.name}`}
        className="flex max-h-full max-w-full items-center justify-center"
      >
        <img
          src={image.url}
          alt={image.name}
          className="max-h-[min(88vh,900px)] max-w-[min(92vw,1100px)] rounded-lg object-contain"
        />
      </div>
    </div>,
    document.body,
  )
}

/** Copies the prompt's text; shown under the bubble while the row is hovered. */
function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(timer)
  }, [copied])
  const label = copied ? 'Copied' : 'Copy message'
  return (
    <Tooltip content={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true))
        }}
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-[color,background-color,opacity] duration-100',
          'text-[var(--basis-text-faint)] hover:bg-hover hover:text-[var(--basis-text)]',
          'opacity-0 focus-visible:opacity-100 group-hover/user:opacity-100 pointer-coarse:opacity-100',
          copied && 'opacity-100',
        )}
      >
        {copied ? <CheckIcon size={13} weight="bold" /> : <CopyIcon size={13} />}
      </button>
    </Tooltip>
  )
}

export function UserMessage({
  content,
  parts,
  optimisticAttachments,
  sendError,
  onRetry,
}: {
  content: string
  parts?: MessagePart[]
  optimisticAttachments?: OptimisticImage[]
  sendError?: string
  /** Send this message again. Omitted when the host cannot retry it. */
  onRetry?: () => void
}) {
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null)
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
      <div className={chatUserMessageShell}>
        <div className={chatUserInner}>
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {images.map((image) => (
                <ImageThumbnail key={image.id} image={image} onPreview={setPreviewImage} />
              ))}
            </div>
          )}
          {content && <div className="min-w-0 whitespace-pre-wrap break-words">{content}</div>}
          {sendError && (
            <div className="mt-2 flex items-start justify-between gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-[11px] leading-4 text-red-500">
              <span className="min-w-0 break-words">Not sent: {sendError}</span>
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
      {content ? (
        <div className="mt-1 flex justify-end">
          <CopyMessageButton text={content} />
        </div>
      ) : (
        <div className="h-2" />
      )}
      {previewImage && (
        <ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />
      )}
    </div>
  )
}
