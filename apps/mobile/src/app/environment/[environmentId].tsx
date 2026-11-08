import { useLocalSearchParams } from 'expo-router'

import { EnvironmentPage } from '../../environment/PhoneEnvironmentProvider'
import { EnvironmentScreen } from '../../settings/EnvironmentScreen'

/**
 * A saved environment's page, opened from its card in Settings or the home's
 * environment line: under that environment's providers while the phone
 * holds a client for it, so its devices, providers and titles read from it.
 */
export default function EnvironmentRoute() {
  const { environmentId } = useLocalSearchParams<{ environmentId: string }>()
  const id = String(environmentId ?? '')
  return (
    <EnvironmentPage environmentId={id} fallback={<EnvironmentScreen environmentId={id} />}>
      <EnvironmentScreen environmentId={id} />
    </EnvironmentPage>
  )
}
