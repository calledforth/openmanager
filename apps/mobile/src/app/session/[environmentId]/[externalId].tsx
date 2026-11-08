import { useLocalSearchParams } from 'expo-router'

import { SessionScreen } from '../../../session/SessionScreen'

/** A session's page, in the environment its address names (`/session/<environment>/<id>`). */
export default function SessionRoute() {
  const { environmentId, externalId, composer } = useLocalSearchParams<{
    environmentId: string
    externalId: string
    composer?: string
  }>()
  return (
    <SessionScreen
      environmentId={String(environmentId ?? '')}
      sessionId={String(externalId ?? '')}
      opened={composer}
    />
  )
}
