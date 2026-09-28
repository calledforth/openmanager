import { useEffect, useState, type ReactNode } from 'react'
import {
  browserStorage,
  notificationSupport,
  readNotificationsEnabled,
  writeNotificationsEnabled,
  type NotificationSupport,
} from '../lib/session-notifications'

export type NotificationsChoice = 'on' | 'off'

export const NOTIFICATIONS_CHOICES: ReadonlyArray<{ id: NotificationsChoice; label: string }> = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
]

function blockedReason(support: NotificationSupport): string | null {
  if (support === 'unsupported') return 'This browser cannot show notifications.'
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return 'Browsers only allow notifications on HTTPS or localhost. Open OpenManager over one of those to turn them on.'
  }
  if (support === 'denied') {
    return 'Notifications are blocked for this site. Allow them in the browser’s site settings, then turn them on here.'
  }
  return null
}

/**
 * Whether this browser notifies when a session finishes or needs input. The
 * choice is this device's; the browser's permission is asked for on the
 * first turn-on, since browsers only ask in answer to a click.
 */
export function NotificationsSettingControl({
  choices,
}: {
  choices: (
    value: NotificationsChoice,
    onChange: (value: NotificationsChoice) => void,
    disabled: boolean,
  ) => ReactNode
}) {
  const [support, setSupport] = useState(notificationSupport)
  const [enabled, setEnabled] = useState(() => readNotificationsEnabled(browserStorage()))
  const [asking, setAsking] = useState(false)
  // Permission can change outside the page, in the browser's site settings.
  // Look again when it reports a change, or when the user comes back.
  useEffect(() => {
    const refresh = () => setSupport(notificationSupport())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    let status: PermissionStatus | null = null
    let live = true
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((result) => {
        if (!live) return
        status = result
        status.addEventListener('change', refresh)
      })
      .catch(() => undefined)
    return () => {
      live = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      status?.removeEventListener('change', refresh)
    }
  }, [])
  const blocked = blockedReason(support)
  const value: NotificationsChoice = enabled && support === 'granted' ? 'on' : 'off'

  const change = async (next: NotificationsChoice) => {
    if (next === 'off') {
      writeNotificationsEnabled(browserStorage(), false)
      setEnabled(false)
      return
    }
    let permission = support
    if (permission === 'default') {
      setAsking(true)
      try {
        permission = await window.Notification.requestPermission()
      } catch {
        permission = notificationSupport()
      } finally {
        setAsking(false)
      }
      setSupport(permission)
    }
    if (permission !== 'granted') return
    writeNotificationsEnabled(browserStorage(), true)
    setEnabled(true)
  }

  return (
    <>
      {choices(value, (next) => void change(next), asking || blocked !== null)}
      {blocked ? <p className="mt-2 text-[12px] text-muted-foreground">{blocked}</p> : null}
    </>
  )
}
