import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi, type PermissionSelection } from './app-ui-provider'

import {
  PermissionStateContext,
  type PendingPermission,
  type PermissionStateValue,
} from '@openmanager/app-core/providers/permission-provider'
export * from '@openmanager/app-core/providers/permission-provider'

export function PermissionStateProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const pendingPermission =
    (useTrackedQuery(
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
