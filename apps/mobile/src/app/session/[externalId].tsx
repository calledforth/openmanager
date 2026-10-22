import { useLocalSearchParams } from 'expo-router'
import { useEnvironmentClientOptional } from '@openmanager/app-core/logic'

import { statusLineOf, statusMarkOf } from '../../home/rows'
import { useHomeSource } from '../../home/source'
import { usePhoneConnection } from '../../environment/PhoneEnvironmentProvider'
import { FixtureThreadStores, useFixtureThread } from '../../session/fixture-thread'
import { SessionThread } from '../../session/SessionThread'
import { useReadOnlySession } from '../../session/useReadOnlySession'

const untitled = (title: string | undefined) => title?.trim() || 'Untitled session'

/** A session of the paired environment, opened read-only for as long as the page is up. */
function LiveSession({ sessionId }: { sessionId: string }) {
  const { session, workspace, title, messages, phase, failure, retry } =
    useReadOnlySession(sessionId)
  return (
    <SessionThread
      title={untitled(session?.title ?? title)}
      project={workspace?.name}
      mark={session ? statusMarkOf(session) : undefined}
      statusLine={session ? statusLineOf(session) : null}
      messages={messages}
      phase={phase}
      failure={failure}
      onRetry={retry}
    />
  )
}

/** A fixture row: its recorded thread, through the same page. */
function FixtureSession({ sessionId }: { sessionId: string }) {
  const { sessions, workspaces } = useHomeSource()
  const { messages, stores } = useFixtureThread(sessionId)
  const session = sessions.find((row) => row.externalId === sessionId)
  const workspace = workspaces.find((entry) => entry.path === session?.workspacePath)
  return (
    <FixtureThreadStores stores={stores}>
      <SessionThread
        title={untitled(session?.title)}
        project={workspace?.name}
        mark={session ? statusMarkOf(session) : undefined}
        statusLine={session ? statusLineOf(session) : null}
        messages={messages}
        phase="ready"
      />
    </FixtureThreadStores>
  )
}

/** No client yet: nothing paired, the first connect, or a refused token. */
function Unreachable() {
  const { status } = usePhoneConnection()
  return (
    <SessionThread
      title="Session"
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
