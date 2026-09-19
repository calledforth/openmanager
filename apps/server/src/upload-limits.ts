/**
 * Attachment upload policy. `uploads.ts` applies it twice: to the size a ticket
 * request declares, and to the bytes that actually arrive.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export function isOversizedUpload(sizeBytes: number): boolean {
  return !Number.isFinite(sizeBytes) || sizeBytes > MAX_ATTACHMENT_BYTES
}
