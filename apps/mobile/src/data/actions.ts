import { api } from '@openmanager/convex/_generated/api'
import { useMutation } from 'convex/react'
import { useCallback } from 'react'

// Action layer mirroring the desktop job payloads exactly (plan §3). `send`
// goes through `jobs.submitMessage` (server builds the payload); everything
// else is a JSON-encoded `jobs.submit` job whose keys the desktop worker's
// `JSON.parse(job.payload)` reads verbatim.

export interface SendMessageParams {
  workspacePath: string
  sessionExternalId: string
  content: string
}

export interface AbortSessionParams {
  workspacePath: string
  sessionExternalId: string
}

export interface ResolvePermissionParams {
  workspacePath: string
  sessionExternalId: string
  permissionId: string
  approved: boolean
}

export interface DeleteSessionParams {
  workspacePath: string
  sessionExternalId: string
}

export function useSessionActions(clientId: string | null) {
  const submit = useMutation(api.jobs.submit)
  const submitMessage = useMutation(api.jobs.submitMessage)

  const requireClientId = useCallback(() => {
    if (!clientId) throw new Error('Client identity unavailable')
    return clientId
  }, [clientId])

  const sendMessage = useCallback(
    async (params: SendMessageParams) => {
      const id = requireClientId()
      const content = params.content.trim()
      if (!content) return
      await submitMessage({
        workspacePath: params.workspacePath,
        sessionExternalId: params.sessionExternalId,
        content,
        clientId: id,
      })
    },
    [requireClientId, submitMessage],
  )

  const abortSession = useCallback(
    async (params: AbortSessionParams) => {
      const id = requireClientId()
      await submit({
        workspacePath: params.workspacePath,
        type: 'abort',
        payload: JSON.stringify({
          workspacePath: params.workspacePath,
          sessionExternalId: params.sessionExternalId,
        }),
        clientId: id,
        sessionExternalId: params.sessionExternalId,
      })
    },
    [requireClientId, submit],
  )

  const resolvePermission = useCallback(
    async (params: ResolvePermissionParams) => {
      const id = requireClientId()
      await submit({
        workspacePath: params.workspacePath,
        type: 'resolve_permission',
        payload: JSON.stringify({
          workspacePath: params.workspacePath,
          sessionExternalId: params.sessionExternalId,
          permissionId: params.permissionId,
          approved: params.approved,
        }),
        clientId: id,
        sessionExternalId: params.sessionExternalId,
      })
    },
    [requireClientId, submit],
  )

  const deleteSession = useCallback(
    async (params: DeleteSessionParams) => {
      const id = requireClientId()
      await submit({
        workspacePath: params.workspacePath,
        type: 'delete_session',
        payload: JSON.stringify({
          workspacePath: params.workspacePath,
          sessionExternalId: params.sessionExternalId,
        }),
        clientId: id,
        sessionExternalId: params.sessionExternalId,
      })
    },
    [requireClientId, submit],
  )

  return { sendMessage, abortSession, resolvePermission, deleteSession }
}
