import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowsOutIcon, XIcon } from '@phosphor-icons/react'

type GeneratedImage = {
  id: string
  url?: string
  name?: string
  description?: string
}

export function GeneratedImagePart({ part }: { part: GeneratedImage }) {
  const [open, setOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const name = part.name?.trim() || 'Generated image'

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    closeRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus()
    }
  }, [open])

  if (!part.url) {
    return (
      <div className="my-2 h-56 max-w-md animate-pulse rounded-xl border border-[var(--basis-border-muted)] bg-[var(--basis-surface)]" />
    )
  }

  return (
    <>
      <figure className="group my-2 flex w-fit max-w-full flex-col items-start">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Preview ${name}`}
          className="relative block max-w-full cursor-zoom-in overflow-hidden rounded-xl border border-[var(--basis-border-muted)] bg-[var(--basis-surface)] text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--basis-text-muted)]"
        >
          <img src={part.url} alt={name} className="max-h-[440px] max-w-full object-contain" />
          <span className="pointer-events-none absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md border border-white/15 bg-black/55 text-white/80 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <ArrowsOutIcon className="h-3.5 w-3.5" />
          </span>
        </button>
        <figcaption className="mt-1 max-w-full truncate bg-transparent font-sans text-ui-base font-normal leading-ui-relaxed tracking-ui text-[var(--basis-text-faint)]">
          {name}
        </figcaption>
      </figure>

      {open &&
        createPortal(
          <div
            className="chat-animate-fade-in fixed inset-0 z-[500] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false)
            }}
          >
            <button
              ref={closeRef}
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close image preview"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              <XIcon className="h-4 w-4" />
            </button>
            <div role="dialog" aria-modal="true" aria-label={`Preview ${name}`}>
              <img
                src={part.url}
                alt={name}
                className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
