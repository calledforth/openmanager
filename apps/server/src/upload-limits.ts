/**
 * Attachment upload policy. `uploads.ts` applies it twice: to the size a ticket
 * request declares, and to the bytes that actually arrive.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Match the composer's supported prompt images; active formats such as SVG are excluded. */
const ALLOWED_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export function isAllowedUploadType(mimeType: string): boolean {
  return ALLOWED_ATTACHMENT_TYPES.has(mimeType.toLowerCase())
}

export function isOversizedUpload(sizeBytes: number): boolean {
  return !Number.isFinite(sizeBytes) || sizeBytes > MAX_ATTACHMENT_BYTES
}

/**
 * The most a file an agent shares into the chat (`share_file`) may hold. It is
 * read in ranges, never whole, so a screen recording of a few minutes fits.
 */
export const MAX_SHARED_FILE_BYTES = 1024 * 1024 * 1024

/**
 * What an agent may share into the chat: media a browser and a phone play
 * natively. Nothing active (SVG, HTML) and nothing that is merely a file, so a
 * prompt-injected agent cannot turn the chat into a way to hand out keys.
 */
export const SHAREABLE = {
  'video/mp4': 'MP4',
  'video/webm': 'WebM',
  'video/quicktime': 'MOV',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/gif': 'GIF',
} as const
export type ShareableType = keyof typeof SHAREABLE

/**
 * A shared image is shown whole, read into memory on every device, so it is
 * held to the same ceiling as an image a user attaches. Only video streams.
 */
export const MAX_SHARED_IMAGE_BYTES = MAX_ATTACHMENT_BYTES

/**
 * All a session's shared files together may hold no more than this: an agent
 * stuck in a loop cannot fill the disk the database lives on.
 */
export const MAX_SHARED_BYTES_PER_SESSION = 8 * 1024 * 1024 * 1024

/** Room a share must leave free on the data disk, beyond the copy itself. */
export const SHARE_DISK_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024

/** How a byte count reads in a message to an agent: `3.2 MB`, `25 MB`, `1 GB`. */
export const megabytes = (bytes: number) => {
  const mb = bytes / 1024 / 1024
  if (mb >= 1024) return `${+(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

/** The shareable types as an agent reads them: `MP4, WebM, ... or GIF`. */
export const SHAREABLE_NAMES = (() => {
  const names: string[] = Object.values(SHAREABLE)
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
})()
