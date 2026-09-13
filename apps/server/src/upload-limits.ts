/**
 * Attachment upload policy. The HTTP route lands with CAL-87; this constant is
 * the size check that route must apply, so oversized-upload tests have a
 * documented reason to fail for once the endpoint exists.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export function isOversizedUpload(sizeBytes: number): boolean {
  return !Number.isFinite(sizeBytes) || sizeBytes > MAX_ATTACHMENT_BYTES
}
