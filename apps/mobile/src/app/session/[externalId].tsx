import { useIsFocused, useLocalSearchParams } from 'expo-router'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useEnvironmentClient, useEnvironmentClientOptional } from '@openmanager/app-core/logic'
import { selectActiveThread } from '@openmanager/environment-client'

import type { HomeSession } from '../../home/rows'
import { useHomeSource } from '../../home/source'
import { usePhoneConnection } from '../../environment/PhoneEnvironmentProvider'
import { childSessionsOf } from '../../session/child-sessions'
import { FixtureThreadStores, useFixtureThread } from '../../session/fixture-thread'
import { SessionThread } from '../../session/SessionThread'
import { threadNoticeSource, TurnNoticesProvider } from '../../session/turn-notices'
import { useReadOnlySession } from '../../session/useReadOnlySession'
import { useStatusLine } from '../../session/useStatusLine'

const untitled = (title: string | undefined) => title?.trim() || 'Untitled session'

/** The listed sessions under this one, kept as the same list while they are the same rows. */
function useChildSessions(sessions: readonly HomeSession[], sessionId: string) {
  return useMemo(() => childSessionsOf(sessions, sessionId), [sessions, sessionId])
}

/** A session of the paired environment, opened read-only for as long as the page is up. */
function LiveSession({ sessionId }: { sessionId: string }) {
  // The page in front owns the client's active session; one left under
  // another page keeps quiet until it is in front again.
  const focused = useIsFocused()
  const client = useEnvironmentClient()
  const { sessions } = useHomeSource()
  const { session, workspace, title, messages, phase, failure, retry } = useReadOnlySession(
    sessionId,
    { focused },
  )
  // The session's own thread, while it is the one the client has open: the
  // status line's times and the turns' notices come from it.
  const getThread = useCallback(() => {
    const state = client.getState()
    return state.activeSessionId === sessionId ? selectActiveThread(state) : null
  }, [client, sessionId])
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client])
  const status = useStatusLine(session, subscribe, getThread)
  const notices = useMemo(() => threadNoticeSource(subscribe, getThread), [getThread, subscribe])
  const childSessions = useChildSessions(sessions, sessionId)
  return (
    <TurnNoticesProvider source={notices}>
      <SessionThread
        title={untitled(session?.title ?? title)}
        project={workspace?.name}
        status={status}
        messages={messages}
        phase={phase}
        failure={failure}
        onRetry={retry}
        childSessions={childSessions}
      />
    </TurnNoticesProvider>
  )
}

/** A fixture row: its fixture thread, through the same page. */
function FixtureSession({ sessionId }: { sessionId: string }) {
  const { sessions, workspaces } = useHomeSource()
  const fixture = useFixtureThread(sessionId)
  const messages = useSyncExternalStore(fixture.subscribe, fixture.getMessages)
  const session = sessions.find((row) => row.externalId === sessionId)
  const workspace = workspaces.find((entry) => entry.path === session?.workspacePath)
  const status = useStatusLine(session, fixture.subscribe, fixture.getThread)
  const childSessions = useChildSessions(sessions, sessionId)
  return (
    <FixtureThreadStores stores={fixture.stores}>
      <TurnNoticesProvider source={fixture.notices}>
        <SessionThread
          title={untitled(session?.title)}
          project={workspace?.name}
          status={status}
          messages={messages}
          phase="ready"
          childSessions={childSessions}
        />
      </TurnNoticesProvider>
    </FixtureThreadStores>
  )
}

/** No client yet: nothing paired, the first connect, or a refused token. */
function Unreachable() {
  const { status } = usePhoneConnection()
  return (
    <SessionThread
      title="Session"
      status={null}
      messages={[]}
      phase={status === 'no_environment' || status === 'unauthorized' ? 'failed' : 'opening'}
      failure={
        status === 'unauthorized'
          ? 'Your environment no longer accepts this phone. Pair it again from Settings.'
          : 'Pair an environment from Settings to open its sessions.'
      }
    />
  )
}

export default function SessionScreen() {
  const { externalId } = useLocalSearchParams<{ externalId: string }>()
  const { kind } = useHomeSource()
  const client = useEnvironmentClientOptional()
  const sessionId = externalId ?? ''
  if (kind === 'fixture') return <FixtureSession sessionId={sessionId} />
  if (!client) return <Unreachable />
  return <LiveSession key={sessionId} sessionId={sessionId} />
}
