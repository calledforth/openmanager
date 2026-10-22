// Inert until permissions come from the environment client's interactions.

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

export function usePendingPermission(
  _sessionExternalId: string | null | undefined,
): PendingPermission | null {
  return null
}
