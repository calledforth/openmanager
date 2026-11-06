import { BellIcon } from 'phosphor-react-native'
import { useSyncExternalStore } from 'react'

import { sessionWatch } from '../notifications'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { notificationsRow } from './notifications'
import { SettingsRow } from './SettingsRow'
import { Toggle } from './Toggle'

/**
 * Session notices: one switch. Turning it on asks Android for the permission
 * and starts the background connection that lets them arrive with the app
 * closed; its cost (a permanent notification, some battery) is said under it.
 * Not shown where the phone cannot notify (the web export).
 */
export function NotificationsSection() {
  const theme = usePhoneTheme()
  const state = useSyncExternalStore(sessionWatch.subscribe, sessionWatch.getState)
  const row = notificationsRow(state)
  if (!row) return null
  const press = () => {
    if (row.busy) return
    if (row.action === 'settings') sessionWatch.openSettings()
    else if (row.action === 'enable') void sessionWatch.enable()
    else void sessionWatch.disable()
  }
  return (
    <>
      <SectionLabel>Notifications</SectionLabel>
      <SettingsRow
        icon={<BellIcon size={17} color={theme.muted} />}
        title="Session notifications"
        sub={row.sub}
        accessibilityLabel="Session notifications"
        trailing={
          <Toggle
            value={row.on}
            label="Session notifications"
            disabled={row.busy}
            onChange={press}
          />
        }
      />
    </>
  )
}
