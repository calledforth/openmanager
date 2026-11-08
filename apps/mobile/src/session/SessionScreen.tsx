import { useIsFocused } from 'expo-router'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useWindowDimensions } from 'react-native'
import { useEnvironmentClient } from '@openmanager/app-core/logic'
import { selectActiveThread } from '@openmanager/environment-client'

import { BackgroundTasksRow, useBackgroundTasks } from './BackgroundTasks'

import { LiveComposer } from '../composer/LiveComposer'
import { FixtureComposer } from '../composer/FixtureComposer'
import { createComposerUi, fixtureComposerUi } from '../composer/ui-state'
import type { HomeSession } from '../home/rows'
import { useHomeSource, usePageSessions } from '../home/source'
import { EnvironmentPage, useEnvironmentStatus } from '../environment/PhoneEnvironmentProvider'
import { childSessionsOf } from './child-sessions'
import { FixtureThreadStores, useFixtureThread } from './fixture-thread'
import { SessionThread } from './SessionThread'
import { useReadOnlySession } from './useReadOnlySession'
import { unavailableSessionActions, useSessionActions } from './useSessionActions'
import { useStatusLine } from './useStatusLine'

const untitled = (title: string | undefined) => title?.trim() || 'Untitled session'

/** The listed sessions under this one, kept as the same list while they are the same rows. */
function useChildSessions(sessions: readonly HomeSession[], sessionId: string) {
  return useMemo(() => childSessionsOf(sessions, sessionId), [sessions, sessionId])
}

/** A session of its page's environment, opened read-only for as long as the page is up. */
function LiveSession({ sessionId }: { sessionId: string }) {
  // The page in front owns the client's active session; one left under
  // another page keeps quiet until it is in front again.
  const focused = useIsFocused()
  const client = useEnvironmentClient()
  const sessions = usePageSessions()
  const { session, workspace, title, messages, phase, failure, retry } = useReadOnlySession(
    sessionId,
    { focused },
  )
  // The session's own thread, while it is the one the client has open: the
  // status line's times come from it.
  const getThread = useCallback(() => {
    const state = client.getState()
    return state.activeSessionId === sessionId ? selectActiveThread(state) : null
  }, [client, sessionId])
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client])
  const status = useStatusLine(session, subscribe, getThread)
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
  // One element for the page's life: the thread re-rendering leaves it be.
  const composer = useMemo(() => <LiveComposer sessionId={sessionId} ui={ui} />, [sessionId, ui])
  return (
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
  )
}

/** A fixture row: its fixture thread, through the same page. */
export function FixtureSession({ sessionId, opened }: { sessionId: string; opened?: string }) {
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
  const composer = useMemo(() => <FixtureComposer session={session} ui={ui} />, [session, ui])
  return (
    <FixtureThreadStores stores={fixture.stores}>
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
    </FixtureThreadStores>
  )
}

/**
 * No client for its environment yet: the first connect, a refused token, or
 * an environment this phone does not have (removed, or never paired).
 */
export function Unreachable({
  environmentId,
  opening = false,
}: {
  environmentId: string | null
  /** Still finding out where it is (an old address): shown as opening. */
  opening?: boolean
}) {
  const status = useEnvironmentStatus(environmentId)
  const actions = useMemo(
    () => unavailableSessionActions(undefined, 'Not connected to its environment'),
    [],
  )
  return (
    <SessionThread
      title="Session"
      status={null}
      actions={actions}
      messages={[]}
      phase={
        !opening && (status === 'no_environment' || status === 'unauthorized')
          ? 'failed'
          : 'opening'
      }
      failure={
        status === 'unauthorized'
          ? 'Its environment no longer accepts this phone. Pair it again from Settings.'
          : 'This session’s environment is not on this phone. Pair it from Settings to open its sessions.'
      }
    />
  )
}

/**
 * A session's page, through its own environment: the session and every
 * command on the page are that environment's, whatever is under or over it
 * on the stack. Until the environment has a client the phone can use, the
 * page says where it stands.
 */
export function SessionScreen({
  environmentId,
  sessionId,
  opened,
}: {
  environmentId: string
  sessionId: string
  /** The fixture composer's open state, for screenshots. */
  opened?: string
}) {
  const { kind } = useHomeSource()
  if (kind === 'fixture') return <FixtureSession sessionId={sessionId} opened={opened} />
  return (
    <EnvironmentPage
      environmentId={environmentId}
      fallback={<Unreachable environmentId={environmentId} />}
    >
      <LiveSession key={sessionId} sessionId={sessionId} />
    </EnvironmentPage>
  )
}
