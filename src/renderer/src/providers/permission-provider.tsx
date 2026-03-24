import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { api } from '@convex/_generated/api'
import { useTrackedQuery } from '../lib/convex-telemetry'
import { useAppUi } from './app-ui-provider'

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

interface PermissionStateValue {
  activeSessionId: string | null
  pendingPermission: PendingPermission | null
  resolvePermission: (approved: boolean) => Promise<void>
}

const PermissionStateContext = createContext<PermissionStateValue | null>(null)

export function usePermissionState() {
  const ctx = useContext(PermissionStateContext)
  if (!ctx) throw new Error('usePermissionState must be used within PermissionStateProvider')
  return ctx
}

export function PermissionStateProvider({ children }: { children: ReactNode }) {
  const ui = useAppUi()
  const pendingPermission = (useTrackedQuery(
    'permissions.getPendingForSession',
    (api as any).permissions.getPendingForSession,
    ui.activeSessionId ? { sessionExternalId: ui.activeSessionId } : 'skip',
  ) as PendingPermission | null | undefined) ?? null

  const resolvePermission = async (approved: boolean) => {
    if (!ui.activeSessionId || !pendingPermission) return
    await ui.resolvePermission(ui.activeSessionId, pendingPermission.requestId, approved)
  }

  const value = useMemo<PermissionStateValue>(
    () => ({
      activeSessionId: ui.activeSessionId,
      pendingPermission,
      resolvePermission,
    }),
    [ui.activeSessionId, pendingPermission],
  )

  return <PermissionStateContext.Provider value={value}>{children}</PermissionStateContext.Provider>
}
