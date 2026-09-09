import { useMemo, type ReactNode } from 'react'
import { ViewActionsContext } from '@openmanager/app-core/providers/view-actions'
import { useAppUi } from './app-ui-provider'

const iconRequests = new Map<string, Promise<string | null>>()
function resolveWorkspaceIcon(path: string) {
  let request = iconRequests.get(path)
  if (!request) {
    request = window.electronAPI.resolveWorkspaceIcon(path).catch(() => null)
    iconRequests.set(path, request)
  }
  return request
}

export function DesktopViewActions({ children }: { children: ReactNode }) {
  const { activeSessionId, openChildSession } = useAppUi()
  const value = useMemo(
    () => ({ activeSessionId, openChildSession, resolveWorkspaceIcon }),
    [activeSessionId, openChildSession],
  )
  return <ViewActionsContext.Provider value={value}>{children}</ViewActionsContext.Provider>
}
