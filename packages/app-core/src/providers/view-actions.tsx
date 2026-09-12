import { createContext, useContext } from 'react'
import type { ProviderId } from '@agentpack/contract'
import type { DraftImageAttachment, UploadedImageAttachment } from '../lib/attachments'

/**
 * Host-supplied actions that have no place in the environment client: they
 * touch the host's file system, its upload storage, or its process model.
 * Every member is optional; a view without it hides the affordance.
 */
export interface ViewActions {
  activeSessionId: string | null
  openChildSession?: (childId: string, parentId: string) => Promise<void>
  resolveWorkspaceIcon?: (path: string) => Promise<string | null>
  /** Upload the composer's image drafts and return what a prompt can reference. */
  uploadAttachments?: (drafts: DraftImageAttachment[]) => Promise<UploadedImageAttachment[]>
  /** Release uploads whose prompt never went out. Best effort. */
  discardAttachments?: (attachments: UploadedImageAttachment[]) => Promise<void>
  /** Whether a model can read images; `null` when the host cannot tell. */
  getModelImageSupport?: (providerId: ProviderId, modelId: string) => Promise<boolean | null>
}

export const ViewActionsContext = createContext<ViewActions>({ activeSessionId: null })
export const useViewActions = () => useContext(ViewActionsContext)
