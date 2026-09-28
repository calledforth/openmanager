// Browser notifications for sessions that finish or stop to ask something.
// The sidebar already knows each session's status; this only decides which
// changes are worth interrupting someone for, and remembers whether they
// want to be interrupted at all.

export const NOTIFICATIONS_STORAGE_KEY = 'openmanager-notifications'

export type SessionNotice = 'done' | 'waiting' | 'error'

const BUSY = new Set(['running', 'busy'])

/**
 * What a status change means to someone not looking: a turn that ended, one
 * that stopped for input, or one that failed. Anything else — first sight of
 * a session, starting work, being opened — says nothing.
 */
export function sessionNotice(previous: string | undefined, next: string): SessionNotice | null {
  if (previous === undefined || previous === next) return null
  if (next === 'waiting') return 'waiting'
  if (!BUSY.has(previous)) return null
  // `ready` too: a session on screen in a visible tab is acknowledged the
  // moment it finishes, so `done` can be skipped on its way to `ready`.
  if (next === 'done' || next === 'ready') return 'done'
  if (next === 'error') return 'error'
  return null
}

const NOTICE_BODY: Record<SessionNotice, string> = {
  done: 'Finished',
  waiting: 'Needs your input',
  error: 'Stopped with an error',
}

export function noticeBody(notice: SessionNotice): string {
  return NOTICE_BODY[notice]
}

export type NotificationSupport = 'unsupported' | NotificationPermission

export function notificationSupport(): NotificationSupport {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return window.Notification.permission
}

// The choice made on this page. It outranks storage, so turning notifications
// off holds even where storage is unavailable or refuses the write.
let chosenThisPage: boolean | null = null

/** On unless turned off: the browser's own permission is the first gate. */
export function readNotificationsEnabled(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  if (chosenThisPage !== null) return chosenThisPage
  try {
    return storage?.getItem(NOTIFICATIONS_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeNotificationsEnabled(
  storage: Pick<Storage, 'setItem'> | undefined,
  enabled: boolean,
) {
  chosenThisPage = enabled
  try {
    storage?.setItem(NOTIFICATIONS_STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    /* best effort */
  }
}

export function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}
