import { View } from 'react-native'
import { useContext } from 'react'
import { PlatformCapabilitiesContext, type ProviderHealthTone } from '@openmanager/app-core/logic'
import { useNow } from '@openmanager/app-core/lib/relative-time'

import type { PhoneTheme } from '../theme/tokens'
import { usePhoneTheme } from '../theme/ThemeProvider'
import { SectionLabel } from '../ui/chrome'
import { ProviderMark } from '../ui/ProviderMark'
import { GroupNote, RoundAction } from './DevicesSection'
import { providerHealthRows } from './providers'
import { Dot, SettingsRow } from './SettingsRow'

function toneColor(theme: PhoneTheme, tone: ProviderHealthTone): string {
  switch (tone) {
    case 'ready':
      return theme.status.done
    case 'warning':
      return theme.status.needs
    case 'error':
      return theme.status.error
    case 'muted':
      return theme.faint
  }
}

/**
 * The connected environment's providers, each as its mark (never its name)
 * with its health in the shared words and, where a re-check makes sense, a
 * probe. The probe runs through the shared platform (`retryProvider`), in a
 * registered workspace; what it finds arrives as the environment's own
 * health push.
 */
export function ProvidersSection() {
  const theme = usePhoneTheme()
  const platform = useContext(PlatformCapabilitiesContext)
  const now = useNow()
  if (!platform) return null
  const rows = providerHealthRows(platform, now)
  return (
    <>
      <SectionLabel>Providers</SectionLabel>
      {rows.length === 0 ? (
        <GroupNote words="This environment has not reported any providers." />
      ) : null}
      {rows.map((row) => (
        <SettingsRow
          key={row.providerId}
          icon={<ProviderMark providerId={row.providerId} size={17} />}
          title={row.health.label}
          sub={row.health.detail}
          accessibilityLabel={`${row.name}: ${row.health.label}${row.health.detail ? `, ${row.health.detail}` : ''}`}
          trailing={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Dot color={toneColor(theme, row.health.tone)} />
              {row.health.canRetry ? (
                <RoundAction
                  label={`Check ${row.name} again`}
                  icon="retry"
                  onPress={() => void platform.retryProvider(row.providerId as never)}
                />
              ) : null}
            </View>
          }
        />
      ))}
      {platform.error ? <GroupNote words={platform.error} tone="error" /> : null}
    </>
  )
}
