import { useRouter } from 'expo-router'

import { phoneConnectionView } from '../environment/connection-ui'
import { usePhoneConnection } from '../environment/PhoneEnvironmentProvider'
import { ROUTE_KIND_LABELS } from '../environment/route-order'
import type { HomeSource } from '../home/source'
import { usePhoneTheme } from '../theme/ThemeProvider'
import type { TitleEnvironment } from '../ui/chrome'
import { environmentCards } from './environments'
import { toneColor } from './SettingsRow'

/**
 * The environment line under a tab's title, from the same card Settings
 * shows: the route kind while connected, else the state in the shared words,
 * with the state's dot; a tap opens the environment's page. The fixture's
 * line stays as it was, with nothing behind it.
 */
export function useTitleEnvironment(
  source: Pick<HomeSource, 'kind' | 'environment' | 'connected'>,
): TitleEnvironment | null {
  const router = useRouter()
  const theme = usePhoneTheme()
  const state = usePhoneConnection()
  const environment = source.environment
  if (!environment) return null
  if (source.kind === 'fixture') {
    return {
      label: environment.label,
      detail: environment.route.kind === 'local' ? 'LAN' : 'Tunnel',
      connected: source.connected,
    }
  }
  const view = phoneConnectionView(state)
  const card = environmentCards(state, view).find(
    (item) => item.environmentId === environment.environmentId,
  )
  if (!card) return null
  return {
    label: card.label,
    detail: card.route ? ROUTE_KIND_LABELS[card.route.kind] : (card.words ?? undefined),
    connected: view.ui.kind === 'ready',
    color: toneColor(theme, card.tone),
    onPress: () => router.push(`/environment/${encodeURIComponent(card.environmentId)}`),
  }
}
