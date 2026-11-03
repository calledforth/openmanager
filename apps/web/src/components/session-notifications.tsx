import { useEffect, useMemo, useRef } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
  selectSessionList,
  type EnvironmentClient,
  type EnvironmentState,
} from '@openmanager/environment-client'
import { sidebarRowKey } from '@openmanager/app-core/components/sidebar/sidebar-sessions'
import { groupSidebarSessions } from '@openmanager/app-core/providers/sidebar-rows'
import {
  browserStorage,
  noticeBody,
  notificationSupport,
  readNotificationsEnabled,
  sessionNotice,
} from '../lib/session-notifications'
import { addressOf, useAddressLookup } from '../providers/address-environment'
import { useConnection } from '../providers/connection-provider'
import { useEnvironmentClients } from '../providers/environment-client-provider'

/** What one environment's sessions last said, as this page saw it. */
type Watched = {
  /**
   * The environment has been caught up with on this page, so a change from
   * here on is news. What was kept of it from an earlier visit is not: a
   * session cached as running and found finished ended while nobody was here.
   */
  live: boolean
  sessions: EnvironmentState['sessions']
  statuses: ReadonlyMap<string, string>
}

type Notice = { sessionId: string; title: string; body: string }

const NOTHING: readonly never[] = []

function rowsOf(state: EnvironmentState, environmentId: string) {
  const grouped = groupSidebarSessions({
    sessions: selectSessionList(state),
    unsent: NOTHING,
    workspaces: NOTHING,
    environmentId,
  })
  return Object.values(grouped).flat()
}

/** Moves `watched` up to this state, and says what about that is news. */
function catchUp(
  watched: Map<string, Watched>,
  environmentId: string,
  state: EnvironmentState,
): readonly Notice[] {
  const { connection, sessions } = state
  const caughtUp = connection.phase === 'connected' && connection.caughtUp !== false
  const before = watched.get(environmentId)
  // Every store update lands here, a streamed token included.
  if (before?.sessions === sessions && (before.live || !caughtUp)) return NOTHING
  const notices: Notice[] = []
  const statuses = new Map<string, string>()
  for (const session of rowsOf(state, environmentId)) {
    statuses.set(session.externalId, session.status)
    if (!before?.live || session.parentExternalId) continue
    const notice = sessionNotice(before.statuses.get(session.externalId), session.status)
    if (!notice) continue
    notices.push({
      sessionId: session.externalId,
      title: session.title || 'Session',
      body: noticeBody(notice, session.waitingOn),
    })
  }
  watched.set(environmentId, { live: before?.live || caughtUp, sessions, statuses })
  return notices
}

/**
 * Raises a browser notification when a session in any saved environment
 * finishes, fails, or stops for input. Silent for the session already in front
 * of you, and for subagent sessions, whose parent speaks for them. It watches
 * the clients themselves, outside React: nothing renders for it, wherever a
 * token streams. Renders nothing.
 */
export function SessionNotifications({
  clients,
  names,
  isOnScreen,
  openSession,
}: {
  clients: Readonly<Record<string, EnvironmentClient>>
  /** Every saved environment's name by its ID. With several, a notice names its own. */
  names: Readonly<Record<string, string>>
  isOnScreen: (environmentId: string, sessionId: string) => boolean
  openSession: (environmentId: string, sessionId: string) => void
}) {
  const watched = useRef(new Map<string, Watched>())
  // A notice is clicked long after it was raised, and reads what is true then.
  const latest = useRef({ names, isOnScreen, openSession })
  latest.current = { names, isOnScreen, openSession }

  useEffect(() => {
    const raise = (environmentId: string, notices: readonly Notice[]) => {
      if (notices.length === 0) return
      if (notificationSupport() !== 'granted' || !readNotificationsEnabled(browserStorage())) return
      const watching = document.visibilityState === 'visible' && document.hasFocus()
      const saved = latest.current.names
      const name = Object.keys(saved).length > 1 ? saved[environmentId] : undefined
      for (const { sessionId, title, body } of notices) {
        if (watching && latest.current.isOnScreen(environmentId, sessionId)) continue
        try {
          const notification = new Notification(title, {
            body: name ? `${body} · ${name}` : body,
            // The tag makes a newer notice for the same session replace the
            // older, and only that session: ids repeat across environments.
            tag: sidebarRowKey(environmentId, sessionId),
          })
          notification.onclick = () => {
            window.focus()
            latest.current.openSession(environmentId, sessionId)
            notification.close()
          }
        } catch {
          // Some browsers (Android Chrome) only notify through a service worker.
        }
      }
    }
    const leave = Object.entries(clients).map(([environmentId, client]) => {
      const look = () =>
        raise(environmentId, catchUp(watched.current, environmentId, client.getState()))
      look()
      return client.subscribe(look)
    })
    return () => {
      for (const stop of leave) stop()
    }
  }, [clients])

  // A client can come and go while its environment stays saved, and what was
  // seen stands across that. An environment removed is forgotten.
  useEffect(() => {
    for (const environmentId of watched.current.keys()) {
      if (!Object.hasOwn(names, environmentId)) watched.current.delete(environmentId)
    }
  }, [names])

  return null
}

/**
 * Notifications for every saved environment, for as long as the app is up:
 * neither a move between environments nor an open one with no client stops
 * them. A click is a card's click: the address does not say whose session it
 * means, so the notice tells the lookup.
 */
export function EnvironmentNotifications({ openId }: { openId: string | null }) {
  const { clients } = useEnvironmentClients()
  const { environments } = useConnection()
  const { prefer } = useAddressLookup()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const names = useMemo(
    () => Object.fromEntries(environments.map((item) => [item.environmentId, item.label])),
    [environments],
  )
  const isOnScreen = (environmentId: string, sessionId: string) => {
    // Not the open environment's active session: that stays set behind Settings.
    const address = addressOf(pathname)
    return address?.kind === 'session' && address.id === sessionId && openId === environmentId
  }
  const openSession = (environmentId: string, sessionId: string) => {
    // Removed since: its id could mean something else in one that's left.
    // One that's saved but unreachable is the lookup's to explain.
    if (!Object.hasOwn(names, environmentId)) return
    prefer({ kind: 'session', id: sessionId }, environmentId)
    void navigate({ to: '/sessions/$sessionId', params: { sessionId } })
  }
  return (
    <SessionNotifications
      clients={clients}
      names={names}
      isOnScreen={isOnScreen}
      openSession={openSession}
    />
  )
}
