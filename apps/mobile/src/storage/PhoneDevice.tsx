import { useMemo, type ReactNode } from 'react'
import { DeviceHostContext } from '@openmanager/app-core/logic'

import { phoneStorage } from './index'

/**
 * The phone's own storage for what this device remembers about itself (what
 * Send does while a turn runs), for screens outside any environment: the
 * environments' providers hand it to the shared logic, but Settings and a
 * sample session have none above them.
 */
export function PhoneDevice({ children }: { children: ReactNode }) {
  const host = useMemo(() => ({ storage: phoneStorage.device }), [])
  return <DeviceHostContext.Provider value={host}>{children}</DeviceHostContext.Provider>
}
