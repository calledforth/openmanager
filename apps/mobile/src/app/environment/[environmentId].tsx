import { useLocalSearchParams } from 'expo-router'

import { EnvironmentScreen } from '../../settings/EnvironmentScreen'

/** A saved environment's page, opened from its card in Settings or the home's environment line. */
export default function EnvironmentRoute() {
  const { environmentId } = useLocalSearchParams<{ environmentId: string }>()
  return <EnvironmentScreen environmentId={String(environmentId ?? '')} />
}
