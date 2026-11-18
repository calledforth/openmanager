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
export const SHAREABLE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const
export type ShareableType = (typeof SHAREABLE_TYPES)[number]

/** Whether stored bytes of this type are played by streaming them in ranges. */
export const isStreamedType = (mimeType: string) => mimeType.toLowerCase().startsWith('video/')
