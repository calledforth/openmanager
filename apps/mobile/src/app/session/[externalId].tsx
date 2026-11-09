import { useLocalSearchParams } from 'expo-router'

import { LegacyRedirect } from '../../environment/legacy-route'
import { useHomeSource } from '../../home/source'
import { FixtureSession, Unreachable } from '../../session/SessionScreen'

/**
 * A session's address from before environments were part of it
 * (`/session/<id>`: an older notification, a link). It moves to the address
 * of the environment that holds the session. The sample home's rows open
 * here too, with no environment behind them.
 */
export default function LegacySessionRoute() {
  const { externalId, composer } = useLocalSearchParams<{
    externalId: string
    composer?: string
  }>()
  const { kind } = useHomeSource()
  const sessionId = String(externalId ?? '')
  if (kind === 'fixture') return <FixtureSession sessionId={sessionId} opened={composer} />
  return (
    <LegacyRedirect
      kind="session"
      id={sessionId}
      waiting={<Unreachable environmentId={null} opening />}
      none={<Unreachable environmentId={null} />}
    />
  )
}
