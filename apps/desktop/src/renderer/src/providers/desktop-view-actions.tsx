import { useCallback, useMemo, type ReactNode } from 'react'
import type { ProviderId } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { ViewActionsContext, type ViewActions } from '@openmanager/app-core/providers/view-actions'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { usePlatformCapabilities } from '@openmanager/app-core/providers/platform-provider'
import type {
  DraftImageAttachment,
  UploadedImageAttachment,
} from '@openmanager/app-core/lib/attachments'
import { useTrackedMutation } from '../lib/convex-telemetry'

const iconRequests = new Map<string, Promise<string | null>>()
function resolveWorkspaceIcon(path: string) {
  let request = iconRequests.get(path)
  if (!request) {
    request = window.electronAPI.resolveWorkspaceIcon(path).catch(() => null)
    iconRequests.set(path, request)
  }
  return request
}

function getModelImageSupport(providerId: ProviderId, modelId: string) {
  return window.electronAPI.getModelImageSupport(providerId, modelId)
}

/** Host actions for the shared views: subagent navigation through session
 * state, workspace icons and model vision checks over IPC, and image uploads
 * through Convex storage. */
export function DesktopViewActions({ children }: { children: ReactNode }) {
  const { activeSessionId, openChildSession } = useSessionState()
  const { currentClientId } = usePlatformCapabilities()
  const generateUploadUrl = useTrackedMutation(
    'attachments.generateUploadUrl',
    (api as any).attachments.generateUploadUrl,
  )
  const registerAttachment = useTrackedMutation(
    'attachments.register',
    (api as any).attachments.register,
  )
  const removeAttachments = useTrackedMutation(
    'attachments.removeMany',
    (api as any).attachments.removeMany,
  )

  const uploadAttachments = useCallback(
    async (drafts: DraftImageAttachment[]) => {
      if (!currentClientId) throw new Error('Client identity unavailable')
      const uploaded: UploadedImageAttachment[] = []
      try {
        for (const draft of drafts) {
          const uploadUrl = (await generateUploadUrl({ clientId: currentClientId })) as string
          const response = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': draft.file.type },
            body: draft.file,
          })
          if (!response.ok) throw new Error(`Failed to upload ${draft.file.name}`)
          const result = (await response.json()) as { storageId?: string }
          if (!result.storageId) {
            throw new Error(`Upload did not return storage for ${draft.file.name}`)
          }
          const attachmentId = (await registerAttachment({
            storageId: result.storageId,
            clientId: currentClientId,
            name: draft.file.name,
            mimeType: draft.file.type,
            size: draft.file.size,
          })) as string
          uploaded.push({
            id: attachmentId,
            name: draft.file.name,
            mimeType: draft.file.type,
            size: draft.file.size,
            previewUrl: draft.previewUrl,
          })
        }
        return uploaded
      } catch (error) {
        // A partial batch is useless to the prompt; release what did land.
        if (uploaded.length) {
          await removeAttachments({
            ids: uploaded.map((attachment) => attachment.id),
            clientId: currentClientId,
          }).catch(() => undefined)
        }
        throw error
      }
    },
    [currentClientId, generateUploadUrl, registerAttachment, removeAttachments],
  )

  const discardAttachments = useCallback(
    async (attachments: UploadedImageAttachment[]) => {
      if (!currentClientId || attachments.length === 0) return
      await removeAttachments({
        ids: attachments.map((attachment) => attachment.id),
        clientId: currentClientId,
      })
    },
    [currentClientId, removeAttachments],
  )

  const value = useMemo<ViewActions>(
    () => ({
      activeSessionId,
      openChildSession,
      resolveWorkspaceIcon,
      uploadAttachments,
      discardAttachments,
      getModelImageSupport,
    }),
    [activeSessionId, discardAttachments, openChildSession, uploadAttachments],
  )
  return <ViewActionsContext.Provider value={value}>{children}</ViewActionsContext.Provider>
}
