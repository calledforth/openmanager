import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { PermissionOption } from '@agentpack/contract'
export type PermissionSelection = { optionId: string } | { approved: boolean }
export interface PendingPermission {
  requestId: string
  toolCallId?: string
  permission?: string
  toolName: string
  description: string
  input?: unknown
  patterns?: unknown
  alwaysPatterns?: unknown
  options?: PermissionOption[]
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

export interface PermissionStateValue {
  activeSessionId: string | null
  pendingPermission: PendingPermission | null
  /** True when an inline prompt attached to a tool call is showing the pending request. */
  isPermissionClaimed: boolean
  /** Called by the inline tool-call prompt to suppress the fallback card. Returns a release fn. */
  claimPermission: (requestId: string) => () => void
  resolvePermission: (selection: PermissionSelection) => Promise<void>
}

export const PermissionStateContext = createContext<PermissionStateValue | null>(null)

export function usePermissionState() {
  const ctx = useContext(PermissionStateContext)
  if (!ctx) throw new Error('usePermissionState must be used within PermissionStateProvider')
  return ctx
}

/** Safe variant for components also rendered outside the provider (e.g. Storybook). */
export function usePermissionStateOptional() {
  return useContext(PermissionStateContext)
}

/**
 * Owns the claim handshake between the inline tool-call prompt and the
 * bottom-of-chat fallback. Hosts pass in the pending request and how to
 * answer it; where that comes from (Convex row, environment interaction) is
 * theirs to decide.
 */
export function PermissionStateProvider({
  activeSessionId,
  pendingPermission,
  resolvePermission,
  children,
}: {
  activeSessionId: string | null
  pendingPermission: PendingPermission | null
  resolvePermission: (selection: PermissionSelection) => Promise<void>
  children: ReactNode
}) {
  const [claimedRequestId, setClaimedRequestId] = useState<string | null>(null)

  const claimPermission = useCallback((requestId: string) => {
    setClaimedRequestId(requestId)
    return () => {
      setClaimedRequestId((current) => (current === requestId ? null : current))
    }
  }, [])

  const isPermissionClaimed =
    pendingPermission != null && claimedRequestId === pendingPermission.requestId

  const value = useMemo<PermissionStateValue>(
    () => ({
      activeSessionId,
      pendingPermission,
      isPermissionClaimed,
      claimPermission,
      resolvePermission,
    }),
    [activeSessionId, pendingPermission, isPermissionClaimed, claimPermission, resolvePermission],
  )

  return <PermissionStateContext.Provider value={value}>{children}</PermissionStateContext.Provider>
}
