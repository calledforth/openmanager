import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { PermissionOption } from '@agentpack/contract'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi, type PermissionSelection } from './app-ui-provider'

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

interface PermissionStateValue {
  activeSessionId: string | null
  pendingPermission: PendingPermission | null
  /** True when an inline prompt attached to a tool call is showing the pending request. */
  isPermissionClaimed: boolean
  /** Called by the inline tool-call prompt to suppress the fallback card. Returns a release fn. */
  claimPermission: (requestId: string) => () => void
  resolvePermission: (selection: PermissionSelection) => Promise<void>
}

const PermissionStateContext = createContext<PermissionStateValue | null>(null)

export function usePermissionState() {
  const ctx = useContext(PermissionStateContext)
  if (!ctx) throw new Error('usePermissionState must be used within PermissionStateProvider')
  return ctx
}

/** Safe variant for components also rendered outside the provider (e.g. Storybook). */
export function usePermissionStateOptional() {
  return useContext(PermissionStateContext)
}

export function PermissionStateProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const pendingPermission = (useTrackedQuery(
    'permissions.getPendingForSession',
    api.permissions.getPendingForSession,
    ui.activeSessionId ? { sessionExternalId: ui.activeSessionId } : 'skip',
  ) as PendingPermission | null | undefined) ?? null

  const [claimedRequestId, setClaimedRequestId] = useState<string | null>(null)

  const claimPermission = useCallback((requestId: string) => {
    setClaimedRequestId(requestId)
    return () => {
      setClaimedRequestId((current) => (current === requestId ? null : current))
    }
  }, [])

  const resolvePermission = useCallback(
    async (selection: PermissionSelection) => {
      if (!ui.activeSessionId || !pendingPermission) return
      await ui.resolvePermission(ui.activeSessionId, pendingPermission.requestId, selection)
    },
    [ui, pendingPermission],
  )

  const isPermissionClaimed =
    pendingPermission != null && claimedRequestId === pendingPermission.requestId

  const value = useMemo<PermissionStateValue>(
    () => ({
      activeSessionId: ui.activeSessionId,
      pendingPermission,
      isPermissionClaimed,
      claimPermission,
      resolvePermission,
    }),
    [
      ui.activeSessionId,
      pendingPermission,
      isPermissionClaimed,
      claimPermission,
      resolvePermission,
    ],
  )

  return <PermissionStateContext.Provider value={value}>{children}</PermissionStateContext.Provider>
}
