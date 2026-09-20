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
