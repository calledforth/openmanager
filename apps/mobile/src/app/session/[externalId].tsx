import { useIsFocused, useLocalSearchParams } from 'expo-router'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useWindowDimensions } from 'react-native'
import { useEnvironmentClient, useEnvironmentClientOptional } from '@openmanager/app-core/logic'
import { selectActiveThread } from '@openmanager/environment-client'

import { BackgroundTasksRow, useBackgroundTasks } from '../../session/BackgroundTasks'

import { LiveComposer } from '../../composer/LiveComposer'
import { FixtureComposer } from '../../composer/FixtureComposer'
import { createComposerUi, fixtureComposerUi } from '../../composer/ui-state'
import type { HomeSession } from '../../home/rows'
import { useHomeSource } from '../../home/source'
import { usePhoneConnection } from '../../environment/PhoneEnvironmentProvider'
import { childSessionsOf } from '../../session/child-sessions'
import { FixtureThreadStores, useFixtureThread } from '../../session/fixture-thread'
import { SessionThread } from '../../session/SessionThread'
import { threadNoticeSource, TurnNoticesProvider } from '../../session/turn-notices'
import { useReadOnlySession } from '../../session/useReadOnlySession'
import { unavailableSessionActions, useSessionActions } from '../../session/useSessionActions'
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
  // Work the agent left running: above the status line, with its Stop.
  const tasks = useBackgroundTasks(client, sessionId)
  const stopTasks = useCallback(
    (taskIds?: string[]) =>
      client.commands.stopBackgroundTasks({ sessionId, ...(taskIds ? { taskIds } : {}) }),
    [client, sessionId],
  )
  // One element while the tasks are the same, so the page's memo holds.
  const canStop = client.supports('stopBackgroundTasks')
  const above = useMemo(
    () =>
      tasks.length > 0 ? (
        <BackgroundTasksRow
          // Per session: a stop pending in one must not show as pending in the next.
          key={sessionId}
          tasks={tasks}
          onStop={canStop ? stopTasks : undefined}
        />
      ) : null,
    [canStop, sessionId, stopTasks, tasks],
  )
  const childSessions = useChildSessions(sessions, sessionId)
  const [ui] = useState(() => createComposerUi())
  const openSettings = useCallback(() => ui.open({ kind: 'settings' }), [ui])
  const actions = useSessionActions(sessionId, session, openSettings)
  const projectName = workspace?.name ?? null
  // One element for the page's life: the thread re-rendering leaves it be.
  const composer = useMemo(
    () => <LiveComposer sessionId={sessionId} ui={ui} contextName={projectName} />,
    [projectName, sessionId, ui],
  )
  return (
    <TurnNoticesProvider source={notices}>
      <SessionThread
        title={untitled(session?.title ?? title)}
        project={workspace?.name}
        projectId={workspace?.path ?? null}
        above={above}
        status={status}
        messages={messages}
        phase={phase}
        failure={failure}
        onRetry={retry}
        childSessions={childSessions}
        actions={actions}
        composer={composer}
      />
    </TurnNoticesProvider>
  )
}

/** A fixture row: its fixture thread, through the same page. */
function FixtureSession({ sessionId, opened }: { sessionId: string; opened?: string }) {
  const { sessions, workspaces } = useHomeSource()
  const window = useWindowDimensions()
  const [ui] = useState(() => createComposerUi(fixtureComposerUi(opened, window)))
  const fixture = useFixtureThread(sessionId)
  const messages = useSyncExternalStore(fixture.subscribe, fixture.getMessages)
  const session = sessions.find((row) => row.externalId === sessionId)
  const workspace = workspaces.find((entry) => entry.path === session?.workspacePath)
  const status = useStatusLine(session, fixture.subscribe, fixture.getThread)
  const childSessions = useChildSessions(sessions, sessionId)
  const actions = useMemo(
    () => unavailableSessionActions(session, 'A sample session: pair an environment to change it'),
    [session],
  )
  const projectName = workspace?.name ?? null
  const composer = useMemo(
    () => <FixtureComposer session={session} ui={ui} contextName={projectName} />,
    [projectName, session, ui],
  )
  return (
    <FixtureThreadStores stores={fixture.stores}>
      <TurnNoticesProvider source={fixture.notices}>
        <SessionThread
          title={untitled(session?.title)}
          project={workspace?.name}
          projectId={workspace?.path ?? null}
          status={status}
          messages={messages}
          phase="ready"
          childSessions={childSessions}
          actions={actions}
          composer={composer}
        />
      </TurnNoticesProvider>
    </FixtureThreadStores>
  )
}

/** No client yet: nothing paired, the first connect, or a refused token. */
function Unreachable() {
  const { status } = usePhoneConnection()
  const actions = useMemo(
    () => unavailableSessionActions(undefined, 'Not connected to an environment'),
    [],
  )
  return (
    <SessionThread
      title="Session"
      status={null}
      actions={actions}
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
  const { externalId, composer } = useLocalSearchParams<{ externalId: string; composer?: string }>()
  const { kind } = useHomeSource()
  const client = useEnvironmentClientOptional()
  const sessionId = externalId ?? ''
  if (kind === 'fixture') return <FixtureSession sessionId={sessionId} opened={composer} />
  if (!client) return <Unreachable />
  return <LiveSession key={sessionId} sessionId={sessionId} />
}
