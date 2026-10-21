import { useMemo } from 'react'
import { notConnected } from './inert'

// Inert until the chat screen sends through the environment client: every
// action rejects, which the screens already show as a failed attempt.

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

export function useSessionActions(_clientId: string | null) {
  return useMemo(
    () => ({
      sendMessage: (_params: SendMessageParams) => notConnected(),
      abortSession: (_params: AbortSessionParams) => notConnected(),
      resolvePermission: (_params: ResolvePermissionParams) => notConnected(),
      deleteSession: (_params: DeleteSessionParams) => notConnected(),
    }),
    [],
  )
}
