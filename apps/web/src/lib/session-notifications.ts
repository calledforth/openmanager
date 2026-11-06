// Browser notifications for sessions that finish or stop to ask something.
// Which changes are worth interrupting someone for is shared with the phone
// (`@openmanager/app-core/lib/session-notices`); this remembers whether they
// want to be interrupted at all.

export const NOTIFICATIONS_STORAGE_KEY = 'openmanager-notifications'

export {
  noticeBody,
  sessionNotice,
  type SessionNotice,
} from '@openmanager/app-core/lib/session-notices'

export type NotificationSupport = 'unsupported' | NotificationPermission

export function notificationSupport(): NotificationSupport {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return window.Notification.permission
}

// Storage is the device's shared record, so every open tab follows it. Two
// stand-ins cover storage failing: a choice it refused to keep, which holds on
// this page until a write lands, and the last value this page saw, used when
// storage cannot be read. Either way an Off choice stays off.
let unsavedChoice: boolean | null = null
let lastKnown: boolean | null = null

/** On unless turned off: the browser's own permission is the first gate. */
export function readNotificationsEnabled(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  if (unsavedChoice !== null) return unsavedChoice
  try {
    if (!storage) throw new Error('no storage')
    lastKnown = storage.getItem(NOTIFICATIONS_STORAGE_KEY) !== 'off'
    return lastKnown
  } catch {
    return lastKnown ?? true
  }
}

export function writeNotificationsEnabled(
  storage: Pick<Storage, 'setItem'> | undefined,
  enabled: boolean,
) {
  try {
    if (!storage) throw new Error('no storage')
    storage.setItem(NOTIFICATIONS_STORAGE_KEY, enabled ? 'on' : 'off')
    unsavedChoice = null
    lastKnown = enabled
  } catch {
    unsavedChoice = enabled
  }
}

/** Tests only: forget what this page remembers about the choice. */
export function forgetUnsavedNotificationsChoice() {
  unsavedChoice = null
  lastKnown = null
}

export function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}
