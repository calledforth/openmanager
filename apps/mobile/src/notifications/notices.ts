/**
 * Which of an environment's session changes are news, as the phone saw them.
 * The rule for one change is shared with web (`sessionNotice`); this is the
 * bookkeeping around it, the same as web's `session-notifications.tsx`: what
 * each session last said, and whether the environment has been caught up
 * with, so a change from then on is news. A status kept from before the
 * connection is not news: a session cached as running and found finished
 * ended while nobody was watching.
 */
import { selectSessionList, type EnvironmentState } from '@openmanager/environment-client'
import { groupSidebarSessions } from '@openmanager/app-core/providers/sidebar-rows'
import { noticeBody, sessionNotice } from '@openmanager/app-core/lib/session-notices'

/** What one environment's sessions last said, as the phone saw them. */
export type Watched = {
  live: boolean
  sessions: EnvironmentState['sessions']
  statuses: ReadonlyMap<string, string>
}

export type Notice = { sessionId: string; title: string; body: string }

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
export function catchUp(
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
    // Subagent sessions are spoken for by their parent.
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

/** The link a notice opens: the session's page, in its environment, in the app. */
export function sessionLink(environmentId: string, sessionId: string): string {
  return `openmanager://session/${encodeURIComponent(environmentId)}/${encodeURIComponent(sessionId)}`
}
