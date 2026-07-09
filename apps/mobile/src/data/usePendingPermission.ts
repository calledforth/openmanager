import { api } from '@openmanager/convex/_generated/api'
import { useQuery } from 'convex/react'

// Latest pending permission for a session, or null. Shape mirrors
// `permissions.getPendingForSession` (plan §3).

export interface PendingPermission {
  requestId: string
  permission?: string
  toolName: string
  description: string
  input?: unknown
  patterns?: unknown
  alwaysPatterns?: unknown
  createdAt: number
  updatedAt: number
}

export function usePendingPermission(sessionExternalId: string | null | undefined) {
  const pending = useQuery(
    api.permissions.getPendingForSession,
    sessionExternalId ? { sessionExternalId } : 'skip',
  )

  return (pending ?? null) as PendingPermission | null
}
