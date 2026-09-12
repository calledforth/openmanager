import { useCallback, type ReactNode } from 'react'
import { api } from '@openmanager/convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useSessionState } from '@openmanager/app-core/providers/session-provider'
import { useActiveThreadState } from '@openmanager/app-core/providers/active-thread-provider'
import {
  PermissionStateProvider,
  type PendingPermission,
  type PermissionSelection,
} from '@openmanager/app-core/providers/permission-provider'
export {
  usePermissionState,
  usePermissionStateOptional,
} from '@openmanager/app-core/providers/permission-provider'

/** The pending permission row from Convex, answered through the active thread. */
export function DesktopPermissionStateProvider({ children }: { children: ReactNode }) {
  const { activeSessionId } = useSessionState()
  const { resolvePermission: resolveSessionPermission } = useActiveThreadState()
  const pendingPermission =
    (useTrackedQuery(
      'permissions.getPendingForSession',
      api.permissions.getPendingForSession,
      activeSessionId ? { sessionExternalId: activeSessionId } : 'skip',
    ) as PendingPermission | null | undefined) ?? null

  const resolvePermission = useCallback(
    async (selection: PermissionSelection) => {
      if (!activeSessionId || !pendingPermission) return
      await resolveSessionPermission(activeSessionId, pendingPermission.requestId, selection)
    },
    [activeSessionId, pendingPermission, resolveSessionPermission],
  )

  return (
    <PermissionStateProvider
      activeSessionId={activeSessionId}
      pendingPermission={pendingPermission}
      resolvePermission={resolvePermission}
    >
      {children}
    </PermissionStateProvider>
  )
}
