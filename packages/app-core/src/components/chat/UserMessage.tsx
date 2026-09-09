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
