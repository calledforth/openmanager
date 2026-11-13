import type { ReactNode } from 'react'

import { HydratedDevice } from './device-host'
import { phoneStorage } from './index'

/**
 * The phone's own storage for what this device remembers about itself (what
 * Send does while a turn runs), for screens outside any environment: the
 * environments' providers hand it to the shared logic, but Settings and a
 * sample session have none above them. Provided once it has loaded; with
 * `hold`, what it wraps waits for that (see `HydratedDevice`).
 */
export function PhoneDevice({ hold = false, children }: { hold?: boolean; children: ReactNode }) {
  return (
    <HydratedDevice store={phoneStorage} hold={hold}>
      {children}
    </HydratedDevice>
  )
}
