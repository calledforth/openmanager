import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowsOutIcon, XIcon } from '@phosphor-icons/react'
import type { StreamMessagePart } from '@openmanager/shared/lib/remote-stream-parts'
import { cn } from '../../lib/utils'
import type { UploadedImageAttachment } from '../../lib/attachments'
import { ReferenceComposerToolbar } from './composer-toolbar'
import { chatUserInner, chatUserMessageShell } from './userMessageStyles'

type MessagePart = StreamMessagePart

type PreviewImage = {
  id: string
  url: string
  name: string
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
      className="chat-animate-fade-in fixed inset-0 z-[500] flex items-center justify-center bg-black/80 p-5 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${image.name}`}
        className="relative flex h-full w-full max-w-[min(1100px,94vw)] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#111]/95 shadow-[0_28px_100px_rgba(0,0,0,0.65)]"
      >
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/10 px-3.5 text-white/70">
          <ArrowsOutIcon className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{image.name}</span>
          <span className="hidden text-[10px] uppercase tracking-[0.12em] text-white/35 sm:block">
            Esc to close
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close image preview"
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.055),transparent_62%)] p-4 sm:p-8">
          <img
            src={image.url}
            alt={image.name}
            className="max-h-full max-w-full rounded-md object-contain shadow-[0_12px_45px_rgba(0,0,0,0.4)]"
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function UserMessage({
  content,
  parts,
  optimisticAttachments,
  sendError,
}: {
  content: string
  parts?: MessagePart[]
  optimisticAttachments?: UploadedImageAttachment[]
  sendError?: string
}) {
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null)
  const persistedImages = (parts ?? []).flatMap((part) => {
    if (part.type !== 'image' || typeof part.url !== 'string') return []
    return [
      { id: part.id, url: part.url, name: typeof part.name === 'string' ? part.name : 'Image' },
    ]
  })
  const images = persistedImages.length
    ? persistedImages
    : (optimisticAttachments ?? []).map((attachment) => ({
        id: attachment.id,
        url: attachment.previewUrl,
        name: attachment.name,
      }))
  return (
    <div className="w-full py-1">
      <div className={cn(chatUserMessageShell, 'max-w-none')}>
        <div className={chatUserInner}>
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {images.map((image) => (
                <button
                  type="button"
                  key={image.id}
                  onClick={() => setPreviewImage(image)}
                  className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-[var(--basis-border-muted)] bg-[var(--basis-surface)]"
                  aria-label={`Preview ${image.name}`}
                >
                  <img
                    src={image.url}
                    alt={image.name}
                    className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                  />
                  <span className="pointer-events-none absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded border border-white/15 bg-black/55 text-white/75 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    <ArrowsOutIcon className="h-2.5 w-2.5" />
                  </span>
                </button>
              ))}
            </div>
          )}
          {content && <div className="min-w-0 whitespace-pre-wrap break-words">{content}</div>}
          {sendError && (
            <div className="mt-2 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-[11px] leading-4 text-red-500">
              Not sent: {sendError}
            </div>
          )}
        </div>
        <div className="px-1 pb-0.5" onClick={(e) => e.stopPropagation()}>
          <ReferenceComposerToolbar />
        </div>
      </div>
      {previewImage && (
        <ImagePreviewDialog image={previewImage} onClose={() => setPreviewImage(null)} />
      )}
    </div>
  )
}
