import type { PromptAttachment } from '@agentpack/contract'

export type DraftImageAttachment = {
  id: string
  file: File
  previewUrl: string
}

export type UploadedImageAttachment = PromptAttachment & {
  previewUrl: string
}

export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const MAX_IMAGE_ATTACHMENTS = 4
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export function promptAttachment(attachment: UploadedImageAttachment): PromptAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  }
}
