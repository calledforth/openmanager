import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowsOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ImageBrokenIcon,
  XIcon,
} from '@phosphor-icons/react'
import { cn } from '../../lib/utils'
import { partArtifact, useArtifactPreview } from '../../lib/artifact-preview'

type GeneratedImage = {
  id: string
  url?: string
  /** Stored bytes to read through the environment when the part carries no URL. */
  artifact?: unknown
  name?: string
  description?: string
}

/** How many tiles a folded gallery shows, counting the "+N more" tile. */
const GALLERY_VISIBLE = 6

const imageName = (part: GeneratedImage) => part.name?.trim() || 'Generated image'

/** A part's displayable URL: its own, or its stored bytes read through the environment. */
function useImageUrl(part: GeneratedImage) {
  const preview = useArtifactPreview(part.url ? undefined : partArtifact(part))
  return { url: part.url ?? preview.url, failed: preview.failed }
}

const viewerButton =
  'flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:pointer-events-none disabled:opacity-0'

function ViewerImage({ part }: { part: GeneratedImage }) {
  const { url, failed } = useImageUrl(part)
  const name = imageName(part)
  if (!url) {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-[13px] text-white/60">
        {failed ? (
          <>
            <ImageBrokenIcon className="h-4 w-4" />
            {name} is unavailable
          </>
        ) : null}
      </div>
    )
  }
  // The box is sized to the viewport and the image scales up to fill it, so
  // a small preview still opens large.
  return <img src={url} alt={name} className="h-full w-full object-contain drop-shadow-2xl" />
}

/**
 * Full-screen viewer over a set of images. Left and right arrow keys (and
 * the side buttons) step through the set; Escape or a click on the backdrop
 * closes it.
 */
function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: GeneratedImage[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const count = images.length
  const hasPrev = index > 0
  const hasNext = index < count - 1

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft' && hasPrev) onIndexChange(index - 1)
      else if (event.key === 'ArrowRight' && hasNext) onIndexChange(index + 1)
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [index, hasPrev, hasNext, onClose, onIndexChange])

  const current = images[index]
  if (!current) return null

  return createPortal(
    <div
      className="chat-animate-fade-in fixed inset-0 z-[500] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className={cn(viewerButton, 'absolute right-4 top-4 h-8 w-8')}
      >
        <XIcon className="h-4 w-4" />
      </button>
      {count > 1 && (
        <>
          <button
            type="button"
            onClick={() => onIndexChange(index - 1)}
            disabled={!hasPrev}
            aria-label="Previous image"
            className={cn(viewerButton, 'absolute left-4 top-1/2 -translate-y-1/2')}
          >
            <CaretLeftIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => onIndexChange(index + 1)}
            disabled={!hasNext}
            aria-label="Next image"
            className={cn(viewerButton, 'absolute right-4 top-1/2 -translate-y-1/2')}
          >
            <CaretRightIcon className="h-5 w-5" />
          </button>
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-[12px] tabular-nums text-white/80">
            {index + 1} / {count}
          </div>
        </>
      )}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${imageName(current)}`}
        className="h-[84vh] w-[calc(100vw-9rem)]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <ViewerImage key={current.id} part={current} />
      </div>
    </div>,
    document.body,
  )
}

/**
 * One image, or a run of images, from the agent's turn. A single image keeps
 * the full card; two or more sit as tiles in a grid (two across for two or
 * four, three across otherwise), so a tool that returns a dozen screenshots
 * doesn't push the reply apart by a screen per picture. Any tile opens the
 * viewer, which steps through the whole run, folded tiles included.
 */
export function GeneratedImages({ parts }: { parts: GeneratedImage[] }) {
  const [expanded, setExpanded] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  if (parts.length === 1) return <GeneratedImagePart part={parts[0]} />

  const foldable = parts.length > GALLERY_VISIBLE
  const shown = foldable && !expanded ? parts.slice(0, GALLERY_VISIBLE - 1) : parts
  const hiddenCount = parts.length - shown.length
  const twoAcross = parts.length === 2 || parts.length === 4
  const foldTile =
    'flex aspect-[3/2] items-center justify-center rounded-lg bg-[var(--basis-surface)] text-12-medium text-[var(--basis-text-muted)] transition-colors hover:bg-[var(--basis-surface-hover)] hover:text-[var(--basis-text)]'

  return (
    <>
      <div className={cn('my-2 grid w-full gap-2', twoAcross ? 'grid-cols-2' : 'grid-cols-3')}>
        {shown.map((part, index) => (
          <GeneratedImagePart
            key={part.id}
            part={part}
            variant="tile"
            onOpen={() => setViewing(index)}
          />
        ))}
        {foldable &&
          (expanded ? (
            <button type="button" onClick={() => setExpanded(false)} className={foldTile}>
              Show less
            </button>
          ) : (
            <button type="button" onClick={() => setExpanded(true)} className={foldTile}>
              +{hiddenCount} more
            </button>
          ))}
      </div>
      {viewing !== null && (
        <ImageViewer
          images={parts}
          index={viewing}
          onIndexChange={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  )
}

export function GeneratedImagePart({
  part,
  variant = 'full',
  onOpen,
}: {
  part: GeneratedImage
  /** `tile` is a fixed-ratio thumbnail for a gallery cell. */
  variant?: 'full' | 'tile'
  /** Open a viewer the caller owns (a gallery's). Without it the image opens its own. */
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const tile = variant === 'tile'
  const name = imageName(part)
  const { url, failed } = useImageUrl(part)

  if (!url && failed) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] px-3 py-2 text-[11px] text-[var(--basis-text-faint)]',
          tile ? 'aspect-[3/2] justify-center rounded-lg' : 'my-2 w-fit rounded-xl',
        )}
      >
        <ImageBrokenIcon className="h-3.5 w-3.5" />
        {name} is unavailable
      </div>
    )
  }

  if (!url) {
    return (
      <div
        className={cn(
          'animate-pulse border border-[var(--basis-border-muted)] bg-[var(--basis-surface)]',
          tile ? 'aspect-[3/2] rounded-lg' : 'my-2 h-56 max-w-md rounded-xl',
        )}
      />
    )
  }

  return (
    <>
      {/* No caption: the stored name is `generated-<uuid>.webp`, which says
          nothing. It stays on the image as alt text. */}
      <figure
        className={cn(
          'group relative overflow-hidden border border-[var(--basis-border-muted)] bg-[var(--basis-surface)]',
          tile ? 'aspect-[3/2] rounded-lg' : 'my-2 w-fit max-w-full rounded-xl shadow-sm',
        )}
      >
        <button
          type="button"
          onClick={() => (onOpen ? onOpen() : setOpen(true))}
          aria-label={`Preview ${name}`}
          className={cn(
            'relative block max-w-full cursor-zoom-in overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--basis-text-muted)]',
            tile && 'h-full w-full',
          )}
        >
          <img
            src={url}
            alt={name}
            className={
              tile
                ? 'h-full w-full object-cover object-top transition-transform duration-200 group-hover:scale-[1.02]'
                : 'max-h-[440px] max-w-full object-contain'
            }
          />
          <span
            className={cn(
              'pointer-events-none absolute flex items-center justify-center rounded-md border border-white/15 bg-black/55 text-white/80 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
              tile ? 'right-1.5 top-1.5 h-6 w-6' : 'right-2 top-2 h-7 w-7',
            )}
          >
            <ArrowsOutIcon className="h-3.5 w-3.5" />
          </span>
        </button>
      </figure>
      {open && (
        <ImageViewer images={[part]} index={0} onIndexChange={() => {}} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
