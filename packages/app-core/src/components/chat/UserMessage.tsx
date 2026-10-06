import { useEffect, useState } from 'react'
import { ArrowsOutIcon, CheckIcon, ImageBrokenIcon } from '@phosphor-icons/react'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { cn } from '../../lib/utils'
import type { ArtifactSource, OptimisticImage } from '../../lib/attachments'
import { partArtifact, useArtifactPreview } from '../../lib/artifact-preview'
import { Markdown } from '../markdown/Markdown'
import { ImageViewer } from '../parts/GeneratedImagePart'
import { Tooltip } from '../ui/Tooltip'
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

/** Phosphor's Copy glyph (same 256 grid and regular stroke) with rounded corners. */
function SoftCopyIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={16}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M168 168h24a24 24 0 0 0 24-24V64a24 24 0 0 0-24-24h-80a24 24 0 0 0-24 24v24" />
      <rect x="40" y="88" width="128" height="128" rx="24" />
    </svg>
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
        {copied ? <CheckIcon size={13} weight="bold" /> : <SoftCopyIcon size={13} />}
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
  const [viewing, setViewing] = useState<number | null>(null)
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
              {images.map((image, index) => (
                <ImageThumbnail key={image.id} image={image} onPreview={() => setViewing(index)} />
              ))}
            </div>
          )}
          {/* Same renderer as assistant prose, so a prompt's code, lists and
              links read the way the reply's do. */}
          {content && <Markdown>{content}</Markdown>}
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
