import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'

import {
  PermissionStateContext,
  type PendingPermission,
  type PermissionSelection,
  type PermissionStateValue,
} from '@openmanager/app-core/providers/permission-provider'
export * from '@openmanager/app-core/providers/permission-provider'

export function PermissionStateProvider({ children }: { children: ReactNode }) {
  const { activeSessionId } = useSessionState()
  const { resolvePermission: resolveSessionPermission } = useActiveThreadState()
  const pendingPermission =
    (useTrackedQuery(
      'permissions.getPendingForSession',
      api.permissions.getPendingForSession,
      activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
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
      if (!activeSessionId || !pendingPermission) return
      await resolveSessionPermission(activeSessionId, pendingPermission.requestId, selection)
    },
    [activeSessionId, pendingPermission, resolveSessionPermission],
  )

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
