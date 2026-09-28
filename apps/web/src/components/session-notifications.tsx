import { useEffect, useRef } from 'react'
import { useSidebarData } from '@openmanager/app-core/providers/sidebar-provider'
import {
  browserStorage,
  noticeBody,
  notificationSupport,
  readNotificationsEnabled,
  sessionNotice,
} from '../lib/session-notifications'

/**
 * Raises a browser notification when a session finishes, fails, or stops for
 * input. Silent for the session already in front of you, and for subagent
 * sessions, whose parent speaks for them. Renders nothing.
 */
export function SessionNotifications({
  openSession,
}: {
  openSession: (sessionId: string) => void
}) {
  const { sessionsByWorkspace, activeSessionId } = useSidebarData()
  // null until the first look: sessions already done or waiting when the
  // page loads are not news.
  const seen = useRef<Map<string, string> | null>(null)
  const openRef = useRef(openSession)
  openRef.current = openSession

  useEffect(() => {
    const previous = seen.current
    const next = new Map<string, string>()
    const notices: Array<{ id: string; title: string; body: string }> = []
    for (const sessions of Object.values(sessionsByWorkspace)) {
      for (const session of sessions) {
        next.set(session.externalId, session.status)
        if (!previous || session.parentExternalId) continue
        const notice = sessionNotice(previous.get(session.externalId), session.status)
        if (!notice) continue
        notices.push({
          id: session.externalId,
          title: session.title || 'Session',
          body: noticeBody(notice),
        })
      }
    }
    seen.current = next
    if (notices.length === 0) return
    if (notificationSupport() !== 'granted' || !readNotificationsEnabled(browserStorage())) return
    const watching = document.visibilityState === 'visible' && document.hasFocus()
    for (const notice of notices) {
      if (watching && notice.id === activeSessionId) continue
      try {
        // The tag makes a newer notice for the same session replace the older.
        const notification = new Notification(notice.title, { body: notice.body, tag: notice.id })
        notification.onclick = () => {
          window.focus()
          openRef.current(notice.id)
          notification.close()
        }
      } catch {
        // Some browsers (Android Chrome) only notify through a service worker.
      }
    }
  }, [sessionsByWorkspace, activeSessionId])

  return null
}
