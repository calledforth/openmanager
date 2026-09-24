import type { PromptAttachment } from '@agentpack/contract'

export type DraftImageAttachment = {
  id: string
  file: File
  previewUrl: string
}

export type UploadedImageAttachment = PromptAttachment & {
  previewUrl: string
  /**
   * The session the bytes were stored under, when the host's storage is
   * session-scoped. A send to any other session must refuse it rather than
   * let the environment reject the whole turn.
   */
  sessionId?: string
  /**
   * The workspace a draft's upload is held for. Set with no `sessionId`: the
   * draft had no session, and its launch hands the image to the new one.
   */
  workspaceId?: string
}

/** What an upload is stored for: the open session, or a draft's workspace. */
export type UploadScope = { sessionId: string } | { workspaceId: string }

export function sameUploadScope(a: UploadScope | null, b: UploadScope | null): boolean {
  if (!a || !b) return a === b
  return 'sessionId' in a
    ? 'sessionId' in b && a.sessionId === b.sessionId
    : 'workspaceId' in b && a.workspaceId === b.workspaceId
}

/**
 * An image the environment stores. Its bytes are read through the environment
 * client's authorized route, never from a URL a view could put in `src`.
 */
export type ArtifactSource = {
  sessionId: string
  artifactId: string
}

/**
 * What a user bubble shows before its persisted body arrives: the composer's
 * local preview, or an artifact the send already named.
 */
export type OptimisticImage = {
  id: string
  name: string
  previewUrl?: string
  artifact?: ArtifactSource
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
